import { ArrowLeft, ChevronDown, History, Maximize2, MessageSquarePlus } from 'lucide-react';

import { AiHaloOrb } from './AiHaloOrb';
import type { AiConversation, AiRunStatus } from './types';

interface AiPanelHeaderProps {
  conversations: AiConversation[];
  conversationId: string | null;
  hasOlderConversations: boolean;
  loadingOlderConversations: boolean;
  runStatus: AiRunStatus;
  onSelectConversation?: (id: string) => void;
  onLoadOlderConversations?: () => void;
  onNewConversation?: () => void;
  onResetWidth: () => void;
  onClose: () => void;
}

export function AiPanelHeader({
  conversations, conversationId, hasOlderConversations, loadingOlderConversations,
  runStatus, onSelectConversation, onLoadOlderConversations, onNewConversation,
  onResetWidth, onClose,
}: AiPanelHeaderProps) {
  return <header className="shrink-0 border-b border-slate-200/80 bg-white/95 px-3 py-2 backdrop-blur-xl dark:border-slate-800/80 dark:bg-slate-950/95">
    <div className="flex min-h-9 items-center gap-2.5">
      <AiHaloOrb
        size="xs"
        state={runStatus === 'unavailable' ? 'unavailable' : runStatus === 'running' || runStatus === 'stopping' ? 'running' : 'idle'}
        className="size-7"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-bold text-slate-900 dark:text-white">AI Comenzi</div>
        <div className="truncate text-[10px] font-medium text-slate-400">Analizează · Explică · Răspunde</div>
      </div>
      <button
        type="button"
        onClick={onResetWidth}
        className="hidden size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 xl:inline-flex"
        aria-label="Resetează lățimea panoului"
      >
        <Maximize2 size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-2.5 text-xs font-bold text-indigo-700 transition hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200 dark:hover:bg-indigo-950"
        aria-label="Închide AI Comenzi"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Înapoi</span>
      </button>
    </div>

    <div className="mt-2 flex min-w-0 items-center gap-2">
      {onSelectConversation && conversations.length > 0 ? <label className="relative min-w-0 flex-1">
        <span className="sr-only">Selectează sesiunea AI</span>
        <select
          aria-label="Selectează sesiunea AI"
          value={conversationId ?? ''}
          disabled={runStatus === 'loading' || runStatus === 'unavailable'}
          onChange={(event) => onSelectConversation(event.target.value)}
          className="block h-11 w-full appearance-none truncate rounded-xl border border-slate-200 bg-slate-50 py-1.5 pl-3 pr-7 text-xs font-semibold text-slate-700 outline-none transition hover:border-indigo-200 hover:bg-white focus:ring-2 focus:ring-indigo-100 disabled:opacity-50 sm:h-9 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
        </select>
        <ChevronDown size={13} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      </label> : <div className="min-w-0 flex-1 truncate rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">Sesiunea curentă</div>}

      {onNewConversation && <button
        type="button"
        disabled={runStatus === 'loading' || runStatus === 'unavailable'}
        onClick={onNewConversation}
        className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 text-xs font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-40 sm:h-9"
        aria-label="Sesiune nouă"
      >
        <MessageSquarePlus size={15} aria-hidden="true" />
        <span>Sesiune nouă</span>
      </button>}

      {hasOlderConversations && onLoadOlderConversations && <button
        type="button"
        aria-label="Încarcă sesiuni mai vechi"
        title="Încarcă sesiuni mai vechi"
        aria-busy={loadingOlderConversations || undefined}
        disabled={loadingOlderConversations || runStatus === 'running' || runStatus === 'stopping'}
        onClick={onLoadOlderConversations}
        className="inline-flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-slate-200 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 sm:h-9 sm:w-auto sm:px-2.5 dark:border-slate-700 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
      >
        <History size={15} aria-hidden="true" />
        <span className="hidden sm:inline">{loadingOlderConversations ? 'Se încarcă…' : 'Mai vechi'}</span>
      </button>}
    </div>
  </header>;
}
