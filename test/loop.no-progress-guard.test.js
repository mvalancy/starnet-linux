/* node test/loop.no-progress-guard.test.js — Step 2 F1 (c) of the 2026-09-22 Hermes audit: NO-PROGRESS SUCCESS
   POLLING on a non-read tool (sidecar/loop-breaker.js, loop.js step 9).

   The identical-failure loop guard only counts FAILURES, and the evidence-progress guard (tool-progress-guard.js)
   only tracks reads / browser / tool.search. So a model that kept making the same SUCCESSFUL non-read call — a
   shell poll, a connector status call — and getting the same answer ran until a human noticed. Now: a tool turn
   whose calls all succeeded with the same (tool, canonical args, normalized result) as the previous tool turn
   extends a streak; one <no_progress> nudge at 3 on every surface, a hard stop at 5 only when UNATTENDED.
   Anything that changes — the result, the arguments, another call in between, a failure — resets it; calls the
   host's progress guard already owns (o.progressTracked) are left to it.

   Deterministic: scripted provider + scripted dispatch, no network. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');

const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const usage = { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
function scripted(turns) {
  const script = turns.map((calls, t) => calls.map((c, i) => [
    { type: 'tool_start', index: i, id: 't' + t + '_' + i, name: c.name },
    { type: 'tool_args', index: i, chunk: c.raw != null ? c.raw : JSON.stringify(c.args || {}) }
  ]).reduce((a, b) => a.concat(b), []).concat([usage, { type: 'done', finishReason: 'tool_calls' }]));
  script.push([{ type: 'text', delta: 'final answer' }, usage, { type: 'done', finishReason: 'stop' }]);
  let n = 0;
  return {
    async *stream() { const t = script[Math.min(n, script.length - 1)]; n++; for (const ev of t) yield ev; },
    priceOf: () => ({ prompt: '0', completion: '0' }), contextLimit: () => 8000, callCount: () => n
  };
}
const repeat = (k, fn) => Array.from({ length: k }, (_, i) => fn(i));
async function run(provider, dispatch, extra) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  const messages = [{ role: 'user', content: 'wait for the deploy' }];
  const res = await runAgentLoop(Object.assign({ messages, provider, emit, dispatch, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', capCtx: openCtx() }, extra || {}));
  return { res, seq, messages };
}
const ok = content => ({ ok: true, isError: false, content, summary: 'ok' });
const nudges = messages => messages.filter(m => m.role === 'system' && m.content.indexOf('<no_progress>') === 0);
const errors = seq => seq.filter(e => e.name === 'agent.run.error');
const POLL = { name: 'shell_exec', args: { command: 'curl -s https://deploy.invalid/status' } };

(async () => {
  // ---- the stuck poll, UNATTENDED: nudge at 3, stop at 5 ----
  {
    const provider = scripted(repeat(12, () => [POLL]));
    const { res, seq, messages } = await run(provider, async () => ok('{"state":"pending"}\n[exit 0]'), { unattended: true });
    A.eq(res.reason, 'error', 'unattended: an unchanged successful poll is stopped');
    A.eq(provider.callCount(), 5, 'stopped on the 5th identical turn, not the 12th');
    A.eq(res.failureStage, 'tool_loop', 'failureStage tool_loop');
    A.eq(res.failureCode, 'no_progress', 'failureCode no_progress');
    const errs = errors(seq);
    A.eq(errs.length, 1, 'one agent.run.error');
    A.ok(/shell_exec returned the identical result 5 turns in a row/.test(errs[0].payload.message), 'the stop names the tool and the streak: ' + errs[0].payload.message);
    const n = nudges(messages);
    A.eq(n.length, 1, 'exactly one no-progress nudge before the stop');
    A.ok(/\(shell_exec\) 3 turns in a row/.test(n[0].content), 'the nudge fires on the 3rd identical turn');
    A.ok(/stop it after 5 identical turns/.test(n[0].content), 'an unattended nudge says the stop is coming');
    A.eq(messages.filter(m => m.role === 'tool').length, 5, 'every call got its paired result before the stop');
  }

  // ---- the same poll on an INTERACTIVE run is only warned ----
  {
    const provider = scripted(repeat(12, () => [POLL]));
    const { res, seq, messages } = await run(provider, async () => ok('{"state":"pending"}\n[exit 0]'), { limits: { maxIters: 9, grace: false } });
    A.eq(res.reason, 'max_iters', 'interactive: warn only — runs to the Commander\'s own ceiling');
    A.eq(errors(seq).length, 0, 'no stop on a watched run');
    A.eq(nudges(messages).length, 1, 'one nudge (it fires once per streak)');
    A.ok(!/unattended/.test(nudges(messages)[0].content), 'the interactive nudge promises no stop');
  }

  // ---- a changing result is progress: never a streak ----
  {
    const provider = scripted(repeat(10, () => [POLL]));
    let k = 0;
    const { res, messages } = await run(provider, async () => ok('{"state":"pending","pct":' + (++k * 10) + '}\n[exit 0]'), { unattended: true });
    A.eq(res.reason, 'done', 'a poll whose answer moves is progress — the run finishes');
    A.eq(nudges(messages).length, 0, 'no nudge while the answer changes');
  }

  // ---- host-generated volatility (durations, call ids, parked-output paths) is NOT progress ----
  {
    const provider = scripted(repeat(10, () => [POLL]));
    let k = 0;
    const { res } = await run(provider, async () => { k++; return ok('still pending after ' + (100 + k) + 'ms (call_x' + k + ')\n[exit 0]'); }, { unattended: true });
    A.eq(res.failureCode, 'no_progress', 'only the duration/call id changed -> still no progress (tool-progress-guard normalizeEvidence reused)');
  }

  // ---- a different call in between breaks the streak (A,B,A,B...) ----
  {
    const provider = scripted(repeat(12, i => [i % 2 ? { name: 'notify_send', args: { text: 'still waiting' } } : POLL]));
    const { res, messages } = await run(provider, async () => ok('same'), { unattended: true });
    A.eq(res.reason, 'done', 'alternating calls are not an identical consecutive repeat');
    A.eq(nudges(messages).length, 0, 'no nudge');
  }

  // ---- key order in the arguments cannot hide a repeat (canonical JSON) ----
  {
    const provider = scripted(repeat(8, i => [{ name: 'connector_status', raw: i % 2 ? '{"b":2,"a":1}' : '{"a":1,"b":2}' }]));
    const { res } = await run(provider, async () => ok('queued'), { unattended: true });
    A.eq(res.failureCode, 'no_progress', 'reordered keys are the same call');
  }

  // ---- calls the host's evidence-progress guard owns (reads) are left to it ----
  {
    const provider = scripted(repeat(9, () => [{ name: 'fs_read', args: { path: 'status.txt' } }]));
    const { res, messages } = await run(provider, async () => ok('pending'), { unattended: true, progressTracked: n => n === 'fs_read' });
    A.eq(res.reason, 'done', 'a tracked read is not double-counted here (tool-progress-guard blocks it at the dispatch seam instead)');
    A.eq(nudges(messages).length, 0, 'no loop-breaker nudge for a tracked read');
  }

  // ---- a failure is not "no progress": the streak resets ----
  {
    const provider = scripted(repeat(10, () => [POLL]));
    let k = 0;
    const { res } = await run(provider, async () => (++k % 4 === 0 ? { ok: false, isError: true, content: 'connection reset', summary: 'error' } : ok('pending')), { unattended: true });
    A.eq(res.reason, 'done', 'ok,ok,ok,FAIL,ok,ok,ok,FAIL... never reaches 5 identical successes in a row');
  }

  A.report('loop.no-progress-guard.test');
})();
