// Render the real form with deterministic hook state; no network or account data.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
const dir=mkdtempSync(join(tmpdir(),'partner-form-'));
globalThis.__partnerFixture={cui:'900000001',location:'Exemplu',county:'BV',address:'Main Nr22'};
globalThis.__partnerLocations=Array.from({length:9},(_,i)=>({id:'synthetic-'+i,cui:'900000001',name:'Synthetic Company',city:'Exemplu',county:'BV',address:'Main Nr24',warehouseIds:['w']}));
try{
 const plugin={name:'form-fixture',setup(b){
 b.onResolve({filter:/^(react|@\/lib\/(client-api|local-work))$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='react'?`let arrays=0;export const useEffect=()=>{};export const useRef=()=>({current:null});export const useState=initial=>{let value=typeof initial==='function'?initial():initial;if(Array.isArray(value)&&arrays++===0)value=globalThis.__partnerLocations;return [value,()=>{}];};`:a.path.endsWith('local-work')?`export const readLocalWork=()=>({value:globalThis.__partnerFixture,error:''});export const removeLocalWork=()=>'';export const writeLocalWork=()=>'';`:`export const api=()=>Promise.reject(new Error('No network'));export class ApiError extends Error{};export const dateLabel=x=>x;export const errorMessage=e=>e.message;`}));
 }};
 await build({entryPoints:['components/partner-new.tsx'],outfile:join(dir,'form.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',plugins:[plugin],alias:{'@':process.cwd()},jsx:'automatic'});
 // Resolve external React from this checkout when executing a temporary artifact.
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
 const {readFileSync,writeFileSync}=await import('node:fs');
 let source=readFileSync(join(dir,'form.mjs'),'utf8');for(const name of ['react/jsx-runtime','lucide-react'])source=source.replaceAll('"'+name+'"',JSON.stringify(require.resolve(name)));
 writeFileSync(join(dir,'form.mjs'),source);
 const {PartnerNew}=await import(join(dir,'form.mjs'));
 const html=renderToStaticMarkup(createElement(PartnerNew,{userId:'synthetic-agent'}));
 assert.ok(html.includes('posibil punct duplicat'));assert.ok(html.includes('numere apropiate'));
 for(let i=0;i<9;i++)assert.ok(html.includes('value="synthetic-'+i+'"'));
 assert.ok(html.includes('Locație diferită / nouă'));assert.ok(html.includes('name="locationResolution"'));
 console.log('Partner form rendered all 9 candidates, reasons and explicit choices');
}finally{rmSync(dir,{recursive:true,force:true});}
