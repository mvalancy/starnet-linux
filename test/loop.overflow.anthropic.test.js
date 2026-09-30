/* node test/loop.overflow.anthropic.test.js — F1 of the 2026-09-22 Hermes audit, end to end through the REAL
   native Anthropic adapter (stubbed fetch, no network, no sidecar):

   (A) Anthropic's own overflow wording — 400 "prompt is too long: 215000 tokens > 200000 maximum" — arrives
       mid-run with a REALISTIC approxTokens that would NOT trip the old 0.4·contextLimit ratio heuristic. It used
       to classify format_error (the old pattern wanted `maximum … tokens` in that order) and kill the run. Now:
       exactly one fold, one retry, run ends `done`.
   (B) The ratio fallback uses the prompt's CURRENT size. o.approxTokens is frozen at run start; a run whose
       history has since grown past 40% of the window and then gets an unrecognizable 400 is still recognized as
       an overflow (live estimate from the context manager) instead of dying as format_error. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');

const NL = String.fromCharCode(10);
const line = obj => 'data: ' + JSON.stringify(obj);
const okSse = text => new Response([
  line({ type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 0 } } }),
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
  line({ type: 'message_stop' }),
  ''
].join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const anthropicError = (status, message) => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
  { status, headers: { 'Content-Type': 'application/json' } });

function upstream(script) {
  const posts = [];
  const fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });   // catalog re-warm
    posts.push(JSON.parse(init.body));
    return script(posts.length);
  };
  return { fetch, posts };
}
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  return { seq, emit: makeEmitter(bus, () => {}) };
}
const priceOf = () => ({ in: 3, out: 15 });

(async () => {
  // (A) the native "prompt is too long" error, realistic approxTokens
  {
    const approxTokens = 5000, contextLimit = 200000;
    const overflow = 'prompt is too long: 215000 tokens > 200000 maximum';
    // proof the OLD path could not have saved this run: a bare 400 at this size is NOT an overflow by ratio
    A.eq(classifyApiError(Object.assign(new Error('anthropic http 400 - invalid request'), { status: 400 }), { approxTokens, contextLimit }).reason,
      'format_error', 'the ratio heuristic does not fire at 5k/200k — only the phrasing can identify this overflow');

    const up = upstream(n => n === 1 ? anthropicError(400, overflow) : okSse('finished after the fold'));
    const provider = makeAnthropicProvider({ fetch: up.fetch, key: 'fixture-only', baseUrl: 'https://anthropic.fixture.invalid/v1' });
    const { seq, emit } = setup();
    let summarized = 0;
    const history = [
      { role: 'system', content: 'You are a station agent.' },
      { role: 'user', content: 'Refactor the importer.' },
      { role: 'assistant', content: 'Reading the importer and its tests. ' + 'a'.repeat(4000) },
      { role: 'user', content: 'Also keep the CLI flags stable. ' + 'b'.repeat(4000) },
      { role: 'assistant', content: 'Noted — flags stay stable. ' + 'c'.repeat(4000) },
      { role: 'user', content: 'Continue.' }
    ];
    const res = await runAgentLoop({
      messages: history, provider, emit, cost: makeCostEngine({ priceOf }), model: 'claude-sonnet-4-5', agentId: 'a', runId: 'r',
      context: makeContext({ contextLimit, compactAt: 0.65, keepTail: 1 }),
      summarize: async () => { summarized++; return 'SUMMARY: importer refactor, CLI flags must stay stable.'; },
      approxTokens, contextLimit, sleep: async () => {}, random: () => 0.5
    });
    A.eq(res.reason, 'done', 'the Anthropic overflow folded and the run finished');
    A.eq(up.posts.length, 2, 'exactly one overflowing request and one retry after the fold');
    A.eq(summarized, 1, 'the summarizer ran once for the recovery fold');
    const compacts = seq.filter(e => e.name === 'agent.compact');
    A.eq(compacts.length, 1, 'exactly ONE fold');
    A.ok(compacts.length > 0 && compacts[0].payload.afterTokens < compacts[0].payload.beforeTokens, 'the fold genuinely shrank the prompt');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'no run.error: the overflow was recovered, not surfaced');
    const retried = JSON.stringify(up.posts[1].messages) + JSON.stringify(up.posts[1].system || '');
    A.ok(retried.indexOf('SUMMARY: importer refactor') >= 0, 'the retried request carries the summary');
    A.ok(retried.indexOf('b'.repeat(4000)) < 0, 'the folded history is gone from the retried request');
    A.ok(res.messages.some(m => m.role === 'assistant' && m.content === 'finished after the fold'), 'the delivered answer is the post-fold turn');
  }

  // (B) a grown run + an unrecognizable 400: the classifier sees the LIVE prompt size, not the frozen start figure
  {
    const contextLimit = 200000;
    const up = upstream(n => n === 1 ? anthropicError(400, 'invalid request') : okSse('recovered by the live estimate'));
    const provider = makeAnthropicProvider({ fetch: up.fetch, key: 'fixture-only', baseUrl: 'https://anthropic.fixture.invalid/v1' });
    const { seq, emit } = setup();
    const big = 'x'.repeat(400000);   // ~100k tokens by the local estimator: > 0.4 x 200k
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'directive' }, { role: 'user', content: 'tool dump ' + big }, { role: 'assistant', content: 'read it' }, { role: 'user', content: 'go on' }],
      provider, emit, cost: makeCostEngine({ priceOf }), model: 'claude-sonnet-4-5', agentId: 'a', runId: 'r',
      context: makeContext({ contextLimit, compactAt: 0.65, keepTail: 1 }), summarize: async () => 'SUMMARY of the dump',
      approxTokens: 100,   // frozen at run start, before the history grew
      contextLimit, sleep: async () => {}, random: () => 0.5
    });
    A.eq(res.reason, 'done', 'the grown run was recognized as overflowing and recovered');
    A.eq(seq.filter(e => e.name === 'agent.compact').length, 1, 'one fold, driven by the live estimate');
    A.eq(up.posts.length, 2, 'one refused request, one retry');
  }

  A.report('loop.overflow.anthropic.test');
})();
