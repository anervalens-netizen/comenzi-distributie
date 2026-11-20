import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import { useAiApi } from './api-context';
import type { AiChatMessage, AiRunStatus } from './types';
import { captureRunGuard, createSubmissionId, delay, isActiveRun, mergePersisted, runStatusFromProtocol, type MutableRef } from './protocolState';

type Setter<T> = Dispatch<SetStateAction<T>>;
type RunControls = {
  conversationId: string | null;
  submissionId?: string;
  runStatusRef: MutableRef<AiRunStatus>;
  runGenerationRef: MutableRef<number>;
  selectionEpochRef: MutableRef<number>;
  setRunStatus: (status: AiRunStatus) => void;
};

export function usePendingRunReconciliation(params: RunControls & {
  enabled: boolean; active: boolean;
  streamAbortRef: MutableRef<AbortController | null>;
  setMessages: Setter<AiChatMessage[]>; setHasOlderMessages: Setter<boolean>;
  refreshConversations: () => Promise<void>; activeSubmissionIdRef: MutableRef<string | undefined>;
}) {
  const { enabled, active, conversationId, submissionId, runStatusRef, streamAbortRef,
    selectionEpochRef, runGenerationRef, setMessages, setHasOlderMessages, setRunStatus,
    refreshConversations, activeSubmissionIdRef } = params;
  const { getAiSubmissionStatus, listAiMessages } = useAiApi();
  useEffect(() => {
    if (!enabled || !active || !conversationId || !submissionId) return;
    const isCurrent = captureRunGuard(selectionEpochRef, runGenerationRef);
    let cancelled = false;
    let syncedDetachedRun = false;
    let detachedUnseenCount = 0;
    const valid = () => !cancelled && isCurrent() && isActiveRun(runStatusRef.current)
      && activeSubmissionIdRef.current === submissionId;
    void (async () => {
      while (valid()) {
        await delay(2_000);
        if (!valid()) return;
        try {
          const state = await getAiSubmissionStatus(conversationId, submissionId);
          if (!valid()) return;
          if (state.state === 'unknown') continue;
          if (state.state === 'unseen') {
            // A detached request may not have reached the server. Allow the same ID to be retried
            // after two durable misses, while an open upload continues to own admission.
            if (streamAbortRef.current || ++detachedUnseenCount < 2) continue;
            setRunStatus('idle');
            return;
          }
          detachedUnseenCount = 0;
          const status = runStatusFromProtocol(state);
          const terminal = status === 'idle';
          // An active stream supplies message content. The recovery loop only checks status
          // until delivery is lost or a durable terminal state needs to be shown.
          if (!terminal && (streamAbortRef.current || syncedDetachedRun)) continue;
          const page = await listAiMessages(conversationId);
          if (!valid()) return;
          if (!terminal && streamAbortRef.current) continue;
          const reconciled = terminal || runStatusRef.current !== 'stopping' ? status : 'stopping';
          setMessages((current) => mergePersisted(page.items, current, reconciled, state));
          setHasOlderMessages(page.hasMore);
          if (terminal) {
            const delivery = streamAbortRef.current;
            streamAbortRef.current = null;
            delivery?.abort();
          }
          setRunStatus(reconciled);
          if (terminal) {
            void refreshConversations().catch(() => undefined);
            return;
          }
          syncedDetachedRun = true;
        } catch { /* A read failure does not fabricate a terminal outcome. */ }
      }
    })();
    return () => { cancelled = true; };
  }, [active, activeSubmissionIdRef, conversationId, enabled, getAiSubmissionStatus, listAiMessages,
    refreshConversations, runGenerationRef, runStatusRef, selectionEpochRef, setHasOlderMessages,
    setMessages, setRunStatus, streamAbortRef, submissionId]);
}

export function useStopAction({
  conversationId, submissionId, runStatusRef, setRunStatus, selectionEpochRef, runGenerationRef,
}: RunControls) {
  const { getAiSubmissionStatus, stopAiTurn } = useAiApi();
  return useCallback(async () => {
    const waitingForStop = () => runStatusRef.current === 'stopping';
    if (!conversationId || !submissionId || runStatusRef.current !== 'running') return;
    const isCurrent = captureRunGuard(selectionEpochRef, runGenerationRef);
    setRunStatus('stopping');
    try {
      await stopAiTurn(conversationId, submissionId, createSubmissionId());
    } catch {
      // Stop may have committed before its ACK was lost. The terminal recovery path
      // reads the stored answer; only an active or not-yet-admitted run re-enables Stop.
      try {
        const state = await getAiSubmissionStatus(conversationId, submissionId);
        if (isCurrent() && waitingForStop()
          && (runStatusFromProtocol(state) === 'running' || state.state === 'unseen')) setRunStatus('running');
      } catch { /* Keep the existing execution state while the active run is polled. */ }
    }
  }, [conversationId, getAiSubmissionStatus, runGenerationRef, runStatusRef, selectionEpochRef, setRunStatus, stopAiTurn, submissionId]);
}
