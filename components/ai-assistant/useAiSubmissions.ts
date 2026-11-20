import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { ApiError } from '@/lib/client-api';
import { consumeAiStream, type AiStreamEvent } from './api';
import { useAiApi } from './api-context';
import { AI_NOT_CONFIGURED_MESSAGE, type AiChatMessage, type AiComposerSubmission, type AiRunStatus, type AiSubmissionResult } from './types';
import { captureRunGuard, streamingMessage, STREAMING_MESSAGE_ID, submissionResult, type MutableRef } from './protocolState';

type Params = {
  setMessages: Dispatch<SetStateAction<AiChatMessage[]>>;
  setRunStatus: (status: AiRunStatus) => void;
  streamAbortRef: MutableRef<AbortController | null>;
  selectionEpochRef: MutableRef<number>;
  runGenerationRef: MutableRef<number>;
  refreshConversations: () => Promise<void>;
};

function reduceStreamEvent(current: AiChatMessage[], event: AiStreamEvent): AiChatMessage[] {
  if (event.type === 'user_message') {
    return [...current.filter((m) => m.id !== event.message.id && m.id !== STREAMING_MESSAGE_ID), event.message, streamingMessage()];
  }
  if (event.type === 'status') {
    return current.map((m) => m.id === STREAMING_MESSAGE_ID ? { ...m, activity: event.message } : m);
  }
  if (event.type === 'reset') {
    return [...current.filter((m) => m.id !== STREAMING_MESSAGE_ID), streamingMessage()];
  }
  if (event.type === 'delta') {
    return current.map((m) => m.id === STREAMING_MESSAGE_ID ? { ...m, text: m.text + event.text, activity: 'Redactez răspunsul…' } : m);
  }
  if (event.type === 'complete' || event.type === 'stopped') {
    const message = event.message;
    return [...current.filter((m) => m.id !== STREAMING_MESSAGE_ID && m.id !== message?.id), ...(message ? [message] : [])];
  }
  return current;
}

function definiteError(error: unknown): AiSubmissionResult | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409) {
    const body = error.data as { code?: string; detail?: { code?: string; message?: string } } | null;
    return { outcome: 'conflict', code: body?.detail?.code ?? body?.code ?? 'submission_conflict', message: body?.detail?.message ?? error.message };
  }
  const unavailable = error.status === 503 && [
    AI_NOT_CONFIGURED_MESSAGE, 'Toate sesiunile AI sunt ocupate.', 'Portofoliul nu este disponibil.',
    'Asistentul AI este indisponibil pe această instanță.',
  ].includes(error.message);
  return unavailable || [400, 401, 403, 404, 413, 415, 422].includes(error.status)
    ? { outcome: 'rejected', message: error.message } : null;
}

export function useSubmissionActions(params: Params) {
  const { getAiSubmissionStatus, openAiTurnStream, steerAiTurn } = useAiApi();
  const { setMessages, setRunStatus, selectionEpochRef, runGenerationRef, streamAbortRef, refreshConversations } = params;

  const confirmAdmission = useCallback(async (id: string, submissionId: string): Promise<AiSubmissionResult> => {
    try { return submissionResult(await getAiSubmissionStatus(id, submissionId)); }
    catch { return { outcome: 'unknown' }; }
  }, [getAiSubmissionStatus]);

  const submitSteer = useCallback(async (id: string, submission: AiComposerSubmission): Promise<AiSubmissionResult> => {
    try {
      await steerAiTurn(id, submission);
      // The active run's stream delivers the persisted instruction in order.
      return { outcome: 'accepted' };
    } catch (error) {
      return definiteError(error) ?? await confirmAdmission(id, submission.submissionId!);
    }
  }, [confirmAdmission, steerAiTurn]);

  async function submitTurn(id: string, submission: AiComposerSubmission): Promise<AiSubmissionResult> {
    const isCurrent = captureRunGuard(selectionEpochRef, runGenerationRef);
    const submissionId = submission.submissionId!;
    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;
    const ownsDelivery = () => isCurrent() && streamAbortRef.current === controller;
    const releaseDelivery = () => {
      if (ownsDelivery()) streamAbortRef.current = null;
    };
    let response: Response;
    try {
      response = await openAiTurnStream(id, submission, controller.signal);
    } catch (error) {
      const definite = definiteError(error);
      if (!ownsDelivery()) return definite ?? { outcome: 'unknown' };
      releaseDelivery();
      if (definite) {
        setRunStatus('idle');
        return definite;
      }
      return confirmAdmission(id, submissionId);
    }

    // The composer resolves on durable admission while delivery continues.
    return new Promise<AiSubmissionResult>((resolve) => {
      let settled = false;
      let terminal = false;
      const settle = (result: AiSubmissionResult) => {
        if (!settled) { settled = true; resolve(result); }
      };
      void (async () => {
        try {
          await consumeAiStream(response, (event) => {
            if (!ownsDelivery() || terminal) return;
            if (event.type === 'submission_status') {
              const result = submissionResult(event.status);
              if (result.outcome !== 'unknown') settle(result);
              if (event.status.run_state === 'stopping') setRunStatus('stopping');
              return;
            }
            if (event.type === 'error') return;
            settle({ outcome: 'accepted' });
            // A stopped event without its persisted message needs durable recovery.
            if (event.type === 'stopped' && !event.message) return;
            setMessages((current) => reduceStreamEvent(current, event));
            if (event.type === 'complete' || event.type === 'stopped') {
              terminal = true;
              setRunStatus('idle');
              void refreshConversations().catch(() => undefined);
            }
          });
        } catch { /* Polling recovers the active run after delivery loss. */ }
        finally {
          const owned = ownsDelivery();
          releaseDelivery();
          if (!settled) settle(owned ? await confirmAdmission(id, submissionId) : { outcome: 'unknown' });
        }
      })();
    });
  }

  return { submitSteer, submitTurn };
}
