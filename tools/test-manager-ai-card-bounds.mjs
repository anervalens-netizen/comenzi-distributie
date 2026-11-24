import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

const {outputFiles}=await build({stdin:{resolveDir:process.cwd(),contents:`
 export * from './lib/manager-ai-card-bounds.ts';
 export * from './lib/manager-ai-presentation.ts';
 export * from './lib/manager-ai-report-card.ts';
 export {default as PresentationSurface} from './components/ai-assistant/PresentationSurface.tsx';
 export {default as ReportSurface} from './components/ai-assistant/ReportSurface.tsx';
`},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'observe-parser-entry',setup(b){
 b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},args=>({path:import.meta.resolve(args.path),external:true}));
 b.onResolve({filter:/^@a2ui\//},args=>({path:args.path,namespace:'observe'}));
 b.onLoad({filter:/.*/,namespace:'observe'},()=>({contents:`
  import React from 'react';
  export const createComponentImplementation=definition=>definition;
  export const A2uiSurface=()=>React.createElement('output',null,'Valid bounded card');
  export class Catalog {}
  export class MessageProcessor {
   model={surfacesMap:new Map()};
   processMessagesWithErrors(wire){globalThis.cardProcessorCalls++;this.model.surfacesMap.set(wire[0].createSurface.surfaceId,{});return [];}
  }
 `}));
}}]});
const {parsePresentation,parsePresentationData,presentationSchema,boundedReportCardMessages,reportCardData,reportCardMessages,PresentationSurface,ReportSurface}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const valid={title:' Example ',layout:'table',columns:['Column'],rows:[['Value']]};
const card={title:'Report',columns:['Column'],rows:[['Value']],exported:1,total:1,sources:['Synthetic']};
let schemaCalls=0,tests=0;
globalThis.cardProcessorCalls=0;
const original=presentationSchema.safeParse;
presentationSchema.safeParse=function(...args){schemaCalls++;return original.apply(this,args);};
const test=(label,fn)=>{fn();tests++;console.log('PASS '+label);};
const markup=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
try{
 test('valid server and frontend presentation preserve normalization',()=>{
  assert.equal(parsePresentation(JSON.stringify(valid)).title,'Example');
  assert.match(markup(PresentationSurface,{data:valid,id:'example'}),/Valid bounded card/);
  assert.equal(globalThis.cardProcessorCalls,1);
 });
 test('oversized collection is rejected before Zod allocates element issues',()=>{
  const oversized={...valid,rows:Array(5000).fill(0)};
  const raw=JSON.stringify(oversized);assert.ok(raw.length<32000);
  const before=schemaCalls;
  assert.equal(parsePresentation(raw),undefined);
  assert.equal(schemaCalls,before);
  const processed=globalThis.cardProcessorCalls;
  assert.match(markup(PresentationSurface,{data:oversized,id:'example'}),/Fișa nu poate fi afișată/);
  assert.equal(schemaCalls,before);assert.equal(globalThis.cardProcessorCalls,processed);
 });
 test('array bounds are checked before reading an invalid first element',()=>{
  const rows=Array(10000);Object.defineProperty(rows,0,{get(){throw Error('must not inspect oversized elements');}});
  assert.equal(parsePresentationData({...valid,rows}),undefined);
  assert.match(markup(PresentationSurface,{data:{...valid,rows},id:'example'}),/Fișa nu poate fi afișată/);
 });
 test('deeply nested JSON cannot reach recursive schema validation',()=>{
  const before=schemaCalls;
  const raw='{"title":"Nested","layout":"table","columns":["One"],"rows":'+ '['.repeat(6000)+'0'+']'.repeat(6000)+'}';
  assert.ok(raw.length<32000);assert.equal(parsePresentation(raw),undefined);assert.equal(schemaCalls,before);
 });
 test('literal presentation shape rejects nested, sparse and unknown fields',()=>{
  const before=schemaCalls;
  for(const data of [null,[],{...valid,rows:[[{}]]},{...valid,columns:Array(10000).fill('x')},{...valid,rows:[Array(10000).fill('x')]},{...valid,rows:Array(2)},{...valid,rows:[Array(1)]},{...valid,extra:'untrusted'},{...valid,layout:{toString(){throw Error('no coercion');}}}])assert.equal(parsePresentationData(data),undefined);
  assert.equal(schemaCalls,before);
 });
 test('valid report envelope passes unchanged to the existing processor',()=>{
  const wire=reportCardMessages('example',card);
  assert.equal(boundedReportCardMessages(wire,'example'),wire);
  assert.match(markup(ReportSurface,{wire,id:'example'}),/Valid bounded card/);
 });
 test('normal generated report data fits the bounded envelope',()=>{
  const data=reportCardData({id:'R1',dataset:'digiImports',columns:['sourceRows','matchingTR'],rows:[[7,null]],totalRows:1,coverage:[]});
  const wire=reportCardMessages('report',data);assert.equal(boundedReportCardMessages(wire,'report'),wire);
 });
 test('empty reports and the bounded maximum column shape remain valid',()=>{
  const empty=reportCardMessages('empty',{...card,rows:[],exported:0,total:0});assert.ok(boundedReportCardMessages(empty,'empty'));
  const columns=Array.from({length:64},(_,i)=>'Column '+i),rows=Array.from({length:10},()=>Array(64).fill('Value'));
  const wire=reportCardMessages('wide',{...card,columns,rows,exported:10,total:20});assert.ok(boundedReportCardMessages(wire,'wide'));
 });
 test('oversized report envelopes never enter A2UI parsing',()=>{
  const before=globalThis.cardProcessorCalls;
  for(const wire of [Array(10000).fill(null),reportCardMessages('example',{...card,rows:Array(10000).fill(0)}),reportCardMessages('example',{...card,columns:Array(10000).fill('x')}),reportCardMessages('example',{...card,rows:[Array(10000).fill('x')]}),reportCardMessages('example',{...card,sources:Array(10000).fill('x')})]){
   assert.equal(boundedReportCardMessages(wire,'example'),undefined);
   assert.match(markup(ReportSurface,{wire,id:'example'}),/Fișa nu poate fi afișată/);
  }
  assert.equal(globalThis.cardProcessorCalls,before);
 });
 test('report component, surface identity and literal fields are fenced',()=>{
  const mutations=[wire=>wire[0].createSurface.catalogId='other',wire=>wire[1].updateComponents.surfaceId='other',wire=>wire[1].updateComponents.components.push({}),wire=>wire[1].updateComponents.components[0].component='Other',wire=>wire[1].updateComponents.components[0].rows=[[{path:'/private'}]],wire=>wire[1].updateComponents.components[0].rows=[Array(1)],wire=>wire[1].updateComponents.components[0].total=-1,wire=>wire[1].updateComponents.components[0].exported=Infinity,wire=>wire[1].updateComponents.components[0].unknown=[]];
  const before=globalThis.cardProcessorCalls;
  for(const mutate of mutations){const wire=reportCardMessages('example',structuredClone(card));mutate(wire);assert.equal(boundedReportCardMessages(wire,'example'),undefined);assert.match(markup(ReportSurface,{wire,id:'example'}),/Fișa nu poate fi afișată/);}
  assert.equal(globalThis.cardProcessorCalls,before);
 });
 console.log(JSON.stringify({passed:tests,failed:0,upstream_advisory:'open; compatibility dependency unchanged',external_requests:0}));
}finally{presentationSchema.safeParse=original;delete globalThis.cardProcessorCalls;}
