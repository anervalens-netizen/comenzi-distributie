import {
  ChevronDown, FileText, Paperclip, Send, Square, X,
} from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent,
} from 'react';

import { useResizablePanel } from './useResizablePanel';
import { VoiceInput } from './VoiceInput';
import { AiHaloOrb } from './AiHaloOrb';
import { AiPanelHeader } from './AiPanelHeader';
import { usePersistentState } from './usePersistentState';
import { useDialogFocus } from './useDialogFocus';
import { cn } from '@/lib/utils';
import { managerAiAttachmentAccept, managerAiAttachmentLimits } from '@/lib/manager-ai-media-contract';
import type {
  AiModel, AiArtifactAttachment, AiChatMessage, AiComposerSubmission, AiConversation, AiReasoningEffort, AiRunStatus,
  AiUnavailableReason, AiSubmissionResult, AiDistributionContext,
} from './types';
import { AI_NOT_CONFIGURED_MESSAGE } from './types';

const DEFAULT_DESKTOP_WIDTH = 460;
const EFFORTS: Array<{ value: AiReasoningEffort; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];

interface AiAssistantPanelProps {
  canAccess: boolean;
  advancedControls?: boolean;
  currentContext: AiDistributionContext | null;
  messages: AiChatMessage[];
  conversations?: AiConversation[];
  conversationId?: string | null;
  hasOlderConversations?: boolean;
  loadingOlderConversations?: boolean;
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  runStatus: AiRunStatus;
  unavailableReason?: AiUnavailableReason | null;
  onSubmit: (submission: AiComposerSubmission) => Promise<AiSubmissionResult>;
  onStop: () => void;
  onNewConversation?: () => void;
  onSelectConversation?: (id: string) => void;
  onLoadOlderConversations?: () => void;
  onLoadOlderMessages?: () => void;
  onRetryBootstrap?: () => void;
  onClose: () => void;
  open: boolean;
}

