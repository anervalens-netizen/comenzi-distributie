import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { useAiApi } from './api-context';
import type { AiChatMessage } from './types';
import type { MutableRef } from './protocolState';
export function useAiMessagePaging(conversationId: string | null, messages: AiChatMessage[], hasOlderMessages: boolean,
  selectionEpochRef: MutableRef<number>, setMessages: Dispatch<SetStateAction<AiChatMessage[]>>,
  setHasOlderMessages: Dispatch<SetStateAction<boolean>>) {
  const { listAiMessages } = useAiApi();
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const loadOlderMessages = useCallback(async () => {
    if (!conversationId || loadingOlderMessages || !hasOlderMessages) return;
    const oldest = messages.find((item) => item.ordinal !== undefined)?.ordinal;
    if (!oldest) return;
    const epoch = selectionEpochRef.current;
    setLoadingOlderMessages(true);
    try {
      const page = await listAiMessages(conversationId, oldest);
      if (selectionEpochRef.current !== epoch) return;
      setMessages((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...page.items.filter((item) => !known.has(item.id)), ...current];
      });
      setHasOlderMessages(page.hasMore);
    } catch {
      // The previous page stays visible and can be retried.
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [conversationId, hasOlderMessages, listAiMessages, loadingOlderMessages, messages, selectionEpochRef, setHasOlderMessages, setMessages]);

  return { loadingOlderMessages, loadOlderMessages };
}
