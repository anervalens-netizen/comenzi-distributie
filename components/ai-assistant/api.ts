import { ApiError, authenticatedMultipart, networkApi } from '@/lib/client-api';
import type {
  AiArtifactAttachment,
  AiChatMessage,
  AiComposerSubmission,
  AiConversation,
  AiReasoningEffort,
  AiSubmissionStatus,
} from './types';
import { AI_NOT_CONFIGURED_MESSAGE as AI_NOT_CONFIGURED_DETAIL } from './types';

export function isAiNotConfiguredError(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 503
    && error.message === AI_NOT_CONFIGURED_DETAIL;
}

type RawArtifact = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  kind: 'input' | 'output';
  download_url?: string | null;
  removed?: boolean;
  created_at: string;
};

type RawMessage = {
  id: string;
  ordinal?: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  status: 'complete' | 'streaming' | 'error' | 'stopped';
  created_at: string;
  attachments?: RawArtifact[];
};

type RawConversation = {
  id: string;
  title: string;
  effort: AiReasoningEffort;
  created_at: string;
  updated_at: string;
};

type RawConversationList = { items: RawConversation[] };
type RawMessageList = { items: RawMessage[]; has_more?: boolean };
type RawSteerResponse = { accepted: boolean; message: RawMessage };

export type AiStreamEvent =
  | { type: 'submission_status'; status: AiSubmissionStatus }
  | { type: 'user_message'; message: AiChatMessage }
  | { type: 'reset' }
  | { type: 'delta'; text: string }
  | { type: 'status'; message: string }
  | { type: 'complete'; message: AiChatMessage; previousResponseId?: string | null }
  | { type: 'stopped'; message?: AiChatMessage }
  | { type: 'error'; message: string };

