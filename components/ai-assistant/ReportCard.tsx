'use client';

import {useState} from 'react';
import {useAiApi} from './api-context';

export function ReportCard({conversationId,artifactId}:{conversationId:string;artifactId:string}) {
  const api = useAiApi();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState(false);
  const [visible,setVisible] = useState(false);
  const [panel,setPanel] = useState<React.ReactNode>(null);
  async function toggle() {
    if (panel) {setVisible(!visible);return;}
    setBusy(true);
    setError(false);
    try {
      const [wire,{default:Surface}] = await Promise.all([
        api.getReportCard(conversationId,artifactId),import('./ReportSurface'),
      ]);
      setPanel(<Surface wire={wire} id={artifactId}/>);
      setVisible(true);
    } catch {setError(true);}
    finally {setBusy(false);}
  }
  return <div className="mt-2">
    <button type="button" disabled={busy} aria-expanded={visible} className="text-sm font-semibold underline"
      onClick={() => void toggle()}>{busy ? 'Se încarcă…' : visible ? 'Ascunde fișa' : 'Vezi rândurile raportului'}</button>
    {visible && panel}
    {error && <p role="status">Fișa nu este disponibilă pentru selecția curentă. Poți reîncerca.</p>}
  </div>;
}
