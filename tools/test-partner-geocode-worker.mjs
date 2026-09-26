import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from './partner-geocode-worker.mjs';

const dir = mkdtempSync(join(tmpdir(), 'geocode-worker-test-'));
const statePath = join(dir, 'state.json'), results = join(dir, 'results.json');
const write = (p, d) => writeFileSync(p, JSON.stringify(d));
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const initial = () => ({
  version: 1, root: dir, db: join(dir, 'fixture.sqlite'), creditLedger: join(dir, 'credits.sqlite'),
  reviews: [], phase: 'ready', currentJob: 'retry', generation: 0,
  jobs: [{ id: 'retry', input: join(dir, 'input.json'), results, review: join(dir, 'review.json'), status: 'pending' }]
});
try {
  write(statePath, initial());
  let calls = 0;
  const noBudget = await runPipeline(statePath, { credits: () => 100, batch: async () => { calls++; } });
  assert.equal(noBudget.phase, 'waiting_budget');
  assert.equal(calls, 0, 'no external requests when local budget has no capacity');
  assert.equal(read(statePath).jobs[0].status, 'pending', 'quota pause preserves pending work');

  write(statePath, initial());
  const sampledState = initial(); sampledState.jobs[0].creditPollBuffer = 40; write(statePath, sampledState);
  let sampledCalls = 0;
  const sampledRetry = await runPipeline(statePath, {
    credits: () => 96,
    batch: async (input, out, opts) => {
      sampledCalls++; assert.equal(opts.creditPollBuffer, 40); assert.equal(opts.pollIntervalMs, 60000);
      throw new Error('Geoapify a răspuns cu HTTP 402.');
    }
  });
  assert.equal(sampledCalls, 1, 'a deliberately smaller, isolated batch may run below the normal 100-credit reserve');
  assert.equal(sampledRetry.phase, 'waiting_budget', 'sampled batch pauses safely on provider quota response');

  write(statePath, initial());
  write(results, { jobs: [{ status: 'submitted' }], results: {} });
  const paused = await runPipeline(statePath, {
    credits: () => 0,
    batch: async (input, out, opts) => {
      calls++; assert.equal(opts.resume, true); assert.equal(out, results);
      throw new Error('Bugetul gratuit local de 3000 credite/24h nu mai permite apelul.');
    }
  });
  assert.equal(paused.phase, 'waiting_budget');
  assert.equal(calls, 1, 'existing submitted job resumes via its checkpoint, never a replacement output');
  assert.equal(read(statePath).currentJob, 'retry');

  write(statePath, initial());
  write(results, { jobs: [{ jobId: 'temporarily-unavailable', status: 'submitted', submittedAt: new Date().toISOString() }], results: {} });
  const temporary404 = { credits: () => 1000, batch: async (input, out, opts) => {
    assert.equal(opts.resume, true);
    assert.equal(out, results, 'retry must keep the original manifest');
    throw new Error('Geoapify a răspuns cu HTTP 404.');
  } };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const retrying = await runPipeline(statePath, temporary404);
    assert.equal(retrying.phase, 'retry_pending', 'temporary job 404 should resume automatically');
    assert.equal(retrying.transientFailure.attempts, attempt);
  }
  const persistent404 = await runPipeline(statePath, temporary404).catch(() => read(statePath));
  assert.equal(persistent404.phase, 'attention_required', 'persistent 404 must not retry forever');
  write(statePath, initial());
  write(results, { jobs: [{ jobId: 'expired', status: 'submitted', submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }], results: {} });
  const expired404 = await runPipeline(statePath, temporary404).catch(() => read(statePath));
  assert.equal(expired404.phase, 'attention_required', 'expired jobs require investigation');
  write(statePath, { ...initial(), lastError: 'old 404', transientFailure: { jobId: 'recovered', attempts: 1 } });

  let applied = false, imports = 0;
  const deps = {
    credits: () => 1000,
    batch: async (input, out, opts) => {
      calls++; assert.equal(opts.resume, true); assert.equal(opts.creditLedger, initial().creditLedger);
      write(out, { jobs: [{ status: 'complete' }], results: { store: {} } });
      return { pending: 0, results: 1 };
    },
    review: (input, out, path) => write(path, { items: [
      { customerId: 'same-cui-location-a', suggestedDecision: 'approve_recommended' },
      { customerId: 'same-cui-location-b', suggestedDecision: 'review' }
    ] }),
    importer: (db, path, audit, apply, approximate) => {
      assert.equal(approximate, true);
      assert.deepEqual(read(path).items.map(i => i.approved), [true, false], 'ambiguous rows remain unapproved');
      if (apply) { imports++; const n = applied ? 0 : 1; applied = true; return { applied: n }; }
      return { wouldApply: applied ? 0 : 1 };
    },
    queue: () => ({ counts: { positioned: 1, targeted_review: 1 }, retryCount: 0, freshCount: 0 })
  };
  const finished = await runPipeline(statePath, deps);
  assert.equal(finished.phase, 'research_required', 'unresolved addresses are not falsely complete');
  assert.equal(finished.lastImportCount, 1);
  assert.equal(finished.lastError, undefined, 'successful recovery clears the stale error');
  assert.equal(finished.transientFailure, undefined);
  assert.equal(read(statePath).reviews.length, 1);
  const settledCalls = calls;
  await runPipeline(statePath, deps);
  assert.equal(calls, settledCalls, 'finished automatic stages do not churn provider calls or queue files');

  // Simulate restart after an import committed but before its checkpoint was saved.
  write(statePath, initial());
  const recovered = await runPipeline(statePath, deps);
  assert.equal(recovered.lastImportCount, 0, 'idempotent importer preserves previous commit on replay');
  assert.equal(imports, 2);
  write(statePath, initial());
  const blocked = await runPipeline(statePath, { credits: () => 1000, batch: async () => { throw new Error('Raw query mismatch'); } }).catch(() => read(statePath));
  assert.equal(blocked.phase, 'attention_required');
  console.log('PASS: pipeline budget pause, checkpoint resume, reviewed-only import, restart recovery and unresolved-state accounting.');
} finally { rmSync(dir, { recursive: true, force: true }); }

