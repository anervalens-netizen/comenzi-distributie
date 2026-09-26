#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { batchPartners, createReview, importReview, createWorkQueue, creditCapacity } from './partner-geocode.mjs';

function read(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function save(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
function inFlight(path) {
  return existsSync(path) && read(path).jobs?.some(job => job.status === 'submitted');
}
export async function runPipeline(statePath, deps = {}) {
  const batch = deps.batch || batchPartners, review = deps.review || createReview;
  const importer = deps.importer || importReview, queue = deps.queue || createWorkQueue;
  const credits = deps.credits || creditCapacity;
  const state = read(statePath);
  if (state.version !== 1 || !Array.isArray(state.jobs) || !Array.isArray(state.reviews)) throw new Error('Invalid pipeline state');
  const report = (phase, extra = {}) => {
    Object.assign(state, extra, { phase, updatedAt: new Date().toISOString() });
    save(statePath, state);
  };
  if (['attention_required', 'research_required', 'completed'].includes(state.phase)) return state;
  try {
    for (;;) {
      let job = state.jobs.find(j => j.id === state.currentJob && j.status !== 'done');
      job ||= state.jobs.find(j => j.status !== 'done');
      if (!job) {
        const generation = (state.generation || 0) + 1;
        const prefix = join(state.root, 'pipeline-' + generation);
        const paths = { queue: prefix + '-queue.json', retry: prefix + '-retry.json', fresh: prefix + '-fresh.json' };
        let summary;
        if (existsSync(paths.queue) && existsSync(paths.retry) && existsSync(paths.fresh)) {
          summary = { counts: read(paths.queue).counts, retryCount: read(paths.retry).records.length, freshCount: read(paths.fresh).records.length };
        } else {
          summary = queue(state.db, state.reviews, paths.queue, paths.retry, paths.fresh);
        }
        state.generation = generation;
        state.counts = summary.counts;
        state.latestQueue = paths.queue;
        state.jobs = [];
        for (const [kind, path, count] of [['retry', paths.retry, summary.retryCount], ['fresh', paths.fresh, summary.freshCount]]) {
          if (count) state.jobs.push({ id: kind + '-' + generation, kind, input: path, results: path + '.results.json', review: path + '.review.json', status: 'pending' });
        }
        state.currentJob = null;
        if (!state.jobs.length) {
          const unresolved = Object.entries(state.counts).some(([key, count]) => key !== 'positioned' && count > 0);
          report(unresolved ? 'research_required' : 'completed');
          return state;
        }
        report('ready');
        continue;
      }
      const balance = credits(state.creditLedger);
      const pollBuffer = job.creditPollBuffer === undefined ? 100 : job.creditPollBuffer;
      if (balance <= pollBuffer + 1 && !inFlight(job.results)) {
        report('waiting_budget', { remainingEstimatedCredits: balance });
        return state;
      }
      state.currentJob = job.id;
      report('processing', { activeInput: job.input, remainingEstimatedCredits: balance });
      const result = await batch(job.input, job.results, {
        execute: true, resume: true, maxAddresses: 3000,
        creditLedger: state.creditLedger, timeoutMs: 60 * 60 * 1000,
        creditPollBuffer: pollBuffer, pollIntervalMs: 60 * 1000
      });
      delete state.lastError;
      delete state.transientFailure;
      review(job.input, job.results, job.review, true);
      const reviewed = read(job.review);
      for (const item of reviewed.items) item.approved = item.suggestedDecision === 'approve_recommended';
      save(job.review, reviewed);
      if (!state.reviews.includes(job.review)) state.reviews.push(job.review);
      const audit = job.review + '.audit-' + Date.now();
      importer(state.db, job.review, audit + '-dry.json', false, true);
      const imported = importer(state.db, job.review, audit + '.json', true, true);
      state.lastAudit = audit + '.json';
      state.lastImportCount = imported.applied;
      state.importedByController = (state.importedByController || 0) + imported.applied;
      job.status = result.pending === 0 ? 'done' : 'pending';
      job.returned = result.results;
      job.pending = result.pending;
      if (job.status === 'done') state.currentJob = null;
      report('ready');
      if (result.pending > 0 && result.results === job.lastReviewedCount) {
        report('waiting_budget', { remainingEstimatedCredits: credits(state.creditLedger) });
        return state;
      }
      job.lastReviewedCount = result.results;
    }
  } catch (error) {
    // A newly accepted Geoapify job can briefly return 404 before becoming readable.
    // Retry the saved job on the next timer tick; never resubmit its addresses.
    const current = state.jobs.find(job => job.id === state.currentJob);
    const submitted = current && existsSync(current.results)
      ? read(current.results).jobs?.find(job => job.status === 'submitted') : null;
    if (/HTTP 404/.test(error.message) && submitted) {
      const attempts = state.transientFailure?.jobId === submitted.jobId
        ? state.transientFailure.attempts + 1 : 1;
      const age = Date.now() - Date.parse(submitted.submittedAt);
      state.transientFailure = { jobId: submitted.jobId, attempts };
      if (Number.isFinite(age) && age >= 0 && age < 23 * 60 * 60 * 1000 && attempts <= 3) {
        report('retry_pending', { lastError: error.message });
        return state;
      }
    }
    const recoverable = /3000 credite|HTTP (402|429)|încă în procesare/.test(error.message);
    report(recoverable ? 'waiting_budget' : 'attention_required', { lastError: error.message });
    if (!recoverable) throw error;
    return state;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const statePath = process.argv[2] || '/storage/comenzi-distributie/geocoding/pipeline-state.json';
  runPipeline(statePath).then(state => console.log(JSON.stringify({ phase: state.phase, counts: state.counts, lastImportCount: state.lastImportCount }))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}

