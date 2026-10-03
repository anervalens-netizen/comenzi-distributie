import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=mkdtempSync(join(tmpdir(),'partner-position-test-'));
try{
  const output=join(root,'position.mjs');
  await build({entryPoints:['lib/partner-position.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
  const {partnerPositionLabel,partnerPositionProvenance,positionNeedsConfirmation}=await import(pathToFileURL(output));
  const base={latitude:45,positionAccuracy:null,updatedAt:'2026-10-03T08:00:00Z'};
  assert.equal(partnerPositionLabel({...base,positionSource:'manual',positionQuality:null}),'Pin confirmat manual');
  assert.equal(partnerPositionLabel({...base,positionSource:'manual',positionQuality:'locality_approximate'}),'Confirmat manual · centrul localității (aproximativ)');
  assert.equal(partnerPositionLabel({...base,positionSource:'gps',positionQuality:null,positionAccuracy:12.4}),'Poziție preluată prin GPS');
  assert.equal(partnerPositionLabel({...base,positionSource:'geocoding',positionQuality:'address_approximate'}),'Aproximativ · adresă potrivită');
  assert.equal(partnerPositionLabel({...base,positionSource:'geocoding',positionQuality:'street_approximate'}),'Aproximativ · pe stradă');
  assert.equal(partnerPositionLabel({...base,positionSource:'geocoding',positionQuality:'locality_approximate'}),'Aproximativ · centrul localității');
  assert.equal(partnerPositionLabel({...base,latitude:null,positionSource:null,positionQuality:null}),'Poziție necunoscută');
  assert.match(partnerPositionProvenance({...base,positionSource:'gps',positionQuality:null,positionAccuracy:12.4}),/precizie raportată 12 m · actualizată/);
  assert.equal(positionNeedsConfirmation({...base,positionSource:'manual',positionQuality:null}),false);
  assert.equal(positionNeedsConfirmation({...base,positionSource:'manual',positionQuality:'locality_approximate'}),false);
  assert.equal(positionNeedsConfirmation({...base,positionSource:'geocoding',positionQuality:'locality_approximate'}),true);
  assert.equal(positionNeedsConfirmation({...base,latitude:null,positionSource:null,positionQuality:null}),true);
  console.log('PASS: manual/GPS/address/street/locality/unknown position labels and confirmation fallbacks.');
}finally{rmSync(root,{recursive:true,force:true});}
