import assert from 'node:assert/strict';
import {build} from 'esbuild';

process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID='test-manager';
const manager={id:'test-manager',role:'manager',managerScope:'global',profileVersion:'1'};
const modules=new Map([
  ['#mobiup-activation-store',"export const readVodafoneBonusAsync=()=>globalThis.fixtureRead();"],
  ['./distribution-config',"export const readDistributionRules=async()=>({assignments:[],products:{}});"],
  ['./vodafone-top-locations',"export const readVodafoneTopLocations=async()=>[];"],
  ['./server',[
    'export const db=()=>({prepare:()=>({bind:()=>({first:async()=>null})})});',
    'export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};',
    'export const isGlobalManager=u=>u.role==="manager"&&u.managerScope==="global";',
    'export const response=value=>Response.json(value);',
  ].join('\n')],
]);
const {outputFiles}=await build({entryPoints:['lib/vodafone-bonus-api.ts'],bundle:true,platform:'node',format:'esm',write:false,
  plugins:[{name:'synthetic-report-source',setup(b){
    b.onResolve({filter:/.*/},args=>modules.has(args.path)?{path:args.path,namespace:'fixture'}:undefined);
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules.get(args.path)}));
  }}]});
const {vodafoneBonusResponse}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const parameters=new URLSearchParams({month:'2026-07',view:'preview',progressive:'1'});
let refresh=0,complete;
const check=async()=>{refresh++;return manager;};
globalThis.fixtureRead=()=>new Promise(resolve=>{complete=resolve;});
const waiting=await vodafoneBonusResponse(manager,parameters,check);
assert.equal(waiting.status,202);assert.deepEqual(await waiting.json(),{state:'preparing'});
assert.equal(waiting.headers.get('retry-after'),'5');assert.equal(refresh,1);
complete({points:[],revision:'example'});
globalThis.fixtureRead=async()=>({points:[],revision:'example'});
const next=await vodafoneBonusResponse(manager,parameters,check);
assert.equal(next.status,200);assert.deepEqual(await next.json(),{points:[],revision:'example'});
const legacy=new URLSearchParams(parameters);legacy.delete('progressive');
assert.equal((await vodafoneBonusResponse(manager,legacy,check)).status,200);
globalThis.fixtureRead=async()=>{throw Error('source unavailable');};
await assert.rejects(vodafoneBonusResponse(manager,parameters,check),err=>err.status===503);
globalThis.fixtureRead=()=>new Promise(()=>{});
await assert.rejects(vodafoneBonusResponse(manager,parameters,async()=>({...manager,profileVersion:'2'})),err=>err.status===409);
await assert.rejects(vodafoneBonusResponse({...manager,role:'agent'},parameters,check),err=>err.status===403);
console.log('PASS: authenticated progressive report, pending response, permission recheck, legacy result and source failure.');
