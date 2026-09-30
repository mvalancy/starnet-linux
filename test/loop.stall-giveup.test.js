/* node test/loop.stall-giveup.test.js — Step 2 F4 of the 2026-09-22 Hermes audit: a hung provider no longer keeps a
   run silent for ~37 minutes.

   The idle watchdog (providers/provider.js, SKYNET_PROVIDER_IDLE_MS, default 300s) turns a byte-silent stream into a
   retryable `timeout`, and the loop's ladder used to spend every rung on it: 7 attempts x 300s with no event in
   between. Now two CONSECUTIVE idle stalls on one provider/model end the ladder through recovery-policy: a configured
   fallback is taken (provider.fallback reason 'provider_stalled'); with none, the run ends error with
   failureCode 'provider_stalled' and a message that says the model stopped responding. Connect timeouts, other
   failure classes and single stalls keep the existing bounded ladder.

   Deterministic: the REAL openai-compatible adapter + the REAL idle watchdog over a stubbed fetch whose body sends
   headers and then nothing (idle window shortened to 40ms via the adapter's own env knob); sleep/random injected. */
'use strict';
process.env.SKYNET_PROVIDER_IDLE_MS = '40';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const Provider = require('../sidecar/providers/provider.js');
const P = require('../sidecar/recovery-policy.js');

const NL = String.fromCharCode(10);
const priceOf = () => ({ in: 1, out: 2 });
const sse = chunks => new Response(chunks.map(c => 'data: ' + JSON.stringify(c)).concat(['data: [DONE]', '', '']).join(NL),
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const textTurn = text => sse([
  { choices: [{ index: 0, delta: { content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
]);
// headers arrive, then the body never sends a byte: exactly what the idle watchdog exists for
const silent = () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const jsonErr = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'Content-Type': 'application/json' } });
function upstream(script) {
  const posts = [];
  const fetch = async (url, init) => {
    if (!/chat\/completions/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    posts.push(JSON.parse(init.body));
    return script(posts.length);
  };
  return { fetch, posts };
}
const adapter = fetch => makeOpenAICompatibleProvider({ fetch, key: 'fixture-only', baseUrl: 'https://fixture.invalid/v1', label: 'custom' });
async function runWith(provider, extra) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  const waits = [], recov = [];
  const res = await runAgentLoop(Object.assign({
    messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf }), model: 'fixture-model', agentId: 'a', runId: 'r',
    sleep: async ms => { waits.push(ms); }, random: () => 0.5, onRecovery: row => recov.push(row)
  }, extra || {}));
  return { res, seq, waits, recov };
}

