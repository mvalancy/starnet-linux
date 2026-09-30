/* node test/loop.fatal-keeps-partial.test.js — H2: text already streamed to the Commander survives a FATAL stream error.

   E2E witness (2026-09-22 audit): a mid-stream 401 after streamed text left NO assistant row — the durable transcript,
   result.messages and a resumed run all behaved as if the model had said nothing, although COMMS had shown the words.
   On the FINAL fatal end the loop now appends one provider-valid assistant turn (text, no tool calls) holding what was
   shown plus an explicit "[response interrupted — …; this answer is incomplete]" marker. A retry that recovers never
   leaves a fragment behind. Zero network — a hand-rolled provider throws/yields canned events. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
const httpErr = (s, m) => Object.assign(new Error('http ' + s + (m ? ' — ' + m : '')), { status: s });
const timeoutErr = () => { const e = new Error('provider stream idle timed out after 120000ms'); e.code = 'PROVIDER_STREAM_TIMEOUT'; return e; };
const scripted = (fn) => ({ stream: (req) => fn(req), priceOf: () => null, contextLimit: () => 0 });
const tokens = (seq) => seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
const assistants = (msgs) => msgs.filter(m => m && m.role === 'assistant');
const MARK = /\n\n\[response interrupted — [^\]]+; this answer is incomplete\]$/;

(async () => {
  // (1) text streams, then a fatal 401 → the shown text is kept, flagged incomplete, and returned
  {
    const { seq, emit } = setup();
    const provider = scripted(async function* () {
      yield { type: 'text', delta: 'Here is the plan: first, ' };
      yield { type: 'text', delta: 'back up the database' };
      throw httpErr(401, 'invalid api key');
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'plan the migration' }], provider, emit, model: 'm', agentId: 'a', runId: 'r1' });
    A.eq([res.reason, res.failureStage, res.failureCode], ['error', 'provider_stream', 'auth'], 'a 401 is still a fatal provider_stream error');
    const last = res.messages[res.messages.length - 1];
    A.eq(last.role, 'assistant', 'result.messages ends with an assistant turn');
    A.ok(String(last.content).indexOf('Here is the plan: first, back up the database') === 0, 'it holds exactly the text that was streamed');
    A.ok(MARK.test(last.content), 'and says, in its own content, that the answer is incomplete');
    A.ok(/provider error: auth/.test(last.content), 'naming the classified reason (no provider body echoed)');
    A.ok(!('tool_calls' in last) && !('reasoning' in last), 'provider-valid: no tool calls, no half-streamed signed reasoning');
    A.eq(res.text, last.content, 'result.text carries the same flagged partial');
    A.eq(tokens(seq), 'Here is the plan: first, back up the database', 'the marker is NOT streamed as a model token (live surfaces keep their own error UI)');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 1, 'exactly one run.error');
    A.eq(seq.filter(e => e.name === 'agent.run.end').map(e => e.payload.reason), ['error'], 'the run still ends error');
    // the durable transcript keeps it (run end drains result.messages)
    const lines = [];
    const store = makeTranscriptStore({ io: { readAll: () => [], append: (e) => { lines.push(e); return e; } }, clock: { now: () => 1 } });
    store.markPersisted(res.messages.slice(0, 1));
    store.appendNewStrict('s', 'a', res.messages);
    A.eq(lines.map(r => r.role), ['assistant'], 'the partial reaches the transcript as an assistant row');
    A.ok(MARK.test(lines[0].content), 'with its incomplete marker');
  }

  // (2) a mid-stream RETRY that later succeeds leaves NO partial behind
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scripted(async function* () {
      attempt++;
      if (attempt === 1) { yield { type: 'text', delta: 'The answer is' }; throw timeoutErr(); }
      yield { type: 'text', delta: 'The answer is 42.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'q' }], provider, emit, model: 'm', agentId: 'a', runId: 'r2' });
    A.eq(res.reason, 'done', 'the retry recovered');
    A.eq(assistants(res.messages).map(m => m.content), ['The answer is 42.'], 'exactly one assistant turn — the recovered one, no fragment, no marker');
    A.ok(!/response interrupted/.test(JSON.stringify(res.messages)), 'no interrupted marker anywhere');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'no run.error');
  }

  // (3) text shown, then retries that stream NOTHING until the ladder gives up → the SHOWN text is what is kept
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scripted(async function* () {
      attempt++;
      if (attempt === 1) { yield { type: 'text', delta: 'Partial draft shown live' }; }
      throw timeoutErr();
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'q' }], provider, emit, model: 'm', agentId: 'a', runId: 'r3' });
    A.eq(res.reason, 'error', 'the persistent timeout ends the run');
    A.ok(attempt > 1, 'the ladder really retried (' + attempt + ' attempts)');
    const kept = assistants(res.messages);
    A.eq(kept.length, 1, 'one kept partial');
    A.ok(String(kept[0].content).indexOf('Partial draft shown live') === 0 && MARK.test(kept[0].content), 'it is the text the Commander actually saw, flagged incomplete');
    A.ok(/provider error: timeout/.test(kept[0].content), 'with the final classified reason');
    A.eq(tokens(seq), 'Partial draft shown live', 'nothing new was streamed by the empty retries');
  }

  // (4) a fatal error before ANY text → nothing is invented
  {
    const { emit } = setup();
    const provider = scripted(async function* () { throw httpErr(401, 'invalid api key'); yield; });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'q' }], provider, emit, model: 'm', agentId: 'a', runId: 'r4' });
    A.eq(res.reason, 'error', 'fatal');
    A.eq(assistants(res.messages).length, 0, 'no text streamed → no assistant turn is fabricated');
    A.eq(res.text, '', 'and result.text stays empty');
  }

  // (5) a finishReason:'length' partial already in flight, then the continuation call dies → ONE merged, flagged turn
  {
    const { emit } = setup();
    let n = 0;
    const provider = scripted(async function* () {
      n++;
      if (n === 1) { yield { type: 'text', delta: 'Chapter one. ' }; yield { type: 'done', finishReason: 'length' }; return; }
      yield { type: 'text', delta: 'Chapter two' };
      throw httpErr(401, 'key revoked');
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'write a long story' }], provider, emit, model: 'm', agentId: 'a', runId: 'r5' });
    A.eq(res.reason, 'error', 'fatal');
    const kept = assistants(res.messages);
    A.eq(kept.length, 1, 'the continuation parts are folded into one assistant turn');
    A.ok(String(kept[0].content).indexOf('Chapter one. Chapter two') === 0 && MARK.test(kept[0].content), 'holding both parts, flagged once at the end');
    A.ok(!res.messages.some(m => m.role === 'system'), 'the internal continuation prompt is gone (provider-valid, no dangling nudge)');
  }

  A.report('loop.fatal-keeps-partial.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
