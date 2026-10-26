import type {ActivationPartner} from './activation-types';

export const activationPartnerSortKeys=['label','vodafone','digi','total','recentToday','lastDate'] as const;
export type ActivationPartnerSort=typeof activationPartnerSortKeys[number];
export type ActivationSortDirection='asc'|'desc';
export function compareActivationPartners(a:ActivationPartner&{vodafone?:number;digi?:number},b:ActivationPartner&{vodafone?:number;digi?:number},key:ActivationPartnerSort,direction:ActivationSortDirection){
 const sign=direction==='asc'?1:-1;
 const value=key==='label'?a.label.localeCompare(b.label,'ro',{sensitivity:'base'}):key==='lastDate'?(a.lastDate||'').localeCompare(b.lastDate||''):Number(a[key]||0)-Number(b[key]||0);
 return sign*value||a.key.localeCompare(b.key);
}

/** Calendar dates, independent of the host timezone and daylight-saving length. */
export function activationTodayWindow(now:Date=new Date()){
 const to=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const from=new Date(Date.parse(to+'T12:00:00Z')-4*86400000).toISOString().slice(0,10);
 return {from,to};
}