(async () => {
  // ---- the pure policy ----
  {
    const idle = Provider.timeouts.timeoutError(300000, 'idle');
    const connect = Provider.timeouts.timeoutError(30000, 'connect');
    A.ok(P.isIdleStall(idle), 'the watchdog\'s idle error is a stall');
    A.ok(!P.isIdleStall(connect), 'a connect timeout (no headers, 30s) is NOT a stall — it stays on the ladder');
    A.ok(!P.isIdleStall(new Error('request timed out')), 'a generic timeout message is not a stall');
    A.ok(!P.isIdleStall(null), 'null is not a stall');
    A.eq(P.MAX_IDLE_STALLS, 2, 'two consecutive stalls end the ladder');
    const cls = { retryable: true, reason: 'timeout' };
    const base = { classification: cls, retriesUsed: 1, maxRetries: 6, recoveriesUsed: 0, maxRecoveries: 1 };
    A.eq(P.providerFailure(Object.assign({}, base, { idleStalls: 1 })).action, 'retry', 'ONE stall keeps the ordinary retry (a deep-reasoning turn can be slow once)');
    A.eq(P.providerFailure(Object.assign({}, base, { idleStalls: 2, hasFallback: false })), { action: 'fail', reason: 'provider_stalled', retryable: true, delayMs: 0 },
      'two stalls with no fallback -> fail provider_stalled');
    A.eq(P.providerFailure(Object.assign({}, base, { idleStalls: 2, hasFallback: true })), { action: 'fallback', reason: 'provider_stalled', retryable: true, delayMs: 0, rotate: false },
      'two stalls WITH a fallback -> take it');
    A.eq(P.providerFailure(Object.assign({}, base, { idleStalls: 2, hasFallback: true, recoveriesUsed: 1 })).reason, 'provider_stalled',
      'a spent fallback budget still fails as provider_stalled, never back onto the ladder');
    A.eq(P.providerFailure(base).action, 'retry', 'a caller that does not count stalls is unchanged');
    A.eq(P.providerFailure(Object.assign({}, base, { idleStalls: 5, maxIdleStalls: 0 })).action, 'retry', 'maxIdleStalls 0 disables the rule');
    A.eq(P.providerFailure(Object.assign({}, base, { idleStalls: 2, cancelled: true })).reason, 'cancelled', 'a cancel still outranks everything');
  }

  // ---- THE AUDIT SHAPE: a provider that connects and then never answers, no fallback -> 2 attempts, not 7 ----
  {
    const up = upstream(() => silent());
    const { res, seq, waits, recov } = await runWith(adapter(up.fetch));
    A.eq(res.reason, 'error', 'a stalled provider ends the run');
    A.eq(up.posts.length, 2, 'two silent attempts, then stop (was 7 x the idle window)');
    A.eq([res.failureStage, res.failureCode], ['provider_stream', 'provider_stalled'], 'failureCode provider_stalled');
    const err = seq.find(e => e.name === 'agent.run.error');
    A.ok(err && /^model stalled: 2 consecutive attempts on fixture-model received no response bytes/.test(err.payload.message), 'the Commander reads that the model stopped responding: ' + (err && err.payload.message));
    A.ok(/idle timed out after 40ms/.test(err.payload.message), 'with the watchdog\'s own evidence');
    A.eq(err.payload.transient, true, 'a stall is transient (try again later)');
    A.eq(waits, [400], 'one ordinary rung between the two stalls, then no further waiting');
    A.eq(recov.map(r => [r.action, r.reason]), [['retry', 'timeout']], 'recovery telemetry: one retry, no phantom ladder');
  }

  // ---- with a fallback configured, the stall moves to it and the run completes ----
  {
    const up = upstream(() => silent());
    const fb = upstream(() => textTurn('answered by the fallback'));
    const { res, seq } = await runWith(adapter(up.fetch), { fallbacks: [{ provider: adapter(fb.fetch), model: 'fallback-model' }] });
    A.eq(res.reason, 'done', 'the fallback answered');
    A.eq(up.posts.length, 2, 'the stalled primary got exactly two attempts');
    const f = seq.filter(e => e.name === 'provider.fallback');
    A.eq(f.length, 1, 'one failover');
    A.eq([f[0].payload.fromModel, f[0].payload.toModel, f[0].payload.reason], ['fixture-model', 'fallback-model', 'provider_stalled'], 'the failover says why: provider_stalled');
  }

  // ---- a different failure between stalls resets the count: the ordinary ladder still rides it out ----
  {
    const up = upstream(n => (n === 1 ? silent() : n === 2 ? jsonErr(502, 'bad gateway') : n === 3 ? silent() : textTurn('recovered')));
    const { res } = await runWith(adapter(up.fetch));
    A.eq(res.reason, 'done', 'stall, 502, stall, answer -> never two CONSECUTIVE stalls -> the run completes');
  }

  // ---- stalls are counted per turn: a success in between resets ----
  {
    const up = upstream(n => (n % 2 === 1 ? silent() : textTurn('turn ' + n)));
    const { res } = await runWith(adapter(up.fetch));
    A.eq(res.reason, 'done', 'one stall then an answer is the ordinary ladder at work');
    A.eq(up.posts.length, 2, 'stall + answer');
  }

  A.report('loop.stall-giveup.test');
})();
