import { ResponsesModel, type ModelRequest, type NativeModel } from '@openai/agents';
import OpenAI from 'openai';
import type { ManagerAiModel } from './manager-ai';
import { fail } from './server';

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; message: string };
type Emit = (event: ProviderEvent) => Promise<void>;
type ResponseStream = AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & { controller: AbortController };
type FunctionCall = Extract<OpenAI.Responses.ResponseOutputItem, { type: 'function_call' }>;
type StreamCall = { id?: string; added?: FunctionCall; done?: FunctionCall; delta?: string; arguments?: string };
const callIdentity = (call: FunctionCall) => JSON.stringify([
  call.call_id, call.name, 'namespace' in call && call.namespace != null ? call.namespace : 'functions',
]);

function rawProgress(event: OpenAI.Responses.ResponseStreamEvent): boolean {
  if (event.type.endsWith('.delta')) return 'delta' in event && typeof event.delta === 'string' && event.delta.length > 0;
  return event.type.startsWith('response.') && (event.type.endsWith('.added') || event.type.endsWith('.done'));
}

function boundedFetch(send: typeof fetch): typeof fetch {
  return async (url, options) => {
    const reply = await send(url, { ...options, redirect: 'error' });
    if (!reply.ok) {
      await reply.body?.cancel();
      // Keep provider error bodies out of application logs and user-visible errors.
      return new Response(null, { status: reply.status, headers: reply.headers });
    }
    if (!reply.body) fail(502, 'Furnizorul AI a returnat un răspuns gol.');
    const limit = reply.headers.get('content-type')?.includes('text/event-stream') ? 2 * 1024 * 1024 : 512 * 1024;
    let bytes = 0;
    const bounded = reply.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > limit) fail(502, 'Furnizorul AI a returnat un răspuns prea mare.');
        controller.enqueue(chunk);
      },
    }));
    return new Response(bounded, { status: reply.status, headers: reply.headers });
  };
}

// Keep the application's Responses transport and authorization checks while the
// native SDK owns tool admission, the model loop and cancellation settlement.
export class ManagerAiModelAdapter implements NativeModel {
  resolvedModel = '';
  answer = '';
  failure: unknown;
  readonly stream?: NativeModel['stream'];
  private calls = 0;
  private readonly backend: ResponsesModel;

  constructor(
    private readonly requested: ManagerAiModel,
    key: string,
    send: typeof fetch,
    private readonly authorize: () => Promise<void>,
    private readonly callLimit: number,
    private readonly allowedTools: ReadonlySet<string>,
    private readonly emit?: Emit,
    private readonly progress?: () => void,
    private readonly expectedImages = 0,
  ) {
    const client = new OpenAI({
      apiKey: key, baseURL: 'https://api.openai.com/v1',
      organization: null, project: null, adminAPIKey: null,
      maxRetries: 0, logLevel: 'off', fetch: boundedFetch(send),
    });
    // ResponsesModel preserves native usage/provenance. The borrowed client
    // validates wire calls against the terminal envelope before native admission.
    this.backend = new ResponsesModel({
      responses: {
        create: async (body: OpenAI.Responses.ResponseCreateParams, options: OpenAI.RequestOptions) => {
          if (body.stream) {
            const source = await client.responses.create(body, options);
            return {
              controller: source.controller,
              [Symbol.asyncIterator]: () => this.verifiedEvents(source)[Symbol.asyncIterator](),
            };
          }
          const response = await client.responses.create(body, options);
          this.verifyTerminal(response);
          this.progress?.();
          return response;
        },
      },
    }, requested, { stream: Boolean(emit), requestOptions: { maxRetries: 0 } });
    if (emit) this.stream = request => this.streamRequest(request);
  }

