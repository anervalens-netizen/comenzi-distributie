import { useCallback, useEffect, useRef, useState } from 'react';
import { useAiConversationMetadata } from './useAiConversationMetadata';
import { useAiMessagePaging } from './useAiMessagePaging';
import { usePersistentState, type PersistentStateOptions } from './usePersistentState';
import type { AiChatMessage, AiComposerSubmission, AiConversation, AiRunStatus, AiUnavailableReason, AiSubmissionResult } from './types';
import { createSubmissionId, type StopOutcomeState } from './protocolState';
import { useConversationBootstrap, useConversationControls } from './useAiConversations';
import { useSubmissionActions, useStreamEvents } from './useAiSubmissions';
import { usePendingRunReconciliation, useStopAction } from './useAiRecovery';
const conversationPersistence: PersistentStateOptions<string | null> = {
  serialize: (value) => JSON.stringify(value),
  deserialize: (raw, fallback) => {
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === 'string' || value === null ? value : fallback;
    } catch {
      // Older versions stored conversation IDs without JSON encoding.
      return raw || fallback;
    }
  },
};

export function useAiAssistant(enabled: boolean, storageKey: string) {
  const [conversationId, setConversationId] = usePersistentState<string | null>(storageKey, null, conversationPersistence);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [hasOlderConversations, setHasOlderConversations] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [bootstrapRetryToken, setBootstrapRetryToken] = useState(0);
  const [runStatus, setRunStatus] = useState<AiRunStatus>(enabled ? 'loading' : 'unavailable');
  const [unavailableReason, setUnavailableReason] = useState<AiUnavailableReason | null>(null);
  const serverConversationCountRef = useRef(0);
  const { sessionEpochRef, refreshConversations } = useAiConversationMetadata(enabled, setConversations);
  const { initializedRef, selectionEpochRef } = useConversationBootstrap({
    enabled,
    conversationId,
    setConversationId,
    setMessages,
    setRunStatus,
    setConversations,
    setHasOlderConversations,
    setHasOlderMessages,
    setUnavailableReason,
    serverConversationCountRef,
    retryToken: bootstrapRetryToken,
  });
  const streamAbortRef = useRef<AbortController | null>(null);
  const currentConversationIdRef = useRef<string | null>(conversationId);
  const stopOutcomesRef = useRef<Map<string, StopOutcomeState>>(new Map());
  const pendingSubmissions = useRef<Map<string, string>>(new Map());
  const handleStreamEvent = useStreamEvents(setMessages, setRunStatus);

  usePendingRunReconciliation({
    enabled, conversationId, runStatus, streamAbortRef, selectionEpochRef,
    setMessages, setHasOlderMessages, setRunStatus, refreshConversations, pendingSubmissions,
  });

  useEffect(() => { currentConversationIdRef.current = conversationId; }, [conversationId]);

  useEffect(() => {
    if (enabled) return;
    sessionEpochRef.current += 1;
    selectionEpochRef.current += 1;
    initializedRef.current = false;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }, [enabled, initializedRef, selectionEpochRef, sessionEpochRef]);

  useEffect(() => () => {
    sessionEpochRef.current += 1;
    selectionEpochRef.current += 1;
    streamAbortRef.current?.abort();
  }, [selectionEpochRef, sessionEpochRef]);

  const { submitSteer, submitTurn } = useSubmissionActions({
    setMessages, setRunStatus, streamAbortRef, selectionEpochRef, sessionEpochRef,
    handleStreamEvent, refreshConversations,
  });

  /**
   * Steer is accepted only while the run is genuinely `running`. Once Stop has
   * moved the state to `stopping` the runtime rejects every control request, so
   * submitting would persist a durable user instruction that can never be
   * processed. The submission is dropped, never queued for a later run.
   */
  const submit = useCallback(async (submission: AiComposerSubmission): Promise<AiSubmissionResult> => {
    if (!enabled || !conversationId) return { outcome: 'rejected' };
    if (submission.mode === 'steer') {
      if (runStatus !== 'running') return { outcome: 'rejected' };
      submission.submissionId ??= createSubmissionId();
      return await submitSteer(conversationId, submission);
    }
    if (runStatus !== 'idle') return { outcome: 'rejected' };
    submission.submissionId ??= createSubmissionId();
    pendingSubmissions.current.set(conversationId, submission.submissionId);
    // Keep the ID until durable reconciliation, including transport loss.
    const result = await submitTurn(conversationId, submission);
    if ((result.outcome === 'rejected' || result.outcome === 'conflict')
      && pendingSubmissions.current.get(conversationId) === submission.submissionId) {
      pendingSubmissions.current.delete(conversationId);
    }
    return result;
  }, [conversationId, enabled, runStatus, submitSteer, submitTurn]);

  const stop = useStopAction(conversationId, messages, pendingSubmissions, runStatus, setRunStatus, currentConversationIdRef, stopOutcomesRef, selectionEpochRef);

  const {
    loadingOlderConversations, newConversation, selectConversation, loadOlderConversations,
  } = useConversationControls({
    enabled, conversationId, runStatus, hasOlderConversations,
    setConversationId, setConversations, setHasOlderConversations, setMessages, setRunStatus,
    setHasOlderMessages, initializedRef, selectionEpochRef, serverConversationCountRef,
    streamAbortRef, currentConversationIdRef, stopOutcomesRef,
  });

  const { loadingOlderMessages, loadOlderMessages } = useAiMessagePaging(conversationId, messages, hasOlderMessages, selectionEpochRef, setMessages, setHasOlderMessages);

  const retryBootstrap = useCallback(() => {
    if (!enabled || runStatus !== 'unavailable') return;
    initializedRef.current = false;
    setRunStatus('loading');
    setBootstrapRetryToken((current) => current + 1);
  }, [enabled, initializedRef, runStatus]);

  return {
    conversations, conversationId, hasOlderConversations, loadingOlderConversations,
    hasOlderMessages, loadingOlderMessages, messages, runStatus,
    unavailableReason,
    submit, stop, newConversation, selectConversation,
    loadOlderConversations, loadOlderMessages, retryBootstrap,
  };
}
