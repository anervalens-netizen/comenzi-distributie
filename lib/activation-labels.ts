export const activationReasonLabels:Record<string,string>={outside_territory:'Județ în afara ariei',missing_county:'Județ lipsă',ineligible_type:'Tip SIM neeligibil',missing_type:'Tip SIM lipsă',contradictory_source:'Date contradictorii'};
export const activationReasonLabel=(reason:string)=>activationReasonLabels[reason]||'Motiv de verificat';
export function activationDateLabel(value:string|null|undefined){return !value?'—':/^\d{4}-\d{2}-\d{2}$/.test(value)?value.split('-').reverse().join('.'):value;}
