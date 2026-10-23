import assert from 'node:assert/strict';

const revisionPattern = /^\d+\.[a-f0-9]{64}$/;

export function assertEquivalentSearchReports(first, second) {
  assert.match(first?.revision || '', revisionPattern, 'first search must return a valid opaque revision');
  assert.match(second?.revision || '', revisionPattern, 'second search must return a valid opaque revision');
  assert.notEqual(first.revision, second.revision, 'equivalent filters must retain distinct query-bound revisions');
  const firstReport = {...first}, secondReport = {...second};
  delete firstReport.revision;
  delete secondReport.revision;
  assert.deepEqual(firstReport, secondReport, 'equivalent filters must return identical report data');
}
