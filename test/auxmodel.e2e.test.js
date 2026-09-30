/* node test/auxmodel.e2e.test.js — TRUE end-to-end proof of the AUX MODEL/EFFORT TIER (aux-tier lane).

   WHAT THIS LOCKS: STARNET_AUX_MODEL points every auxiliary LLM pass at a cheap model while the MAIN run keeps
   its own. Three arms against the REAL sidecar + a mock OpenRouter that records every model call:

     ARM A — routing: with STARNET_AUX_MODEL=aux/cheap (declared reasoning-capable but NOT tool-capable in the
             catalog) and the governor off, one substantial task run fires the aux passes. The single-shot
             passes (reflection · study · thread-mine · scout) must ride aux/cheap with per-request reasoning
             effort 'low'; the SKILL REVIEW fork — a nested TOOL loop — must FALL BACK to the run model because
             aux/cheap is verifiably tool-less. The main run stays on run/model.
     ARM B — compaction: a tiny-context model forces a mid-run fold. Run 1 proves the summarizer rides the aux
             model. Run 2 makes the aux-model summary fail (400) and proves the fold RETRIES ONCE on the run's
             own model and the run still compacts + completes — the tier never makes compaction less reliable.
     ARM C — control: with NO aux env set, every provider request carries the run model and no request grows a
             `reasoning` field — the unconfigured install is byte-identical to before the tier existed.

   ZERO network, zero real key (the fake key routes to the mock). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RUN_MODEL = 'run/model';
const AUX_MODEL = 'aux/cheap';

// a ~6 KB plain-text assistant reply: clears reflect/study/threadmine salience (>=200 chars) AND
// skillReview.shouldReviewRun (>=5000) so every aux pass qualifies on a fresh workspace.
const LONG_REPLY = ('I dug through the deploy pipeline and rebuilt the staging rollback path end to end. ' +
  'Here is the substantive write-up with the reasoning, the tradeoffs, and the follow-ups worth remembering. ')
  .repeat(40);

function sse(res, deltas, usage, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const delta of deltas) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

/* mock OpenRouter. Catalog: run/model = tool-capable, NO reasoning; aux/cheap = reasoning-capable, NO tools.
   Records {model, sys, main, summary, reasoning} per /chat/completions call. opts.runContext shrinks the run
   model's window to force compaction; state.failAuxSummary 400s a summary request on the aux model. */
function startMock(opts) {
  const state = { calls: [], failAuxSummary: false };
  const runContext = (opts && opts.runContext) || 8000;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [
          { id: RUN_MODEL, context_length: runContext, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
          { id: AUX_MODEL, context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning'] }
        ] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
          const body = JSON.parse(raw);
          const messages = body.messages || [];
          const sysMsg = messages.find(m => m && m.role === 'system');
          // applyCacheControl never structures non-anthropic models, but stay defensive about content shape.
          const sys = sysMsg ? (typeof sysMsg.content === 'string' ? sysMsg.content : JSON.stringify(sysMsg.content)) : '';
          const rec = {
            model: body.model,
            sys: sys.slice(0, 200),
            // the MAIN task run is the ONLY call carrying the full '[RUNTIME]' agent system prompt (the aux
            // passes and the summarizer all build their own short system prompts).
            main: raw.indexOf('[RUNTIME]') >= 0,
            summary: messages.some(m => String((m && typeof m.content === 'string') ? m.content : '').indexOf('Summarize this earlier part of the conversation') >= 0),
            reasoning: body.reasoning || null,
            tools: Array.isArray(body.tools) ? body.tools.length : 0
          };
          state.calls.push(rec);
          if (state.failAuxSummary && rec.summary && rec.model === AUX_MODEL) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'aux summary rejected (test fault injection)', code: 400 } }));
            return;
          }
          if (rec.summary) { sse(res, [{ content: 'Earlier turns folded into a safe summary.' }], { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, 'stop'); return; }
          if (rec.main) {
            // compaction arm: first main call returns ONE tool call so the run has a second turn to fold before
            if ((opts && opts.toolTurn) && !messages.some(m => m && m.role === 'tool')) {
              sse(res, [{ tool_calls: [{ index: 0, id: 'inspect_once', type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] }],
                { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }, 'tool_calls');
              return;
            }
            sse(res, [{ content: LONG_REPLY }], { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }, 'stop');
            return;
          }
          sse(res, [{ content: 'ok, done.' }], { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, 'stop');
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

async function driveRun(fixture, agentId, text, history) {
  const messages = (Array.isArray(history) ? history : []).concat([{ role: 'user', content: text }]);
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-or-v1-auxmodel-fake', model: RUN_MODEL, agentId, isTask: true, messages })
  });
  A.eq(r.status, 200, 'the real /api/run stream opened for ' + agentId);
  const raw = await r.text();
  return raw.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// wait for the fire-and-forget aux passes to settle: poll the recorded-call counter until stable.
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 12000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    if (state.calls.length !== last) { last = state.calls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 1500)) break;
    await sleep(200);
  }
}

