export const managerAiEfforts = ['none','low','medium','high','xhigh','max'] as const;
export type ManagerAiEffort = typeof managerAiEfforts[number];
export type ManagerAiRunState = 'running' | 'complete' | 'stopped' | 'interrupted' | 'error';
export type ManagerAiArtifact = MediaArtifact & {created_at:string};
export type ManagerAiChatMessage = {
  id:string;
  ordinal:number;
  role:'user'|'assistant';
  status:'complete'|'error';
  text:string;
  created_at:string;
  attachments:ManagerAiArtifact[];
};
export type ManagerAiConversation = {
  id:string;
  title:string;
  effort:ManagerAiEffort;
  created_at:string;
  updated_at:string;
};
export type ManagerAiSubmissionStatus = {
  submission_id:string;
  state:ManagerAiRunState|'unseen';
  mode:'turn'|'steer'|null;
  order_key:number|null;
  run_id:string|null;
  attempt_id:string|null;
  run_state:ManagerAiRunState|null;
  processed_order_key:number|null;
  terminal_message_id:string|null;
};
export type ManagerAiChatEvent =
  | ({type:'submission_status'} & ManagerAiSubmissionStatus)
  | {type:'user_message'|'complete';message:ManagerAiChatMessage}
  | {type:'delta';text:string}
  | {type:'status'|'error';message:string}
  | {type:'stopped'|'reset'};
import type { ManagerAiArtifact as MediaArtifact } from './manager-ai-media-contract';
