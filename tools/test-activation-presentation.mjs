import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

const bundle=await build({stdin:{contents:"export * from './components/activation-eligibility';export * from './lib/activation-labels';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',jsx:'automatic',write:false});
const {ActivationEligibility,activationReasonLabels,activationDateLabel}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const known={outside_territory:'Județ în afara ariei',missing_county:'Județ lipsă',ineligible_type:'Tip SIM neeligibil',missing_type:'Tip SIM lipsă',contradictory_source:'Date contradictorii'};
assert.deepEqual(activationReasonLabels,known);
for(const [reason,label] of Object.entries(known)){
  const html=renderToStaticMarkup(createElement(ActivationEligibility,{eligible:false,reasons:[reason]}));
  assert(html.includes('<span>Necomisionabilă</span><small class="activation-detail-reasons">'+label+'</small>'),'reason is a separate Romanian explanation');
  assert(!html.includes(reason),'raw reason keys are never displayed');
}
const combined=renderToStaticMarkup(createElement(ActivationEligibility,{eligible:false,reasons:[...Object.keys(known),'UNRECOGNIZED_REASON']}));
assert(combined.includes(' · '));assert(combined.includes('Motiv de verificat'));assert(!combined.includes('UNRECOGNIZED_REASON'));
assert.equal(renderToStaticMarkup(createElement(ActivationEligibility,{eligible:true,reasons:[]})),'<span>Comisionabilă</span>');
assert.equal(renderToStaticMarkup(createElement(ActivationEligibility,{eligible:null,reasons:[]})),'<span>Fără regulă geografică</span>');
assert.equal(activationDateLabel('2026-10-15'),'15.10.2026');assert.equal(activationDateLabel('2024-02-29'),'29.02.2024');assert.equal(activationDateLabel(null),'—');
console.log('PASS: all activation reason labels render in Romanian without raw keys, separate explanations, unchanged eligibility and local date presentation.');
