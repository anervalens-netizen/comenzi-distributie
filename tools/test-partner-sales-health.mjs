import assert from 'node:assert/strict';
import { partnerActivity } from '../lib/partner-sales-health.ts';
const dates=['2026-06-01','2026-06-08','2026-06-15','2026-06-22','2026-06-29','2026-07-06'];
const weekly=dates.map(date=>({date,valueCents:10000}));
assert.equal(partnerActivity(weekly,'2026-07-10','2026-07-10').status,'regular');
const overdue=partnerActivity(weekly,'2026-07-22','2026-07-22');
assert.equal(overdue.status,'overdue');assert.equal(overdue.cadenceDays,7);assert.equal(overdue.alertEligible,true);
const inactive=partnerActivity(weekly,'2026-09-30','2026-09-30');
assert.equal(inactive.status,'inactive');
assert.equal(partnerActivity(weekly,'2026-07-10','2026-09-30').status,'regular','evaluate at source coverage date, not wall clock');
assert.equal(partnerActivity(weekly,'2026-07-22','2026-09-30').alertEligible,false,'stale imports suppress alerts');
assert.equal(partnerActivity(weekly,'2026-09-30','2026-09-30',false).status,'insufficient_history');
assert.equal(partnerActivity([...weekly,{date:'2026-09-29',valueCents:0},{date:'2026-09-30',valueCents:-100}],'2026-09-30','2026-09-30').lastBilling,'2026-07-06');
assert.equal(partnerActivity([...weekly,{date:'2026-09-29',valueCents:10000}],'2026-09-30','2026-09-30').reactivated,true);
assert.equal(partnerActivity([...weekly,...weekly],'2026-07-10','2026-07-10').billingDays,6,'repeated sale lines do not increase frequency');
assert.equal(partnerActivity([{date:'2026-09-30',valueCents:500},{date:'2026-09-30',valueCents:-500}],'2026-09-30','2026-09-30').status,'no_billing');
assert.equal(partnerActivity([{date:'2026-09-30',valueCents:500}],'2026-09-30','2026-09-30').status,'insufficient_history');
assert.throws(()=>partnerActivity([{date:'2026-02-30',valueCents:1}],'2026-09-30','2026-09-30'));
assert.throws(()=>partnerActivity([{date:'2026-09-30',valueCents:NaN}],'2026-09-30','2026-09-30'));
assert.equal(partnerActivity([{date:'2026-10-01',valueCents:1}],'2026-09-30','2026-09-30').status,'no_billing');
console.log('PASS: activity frequency, source freshness, incomplete links, returns, free items, reactivation and invalid input.');

assert.equal(partnerActivity([],'2026-09-30','2026-09-30',false).status,'insufficient_history');
const seasonal=[...weekly,...weekly.map(x=>({...x,date:x.date.replace('2026','2025')})),...weekly.map(x=>({...x,date:x.date.replace('2026','2024')}))];
const season=partnerActivity(seasonal,'2026-09-30','2026-09-30');
assert.equal(season.seasonalPossible,true);assert.equal(season.alertEligible,false);

assert.equal(partnerActivity([...weekly,{date:'2026-09-29',valueCents:10000}],'2026-09-30','2026-09-30',false).reactivated,false,'incomplete links cannot establish reactivation');
assert.equal(partnerActivity([{date:'2026-09-30',valueCents:10000}],'2026-09-30','2026-09-30',false).isNew,false,'incomplete links cannot establish first observed billing');
