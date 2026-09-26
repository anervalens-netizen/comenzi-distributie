import assert from 'node:assert/strict';
import { bucharestMonthKey, bucharestMonthUtcRange } from '../lib/bucharest-month.ts';
import { partnerPointKey } from '../lib/partner-identity.ts';

assert.equal(bucharestMonthKey('2026-08-31T21:30:00.000Z'),'2026-09','September local time wins over August UTC');
assert.deepEqual(bucharestMonthUtcRange('2026-09'),{start:'2026-08-31T21:00:00.000Z',end:'2026-09-30T21:00:00.000Z'},'Summer month uses UTC+3 bounds');
assert.deepEqual(bucharestMonthUtcRange('2026-12'),{start:'2026-11-30T22:00:00.000Z',end:'2026-12-31T22:00:00.000Z'},'Winter month uses UTC+2 bounds');
assert.deepEqual(bucharestMonthUtcRange('2026-10'),{start:'2026-09-30T21:00:00.000Z',end:'2026-10-31T22:00:00.000Z'},'DST transition month uses different start/end offsets');
assert.notEqual(partnerPointKey('Dumbrava','Prahova','Strada Principala 1'),partnerPointKey('Dumbrava','Timiș','Strada Principala 1'),'County participates in work-location identity');
assert.equal(partnerPointKey('Dumbrava','Timiș','Strada Principală 1'),partnerPointKey(' DUMBRAVA ','TIMIS','Strada Principala 1'),'Point identity normalizes diacritics, case and spaces');
console.log('PASS: Bucharest month boundaries and county-aware partner identity.');
