import assert from 'node:assert/strict';
import {scrubErrorEvent,normalizeWorkerFrame} from '../deploy/error-reporting.mjs';
const event=scrubErrorEvent({user:{email:'synthetic@example.invalid'},request:{url:'https://example.invalid/private'},extra:{document:'synthetic'},contexts:{private:{value:'synthetic'}},breadcrumbs:[{message:'synthetic'}],tags:{application:'comenzi',private:'synthetic'},exception:{values:[{type:'Error',value:'private synthetic value',stacktrace:{frames:[{filename:'handler.js',lineno:12,vars:{private:'synthetic'},context_line:'private code'}]}}]}});
for(const key of ['user','request','extra','contexts','breadcrumbs'])assert.equal(event[key],undefined);
assert.deepEqual(event.tags,{application:'comenzi'});
assert.deepEqual(event.exception.values[0].stacktrace.frames,[{filename:'handler.js',lineno:12}]);
assert.equal(event.exception.values[0].value,'Application error (private message omitted)');
console.log('PASS: private context removed; diagnostic stack preserved.');

for (const prefix of ['file:///isolated-release/','/isolated-release/']) {
 const frame={filename:prefix+'sales-parser-worker.mjs',lineno:14,colno:3}; normalizeWorkerFrame(frame);
 assert.equal(frame.filename,'app:///workers/sales-parser-worker.mjs');assert.equal(frame.abs_path,frame.filename);
 assert.equal(frame.lineno,14);assert.equal(frame.colno,3);
}
const other={filename:'file:///isolated-release/server.js'};normalizeWorkerFrame(other);assert.equal(other.filename,'file:///isolated-release/server.js');
console.log('PASS: worker file URLs normalized without changing coordinates or unrelated frames.');
