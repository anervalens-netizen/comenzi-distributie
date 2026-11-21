import {readVodafoneBonusAsync} from '#mobiup-activation-store';
import {canViewActivations} from './activation-access';
import {readDistributionRules} from './distribution-config';
import {managerFilter} from './manager-scope';
import {projectIds} from './distribution-rules';
import {bonusProjectSites} from './vodafone-bonus-rules';
import {db,fail,isGlobalManager,response} from './server';
import {salesSiteKey} from './sales-location';
import {bonusMonth,parseVodafoneBonusEvidence,vodafoneBonusEvidenceSetting} from './vodafone-bonus-evidence';
import {readVodafoneTopLocations} from './vodafone-top-locations';
import {firstVodafoneBonusMonth,vodafoneBonusPreview,type VodafoneBonusReport,type VodafoneBonusScope} from './vodafone-bonus-types';
import {vodafoneBonusWorkbook} from './vodafone-bonus-export';
import type {User} from './types';

const calendar = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});
async function authorizedScope(user: User, params: URLSearchParams): Promise<VodafoneBonusScope> {
  if (user.role!=='manager' || !canViewActivations(user)) fail(403,'Registrul Vodafone este disponibil managerilor cu acces la Activări.');
  const filter = await managerFilter(user,params) ??
    (isGlobalManager(user) ? null : await managerFilter(user,new URLSearchParams({managerId:user.id})));
  let sites = filter?.siteCodes ?? null;
  if (filter && sites?.length) {
    const owners=(await db().prepare(`
      SELECT UPPER(TRIM(site_code)) site,MIN(id) owner,COUNT(*) count
      FROM users WHERE role='agent' AND UPPER(TRIM(site_code)) IN(SELECT value FROM json_each(?))
      GROUP BY UPPER(TRIM(site_code))`).bind(JSON.stringify(sites.map(salesSiteKey)))
      .all<{site:string;owner:string;count:number}>()).results;
    const agentIds=new Set(filter.agentIds);
    sites=owners.filter(row=>Number(row.count)===1 && agentIds.has(row.owner)).map(row=>row.site);
  }
  const selected = params.get('siteCode');
  if (selected!==null) {
    const site = salesSiteKey(selected);
    if (!site || site.length>100) fail(400,'Gestiunea este invalidă.');
    if (sites!==null && !sites.some(value=>salesSiteKey(value)===site)) fail(404,'Gestiunea nu face parte din selecție.');
    return [site];
  }
  return sites===null ? null : [...new Set(sites.map(salesSiteKey))].sort();
}
async function getEvidence() {
  return (await db().prepare('SELECT value FROM settings WHERE key=?').bind(vodafoneBonusEvidenceSetting).first<{value:string}>())?.value;
}
export async function readVodafoneBonusForManager(
  user: User, params: URLSearchParams, revalidate?: ()=>Promise<User>,
): Promise<VodafoneBonusReport> {
  const permittedSites = await authorizedScope(user,params);
  const keys = new Set<string>();
  for (const key of params.keys()) {
    if (!['managerId','agentId','siteCode','projects','month','all','view','revision','q'].includes(key) || keys.has(key)) fail(400,'Filtru necunoscut sau duplicat.');
    keys.add(key);
  }
  const today=calendar.format(new Date()), chosenMonth=params.get('month') || today.slice(0,7);
  if (!bonusMonth(chosenMonth) || chosenMonth<firstVodafoneBonusMonth || chosenMonth>today.slice(0,7)) fail(400,'Alege o lună disponibilă.');
  const all=params.get('all'), view=params.get('view'), revision=params.get('revision');
  if ((all!==null && all!=='1') || (view!==null && view!=='export' && view!=='preview') || (revision!==null && !/^[0-9a-f]{64}$/.test(revision))) fail(400,'Selecția registrului este invalidă.');
  const search=params.get('q');
  if (search!==null && (view!=='export' || search.length>180)) fail(400,'Căutarea pentru export este invalidă.');
  if (view==='preview' && all!==null) fail(400,'Alege o lună pentru afișarea registrului.');
  const projects=new Set(params.get('projects')?.split(',').filter(Boolean) ?? projectIds);
  if ([...projects].some(project=>!(projectIds as readonly string[]).includes(project))) fail(400,'Proiect necunoscut.');
  const [rules,targets,raw] = await Promise.all([readDistributionRules(),readVodafoneTopLocations(),getEvidence()]).catch(()=>{
    fail(503,'Sursele de configurare ale registrului nu sunt disponibile.');
  });
  if (!rules) fail(503,'Lipsește clasificarea produselor Vodafone.');
  const scope=bonusProjectSites(permittedSites,rules,projects);
  let evidence;
  try { evidence=parseVodafoneBonusEvidence(raw); } catch { fail(503,'Dovezile fiscale ale registrului necesită verificare.'); }
  const report=await readVodafoneBonusAsync({today,rules,targets,evidence,scope,month:all==='1'?null:chosenMonth})
    .catch(()=>fail(503,'Registrul Vodafone nu este disponibil momentan. Reîncarcă raportul.'));
  const current = revalidate ? await revalidate() : user;
  if (current.id!==user.id || current.profileVersion!==user.profileVersion || current.managerScope!==user.managerScope ||
      JSON.stringify(permittedSites)!==JSON.stringify(await authorizedScope(current,params))) fail(409,'Accesul la registru s-a schimbat.');
  const [updatedRules,updatedTargets,updatedEvidence]=await Promise.all([readDistributionRules(),readVodafoneTopLocations(),getEvidence()]).catch(()=>{
    fail(503,'Configurarea registrului nu a putut fi reverificată.');
  });
  if (JSON.stringify(updatedRules)!==JSON.stringify(rules) || JSON.stringify(updatedTargets)!==JSON.stringify(targets) ||
      raw!==updatedEvidence || revision!==null && revision!==report.revision) fail(409,'Registrul s-a actualizat. Reîncarcă selecția.');
  return report;
}

export async function vodafoneBonusResponse(user: User, params: URLSearchParams, revalidate: ()=>Promise<User>) {
  const report = await readVodafoneBonusForManager(user,params,revalidate);
  const view=params.get('view');
  if (view==='export') return response({workbook:vodafoneBonusWorkbook(report,params.get('q') || '')});
  return response(view==='preview' ? vodafoneBonusPreview(report) : report);
}
