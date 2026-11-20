import { useCallback, useEffect, useRef, useState } from 'react';
import { useAiConversationMetadata } from './useAiConversationMetadata';
import { useAiMessagePaging } from './useAiMessagePaging';
import { usePersistentState, type PersistentStateOptions } from './usePersistentState';
import type { AiChatMessage, AiComposerSubmission, AiConversation, AiRunStatus, AiUnavailableReason, AiSubmissionResult } from './types';
import { createSubmissionId, isActiveRun } from './protocolState';
import { useConversationBootstrap, useConversationControls } from './useAiConversations';
import { useSubmissionActions } from './useAiSubmissions';
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
  const [activeSubmissionId, writeActiveSubmissionId] = useState<string>();
  const activeSubmissionIdRef = useRef<string | undefined>(undefined);
  const setActiveSubmissionId = useCallback((id: string | undefined) => {
    activeSubmissionIdRef.current = id;
    writeActiveSubmissionId(id);
  }, []);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [hasOlderConversations, setHasOlderConversations] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [bootstrapRetryToken, setBootstrapRetryToken] = useState(0);
  const [runStatus, writeRunStatus] = useState<AiRunStatus>(enabled ? 'loading' : 'unavailable');
  const runStatusRef = useRef(runStatus);
  const setRunStatus = useCallback((status: AiRunStatus) => {
    runStatusRef.current = status;
    writeRunStatus(status);
  }, []);
  const [unavailableReason, setUnavailableReason] = useState<AiUnavailableReason | null>(null);
  const serverConversationCountRef = useRef(0);
  const currentConversationIdRef = useRef<string | null>(conversationId);
  const runGenerationRef = useRef(0);
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
    currentConversationIdRef,
    setActiveSubmissionId,
  });
  const streamAbortRef = useRef<AbortController | null>(null);
  const runControls = {
    conversationId, submissionId: activeSubmissionId, runStatusRef, setRunStatus,
    selectionEpochRef, runGenerationRef,
  };

  usePendingRunReconciliation({
    ...runControls, enabled, active: isActiveRun(runStatus), streamAbortRef,
    setMessages, setHasOlderMessages, refreshConversations, activeSubmissionIdRef,
  });

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
    setMessages, setRunStatus, streamAbortRef, selectionEpochRef, runGenerationRef,
    refreshConversations,
  });

  const submit = useCallback(async (submission: AiComposerSubmission): Promise<AiSubmissionResult> => {
    const id = currentConversationIdRef.current;
    if (!enabled || !id) return { outcome: 'rejected' };
    if (submission.mode === 'steer') {
      if (runStatusRef.current !== 'running') return { outcome: 'rejected' };
      submission.submissionId ??= createSubmissionId();
      return submitSteer(id, submission);
    }
    if (runStatusRef.current !== 'idle') return { outcome: 'rejected' };
    submission.submissionId ??= createSubmissionId();
    // Claim the new generation before registering a delivery or releasing the old one.
    runGenerationRef.current += 1;
    setActiveSubmissionId(submission.submissionId);
    setRunStatus('running');
    return submitTurn(id, submission);
  }, [enabled, setActiveSubmissionId, setRunStatus, submitSteer, submitTurn]);

  const stop = useStopAction(runControls);

  const {
    loadingOlderConversations, newConversation, selectConversation, loadOlderConversations,
  } = useConversationControls({
    enabled, runStatusRef, hasOlderConversations,
    setConversationId, setConversations, setHasOlderConversations, setMessages, setRunStatus,
    setHasOlderMessages, initializedRef, selectionEpochRef, serverConversationCountRef,
    streamAbortRef, currentConversationIdRef, setActiveSubmissionId,
  });

  const { loadingOlderMessages, loadOlderMessages } = useAiMessagePaging(conversationId, messages, hasOlderMessages, selectionEpochRef, setMessages, setHasOlderMessages);

  const retryBootstrap = useCallback(() => {
    if (!enabled || runStatusRef.current !== 'unavailable') return;
    initializedRef.current = false;
    setRunStatus('loading');
    setBootstrapRetryToken((current) => current + 1);
  }, [enabled, initializedRef, setRunStatus]);

  return {
    conversations, conversationId, hasOlderConversations, loadingOlderConversations,
    hasOlderMessages, loadingOlderMessages, messages, runStatus,
    unavailableReason,
    submit, stop, newConversation, selectConversation,
    loadOlderConversations, loadOlderMessages, retryBootstrap,
  };
}
