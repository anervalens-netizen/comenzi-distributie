import type { ManagerAiModel } from '@/lib/manager-ai';

export type AiModel = ManagerAiModel;

export type AiDistributionContext = { tab: string; period: string; scopeLabel: string };

export type AiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AiMessageRole = 'user' | 'assistant' | 'system';

export type AiMessageStatus = 'complete' | 'streaming' | 'error';

export interface AiArtifactAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'input' | 'output';
  downloadUrl?: string;
}

export interface AiChatMessage {
  id: string;
  ordinal?: number;
  role: AiMessageRole;
  text: string;
  status: AiMessageStatus;
  createdAt: string;
  attachments?: AiArtifactAttachment[];
  /** Ephemeral progress from runtime events; never stored as assistant content. */
  activity?: string;
}

export interface AiConversation {
  id: string;
  title: string;
  effort: AiReasoningEffort;
  createdAt: string;
  updatedAt: string;
}

export type AiCurrentViewContext = Pick<AiDistributionContext, 'tab' | 'period'>;

export interface AiComposerSubmission {
  model?: AiModel;
  text: string;
  effort: AiReasoningEffort;
  includeCurrentView: boolean;
  currentView: AiCurrentViewContext | null;
  files: File[];
  mode: 'send' | 'steer';
  submissionId?: string;
  /** Client-only retry signal; never serialized to the backend. */
  reuseSubmissionId?: boolean;
}

export type AiRunStatus = 'idle' | 'loading' | 'running' | 'stopping' | 'unavailable';

export type AiUnavailableReason = 'not_configured' | 'runtime_unavailable';

export const AI_NOT_CONFIGURED_MESSAGE =
  'Asistentul AI nu este configurat pentru Comenzi.';

export type AiSubmissionResult =
  | { outcome: 'accepted' }
  | { outcome: 'unknown' }
  | { outcome: 'rejected'; message?: string }
  | { outcome: 'conflict'; code: string };

export interface AiSubmissionStatus {
  submission_id: string;
  state: 'unseen' | 'unknown' | 'accepted' | 'running' | 'complete' | 'stopped' | 'rejected' | 'interrupted' | 'error';
  run_id?: string | null;
  attempt_id?: string | null;
  run_state?: 'accepted' | 'running' | 'stopping' | 'complete' | 'stopped' | 'rejected' | 'interrupted' | 'error' | null;
  processed_order_key?: number | null;
  terminal_message_id?: string | null;
}
