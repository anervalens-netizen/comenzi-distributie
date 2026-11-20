export const managerAiAttachmentAccept = '.csv,.tsv,.xlsx,.json,.txt,.md,.pdf,.jpg,.jpeg,.png,.webp';
export const managerAiAttachmentLimits = {
  maxFiles:4,
  maxFileBytes:1024*1024,
  maxTotalBytes:3*1024*1024,
} as const;
export const managerAiAudioLimits = {maxFileBytes:12*1024*1024,maxRecordingMs:120_000} as const;

export type ManagerAiMediaPart =
  | {type:'input_file';file_data:string;filename:string}
  | {type:'input_image';image_url:string;detail:'auto'};

export type ManagerAiPreparedArtifact = {
  filename:string;
  mime_type:string;
  bytes:Uint8Array;
  kind:'input'|'output';
};

export type ManagerAiArtifact = {
  id:string;
  filename:string;
  mime_type:string;
  size_bytes:number;
  kind:'input'|'output';
  download_url:string;
  removed?:true;
};
