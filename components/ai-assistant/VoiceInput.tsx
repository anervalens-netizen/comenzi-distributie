import { Mic, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAiApi } from './api-context';
import { errorMessage } from '@/lib/client-api';

import { managerAiAudioLimits } from '@/lib/manager-ai-media-contract';

const { maxRecordingMs: MAX_RECORDING_MS, maxFileBytes: MAX_AUDIO_BYTES } = managerAiAudioLimits;
type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';
type RecordingSession = {
  recorder?: MediaRecorder; stream?: MediaStream; timer?: ReturnType<typeof setTimeout>;
  abort: AbortController; cancelled: boolean; chunks: Blob[]; bytes: number;
};

export function VoiceInput({ disabled, onTranscript, onBusyChange }: { disabled: boolean; onTranscript: (text: string) => void; onBusyChange: (busy: boolean) => void }) {
  const {transcribeAiAudio} = useAiApi();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const session = useRef<RecordingSession | null>(null);
  useEffect(() => { onBusyChange(phase !== 'idle'); }, [phase, onBusyChange]);
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  const supported = typeof MediaRecorder !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';

  function cancel() {
    const active = session.current;
    if (!active) return;
    active.cancelled = true;
    active.abort.abort();
    clearTimeout(active.timer);
    if (active.recorder?.state === 'recording') active.recorder.stop();
    active.stream?.getTracks().forEach(track => track.stop());
    active.chunks = [];
    session.current = null;
    setPhase('idle');
  }
  useEffect(() => () => {
    const active = session.current;
    if (!active) return;
    active.cancelled = true;
    active.abort.abort();
    clearTimeout(active.timer);
    active.stream?.getTracks().forEach(track => track.stop());
    if (active.recorder?.state === 'recording') active.recorder.stop();
    active.chunks = [];
  }, []);

  async function start() {
    if (session.current || disabled) return;
    setError('');
    setPhase('starting');
    const active: RecordingSession = {
      abort: new AbortController(), cancelled: false, chunks: [], bytes: 0,
    };
    session.current = active;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      active.stream = stream;
      if (active.cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      active.recorder = recorder;
      recorder.ondataavailable = event => {
        if (active.cancelled) return;
        active.bytes += event.data.size;
        if (active.bytes > MAX_AUDIO_BYTES) {
          setError('Înregistrarea este prea mare. Încearcă un mesaj mai scurt.');
          cancel();
          return;
        }
        active.chunks.push(event.data);
      };
      recorder.onerror = () => {
        setError('Înregistrarea a fost întreruptă. Încearcă din nou.');
        cancel();
      };
      recorder.onstop = () => { void finish(active, recorder.mimeType); };
      recorder.start(1000);
      active.timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, MAX_RECORDING_MS);
      setPhase('recording');
    } catch {
      if (active.cancelled) return;
      setError('Microfonul nu poate fi accesat. Verifică permisiunea în browser.');
      cancel();
    }
  }

  async function finish(active: RecordingSession, mimeType: string) {
    clearTimeout(active.timer);
    active.stream?.getTracks().forEach(track => track.stop());
    if (active.cancelled) return;
    setPhase('transcribing');
    try {
      const blob = new Blob(active.chunks, { type: mimeType });
      active.chunks = [];
      if (!blob.size) throw new Error('empty audio');
      const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const result = await transcribeAiAudio(new File([blob], `dictare.${extension}`, { type: mimeType }), active.abort.signal);
      if (!active.cancelled) {
        if (!result.text.trim()) setError('Nu am detectat vorbire. Încearcă din nou.');
        else onTranscriptRef.current(result.text);
      }
    } catch (cause) {
      if (!active.cancelled) setError(errorMessage(cause));
    } finally {
      if (session.current === active) { session.current = null; setPhase('idle'); }
    }
  }

  return <div className="flex items-center gap-1">
    <button type="button" disabled={!supported || phase === 'starting' || phase === 'transcribing' || (disabled && phase === 'idle')}
      aria-label={phase === 'recording' ? 'Oprește dictarea' : 'Dictează mesaj'}
      aria-pressed={phase === 'recording'}
      title={supported ? 'Dictează și verifică textul înainte de trimitere' : 'Dictarea nu este disponibilă în acest browser'}
      onClick={() => { if (phase === 'recording') session.current?.recorder?.stop(); else if (phase === 'idle') void start(); }}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 dark:text-indigo-300 dark:hover:bg-slate-800">
      {phase === 'recording' ? <Square size={15} fill="currentColor" /> : <Mic size={16} />}
    </button>
    {phase !== 'idle' && <><output className="text-[11px]">{phase === 'recording' ? 'Înregistrez · max. 2 min' : phase === 'starting' ? 'Pornesc microfonul…' : 'Transcriu…'}</output><button type="button" aria-label="Anulează dictarea" onClick={cancel}><X size={14} /></button></>}
    {error && <span role="alert" className="max-w-48 text-[11px] text-rose-600">{error}</span>}
  </div>;
}