function mapArtifact(raw: RawArtifact): AiArtifactAttachment {
  return {
    id: raw.id,
    filename: raw.filename,
    mimeType: raw.mime_type,
    sizeBytes: raw.size_bytes,
    kind: raw.kind,
    removed: raw.removed === true,
    downloadUrl: !raw.removed && typeof raw.download_url === 'string' && /^\/api\/manager-ai\/conversations\/[A-Za-z0-9-]+\/artifacts\/[A-Za-z0-9-]+(?:\?[^#\\]*)?$/.test(raw.download_url) ? raw.download_url : undefined,
  };
}

function mapMessage(raw: RawMessage): AiChatMessage {
  return {
    id: raw.id,
    ordinal: raw.ordinal,
    role: raw.role,
    text: raw.text,
    status: raw.status,
    createdAt: raw.created_at,
    attachments: raw.attachments?.map(mapArtifact),
  };
}

function mapConversation(raw: RawConversation): AiConversation {
  return {
    id: raw.id,
    title: raw.title,
    effort: raw.effort,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function submissionForm(submission: AiComposerSubmission): FormData {
  const data = new FormData();
  data.append('text', submission.text);
  data.append('effort', submission.effort);
  data.append('model', submission.model ?? 'gpt-6.1-terra');
  if (submission.currentView) {
    data.append('current_view', JSON.stringify(submission.currentView));
  }
  if (submission.submissionId) data.append('submission_id', submission.submissionId);
  for (const file of submission.files) data.append('files', file, file.name);
  return data;
}

// The Retail chat protocol runs against this application's authenticated and scoped API.
export function createAiApi(scopeQuery: string, ownerId: string) {
  const endpoint = (relative: string, params: Record<string, number> = {}) => {
    const query = new URLSearchParams(scopeQuery);
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    return 'manager-ai/' + relative + (query.size ? '?' + query : '');
  };

  async function postMultipart(path: string, form: FormData, signal: AbortSignal) {
    const res = await authenticatedMultipart(endpoint(path), form, signal, ownerId);
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error : 'Cererea asistentului AI nu a putut fi finalizată.';
      throw new ApiError(res.status, message, data);
    }
    return res;
  }

  const conversations = 'conversations';
  function conversation(id: string) {
    return conversations + '/' + encodeURIComponent(id);
  }

  async function listAiConversations(offset = 0, limit = 30) {
    const data = await networkApi<RawConversationList>(endpoint(conversations, { offset, limit }));
    return data.items.map(mapConversation);
  }

  async function createAiConversation(effort: AiReasoningEffort = 'high') {
    const data = await networkApi<RawConversation>(endpoint(conversations), 'POST', { effort }, undefined, undefined, ownerId);
    return mapConversation(data);
  }

  async function getAiConversation(id: string) {
    const data = await networkApi<RawConversation>(endpoint(conversation(id)));
    return mapConversation(data);
  }

  async function listAiMessages(id: string, beforeOrdinal?: number, limit = 200) {
    const data = await networkApi<RawMessageList>(endpoint(conversation(id) + '/messages', {
      limit, ...(beforeOrdinal === undefined ? {} : { before_ordinal: beforeOrdinal }),
    }));
    return { items: data.items.map(mapMessage), hasMore: Boolean(data.has_more) };
  }

  function openAiTurnStream(id: string, submission: AiComposerSubmission, signal: AbortSignal) {
    return postMultipart(conversation(id) + '/turn', submissionForm(submission), signal);
  }

  async function steerAiTurn(id: string, submission: AiComposerSubmission) {
    const response = await postMultipart(conversation(id) + '/steer', submissionForm(submission), AbortSignal.timeout(30_000));
    const data = await response.json() as RawSteerResponse;
    return mapMessage(data.message);
  }

  function getAiSubmissionStatus(id: string, submissionId: string) {
    return networkApi<AiSubmissionStatus>(endpoint(conversation(id) + '/submissions/' + encodeURIComponent(submissionId)));
  }

  async function stopAiTurn(id: string, submissionId: string, controlId: string) {
    const data = await getAiSubmissionStatus(id, submissionId);
    if (!data.run_id || !data.attempt_id) throw new Error('Rularea activă nu a putut fi identificată.');
    await networkApi(endpoint(conversation(id) + '/stop'), 'POST', {
      control_id: controlId, run_id: data.run_id, attempt_id: data.attempt_id,
    }, undefined, undefined, ownerId);
  }

  async function removeAiArtifact(id: string, artifactId: string) {
    const path = endpoint(conversation(id) + '/artifacts/' + encodeURIComponent(artifactId));
    await networkApi(path, 'DELETE', {}, undefined, undefined, ownerId);
  }

  async function transcribeAiAudio(file: File, signal: AbortSignal) {
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await postMultipart('transcribe', form, AbortSignal.any([signal, AbortSignal.timeout(90_000)]));
    return await response.json() as { text: string; model: string };
  }

  return {
    listAiConversations, createAiConversation, getAiConversation, listAiMessages,
    openAiTurnStream, steerAiTurn, getAiSubmissionStatus, stopAiTurn, transcribeAiAudio, removeAiArtifact,
  };
}

function parseStreamEvent(raw: unknown): AiStreamEvent | null {
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return null;
  const event = raw as Record<string, unknown>;
  switch (event.type) {
    case 'submission_status':
      return { type: 'submission_status', status: event as unknown as AiSubmissionStatus };
    case 'user_message':
      return event.message && typeof event.message === 'object'
        ? { type: 'user_message', message: mapMessage(event.message as RawMessage) }
        : null;
    case 'reset':
      return { type: 'reset' };
    case 'delta':
      return typeof event.text === 'string' ? { type: 'delta', text: event.text } : null;
    case 'status':
      return typeof event.message === 'string' ? { type: 'status', message: event.message } : null;
    case 'complete':
      return event.message && typeof event.message === 'object'
        ? {
          type: 'complete',
          message: mapMessage(event.message as RawMessage),
          previousResponseId: typeof event.previous_response_id === 'string'
            ? event.previous_response_id
            : null,
        }
        : null;
    case 'stopped':
      return { type: 'stopped', message: event.message && typeof event.message === 'object' ? mapMessage(event.message as RawMessage) : undefined };
    case 'error':
      return typeof event.message === 'string' ? { type: 'error', message: event.message } : null;
    default:
      return null;
  }
}

export async function consumeAiStream(
  response: Response,
  onEvent: (event: AiStreamEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('AI stream response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const parsed = parseStreamEvent(JSON.parse(line));
          if (parsed) onEvent(parsed);
        } catch {
          // Ignore one malformed transport line without discarding the run.
        }
      }
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  const tail = buffer.trim();
  if (tail) {
    const parsed = parseStreamEvent(JSON.parse(tail));
    if (parsed) onEvent(parsed);
  }
}