function contextLabel(context: AiDistributionContext | null): string {
  if (!context) return 'Fără context disponibil';
  return [context.scopeLabel, context.tab, context.period].filter(Boolean).join(' · ');
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChip({ attachment, assistant }: { attachment: AiArtifactAttachment; assistant: boolean }) {
  const className = cn(
    'flex min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-xs transition',
    assistant
      ? 'border-slate-200/80 bg-slate-50/90 text-slate-700 dark:border-slate-700/80 dark:bg-slate-800/80 dark:text-slate-200'
      : 'border-white/15 bg-white/10 text-white',
    attachment.downloadUrl && (assistant
      ? 'hover:border-indigo-300 hover:bg-indigo-50/70 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30'
      : 'hover:border-white/30 hover:bg-white/15'),
  );
  const content = <>
    <span className={cn(
      'inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
      assistant ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300' : 'bg-white/10 text-white',
    )}>
      <FileText size={15} aria-hidden="true" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate font-semibold">{attachment.filename}</span>
      <span className="mt-0.5 block text-[10px] opacity-65">{formatFileSize(attachment.sizeBytes)}</span>
    </span>
  </>;
  return attachment.downloadUrl
    ? <a href={attachment.downloadUrl} className={className} download={attachment.filename}>{content}</a>
    : <div className={className}>{content}</div>;
}

function AssistantMarkdown({
  text,
  attachments = [],
}: {
  text: string;
  attachments?: AiArtifactAttachment[];
}) {
  const transformUrl = (url: string) => {
    if (url.startsWith('sandbox:/workspace/output/')) {
      const name = url.split('/').at(-1);
      return attachments.find((artifact) => encodeURIComponent(artifact.filename) === name || artifact.filename === name)?.downloadUrl ?? '';
    }
    return defaultUrlTransform(url);
  };

  return <div className="min-w-0 overflow-hidden [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_li]:pl-0.5 [&_strong]:font-semibold [&_strong]:text-slate-900 dark:[&_strong]:text-white [&_a]:break-words [&_a]:font-semibold [&_a]:text-indigo-600 [&_a]:underline [&_a]:underline-offset-2 dark:[&_a]:text-indigo-300 [&_blockquote]:my-2.5 [&_blockquote]:rounded-r-lg [&_blockquote]:border-l-2 [&_blockquote]:border-indigo-200 [&_blockquote]:bg-indigo-50/50 [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:text-slate-600 dark:[&_blockquote]:border-indigo-800 dark:[&_blockquote]:bg-indigo-950/20 dark:[&_blockquote]:text-slate-300 [&_pre]:my-2.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-slate-950 [&_pre]:p-3 [&_pre]:text-xs [&_pre]:text-slate-100 [&_code]:break-words [&_code]:[overflow-wrap:anywhere] [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={transformUrl}
      components={{
        th: ({ children }) => <th className="border-b border-slate-300 px-3 py-2">{children}</th>,
        td: ({ children }) => <td className="border-b border-slate-200 px-3 py-2">{children}</td>,
        img: ({ alt }) => alt ? <span>{alt}</span> : null,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}
    >
      {text}
    </ReactMarkdown>
  </div>;
}

function MessageBubble({ message }: { message: AiChatMessage }) {
  const assistant = message.role === 'assistant';
  const waiting = assistant && message.status === 'streaming' && !message.text.trim();
  return <div className={cn('flex min-w-0 items-start gap-2', assistant ? 'justify-start' : 'justify-end')}>
    {assistant && <AiHaloOrb size="xs" state={message.status === 'streaming' ? 'running' : 'idle'} className="mt-1 size-6" />}
    <div className={cn(
      'min-w-0 overflow-hidden px-3.5 py-3 text-[13px] leading-5 shadow-sm [overflow-wrap:anywhere] sm:text-sm sm:leading-6',
      assistant
        ? 'max-w-[94%] rounded-[20px] rounded-bl-md border border-slate-200/80 bg-white text-slate-700 shadow-slate-950/5 dark:border-slate-700/80 dark:bg-slate-900 dark:text-slate-200'
        : 'max-w-[88%] rounded-[20px] rounded-br-md bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-indigo-600/20',
    )}>
      {assistant
        ? !waiting && <AssistantMarkdown text={message.text} attachments={message.attachments} />
        : <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>}
      {assistant && message.status === 'streaming' && <output className={cn(
        'inline-flex items-center gap-2 text-xs font-semibold text-indigo-600 dark:text-indigo-300',
        !waiting && 'mt-2',
      )} aria-live="polite">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />
        <span>{message.activity || 'Pregătesc răspunsul…'}</span>
      </output>}
      {message.attachments?.length ? <div className="mt-3 space-y-2">
        {message.attachments.map((attachment) => <AttachmentChip key={attachment.id} attachment={attachment} assistant={assistant} />)}
      </div> : null}
      {message.status === 'streaming' && !waiting && <span className="ml-1 inline-block h-3 w-1 animate-pulse rounded-full bg-current align-middle" aria-label="Răspuns în curs" />}
      {message.status === 'error' && <div className="mt-2 text-xs font-semibold text-red-500">Răspuns întrerupt</div>}
    </div>
  </div>;
}

function AiEmptyState({
  runtimeUnavailable, unavailableReason, onRetry,
}: { runtimeUnavailable: boolean; unavailableReason?: AiUnavailableReason | null; onRetry?: () => void }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
    <AiHaloOrb size="lg" state={runtimeUnavailable ? 'unavailable' : 'idle'} className="mb-5 size-20" />
    <h2 className="text-base font-bold text-slate-900 dark:text-white">AI Comenzi</h2>
    <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">
      Cere analize și rapoarte Vodafone sau atașează un fișier. Agentul folosește datele din portofoliul selectat.
    </p>
    {runtimeUnavailable && <>
      <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
        {unavailableReason === 'not_configured' ? AI_NOT_CONFIGURED_MESSAGE : 'AI Comenzi nu este disponibil momentan.'}
      </p>
      {onRetry && <button type="button" onClick={onRetry} className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Reîncearcă</button>}
    </>}
  </div>;
}

function createComposerSubmissionId(): string {
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

const composerPlaceholder = (
  steering: boolean,
  stopping: boolean,
  loading: boolean,
  basicRunning: boolean,
): string => {
  if (loading) return 'Se încarcă conversația…';
  if (stopping) return 'Rularea se oprește…';
  if (basicRunning) return 'AI analizează răspunsul…';
  if (steering) return 'Scrie pentru a ghida următorul pas…';
  return 'Întreabă AI Comenzi…';
};

function useAutoSizingTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 40), 112)}px`;
  }, [value]);
  return ref;
}

type RetrySubmission = {
  id: string;
  mode: AiComposerSubmission['mode'];
  fingerprint: string;
};

const fileIdentities = new WeakMap<File, number>();
let nextFileIdentity = 0;
function fileIdentity(file: File): number {
  let identity = fileIdentities.get(file);
  if (identity === undefined) { identity = ++nextFileIdentity; fileIdentities.set(file, identity); }
  return identity;
}

function retryFingerprint(submission: Omit<AiComposerSubmission, 'submissionId' | 'reuseSubmissionId'>): string {
  return JSON.stringify({
    mode: submission.mode,
    text: submission.text,
    effort: submission.effort,
    model: submission.model,
    includeCurrentView: submission.includeCurrentView,
    currentView: submission.currentView,
    files: submission.files.map((file) => ({
      identity: fileIdentity(file),
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    })),
  });
}

function buildComposerRequest(args: {
  text: string;
  model: AiModel;
  effort: AiReasoningEffort;
  includeContext: boolean;
  context: AiDistributionContext | null;
  files: File[];
  mode: AiComposerSubmission['mode'];
  retrySubmission?: RetrySubmission;
}): { request: AiComposerSubmission; fingerprint: string } {
  const { text, model, effort, includeContext, context, files, mode, retrySubmission } = args;
  const currentView = includeContext && context ? { tab: context.tab, period: context.period } : null;
  const semanticSubmission = {
    text,
    model,
    effort,
    includeCurrentView: includeContext,
    currentView,
    files,
    mode,
  } satisfies Omit<AiComposerSubmission, 'submissionId' | 'reuseSubmissionId'>;
  const fingerprint = retryFingerprint(semanticSubmission);
  const submissionId = retrySubmission?.mode === mode
    && retrySubmission.fingerprint === fingerprint
    ? retrySubmission.id
    : createComposerSubmissionId();
  return {
    fingerprint,
    request: { ...semanticSubmission, submissionId, reuseSubmissionId: true },
  };
}

function attachClipboardFiles(
  event: ClipboardEvent<HTMLTextAreaElement>,
  files: File[],
  onFilesChange: (value: File[]) => void,
  disabled: boolean,
) {
  if (disabled) return;
  const itemFiles = Array.from(event.clipboardData.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const pastedFiles = itemFiles.length ? itemFiles : Array.from(event.clipboardData.files);
  if (!pastedFiles.length) return;
  event.preventDefault();
  onFilesChange([...files, ...pastedFiles]);
}


function attachInputFiles(event: ChangeEvent<HTMLInputElement>, files: File[], onFilesChange: (files: File[]) => void) {
  const next = Array.from(event.target.files ?? []);
  if (next.length) onFilesChange([...files, ...next]);
  event.target.value = '';
}

function ModelSelector({ model, onChange, disabled }: { model: AiModel; onChange: (model: AiModel) => void; disabled: boolean }) {
  return <label className="relative inline-flex items-center">
    <span className="sr-only">Model AI</span>
    <select aria-label="Model AI" disabled={disabled} value={model} onChange={(event) => onChange(event.target.value as AiModel)} className="rounded-full border border-slate-200 bg-transparent px-2 py-1.5 text-[11px] font-semibold dark:border-slate-700">
      <option value="gpt-6.1-terra">Terra 6.1</option>
      <option value="gpt-6.2-sol">Sol 6.2</option>
    </select>
  </label>;
}

function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => Promise<void>) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}

function Composer({
  context, runStatus, onSubmit, onStop, draft, files, submitting, advancedControls,
  retrySubmission, onDraftChange, onFilesChange, onSubmittingChange,
  onRetrySubmissionChange,
}: {
  context: AiDistributionContext | null;
  advancedControls: boolean;
  runStatus: AiRunStatus;
  onSubmit: (submission: AiComposerSubmission) => Promise<AiSubmissionResult>;
  onStop: () => void;
  draft: string;
  files: File[];
  submitting: boolean;
  retrySubmission?: RetrySubmission;
  onDraftChange: (value: string) => void;
  onFilesChange: (value: File[]) => void;
  onSubmittingChange: (value: boolean) => void;
  onRetrySubmissionChange: (value?: RetrySubmission) => void;
}) {
  const [model, setModel] = usePersistentState<AiModel>('comenzi_ai_model', 'gpt-6.1-terra', {
    deserialize: (stored, fallback) => {
      return stored === 'gpt-6.1-terra' || stored === 'gpt-6.2-sol' ? stored : fallback;
    },
  });
  const [effort, setEffort] = usePersistentState<AiReasoningEffort>('comenzi_ai_effort', 'high');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [composerError, setComposerError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useAutoSizingTextarea(draft);
  const running = runStatus === 'running' || runStatus === 'stopping';
  const steering = advancedControls && runStatus === 'running';
  const stopping = runStatus === 'stopping';
  const loading = runStatus === 'loading';
  const unavailable = runStatus === 'unavailable';
  const basicRunning = !advancedControls && runStatus === 'running';
  const supportsNone = model === 'gpt-6.1-terra';
  const selectedEffort = !supportsNone && effort === 'none' ? 'low' : effort;
  const effectiveEffort: AiReasoningEffort = advancedControls ? selectedEffort : 'high';
  const effectiveIncludeContext = Boolean(context);
  const controlsDisabled = unavailable || stopping || loading || submitting || basicRunning;

  const updateAttachments = (next: File[]) => {
    const { maxFiles, maxFileBytes, maxTotalBytes } = managerAiAttachmentLimits;
    const extensions = managerAiAttachmentAccept.split(',');
    if (next.length > maxFiles || next.reduce((total, file) => total + file.size, 0) > maxTotalBytes) {
      setComposerError(`Poți atașa cel mult ${maxFiles} fișiere, cu un total de ${formatFileSize(maxTotalBytes)}.`);
      return;
    }
    const invalid = next.find((file) => !file.size || file.size > maxFileBytes
      || !extensions.some((extension) => file.name.toLowerCase().endsWith(extension)));
    if (invalid) {
      setComposerError(`„${invalid.name}” trebuie să aibă un format acceptat și cel mult ${formatFileSize(maxFileBytes)}.`);
      return;
    }
    setComposerError('');
    onFilesChange(next);
  };

  async function submit() {
    const text = draft.trim();
    if (!text && files.length === 0) return;
    if (controlsDisabled || voiceBusy) return;
    const mode: AiComposerSubmission['mode'] = steering ? 'steer' : 'send';
    const { request, fingerprint } = buildComposerRequest({
      text,
      model,
      effort: effectiveEffort,
      includeContext: effectiveIncludeContext,
      context,
      files,
      mode,
      retrySubmission,
    });
    const submissionId = request.submissionId!;
    setComposerError('');
    onSubmittingChange(true);
    try {
      const result = await onSubmit(request);
      if (result.outcome !== 'accepted') {
        if (result.outcome === 'unknown') setComposerError('Trimiterea nu a putut fi confirmată. Poți reîncerca.');
        else if (result.outcome === 'conflict') setComposerError('Conversația s-a actualizat. Verifică ultimul mesaj și încearcă din nou.');
        else setComposerError(result.message ?? 'Mesajul nu a putut fi trimis.');
        onRetrySubmissionChange(
          result && result.outcome !== 'unknown'
            ? undefined
            : { id: submissionId, mode, fingerprint },
        );
        return;
      }
      onDraftChange('');
      onFilesChange([]);
      onRetrySubmissionChange(undefined);
    } finally {
      onSubmittingChange(false);
    }
  }


  return <div className="border-t border-slate-200 bg-white/[0.98] p-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/[0.98]">
    {files.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5">
      {files.map((file, index) => <span key={`${file.name}-${file.lastModified}-${index}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"><Paperclip size={12} aria-hidden="true" /><span className="max-w-40 truncate">{file.name}</span><button type="button" disabled={controlsDisabled} aria-label={`Elimină ${file.name}`} onClick={() => updateAttachments(files.filter((_, itemIndex) => itemIndex !== index))}><X size={12} aria-hidden="true" /></button></span>)}
    </div>}
    <div className="rounded-[18px] border border-slate-200 bg-white px-2 py-1.5 shadow-sm focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:focus-within:border-indigo-700 dark:focus-within:ring-indigo-950">
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={controlsDisabled}
        onChange={(event) => onDraftChange(event.target.value)} onPaste={(event) => attachClipboardFiles(event, files, updateAttachments, controlsDisabled)}
        onKeyDown={(event) => submitOnEnter(event, submit)}
        placeholder={composerPlaceholder(steering, stopping, loading, basicRunning)}
        rows={1}
        className="max-h-28 min-h-10 w-full resize-none overflow-y-auto bg-transparent px-1.5 py-2 text-sm leading-5 text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-60 dark:text-slate-100"
        aria-label="Mesaj pentru AI Comenzi" maxLength={4000}
      />
      <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-1.5 dark:border-slate-800">
        <input ref={fileInputRef} type="file" accept={managerAiAttachmentAccept} multiple className="hidden" disabled={controlsDisabled} onChange={(event) => attachInputFiles(event, files, updateAttachments)} />
        <button type="button" disabled={controlsDisabled} onClick={() => fileInputRef.current?.click()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800" aria-label="Atașează fișiere"><Paperclip size={16} aria-hidden="true" /></button>
        <VoiceInput disabled={controlsDisabled} onBusyChange={setVoiceBusy} onTranscript={(text) => onDraftChange([draft.trimEnd(), text].filter(Boolean).join(' ' ))} />
        <ModelSelector model={model} onChange={setModel} disabled={controlsDisabled || running} />
        {advancedControls && <>
          <label className="relative inline-flex items-center">
            <span className="sr-only">Nivel de raționament</span>
            <select disabled={controlsDisabled} value={selectedEffort} onChange={(event) => setEffort(event.target.value as AiReasoningEffort)} className="appearance-none rounded-full border border-slate-200 bg-transparent py-1.5 pl-2.5 pr-7 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              {EFFORTS.filter((option) => supportsNone || option.value !== 'none').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <ChevronDown size={13} className="pointer-events-none absolute right-2 text-slate-400" aria-hidden="true" />
          </label>
        </>}
        <div className="ml-auto flex items-center gap-1.5">
          {running && <button type="button" disabled={runStatus === 'stopping'} onClick={onStop} aria-label="Oprește răspunsul" className={cn('inline-flex h-9 items-center justify-center rounded-full border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800', advancedControls ? 'size-9' : 'gap-1.5 px-3 text-xs font-bold')}><Square size={12} fill="currentColor" aria-hidden="true" />{!advancedControls && <span>Oprește</span>}</button>}
          {(!running || advancedControls) && <button type="button" aria-label={running && advancedControls ? 'Adaugă o instrucțiune' : 'Trimite'} disabled={controlsDisabled || voiceBusy || (!draft.trim() && files.length === 0)} onClick={() => { void submit(); }} className="inline-flex size-9 items-center justify-center rounded-full bg-indigo-600 text-white shadow-sm shadow-indigo-500/25 hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"><Send size={15} aria-hidden="true" /></button>}
        </div>
      </div>
    </div>
    {composerError && <p className="mt-1.5 px-1 text-xs text-red-700 dark:text-red-300" role="alert">{composerError}</p>}
    <p className="mt-1.5 truncate px-1 text-[10px] text-slate-500" title={contextLabel(context)}>{contextLabel(context)}</p>
  </div>;
}


