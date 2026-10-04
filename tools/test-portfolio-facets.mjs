import assert from 'node:assert/strict';
import {canonicalCounty,countyMatches,countySearch,routeMatches,routeTokens} from '../lib/portfolio-facets.ts';
for(const [a,b,id,label] of [['OLT','Olt','RO-OT','Olt'],['Iasi','Iași','RO-IS','Iași'],['Bucuresti','Municipiul Bucuresti','RO-B','București'],['SB','Sibiu','RO-SB','Sibiu']]){
  assert.equal(canonicalCounty(a).id,id);assert.equal(canonicalCounty(a).label,label);assert.equal(canonicalCounty(a).raw,a);assert(countyMatches(a,b));assert(countySearch(a).includes(label));
}
assert.deepEqual(canonicalCounty('unknown raw'),{raw:'unknown raw',id:null,label:'unknown raw'});assert(!countyMatches('UNKNOWN RAW','unknown raw'));
for(const raw of ['1','1, 11','11, 1',' 11 ,\t1\n, 1, '])assert(routeMatches(raw,'1'));
assert(!routeMatches('11','1'));assert(!routeMatches('12, 11','1'));assert(!routeMatches('01','1'));assert(!routeMatches('1, 11','1,11'));
assert.deepEqual(routeTokens('11, 1, 11, ,2'),['11','1','2']);
console.log('PASS: canonical county identities preserve raw/unknown values; exact trimmed route set membership.');
