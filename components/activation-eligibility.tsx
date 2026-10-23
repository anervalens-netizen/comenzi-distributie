import {activationReasonLabel} from '@/lib/activation-labels';

export function ActivationEligibility({eligible,reasons}:{eligible:boolean|null;reasons:string[]}){
  return <><span>{eligible===null?'Fără regulă geografică':eligible?'Comisionabilă':'Necomisionabilă'}</span>{reasons.length>0&&<small className="activation-detail-reasons">{[...new Set(reasons.map(activationReasonLabel))].join(' · ')}</small>}</>;
}