export function AiAssistantPanel({
  canAccess, advancedControls = true, currentContext, messages, conversations = [], conversationId = null,
  hasOlderConversations = false, loadingOlderConversations = false,
  hasOlderMessages = false, loadingOlderMessages = false,
  runStatus, unavailableReason, onSubmit, onStop, onNewConversation, onSelectConversation,
  onLoadOlderConversations, onLoadOlderMessages, onRetryBootstrap, onClose: closePanel, open,
}: AiAssistantPanelProps) {
  const { width, setWidth, startResize, onResizeKeyDown } = useResizablePanel('comenzi_ai_width', DEFAULT_DESKTOP_WIDTH, 380);
  const [drafts, setDrafts] = useState<Record<string, { text: string; files: File[] }>>({});
  const [submittingByConversation, setSubmittingByConversation] = useState<Record<string, boolean>>({});
  const [retrySubmissions, setRetrySubmissions] = useState<Record<string, RetrySubmission | undefined>>({});
  const [modal, setModal] = useState(() => typeof window === 'undefined' || window.innerWidth < 1280);
  useEffect(() => {
    const update = () => setModal(window.innerWidth < 1280);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const panelRef = useDialogFocus<HTMLElement>(closePanel, open && canAccess && modal);

  const autoFollowRef = useRef(true);
  const latestMessageId = messages.at(-1)?.id;
  const latestMessageLength = messages.at(-1)?.text.length ?? 0;
  useEffect(() => { autoFollowRef.current = true; }, [conversationId]);
  useEffect(() => {
    if (!latestMessageId || !open || !autoFollowRef.current) return;
    const node = panelRef.current?.querySelector<HTMLElement>('[data-ai-message-list]');
    if (node && typeof node.scrollTo === 'function') {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    }
  }, [latestMessageId, latestMessageLength, open, panelRef]);

  const draftKey = conversationId ?? '__bootstrap__';
  const currentDraft = drafts[draftKey] ?? { text: '', files: [] };
  const updateDraft = (text: string) => {
    setDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? { text: '', files: [] }), text } }));
    setRetrySubmissions((current) => ({ ...current, [draftKey]: undefined }));
  };
  const updateFiles = (files: File[]) => {
    setDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? { text: '', files: [] }), files } }));
    setRetrySubmissions((current) => ({ ...current, [draftKey]: undefined }));
  };

  const messageList = useMemo(() => messages.filter((message) => message.role !== 'system'), [messages]);
  if (!canAccess) return null;



  return <>
    {open && <div style={{ '--ai-panel-width': `${width}px` } as React.CSSProperties} className="fixed inset-0 z-50 flex justify-end bg-slate-950/20 backdrop-blur-[1px] xl:sticky xl:inset-auto xl:top-0 xl:z-auto xl:h-dvh xl:w-[var(--ai-panel-width)] xl:min-w-0 xl:shrink-0 xl:self-start xl:bg-transparent xl:backdrop-blur-none">
      <button type="button" aria-label="Închide AI Comenzi" className="absolute inset-0 xl:hidden" onClick={closePanel} />
      <aside
        ref={panelRef}
        role={modal ? "dialog" : "complementary"}
        aria-modal={modal || undefined}
        tabIndex={-1}
        aria-label="AI Comenzi"
        style={{ '--ai-panel-width': `${width}px` } as React.CSSProperties}
        className="relative z-10 flex h-dvh w-full flex-col overflow-hidden border-l border-slate-200 bg-slate-50 shadow-2xl dark:border-slate-800 dark:bg-slate-950 sm:max-w-[min(88vw,560px)] xl:w-full xl:max-w-none xl:shrink-0 xl:shadow-none"
      >
        <button type="button" aria-label="Redimensionează panoul AI" onPointerDown={startResize} onKeyDown={onResizeKeyDown} className="absolute inset-y-0 left-0 z-20 hidden w-2 cursor-col-resize touch-none xl:block" />
        <AiPanelHeader
          conversations={conversations}
          conversationId={conversationId}
          hasOlderConversations={hasOlderConversations}
          loadingOlderConversations={loadingOlderConversations}
          runStatus={runStatus}
          onSelectConversation={onSelectConversation}
          onLoadOlderConversations={onLoadOlderConversations}
          onNewConversation={onNewConversation}
          onResetWidth={() => setWidth(DEFAULT_DESKTOP_WIDTH)}
          onClose={closePanel}
        />
        <div
          data-ai-message-list
          className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-slate-50/70 p-3 sm:p-4 dark:bg-slate-950"
          onScroll={(event) => {
            const node = event.currentTarget;
            autoFollowRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          }}
        >
          {hasOlderMessages && onLoadOlderMessages && <div className="mb-3 flex justify-center"><button type="button" disabled={loadingOlderMessages} onClick={onLoadOlderMessages} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 dark:text-indigo-300 dark:hover:bg-indigo-950/40">{loadingOlderMessages ? 'Se încarcă…' : 'Încarcă mesaje mai vechi'}</button></div>}
          {messageList.length === 0 ? <AiEmptyState runtimeUnavailable={runStatus === 'unavailable'} unavailableReason={unavailableReason} onRetry={onRetryBootstrap} /> : <div className="space-y-3.5">{messageList.map((message) => <MessageBubble key={message.id} message={message} />)}</div>}
        </div>
        <Composer
          key={draftKey}
          context={currentContext}
          advancedControls={advancedControls}
          runStatus={runStatus}
          onSubmit={onSubmit}
          onStop={onStop}
          draft={currentDraft.text}
          files={currentDraft.files}
          submitting={Boolean(submittingByConversation[draftKey])}
          retrySubmission={retrySubmissions[draftKey]}
          onDraftChange={updateDraft}
          onFilesChange={updateFiles}
          onSubmittingChange={(value) => setSubmittingByConversation((current) => ({ ...current, [draftKey]: value }))}
          onRetrySubmissionChange={(value) => setRetrySubmissions((current) => ({ ...current, [draftKey]: value }))}
        />
      </aside>
    </div>}
  </>;
}
