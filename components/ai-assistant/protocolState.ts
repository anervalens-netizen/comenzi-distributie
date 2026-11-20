import type { AiChatMessage, AiRunStatus, AiSubmissionResult, AiSubmissionStatus } from './types';

export const STREAMING_MESSAGE_ID = 'comenzi-ai-streaming';
export type MutableRef<T> = { current: T };
export function isActiveRun(status: AiRunStatus): boolean {
  return status === 'running' || status === 'stopping';
}

/** Selection can stay the same while one turn supersedes another. */
export function captureRunGuard(selectionEpoch: MutableRef<number>, runGeneration: MutableRef<number>): () => boolean {
  const selected = selectionEpoch.current;
  const generation = runGeneration.current;
  return () => selectionEpoch.current === selected && runGeneration.current === generation;
}
export const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
export function createSubmissionId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}


/** Durable execution and local delivery are independent. Absence is never rejection. */
export function submissionResult(status: AiSubmissionStatus): AiSubmissionResult {
  if (['unseen', 'unknown'].includes(status.state)) return { outcome: 'unknown' };
  if (['rejected', 'error', 'interrupted'].includes(status.state)) return { outcome: 'rejected' };
  return { outcome: 'accepted' };
}

export function runStatusFromProtocol(status: AiSubmissionStatus | null): AiRunStatus {
  if (status?.run_state === 'stopping') return 'stopping';
  if (status?.run_state === 'accepted' || status?.run_state === 'running') return 'running';
  return 'idle';
}

export function latestSubmission(messages: AiChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].id;
  }
  return undefined;
}

export function streamingMessage(): AiChatMessage {
  return { id: STREAMING_MESSAGE_ID, role: 'assistant', text: '', status: 'streaming', createdAt: new Date().toISOString() };
}

export function mergePersisted(
  persisted: AiChatMessage[], current: AiChatMessage[], status: AiRunStatus, protocol?: AiSubmissionStatus | null,
): AiChatMessage[] {
  const ids = new Set(persisted.map((item) => item.id));
  const older = current.filter((item) => item.ordinal !== undefined && !ids.has(item.id));
  const combined = [...older, ...persisted].sort((a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity));
  if (status === 'idle' && (protocol?.run_state === 'interrupted' || (!protocol?.run_state && protocol?.state === 'interrupted'))) {
    combined.push({ id: 'unihub-ai-interrupted', role: 'assistant', status: 'error',
      text: 'Generarea răspunsului a fost întreruptă. Poți retrimite solicitarea pentru o nouă încercare.',
      createdAt: persisted.at(-1)?.createdAt ?? new Date().toISOString() });
  }
  return status === 'running' || status === 'stopping'
    ? [...combined, current.find((item) => item.id === STREAMING_MESSAGE_ID) ?? streamingMessage()]
    : combined;
}
