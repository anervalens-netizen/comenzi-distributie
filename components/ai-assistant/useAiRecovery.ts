import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import { useAiApi } from './api-context';
import type { AiChatMessage, AiRunStatus } from './types';
import { createSubmissionId, delay, latestSubmission, mergePersisted, runStatusFromProtocol, type MutableRef, type StopOutcomeState } from './protocolState';

type Setter<T> = Dispatch<SetStateAction<T>>;
export function usePendingRunReconciliation(params: {
  enabled: boolean; conversationId: string | null; runStatus: AiRunStatus;
  streamAbortRef: MutableRef<AbortController | null>; selectionEpochRef: MutableRef<number>;
  setMessages: Setter<AiChatMessage[]>; setHasOlderMessages: Setter<boolean>; setRunStatus: Setter<AiRunStatus>;
  refreshConversations: () => Promise<void>; pendingSubmissions: MutableRef<Map<string, string>>;
}) {
  const { enabled, conversationId, runStatus, streamAbortRef, selectionEpochRef,
    setMessages, setHasOlderMessages, setRunStatus, refreshConversations, pendingSubmissions } = params;
  const { getAiSubmissionStatus, listAiMessages } = useAiApi();
  useEffect(() => {
    if (!enabled || !conversationId || runStatus === 'loading' || runStatus === 'unavailable') return;
    const epoch = selectionEpochRef.current;
    let cancelled = false;
    const valid = () => !cancelled && selectionEpochRef.current === epoch;
    void (async () => {
      while (valid()) {
        await delay(2_000);
        if (!valid()) return;
        try {
          let page = await listAiMessages(conversationId);
          const id = pendingSubmissions.current.get(conversationId) ?? latestSubmission(page.items);
          if (!id) return;
          const state = await getAiSubmissionStatus(conversationId, id);
          if (!valid()) return;
          if (state.state === 'unseen' && !pendingSubmissions.current.has(conversationId)) return;
          const status = runStatusFromProtocol(state);
          const terminal = status === 'idle' && !['unknown', 'unseen'].includes(state.state);
          // Reconcile durable completion even if the delivery connection never closes.
          // Preserve live deltas until the server confirms a terminal state.
          if (streamAbortRef.current && !terminal) continue;
          if (terminal) { streamAbortRef.current?.abort(); streamAbortRef.current = null; }
          if (status === 'idle' && !['unknown', 'unseen'].includes(state.state)) page = await listAiMessages(conversationId);
          if (!valid()) return;
          setMessages((current) => mergePersisted(page.items, current, status, state));
          setHasOlderMessages(page.hasMore);
          setRunStatus(status);
          if (!['unknown', 'unseen'].includes(state.state) && status === 'idle') {
            pendingSubmissions.current.delete(conversationId);
            await refreshConversations().catch(() => undefined);
            return;
          }
        } catch { /* A read failure does not fabricate a terminal outcome. */ }
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId, enabled, getAiSubmissionStatus, listAiMessages, pendingSubmissions, refreshConversations, runStatus, selectionEpochRef, setHasOlderMessages, setMessages, setRunStatus, streamAbortRef]);
}

export function useStopAction(
  conversationId: string | null, messages: AiChatMessage[], pendingSubmissions: MutableRef<Map<string, string>>,
  runStatus: AiRunStatus, setRunStatus: Setter<AiRunStatus>, currentConversationIdRef: MutableRef<string | null>,
  stopOutcomesRef: MutableRef<Map<string, StopOutcomeState>>, selectionEpochRef: MutableRef<number>,
) {
  const { getAiSubmissionStatus, stopAiTurn } = useAiApi();
  return useCallback(async () => {
    if (!conversationId || runStatus !== 'running') return;
    const id = pendingSubmissions.current.get(conversationId) ?? latestSubmission(messages);
    if (!id) return;
    const epoch = selectionEpochRef.current;
    const generation = (stopOutcomesRef.current.get(conversationId)?.generation ?? 0) + 1;
    stopOutcomesRef.current.set(conversationId, { generation, outcome: 'pending' });
    setRunStatus('stopping');
    try {
      await stopAiTurn(conversationId, id, createSubmissionId());
      if (stopOutcomesRef.current.get(conversationId)?.generation === generation) {
        stopOutcomesRef.current.set(conversationId, { generation, outcome: 'accepted' });
      }
    } catch {
      // Stop may have committed before its ACK was lost. Query before restoring controls.
      try {
        const state = await getAiSubmissionStatus(conversationId, id);
        if (stopOutcomesRef.current.get(conversationId)?.generation !== generation) return;
        const status = runStatusFromProtocol(state);
        stopOutcomesRef.current.set(conversationId, { generation, outcome: status === 'stopping' ? 'accepted' : 'failed' });
        if (selectionEpochRef.current === epoch && currentConversationIdRef.current === conversationId) setRunStatus((current) => current === 'stopping' ? status : current);
      } catch { /* Remain stopping until durable reconciliation becomes available. */ }
    }
  }, [conversationId, currentConversationIdRef, getAiSubmissionStatus, messages, pendingSubmissions, runStatus, setRunStatus, stopOutcomesRef, selectionEpochRef, stopAiTurn]);
}
