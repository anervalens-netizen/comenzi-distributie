import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { useAiApi } from './api-context';
import type { AiConversation } from './types';

/** Conversation metadata survives selection changes, but never session changes. */
export function useAiConversationMetadata(enabled: boolean, setConversations: Dispatch<SetStateAction<AiConversation[]>>) {
  const { listAiConversations } = useAiApi();
  const sessionEpochRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const refreshConversations = useCallback(async (sessionEpoch = sessionEpochRef.current) => {
    if (!enabled || sessionEpochRef.current !== sessionEpoch) return;
    const generation = ++refreshGenerationRef.current;
    const firstPage = await listAiConversations(0, 30);
    if (sessionEpochRef.current !== sessionEpoch || refreshGenerationRef.current !== generation) return;
    setConversations((current) => {
      const fresh = new Set(firstPage.map((item) => item.id));
      return [...firstPage, ...current.filter((item) => !fresh.has(item.id))];
    });
  }, [enabled, listAiConversations, setConversations]);
  return { sessionEpochRef, refreshConversations };
}
