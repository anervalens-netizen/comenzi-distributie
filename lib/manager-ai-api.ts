import { managerAiReader, managerAiScope } from './manager-ai-data';
import { defaultManagerAiModel, managerAiModels, managerAiNotConfiguredMessage, type ManagerAiModel, type ManagerAiTurn } from './manager-ai';
import { runManagerAi } from './manager-ai-provider';
import { AppError, assertOrigin, fail, readLimited, requireManager, requireUser, response } from './server';
import { runtimeKind } from './runtime';
import type {User} from './types';

const activeTurns = new Set<string>();
const maxConcurrentTurns = 4;

export function managerAiProviderKey() {
  if (runtimeKind !== 'node') return '';
  return process.env.MOBIUP_MANAGER_AI_OPENAI_API_KEY?.trim() || '';
}

function parseInput(body: Record<string,unknown>) {
  const candidate = body.model ?? defaultManagerAiModel;
  if (!(managerAiModels as readonly unknown[]).includes(candidate)) fail(400,'Alege un model AI disponibil.');
  if (typeof body.question!=='string' || !body.question.trim() || body.question.length>4000) fail(400,'Scrie o întrebare de maximum 4.000 de caractere.');
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length>12 || history.length%2!==0) fail(400,'Istoricul conversației este invalid.');
  const turns:ManagerAiTurn[] = history.map((turn,index)=>{
    const role = index%2===0?'user':'assistant';
    if (!turn || turn.role!==role || typeof turn.content!=='string' || !turn.content.trim() || turn.content.length>12_000) fail(400,'Istoricul conversației este invalid.');
    return {role,content:turn.content};
  });
  turns.push({role:'user',content:body.question.trim()});
  return {model:candidate as ManagerAiModel,turns};
}

async function requestData(req: Request) {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json') fail(415,'Este necesar un document JSON.');
  const data = await readLimited(req,256*1024);
  let body:unknown;
  try { body = JSON.parse(new TextDecoder().decode(data)); }
  catch { fail(400,'Cerere AI invalidă.'); }
  if (!body || typeof body!=='object' || Array.isArray(body)) fail(400,'Cerere AI invalidă.');
  return parseInput(body as Record<string,unknown>);
}

export async function managerAi(req:Request,user:User) {
  requireManager(user);
  const params = new URL(req.url).searchParams;
  for (const field of params.keys()) if (!['managerId','agentId'].includes(field)) fail(400,'Filtru necunoscut.');
  const key = managerAiProviderKey();
  if (req.method==='GET') {
    await managerAiScope(user,params);
    const sandboxAvailable=Boolean(key)&&process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED==='1'&&
      (await import('./manager-ai-sandbox')).managerAiSandboxAvailable();
    return response({available:Boolean(key),models:managerAiModels,defaultModel:defaultManagerAiModel,sandboxAvailable});
  }
  if (req.method!=='POST') fail(405,'Metodă indisponibilă.');
  assertOrigin(req);
  if (!key) fail(503,managerAiNotConfiguredMessage);
  const input = await requestData(req), scope = await managerAiScope(user,params);
  if (activeTurns.has(user.id)) fail(409,'O analiză este deja în curs pentru contul tău.');
  if (activeTurns.size>=maxConcurrentTurns) fail(503,'Toate sesiunile de analiză sunt ocupate. Încearcă din nou.');
  async function check() {
    const current = await requireUser(req);
    requireManager(current);
    if ((await managerAiScope(current,params)).signature!==scope.signature) fail(409,'Accesul la portofoliu s-a modificat. Reîncarcă analiza.');
    return current;
  }
  activeTurns.add(user.id);
  const signal = AbortSignal.any([req.signal,AbortSignal.timeout(90_000)]);
  try {
    const readSource=managerAiReader(req,scope,check);
    const result = await runManagerAi({...input,key,signal,readSource,check:async()=>{
      await readSource.checkSourceScope(await check());
    }});
    return response(result);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal.aborted) fail(504,'Analiza s-a întrerupt. Încearcă cu o selecție mai mică.');
    fail(502,'Furnizorul AI nu este accesibil momentan.');
  } finally {
    activeTurns.delete(user.id);
  }
}
