/* node test/threshold.anchored.test.js — Step 2 wave 2, audit F1: the fold trigger is the USAGE ANCHOR.

   The bug: shouldCompact read the previous request's prompt_tokens, which excludes every tool result appended since.
   A reading just under the threshold followed by a large tool result sailed past the threshold unseen and the next
   request went out over it (the fold came one turn late — or never, if that request overflowed). Now:
   anchor = last real prompt_tokens + the ruler's estimate of what was appended after that reading.

   Real runAgentLoop + makeContext (RUN_CONTEXT_DEFAULTS) + a provider that reports honest prompt_tokens. */
'use strict';
const A = require('./_assert.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext, RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const fidelity = require('../sidecar/compaction-fidelity.js');

(async () => {
  // ---- 0. the anchor itself (pure) ----
  A.eq(fidelity.usageAnchor(null, 900), 900, 'no reading -> the full local ruler');
  A.eq(fidelity.usageAnchor({ promptTokens: 12000, rulerAtReading: 10000 }, 18000), 20000, 'reading + what grew since');
  A.eq(fidelity.usageAnchor({ promptTokens: 12000, rulerAtReading: 10000 }, 9000), 12000, 'a shrink since the reading never goes under the real count');
  A.eq(fidelity.usageAnchor({ promptTokens: 0, rulerAtReading: 10000 }, 700), 700, 'a zero reading is no reading');

  // ---- 1. reading under the threshold + an appended result over it -> fold BEFORE the next request ----
  {
    const WIN = 20000;                                   // threshold 13,000 tokens
    const ctx = makeContext(Object.assign({ contextLimit: WIN }, RUN_CONTEXT_DEFAULTS));
    const requests = [];   // { n, est, compactsBefore }
    const compacts = [];
    let n = 0;
    const provider = {
      priceOf: () => null, contextLimit: () => WIN,
      stream: async function* (req) {
        n++;
        const est = ctx.estimateMessages(req.messages);
        requests.push({ n, est, compactsBefore: compacts.length, messages: req.messages.slice() });
        if (n <= 3) {
          yield { type: 'tool_start', index: 0, id: 'c' + n, name: 'read' };
          yield { type: 'tool_args', index: 0, chunk: '{"path":"f' + n + '"}' };
          yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 3, total_tokens: est + 3 } };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'text', delta: 'done reading' };
        yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 3, total_tokens: est + 3 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    };
    // result sizes: #1 22k chars (~5.5k tok), #2 20k chars (~5k tok) -> request 3 reads ~10.6k (< 13k threshold);
    // #3 is 16k chars (~4k tok) appended after that reading -> the anchor is ~14.6k, over the threshold.
    const sizes = { f1: 22000, f2: 20000, f3: 16000 };
    const res = await runAgentLoop({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read f1..f3' }], provider,
      cost: makeCostEngine({ priceOf: () => null }), context: ctx,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      dispatch: async (c) => ({ ok: true, content: 'BODY ' + c.args.path + ' ' + 'r'.repeat(sizes[c.args.path] || 10) }),
      emit: (nm, p) => { if (nm === 'agent.compact') compacts.push(p); },
      summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }),
      model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 10 }
    });
    A.eq(res.reason, 'done', 'the run completes');
    const r3 = requests[2], r4 = requests[3];
    A.ok(r3 && r3.est < 0.65 * WIN, 'fixture: request 3 read UNDER the threshold (' + (r3 && r3.est) + ' < 13000)');
    A.eq(requests[2].compactsBefore, 0, 'no fold before request 3 (nothing was over)');
    A.ok(r4 && r4.compactsBefore >= 1, 'a fold happened between request 3 and request 4 — the appended result was counted');
    A.ok(r4 && r4.est < 0.65 * WIN, 'request 4 went out under the threshold (' + (r4 && r4.est) + ')');
    A.ok(compacts[0].beforeTokens > 0.65 * WIN, 'the fold saw the anchored size, over the threshold (' + compacts[0].beforeTokens + ', last reading ' + r3.est + ')');
    A.ok(r4.messages.some(m => m.role === 'tool' && /^\[tool result elided at compaction/.test(String(m.content))), 'the free micro tier did the fold (older results elided to their heads)');
  }

  // ---- 2. a provider that reports NO usage still gets proactive folds (the ruler decides) ----
  {
    const WIN = 20000;
    const ctx = makeContext(Object.assign({ contextLimit: WIN }, RUN_CONTEXT_DEFAULTS));
    let n = 0; const ests = []; let compacts = 0;
    const provider = { priceOf: () => null, contextLimit: () => WIN, stream: async function* (req) {
      n++; ests.push(ctx.estimateMessages(req.messages));
      if (n <= 5) { yield { type: 'tool_start', index: 0, id: 'c' + n, name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' }; yield { type: 'done', finishReason: 'tool_calls' }; return; }
      yield { type: 'text', delta: 'ok' }; yield { type: 'done', finishReason: 'stop' };
    } };
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
      dispatch: async () => ({ ok: true, content: 'x'.repeat(16000) }), emit: (nm) => { if (nm === 'agent.compact') compacts++; },
      summarize: async () => 'S', model: 'm', agentId: 'a', runId: 'r', limits: { maxIters: 10 } });
    A.eq(res.reason, 'done', 'a usage-less run completes');
    A.ok(compacts >= 1, 'it folded without any usage reading (' + compacts + ' folds)');
    A.ok(Math.max.apply(null, ests) < 0.65 * WIN, 'no request went out over the threshold (max ' + Math.max.apply(null, ests) + ')');
  }

  A.report('threshold.anchored.test');
})().catch(e => { console.error(e); process.exit(1); });
