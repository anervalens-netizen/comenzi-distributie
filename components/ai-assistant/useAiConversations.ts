import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { isAiNotConfiguredError, type createAiApi } from './api';
import { useAiApi } from './api-context';
import type { AiChatMessage, AiConversation, AiRunStatus, AiUnavailableReason } from './types';
import { latestSubmission, mergePersisted, runStatusFromProtocol, type MutableRef } from './protocolState';
const CONVERSATION_PAGE_SIZE = 30;
async function loadPage(id: string, { listAiMessages, getAiSubmissionStatus }: ReturnType<typeof createAiApi>) {
  let page = await listAiMessages(id);
  const submission = latestSubmission(page.items);
  const state = submission ? await getAiSubmissionStatus(id, submission) : null;
  const status = runStatusFromProtocol(state);
  if (state?.terminal_message_id && !page.items.some((message) => message.id === state.terminal_message_id)) {
    page = await listAiMessages(id);
  }
  return { ...page, status, submission, items: mergePersisted(page.items, [], status, state) };
}
/**
 * Owns conversation bootstrap/selection. A monotonically increasing selection
 * epoch makes a delayed bootstrap response unable to overwrite a newer owner
 * selection or replace data from an earlier account session.
 */
export function useConversationBootstrap(params: {
  enabled: boolean;
  conversationId: string | null;
  setConversationId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<AiChatMessage[]>>;
  setRunStatus: (status: AiRunStatus) => void;
  setActiveSubmissionId: (id: string | undefined) => void;
  setConversations: Dispatch<SetStateAction<AiConversation[]>>;
  setHasOlderConversations: Dispatch<SetStateAction<boolean>>;
  setHasOlderMessages: Dispatch<SetStateAction<boolean>>;
  setUnavailableReason: Dispatch<SetStateAction<AiUnavailableReason | null>>;
  serverConversationCountRef: MutableRef<number>;
  retryToken: number;
  currentConversationIdRef: MutableRef<string | null>;
}): { initializedRef: MutableRef<boolean>; selectionEpochRef: MutableRef<number> } {
  const {
    enabled,
    conversationId,
    setConversationId,
    setMessages,
    setRunStatus,
    setActiveSubmissionId,
    setConversations,
    setHasOlderConversations,
    setHasOlderMessages,
    setUnavailableReason,
    serverConversationCountRef,
    retryToken,
    currentConversationIdRef,
  } = params;
  const api = useAiApi();
  const { createAiConversation, getAiConversation, listAiConversations } = api;
  const initializedRef = useRef(false);
  const selectionEpochRef = useRef(0);

  const loadConversation = useCallback(async (
    id: string,
    epoch: number,
  ): Promise<AiRunStatus | null> => {
    const page = await loadPage(id, api);
    if (selectionEpochRef.current !== epoch) return null;
    currentConversationIdRef.current = id;
    setConversationId(id);
    setActiveSubmissionId(page.submission);
    setMessages(page.items);
    setHasOlderMessages(page.hasMore);
    return page.status;
  }, [api, currentConversationIdRef, selectionEpochRef, setActiveSubmissionId, setConversationId, setHasOlderMessages, setMessages]);

  useEffect(() => {
    if (!enabled) {
      setRunStatus('unavailable');
      return;
    }
    if (initializedRef.current) return;
    initializedRef.current = true;
    const epoch = selectionEpochRef.current + 1;
    selectionEpochRef.current = epoch;
    let cancelled = false;
    void (async () => {
      try {
        setRunStatus('loading');
        const listed = await listAiConversations(0, CONVERSATION_PAGE_SIZE);
        if (cancelled || selectionEpochRef.current !== epoch) return;
        let preferred = conversationId
          ? listed.find((item) => item.id === conversationId)
          : undefined;
        if (!preferred && conversationId) {
          try {
            preferred = await getAiConversation(conversationId);
          } catch {
            preferred = undefined;
          }
        }
        let active = preferred ?? listed[0];
        let createdDuringBootstrap = false;
        if (!active) {
          active = await createAiConversation('high');
          createdDuringBootstrap = true;
        }
        if (cancelled || selectionEpochRef.current !== epoch) return;
        serverConversationCountRef.current = listed.length + (createdDuringBootstrap ? 1 : 0);
        const visible = preferred && !listed.some((item) => item.id === preferred?.id)
          ? [preferred, ...listed]
          : (listed.length ? listed : [active]);
        setConversations(visible);
        setHasOlderConversations(listed.length === CONVERSATION_PAGE_SIZE);
        const pending = await loadConversation(active.id, epoch);
        if (pending !== null && !cancelled) setRunStatus(pending);
        setUnavailableReason(null);
      } catch (error) {
        if (!cancelled && selectionEpochRef.current === epoch) {
          console.error('AI Comenzi bootstrap failed', error);
          initializedRef.current = false;
          setUnavailableReason(isAiNotConfiguredError(error) ? 'not_configured' : 'runtime_unavailable');
          setRunStatus('unavailable');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, createAiConversation, enabled, getAiConversation, listAiConversations, loadConversation, retryToken, serverConversationCountRef, setConversations, setHasOlderConversations, setRunStatus, setUnavailableReason]);

  return { initializedRef, selectionEpochRef };
}

export function useConversationControls(params: {
  enabled: boolean;
  runStatusRef: MutableRef<AiRunStatus>;
  hasOlderConversations: boolean;
  setConversationId: Dispatch<SetStateAction<string | null>>;
  setConversations: Dispatch<SetStateAction<AiConversation[]>>;
  setHasOlderConversations: Dispatch<SetStateAction<boolean>>;
  setMessages: Dispatch<SetStateAction<AiChatMessage[]>>;
  setRunStatus: (status: AiRunStatus) => void;
  setActiveSubmissionId: (id: string | undefined) => void;
  setHasOlderMessages: Dispatch<SetStateAction<boolean>>;
  initializedRef: MutableRef<boolean>;
  selectionEpochRef: MutableRef<number>;
  serverConversationCountRef: MutableRef<number>;
  streamAbortRef: MutableRef<AbortController | null>;
  currentConversationIdRef: MutableRef<string | null>;
}) {
  const {
    enabled, runStatusRef, hasOlderConversations,
    setConversationId, setConversations, setHasOlderConversations, setMessages,
    setRunStatus, setActiveSubmissionId, setHasOlderMessages, initializedRef, selectionEpochRef,
    serverConversationCountRef, streamAbortRef, currentConversationIdRef,
  } = params;
  const api = useAiApi();
  const { createAiConversation, listAiConversations } = api;
  const [loadingOlderConversations, setLoadingOlderConversations] = useState(false);

  const newConversation = useCallback(async () => {
    if (!enabled || runStatusRef.current !== 'idle') return;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    const epoch = selectionEpochRef.current + 1;
    selectionEpochRef.current = epoch;
    setRunStatus('loading');
    try {
      const created = await createAiConversation('high');
      if (selectionEpochRef.current !== epoch) return;
      serverConversationCountRef.current += 1;
      currentConversationIdRef.current = created.id;
      setConversationId(created.id);
      setConversations((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setActiveSubmissionId(undefined);
      setMessages([]);
      setHasOlderMessages(false);
      setRunStatus('idle');
      initializedRef.current = true;
    } catch (error) {
      if (selectionEpochRef.current !== epoch) return;
      console.error('AI Comenzi conversation creation failed', error);
      setRunStatus(currentConversationIdRef.current ? 'idle' : 'unavailable');
    }
  }, [createAiConversation, currentConversationIdRef, enabled, initializedRef, runStatusRef, selectionEpochRef, serverConversationCountRef, setActiveSubmissionId, setConversationId, setConversations, setHasOlderMessages, setMessages, setRunStatus, streamAbortRef]);

  const selectConversation = useCallback(async (id: string) => {
    if (!enabled || id === currentConversationIdRef.current || runStatusRef.current !== 'idle') return;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    const epoch = selectionEpochRef.current + 1;
    selectionEpochRef.current = epoch;
    setRunStatus('loading');
    try {
      const page = await loadPage(id, api);
      if (selectionEpochRef.current !== epoch) return;
      currentConversationIdRef.current = id;
      setConversationId(id);
      setActiveSubmissionId(page.submission);
      setMessages(page.items);
      setHasOlderMessages(page.hasMore);
      setRunStatus(page.status);
      initializedRef.current = true;
    } catch (error) {
      if (selectionEpochRef.current !== epoch) return;
      console.error('AI Comenzi conversation selection failed', error);
      setRunStatus('idle');
    }
  }, [api, currentConversationIdRef, enabled, initializedRef, runStatusRef, selectionEpochRef, setActiveSubmissionId, setConversationId, setHasOlderMessages, setMessages, setRunStatus, streamAbortRef]);

  const loadOlderConversations = useCallback(async () => {
    if (!enabled || loadingOlderConversations || !hasOlderConversations) return;
    if (runStatusRef.current !== 'idle') return;
    const epoch = selectionEpochRef.current;
    setLoadingOlderConversations(true);
    try {
      const offset = serverConversationCountRef.current;
      const page = await listAiConversations(offset, CONVERSATION_PAGE_SIZE);
      if (selectionEpochRef.current !== epoch) return;
      serverConversationCountRef.current = Math.max(
        serverConversationCountRef.current, offset + page.length,
      );
      setConversations((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.filter((item) => !known.has(item.id))];
      });
      setHasOlderConversations(page.length === CONVERSATION_PAGE_SIZE);
    } catch (error) {
      console.error('AI Comenzi older conversations failed', error);
    } finally {
      setLoadingOlderConversations(false);
    }
  }, [enabled, hasOlderConversations, listAiConversations, loadingOlderConversations, runStatusRef, selectionEpochRef, serverConversationCountRef, setConversations, setHasOlderConversations]);

  return { loadingOlderConversations, newConversation, selectConversation, loadOlderConversations };
}
