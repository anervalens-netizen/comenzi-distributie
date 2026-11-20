'use client';

import { useMemo } from 'react';
import { AiAssistantPanel } from './ai-assistant/AiAssistantPanel';
import { createAiApi } from './ai-assistant/api';
import { AiApiContext } from './ai-assistant/api-context';
import { useAiAssistant } from './ai-assistant/useAiAssistant';

type ManagerAiProps = {
  open: boolean;
  onClose: () => void;
  ownerId: string;
  scopeQuery: string;
  scopeLabel: string;
  currentSection: string;
  period: string;
};

function ManagerAiConversation({ open, onClose, ownerId, scopeQuery, scopeLabel, currentSection, period }: ManagerAiProps) {
  const chat = useAiAssistant(true, `comenzi_ai_conversation:${ownerId}:${scopeQuery}`);

  return <AiAssistantPanel
    canAccess
    open={open}
    onClose={onClose}
    currentContext={{ tab: currentSection, period, scopeLabel }}
    messages={chat.messages}
    conversations={chat.conversations}
    conversationId={chat.conversationId}
    hasOlderConversations={chat.hasOlderConversations}
    loadingOlderConversations={chat.loadingOlderConversations}
    hasOlderMessages={chat.hasOlderMessages}
    loadingOlderMessages={chat.loadingOlderMessages}
    runStatus={chat.runStatus}
    unavailableReason={chat.unavailableReason}
    onSubmit={chat.submit}
    onStop={chat.stop}
    onNewConversation={chat.newConversation}
    onSelectConversation={chat.selectConversation}
    onLoadOlderConversations={chat.loadOlderConversations}
    onLoadOlderMessages={chat.loadOlderMessages}
    onRetryBootstrap={chat.retryBootstrap}
  />;
}

export function ManagerAi(props: ManagerAiProps) {
  const { ownerId, scopeQuery } = props;
  const api = useMemo(() => createAiApi(scopeQuery, ownerId), [scopeQuery, ownerId]);

  return <AiApiContext.Provider value={api}>
    <ManagerAiConversation key={`${ownerId}:${scopeQuery}`} {...props} />
  </AiApiContext.Provider>;
}