  private verifyModel(value: unknown) {
    if (typeof value !== 'string' || (value !== this.requested &&
      !(value.startsWith(this.requested + '-') && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(this.requested.length + 1))))) {
      fail(502, 'Modelul răspunsului diferă de cel selectat.');
    }
    return value;
  }

  private verifyCalls(calls: FunctionCall[]) {
    if (calls.length && this.calls >= this.callLimit)
      fail(422, 'Analiza a depășit limita de rapoarte. Restrânge perioada sau selecția.');
    const ids = new Set<string>();
    for (const call of calls) {
      if (!this.allowedTools.has(call.name) || typeof call.call_id !== 'string' || !call.call_id ||
        ids.has(call.call_id) || typeof call.arguments !== 'string' ||
        ('namespace' in call && call.namespace != null && call.namespace !== 'functions')) {
        fail(502, 'Cerere de raport invalidă de la furnizor.');
      }
      ids.add(call.call_id);
    }
  }

  private verifyTerminal(data: OpenAI.Responses.Response) {
    this.resolvedModel = this.verifyModel(data?.model);
    if (data?.status !== 'completed' || !Array.isArray(data.output)) fail(502, 'Analiza AI este incompletă.');
    const calls = data.output.filter(item => item.type === 'function_call');
    this.verifyCalls(calls);
    if (!calls.length) {
      this.answer = data.output.flatMap(item => item.type === 'message' && item.role === 'assistant'
        ? item.content.map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '')
        : []).filter(text => text.trim()).join('\n').trim();
      if (!this.answer) fail(502, 'Furnizorul AI nu a returnat o analiză.');
    }
  }

  private verifyInput(request: ModelRequest) {
    const input = Array.isArray(request.body.input) ? request.body.input : [];
    const images = input.flatMap(item => item && typeof item === 'object' && !Array.isArray(item) &&
      item.role === 'user' && Array.isArray(item.content) ? item.content : [])
      .filter(part => part && typeof part === 'object' && !Array.isArray(part) && part.type === 'input_image').length;
    // The native runtime may replace an undecodable image with an omission note.
    // Never ask the model to analyze an attachment it has silently lost.
    if (images !== this.expectedImages) fail(400, 'O imagine atașată nu a putut fi pregătită. Încarcă o imagine validă.');
  }

  async complete(request: ModelRequest) {
    try {
      await this.authorize();
      request.signal.throwIfAborted();
      this.verifyInput(request);
      this.calls++;
      return await this.backend.complete(request);
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  private async *streamRequest(request: ModelRequest) {
    try {
      await this.authorize();
      request.signal.throwIfAborted();
      this.verifyInput(request);
      this.calls++;
      yield* await this.backend.stream!(request);
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  private async *verifiedEvents(source: ResponseStream) {
    let verified = false, completed = false, pending = '';
    const refusalEvents: OpenAI.Responses.ResponseStreamEvent[] = [];
    const calls = new Map<number, StreamCall>();
    const ids = new Map<string, number>();
    const invalidCall = () => fail(502, 'Cerere de raport invalidă de la furnizor.');
    const callState = (index: number, id?: string): StreamCall => {
      if (!Number.isSafeInteger(index) || index < 0 || (id !== undefined && (typeof id !== 'string' || !id))) invalidCall();
      const state = calls.get(index) ?? {};
      if (id !== undefined) {
        if (state.id !== undefined && state.id !== id) invalidCall();
        state.id = id;
      }
      calls.set(index, state);
      return state;
    };
    let refusing = false;
    try {
      for await (const event of source) {
        if (completed) fail(502, 'Furnizorul AI a returnat un răspuns invalid.');
        if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
          if (event.item.type === 'function_call') {
            this.verifyCalls([event.item]);
            const state = callState(event.output_index, event.item.id);
            const previous = ids.get(event.item.call_id);
            if (previous !== undefined && previous !== event.output_index) invalidCall();
            ids.set(event.item.call_id, event.output_index);
            if (state.done || (event.type === 'response.output_item.added' && state.added)) invalidCall();
            if (event.type === 'response.output_item.done') state.done = event.item;
            else state.added = event.item;
          } else if (calls.has(event.output_index)) invalidCall();
        } else if (event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done') {
          const state = callState(event.output_index, event.item_id);
          if (state.done || state.arguments !== undefined) invalidCall();
          if (event.type === 'response.function_call_arguments.delta') {
            if (typeof event.delta !== 'string') invalidCall();
            state.delta = (state.delta ?? '') + event.delta;
          } else {
            if (typeof event.arguments !== 'string') invalidCall();
            state.arguments = event.arguments;
          }
        }
        if (event.type === 'response.created') {
          this.verifyModel(event.response.model);
          verified = true;
        } else if (event.type === 'response.output_text.delta' && verified) {
          pending += event.delta;
          if (pending.length >= 128) {
            await this.emit?.({ type: 'delta', text: pending });
            pending = '';
          }
        } else if (event.type === 'response.completed') {
          this.verifyTerminal(event.response);
          // Native execution admits the streamed calls after the terminal and
          // iterator completion. Validate exactly that set, including identities
          // and arguments, before it can start any local callback.
          const terminal = event.response.output.flatMap((item, index) => item.type === 'function_call' ? [{item, index}] : []);
          if (terminal.length !== calls.size) invalidCall();
          for (const {item, index} of terminal) {
            const state = calls.get(index);
            if (!state?.done || callIdentity(state.done) !== callIdentity(item) || state.done.arguments !== item.arguments ||
              (state.id !== undefined && item.id !== undefined && state.id !== item.id) ||
              (state.added && (callIdentity(state.added) !== callIdentity(item) || !item.arguments.startsWith(state.added.arguments))) ||
              (state.delta !== undefined && (state.added?.arguments ?? '') + state.delta !== item.arguments) ||
              (state.arguments !== undefined && state.arguments !== item.arguments)) invalidCall();
          }
          completed = true;
          if (pending) await this.emit?.({ type: 'delta', text: pending });
        } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          fail(502, 'Analiza AI este incompletă.');
        }
        // Keepalive notices do not extend the application's progress deadline.
        if (event.type === 'response.created' || event.type === 'response.completed' || rawProgress(event)) this.progress?.();
        // Alpha terminates a stream at refusal.done. Read and validate the full
        // provider envelope first, then replay those frames to the native loop.
        refusing ||= event.type.startsWith('response.refusal.') ||
          ('part' in event && event.part?.type === 'refusal') ||
          ('item' in event && event.item?.type === 'message' && event.item.content.some(part => part.type === 'refusal'));
        if (refusing) refusalEvents.push(event);
        else yield event;
      }
      if (!completed) fail(502, 'Analiza AI este incompletă.');
      yield* refusalEvents;
    } finally {
      // Early return, revocation and rejected output must release the HTTP stream.
      source.controller.abort();
    }
  }
}
