/* node test/loop.retry-events.test.js — LIVE RETRY EVENTS (2026-09-23, live-events lane).

   The retry ladder (sidecar/loop.js + recovery-policy.js, ~105 s of patience) used to run SILENT: the only events a
   Commander or an API caller saw were run start and then, much later, the answer or the error. Now every same-turn
   retry emits provider.retry BEFORE its backoff sleep, carrying the same attempt numbering the run records for its
   recovery attempts, the classifier's reason, and the wait the loop will actually sleep:

     · ladder retry, pre-stream (no stream event on the failed attempt) and mid-stream (text had arrived)
     · a server-stated Retry-After rides as retryAfterMs, and delayMs is the (capped, jittered) wait actually slept
     · the truncated-stream retry (its own single-retry class)
     · no injected sleep -> delayMs 0 (the retry goes out at once; "retry in 30s" would be a lie)
     · no injected ticker -> no agent.waiting at all (every existing caller byte-identical)

   Every event goes through the REAL validating emitter (shared/emitter.js), so a payload that broke the contract
   would be dropped and fail here. Deterministic: a hand-rolled provider, sleep/random injected, no timers. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const Policy = require('../sidecar/recovery-policy.js');

const priceOf = () => ({ in: 1, out: 2 });
const httpErr = (status, message, headers) => Object.assign(new Error(message), { status, headers: headers || {} });
const answer = text => [
  { type: 'text', delta: text },
  { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  { type: 'done', finishReason: 'stop' }
];
// script(n) -> { events: [...], throw?: Error } for the n-th model call (1-based); each call replays fresh.
function scripted(script) {
  const calls = [];
  return {
    calls, priceOf, contextLimit: () => 0,
    stream: async function* (req) { calls.push(req); const step = script(calls.length); for (const ev of (step.events || [])) yield ev; if (step.throw) throw step.throw; }
  };
}
async function run(provider, extra) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const dropped = [];
  const emit = makeEmitter(bus, e => dropped.push(e));
  const sleeps = [], recov = [];
  const opts = Object.assign({
    messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf }), model: 'fixture-model', agentId: 'a', runId: 'r',
    // snapshot how many provider.retry events had been emitted at the moment each sleep began
    sleep: async ms => { sleeps.push({ ms, retriesSeen: seq.filter(e => e.name === 'provider.retry').length }); },
    random: () => 0.5, onRecovery: row => recov.push(row)
  }, extra || {});
  const res = await runAgentLoop(opts);
  return { res, seq, sleeps, recov, dropped, retries: seq.filter(e => e.name === 'provider.retry').map(e => e.payload) };
}

(async () => {
  // ---- 1. the ladder, pre-stream: 503, 503, answer ----
  {
    const p = scripted(n => (n <= 2 ? { throw: httpErr(503, 'upstream overloaded') } : { events: answer('ok') }));
    const { res, seq, sleeps, recov, dropped, retries } = await run(p);
    A.eq(res.reason, 'done', 'the ladder rode out two 503s');
    A.eq(dropped.length, 0, 'every emitted payload passed the frozen contract (none dropped): ' + JSON.stringify(dropped.slice(0, 1)));
    A.eq(retries.length, 2, 'one provider.retry per rung taken');
    A.eq(retries.map(r => r.attempt), [1, 2], 'attempts count up');
    A.eq(retries.map(r => r.reason), ['overloaded', 'overloaded'], 'reason = the classifier reason');
    A.eq(retries.map(r => r.delayMs), [400, 1200], 'delayMs = the un-jittered rungs at random 0.5');
    A.eq(sleeps.map(s => s.ms), [400, 1200], 'and those are exactly the waits slept');
    A.eq(sleeps.map(s => s.retriesSeen), [1, 2], 'each provider.retry was emitted BEFORE its sleep began');
    A.eq(retries.map(r => r.stage), ['pre_stream', 'pre_stream'], 'no stream event arrived on the failed attempts -> pre_stream');
    A.eq(retries.map(r => r.maxAttempts), [Policy.RETRY_DELAYS_MS.length, Policy.RETRY_DELAYS_MS.length], 'maxAttempts = the ladder rungs');
    A.eq(retries.map(r => r.waitedMs), [0, 400], 'waitedMs = local backoff spent BEFORE this rung');
    A.ok(retries.every(r => r.patienceMs === Policy.RETRY_PATIENCE_MS), 'patienceMs = the ladder total');
    A.ok(retries.every(r => r.model === 'fixture-model' && r.agentId === 'a' && r.runId === 'r'), 'model/agent/run ride along');
    A.ok(retries.every(r => !('retryAfterMs' in r)), 'no server-stated wait -> no retryAfterMs field');
    A.eq(recov.filter(r => r.action === 'retry').map(r => r.attempt), retries.map(r => r.attempt), 'same numbering as the run\'s recorded recovery attempts');
    A.eq(seq.filter(e => e.name === 'provider.fallback').length, 0, 'a same-provider retry is still never a fallback');
    A.eq(seq.filter(e => e.name === 'agent.waiting').length, 0, 'no ticker injected -> no agent.waiting heartbeat');
    const iRetry = seq.findIndex(e => e.name === 'provider.retry'), iToken = seq.findIndex(e => e.name === 'agent.token');
    A.ok(iRetry >= 0 && iRetry < iToken, 'the retry is visible before the answer streams');
  }

  // ---- 2. the ladder, mid-stream: text streamed, then a 500 ----
  {
    const p = scripted(n => (n === 1 ? { events: [{ type: 'text', delta: 'half an ans' }], throw: httpErr(500, 'internal error') } : { events: answer('half an answer, whole') }));
    const { res, retries } = await run(p);
    A.eq(res.reason, 'done', 'mid-stream failure recovered');
    A.eq(retries.length, 1, 'one retry');
    A.eq([retries[0].attempt, retries[0].reason, retries[0].stage, retries[0].delayMs], [1, 'server_error', 'mid_stream', 400], 'mid_stream: the failed attempt had streamed');
  }

  // ---- 3. a server-stated Retry-After: honored, capped, upward-jittered — and reported as such ----
  {
    const p = scripted(n => (n === 1 ? { throw: httpErr(429, 'rate limited', { 'retry-after': '5' }) } : { events: answer('ok') }));
    const { res, retries, sleeps } = await run(p);
    A.eq(res.reason, 'done', 'rate limit rode out');
    A.eq(retries.length, 1, 'one retry');
    A.eq(retries[0].reason, 'rate_limit', 'reason rate_limit');
    A.eq(retries[0].retryAfterMs, 5000, 'the server-stated wait rides as retryAfterMs');
    A.eq(retries[0].delayMs, sleeps[0].ms, 'delayMs is exactly the wait slept');
    A.ok(retries[0].delayMs >= 5000, 'never earlier than the server asked (' + retries[0].delayMs + ')');
  }

  // ---- 4. the truncated-stream retry (its own one-shot class) ----
  {
    const p = scripted(n => (n === 1 ? { events: [{ type: 'text', delta: 'cut' }, { type: 'done', finishReason: null, truncated: true }] } : { events: answer('cut, then whole') }));
    const { res, retries, sleeps } = await run(p);
    A.eq(res.reason, 'done', 'truncation re-run once and completed');
    A.eq(retries.length, 1, 'one provider.retry for the truncation');
    A.eq([retries[0].attempt, retries[0].reason, retries[0].maxAttempts, retries[0].stage, retries[0].delayMs], [1, 'truncated', 1, 'mid_stream', 400], 'truncated: attempt 1 of 1, mid_stream, first rung');
    A.eq(sleeps.map(s => s.retriesSeen), [1], 'emitted before its sleep');
  }

  // ---- 5. no injected sleep: the retry goes out at once, so the event says 0 ----
  {
    const p = scripted(n => (n === 1 ? { throw: httpErr(503, 'upstream overloaded') } : { events: answer('ok') }));
    const { res, retries } = await run(p, { sleep: undefined });
    A.eq(res.reason, 'done', 'recovered without a sleep');
    A.eq(retries.map(r => r.delayMs), [0], 'delayMs 0: no backoff actually happens without an injected sleep');
  }

  // ---- 6. a fatal class never announces a retry ----
  {
    const p = scripted(() => ({ throw: httpErr(401, 'invalid api key') }));
    const { res, retries } = await run(p);
    A.eq(res.reason, 'error', 'auth failure ends the run');
    A.eq(retries.length, 0, 'no provider.retry for a non-retryable failure');
  }

  // ---- 9. maxAttempts is truthful when the patience budget ends the ladder early ----
  {
    // the adapter already spent 2 rungs AND ~all of the local patience before handing the failure up
    const spent = Object.assign(httpErr(503, 'upstream overloaded'), { preStreamRetriesExhausted: true, preStreamAttempts: 3, preStreamWaitMs: Policy.RETRY_PATIENCE_MS - 600 });
    const p = scripted(n => (n === 1 ? { throw: spent } : { events: answer('ok') }));
    const { res, retries } = await run(p);
    A.eq(res.reason, 'done', 'the last rung recovered');
    A.eq([retries[0].attempt, retries[0].delayMs, retries[0].maxAttempts], [3, 600, 3], 'the rung that spends the last of the budget says 3/3, not 3/6');
    const p2 = scripted(n => (n <= 2 ? { throw: httpErr(503, 'upstream overloaded') } : { events: answer('ok') }));
    A.eq((await run(p2)).retries.map(r => r.maxAttempts), [6, 6], 'budget left: the rung count stands');
  }

  // ---- 10. a truncated stream resets the idle-stall count (it DID deliver bytes) ----
  {
    const { timeouts } = require('../sidecar/providers/provider.js');
    const idle = () => timeouts.timeoutError(300000, 'idle');
    const p = scripted(n => n === 1 ? { throw: idle() }
      : n === 2 ? { events: [{ type: 'text', delta: 'partial' }, { type: 'done', finishReason: null, truncated: true }] }
      : n === 3 ? { throw: idle() }
      : { events: answer('ok') });
    const { res } = await run(p);
    A.eq(res.reason, 'done', 'stall, truncation, stall: two NON-consecutive stalls never end the run provider_stalled');
    A.eq(p.calls.length, 4, 'every attempt went out');
  }

  A.report('loop.retry-events');
})().catch(e => { console.error(e); process.exit(1); });