const COMMON = { SKYNET_QUEST_REFRESH: '0', SKYNET_FULL_ACCESS: '1' };

(async () => {
  // ---- ARM A — aux routing + effort + skill-review tool-capability fallback --------------------------------
  {
    const mock = await startMock({});
    const fixture = SidecarFixture.create({
      prefix: 'sk-auxmodel-a-',
      env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, STARNET_AUX_MODEL: AUX_MODEL, SKYNET_AUX_BUDGET: '0' }, COMMON)
    });
    await fixture.start();
    try {
      await driveRun(fixture, 'auxmodel-route', 'Rebuild the staging deploy rollback path and write up what changed and why');
      await settle(mock.state);
      const calls = mock.state.calls;
      if (process.env.AUXDEBUG) calls.forEach((c, i) => console.error('  #' + i + ' model=' + c.model + ' main=' + c.main + ' reasoning=' + JSON.stringify(c.reasoning) + ' sys=' + c.sys.replace(/\s+/g, ' ').slice(0, 90)));
      const main = calls.filter(c => c.main);
      const review = calls.filter(c => c.sys.indexOf('skillbase maintenance worker') >= 0);
      const reflection = calls.filter(c => c.sys.indexOf('reflecting right after finishing a task') >= 0);
      const singleShots = calls.filter(c => !c.main && review.indexOf(c) < 0);
      A.ok(main.length >= 1 && main.every(c => c.model === RUN_MODEL), 'the MAIN run stayed on the run model');
      A.ok(reflection.length === 1, 'the reflection pass fired exactly once');
      A.eq(reflection[0] && reflection[0].model, AUX_MODEL, 'reflection rode the configured aux model');
      A.eq(reflection[0] && reflection[0].reasoning && reflection[0].reasoning.effort, 'low', 'reflection carried per-request reasoning effort low (the aux-tier default)');
      A.ok(singleShots.length >= 2, 'more than one single-shot aux pass fired (governor off, salient run) — non-vacuous');
      A.ok(singleShots.every(c => c.model === AUX_MODEL), 'EVERY single-shot aux pass rode the aux model (got: ' + singleShots.map(c => c.model + '|' + c.sys.slice(0, 40)).join(', ') + ')');
      A.ok(singleShots.every(c => c.reasoning && c.reasoning.effort === 'low'), 'every single-shot aux pass carried effort low');
      A.ok(review.length >= 1, 'the skill-review fork fired (salient 5KB+ run, governor off)');
      A.ok(review.every(c => c.model === RUN_MODEL), 'skill review FELL BACK to the run model — aux/cheap is verifiably tool-less and a tool loop must never ride it');
      A.ok(review.every(c => c.tools > 0), 'the skill-review call really was a tool loop (tools on the wire)');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  // ---- ARM B — compaction on the aux model, with the one-retry reliability floor ---------------------------
  {
    const mock = await startMock({ runContext: 10, toolTurn: true });
    const fixture = SidecarFixture.create({
      prefix: 'sk-auxmodel-b-',
      env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, STARNET_AUX_MODEL: AUX_MODEL }, COMMON)
    });
    await fixture.start();
    try {
      await sleep(600);   // let the mocked model catalog warm — contextLimit is 0 (never compacts) until it does
      // enough foldable history that planCompaction has an `older` slice beyond the kept tail
      const history = [];
      for (let i = 0; i < 10; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: 'historical turn ' + i + ' with enough text to fold safely' });
      // Run 1 — the healthy path: the fold rides the aux model.
      const ev1 = await driveRun(fixture, 'auxmodel-fold', 'Inspect once, compact, then finish.', history);
      const sum1 = mock.state.calls.filter(c => c.summary);
      A.ok(sum1.length >= 1, 'run 1 produced a real summarizer call');
      A.ok(sum1.every(c => c.model === AUX_MODEL), 'the compaction summarizer rode the configured aux model');
      A.ok(sum1.every(c => c.reasoning && c.reasoning.effort === 'low'), 'the fold carried per-request effort low');
      // a 10-token window folds before the first call (preflight) and again after the tool turn: one truthful
      // compaction event per successful aux-model fold
      A.eq(ev1.filter(e => e.name === 'agent.compact').length, sum1.length, 'run 1 emitted one truthful compaction event per aux fold (' + sum1.length + ')');
      const end1 = ev1.filter(e => e.name === 'agent.run.end').pop();
      A.eq(end1 && end1.payload.reason, 'done', 'run 1 completed after the aux-model fold');

      // Run 2 — fault injection: the aux-model summary 400s; the fold must retry ONCE on the run model.
      const before = mock.state.calls.length;
      mock.state.failAuxSummary = true;
      const ev2 = await driveRun(fixture, 'auxmodel-fold-retry', 'Inspect once, compact under a failing aux model, then finish.', history);
      const sum2 = mock.state.calls.slice(before).filter(c => c.summary);
      A.ok(sum2.some(c => c.model === AUX_MODEL), 'run 2 first attempted the fold on the aux model');
      A.ok(sum2.some(c => c.model === RUN_MODEL), 'the failed aux fold RETRIED on the run\'s own model');
      const retried2 = sum2.filter(c => c.model === RUN_MODEL).length;
      A.ok(retried2 >= 1 && ev2.filter(e => e.name === 'agent.compact').length === retried2, 'run 2 still compacted once per fold — every failed aux fold was saved by its run-model retry (' + retried2 + ')');
      const end2 = ev2.filter(e => e.name === 'agent.run.end').pop();
      A.eq(end2 && end2.payload.reason, 'done', 'run 2 completed despite the aux-model summary failure');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  // ---- ARM C — control: no aux env => run model everywhere, no reasoning field appears ---------------------
  {
    const mock = await startMock({});
    const fixture = SidecarFixture.create({
      prefix: 'sk-auxmodel-c-',
      env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, SKYNET_AUX_BUDGET: '0' }, COMMON)
    });
    await fixture.start();
    try {
      await driveRun(fixture, 'auxmodel-control', 'Rebuild the staging deploy rollback path and write up what changed and why');
      await settle(mock.state);
      const calls = mock.state.calls;
      A.ok(calls.length >= 3, 'the control run fired the main call plus aux passes (' + calls.length + ' calls)');
      A.ok(calls.every(c => c.model === RUN_MODEL), 'with NO aux env, every call — main and aux — used the run model');
      A.ok(calls.every(c => !c.reasoning), 'with NO aux env, no request grew a reasoning field (requests byte-identical to before the tier)');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  A.report('auxmodel.e2e.test');
})().catch(e => { console.log('FAIL: auxmodel.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
