import type { AgentOutputItem, ModelRequest } from '@openai/agents-core';
import { OpenAIResponsesModel } from '@openai/agents-openai';
import OpenAI from 'openai';
import type { ManagerAiModel } from './manager-ai';
import { fail } from './server';

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; message: string };
type Emit = (event: ProviderEvent) => Promise<void>;

function boundedFetch(send: typeof fetch): typeof fetch {
  return async (url, options) => {
    const reply = await send(url, { ...options, redirect: 'error' });
    if (!reply.ok) {
      await reply.body?.cancel();
      // Leave error translation to the OpenAI client without exposing provider payloads.
      return new Response(null, {
        status: reply.status,
        headers: reply.headers,
      });
    }
    if (!reply.body) fail(502, 'Furnizorul AI a returnat un răspuns gol.');
    const limit = reply.headers
      .get('content-type')
      ?.includes('text/event-stream')
      ? 2 * 1024 * 1024
      : 512 * 1024;
    let bytes = 0;
    const bounded = reply.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > limit)
            fail(502, 'Furnizorul AI a returnat un răspuns prea mare.');
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(bounded, {
      status: reply.status,
      headers: reply.headers,
    });
  };
}

// Verify the provider envelope before the SDK can dispatch its tools or publish a delta.
export class ManagerAiModelAdapter extends OpenAIResponsesModel {
  resolvedModel = '';
  answer = '';
  private calls = 0;
  constructor(
    private readonly requested: ManagerAiModel,
    key: string,
    send: typeof fetch,
    private readonly authorize: () => Promise<void>,
    private readonly callLimit: number,
    private readonly allowedTools: ReadonlySet<string>,
    private readonly emit?: Emit,
  ) {
    super(
      new OpenAI({
        apiKey: key,
        baseURL: 'https://api.openai.com/v1',
        organization: null,
        project: null,
        adminAPIKey: null,
        maxRetries: 0,
        logLevel: 'off',
        fetch: boundedFetch(send),
      }),
      requested,
    );
  }

  private verifyModel(value: unknown) {
    if (
      typeof value !== 'string' ||
      (value !== this.requested &&
        !(
          value.startsWith(this.requested + '-') &&
          /^\d{4}-\d{2}-\d{2}$/.test(value.slice(this.requested.length + 1))
        ))
    ) {
      fail(502, 'Modelul răspunsului diferă de cel selectat.');
    }
    return value;
  }

  private verifyTerminal(
    data: Record<string, unknown> | undefined,
    output: AgentOutputItem[],
  ) {
    this.resolvedModel = this.verifyModel(data?.model);
    if (data?.status !== 'completed') fail(502, 'Analiza AI este incompletă.');
    const calls = output.filter((item) => item.type === 'function_call');
    if (calls.length && this.calls >= this.callLimit)
      fail(
        422,
        'Analiza a depășit limita de rapoarte. Restrânge perioada sau selecția.',
      );
    const ids = new Set<string>();
    for (const call of calls) {
      if (
        !this.allowedTools.has(call.name) ||
        typeof call.callId !== 'string' ||
        ids.has(call.callId) ||
        typeof call.arguments !== 'string'
      ) {
        fail(502, 'Cerere de raport invalidă de la furnizor.');
      }
      ids.add(call.callId);
    }
    if (!calls.length) {
      this.answer = output
        .flatMap((item) =>
          item.type === 'message' && item.role === 'assistant'
            ? item.content.map((part) =>
                part.type === 'output_text'
                  ? part.text
                  : part.type === 'refusal'
                    ? part.refusal
                    : '',
              )
            : [],
        )
        .filter((text) => text.trim())
        .join('\n')
        .trim();
      if (!this.answer) fail(502, 'Furnizorul AI nu a returnat o analiză.');
    }
  }

  override async getResponse(request: ModelRequest) {
    await this.authorize();
    this.calls++;
    const response = await super.getResponse(request);
    this.verifyTerminal(response.providerData, response.output);
    return response;
  }

  override async *getStreamedResponse(request: ModelRequest) {
    await this.authorize();
    this.calls++;
    let verified = false,
      completed = false,
      pending = '';
    for await (const event of super.getStreamedResponse(request)) {
      if (event.type === 'response_started') {
        this.verifyModel(event.providerData?.response?.model);
        verified = true;
      } else if (event.type === 'output_text_delta' && verified) {
        pending += event.delta;
        if (pending.length >= 128) {
          await this.emit?.({ type: 'delta', text: pending });
          pending = '';
        }
      } else if (event.type === 'response_done') {
        this.verifyTerminal(event.response.providerData, event.response.output);
        completed = true;
        if (pending) await this.emit?.({ type: 'delta', text: pending });
      }
      yield event;
    }
    if (!completed) fail(502, 'Analiza AI este incompletă.');
  }
}
