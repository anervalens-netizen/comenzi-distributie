import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { ApiError } from '@/lib/client-api';
import { consumeAiStream, type AiStreamEvent } from './api';
import { useAiApi } from './api-context';
import type { AiChatMessage, AiComposerSubmission, AiRunStatus, AiSubmissionResult } from './types';
import { mergePersisted, runStatusFromProtocol, streamingMessage, STREAMING_MESSAGE_ID, submissionResult, type MutableRef } from './protocolState';

type Params = {
  setMessages: Dispatch<SetStateAction<AiChatMessage[]>>;
  setRunStatus: Dispatch<SetStateAction<AiRunStatus>>;
  streamAbortRef: MutableRef<AbortController | null>;
  selectionEpochRef: MutableRef<number>;
  sessionEpochRef: MutableRef<number>;
  handleStreamEvent: (event: AiStreamEvent) => void;
  refreshConversations: (sessionEpoch?: number) => Promise<void>;
};

export function useStreamEvents(setMessages: Params['setMessages'], setRunStatus: Params['setRunStatus']) {
  return useCallback((event: AiStreamEvent) => {
    if (event.type === 'submission_status') {
      setRunStatus(runStatusFromProtocol(event.status));
    } else if (event.type === 'user_message') {
      setMessages((current) => [...current.filter((m) => m.id !== event.message.id && m.id !== STREAMING_MESSAGE_ID), event.message, streamingMessage()]);
    } else if (event.type === 'status') {
      setMessages((current) => current.map((m) => m.id === STREAMING_MESSAGE_ID ? { ...m, activity: event.message } : m));
    } else if (event.type === 'reset') {
      setMessages((current) => [...current.filter((m) => m.id !== STREAMING_MESSAGE_ID), streamingMessage()]);
    } else if (event.type === 'delta') {
      setMessages((current) => current.map((m) => m.id === STREAMING_MESSAGE_ID ? { ...m, text: m.text + event.text, activity: 'Redactez răspunsul…' } : m));
    } else if (event.type === 'complete') {
      setMessages((current) => [...current.filter((m) => m.id !== STREAMING_MESSAGE_ID && m.id !== event.message.id), event.message]);
      setRunStatus('idle');
    }
    // Error/stopped are reconciled from the server before changing execution state.
  }, [setMessages, setRunStatus]);
}

function definiteError(error: unknown): AiSubmissionResult | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409) {
    const body = error.data as { code?: string; detail?: { code?: string } } | null;
    return { outcome: 'conflict', code: body?.detail?.code ?? body?.code ?? 'submission_conflict' };
  }
  return [400, 401, 403, 404, 413, 422].includes(error.status) ? { outcome: 'rejected', message: error.message } : null;
}

export function useSubmissionActions(params: Params) {
  const { getAiSubmissionStatus, listAiMessages, openAiTurnStream, steerAiTurn } = useAiApi();
  const { setMessages, setRunStatus, selectionEpochRef, sessionEpochRef, streamAbortRef, handleStreamEvent, refreshConversations } = params;
  const reconcile = useCallback(async (id: string, submissionId: string, epoch: number, sessionEpoch: number): Promise<AiSubmissionResult> => {
    try {
      const state = await getAiSubmissionStatus(id, submissionId);
      const result = submissionResult(state);
      if (selectionEpochRef.current === epoch) {
        const status = runStatusFromProtocol(state);
        // Delivery loss is not a reason to mark a known stopping run as running.
        setRunStatus(status);
        try {
          const page = await listAiMessages(id);
          if (selectionEpochRef.current === epoch) setMessages((current) => mergePersisted(page.items, current, status, state));
        } catch { /* A message read cannot retract known admission. */ }
      }
      if (result.outcome !== 'unknown') await refreshConversations(sessionEpoch).catch(() => undefined);
      return result;
    } catch {
      if (selectionEpochRef.current === epoch) setRunStatus((status) => status === 'stopping' ? status : 'idle');
      return { outcome: 'unknown' };
    }
  }, [getAiSubmissionStatus, listAiMessages, refreshConversations, selectionEpochRef, setMessages, setRunStatus]);

  const submitSteer = useCallback(async (id: string, submission: AiComposerSubmission): Promise<AiSubmissionResult> => {
    const epoch = selectionEpochRef.current;
    const sessionEpoch = sessionEpochRef.current;
    try {
      await steerAiTurn(id, submission);
    } catch (error) {
      const definite = definiteError(error);
      if (definite) return definite;
    }
    return reconcile(id, submission.submissionId!, epoch, sessionEpoch);
  }, [reconcile, selectionEpochRef, sessionEpochRef, steerAiTurn]);

  async function submitTurn(id: string, submission: AiComposerSubmission): Promise<AiSubmissionResult> {
    const epoch = selectionEpochRef.current;
    const sessionEpoch = sessionEpochRef.current;
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setRunStatus('running');
    let response: Response;
    try {
      response = await openAiTurnStream(id, submission, controller.signal);
    } catch (error) {
      try {
        const definite = definiteError(error);
        if (definite) {
          if (selectionEpochRef.current === epoch) setRunStatus('idle');
          return definite;
        }
        return await reconcile(id, submission.submissionId!, epoch, sessionEpoch);
      } finally {
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
      }
    }
    // The composer resolves on durable admission/progress, while delivery continues.
    return new Promise<AiSubmissionResult>((resolve) => {
      let settled = false;
      const settle = (result: AiSubmissionResult) => {
        if (!settled) { settled = true; resolve(result); }
      };
      void (async () => {
        try {
          await consumeAiStream(response, (event) => {
            if (selectionEpochRef.current !== epoch) return;
            if (event.type === 'submission_status') settle(submissionResult(event.status));
            if (event.type === 'user_message' || event.type === 'status' || event.type === 'delta' || event.type === 'complete') settle({ outcome: 'accepted' });
            handleStreamEvent(event);
          });
        } catch { /* The server confirms the outcome, including after an aborted delivery. */ }
        finally {
          if (streamAbortRef.current === controller) streamAbortRef.current = null;
          settle(await reconcile(id, submission.submissionId!, epoch, sessionEpoch));
        }
      })();
    });
  }
  return { submitSteer, submitTurn };
}
