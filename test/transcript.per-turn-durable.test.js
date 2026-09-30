/* node test/transcript.per-turn-durable.test.js — H2 durable transcript: a run's dialogue lands at the loop's durable
   boundaries, not only at run end, and a recovery continuation neither loses nor duplicates it.

   Drives the REAL loop (runAgentLoop), the REAL segmented transcript store on a temp dir, the REAL run journal on disk
   and the REAL recovery planner, wired exactly as runOnceCore wires them: makeRunTranscript (transcript-run.js) for the
   pre-loop start, the onCheckpoint seam (journal checkpoint FIRST, then runTranscript.checkpoint), and the run-end
   drain; adoptRecovery + recoveryBase for a continuation. "Restart" = fresh io/store/journal instances over the same
   directories, reading only what reached disk.

   Audit witness (2026-09-22): killed after a tool result + auto-continue → transcript `user → "Continued and
   finished."`, the executed write missing; killed and never continued → not even the user prompt. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeRunJournal, DISPATCH_BOUNDARY_MODEL } = require('../sidecar/run-journal.js');
const RunRecovery = require('../sidecar/run-recovery.js');
const { makeRunTranscript, recoveryBase } = require('../sidecar/transcript-run.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-per-turn-'));
const TX = path.join(DIR, 'transcript-history-v2');
const JR = path.join(DIR, '.run-journal');
let tick = 1000;
const clock = { now: () => ++tick };

function openStore(ioOverride) {
  const io = ioOverride || makeSegmentedTranscriptIo({ fs, path, root: TX });
  return makeTranscriptStore({ io, clock });
}
function onDisk(streamId) { return openStore().history(streamId, { limit: 400 }); }   // a fresh process's view
function shape(rows) {
  return rows.map(r => r.role + ':' + (r.role === 'tool' ? r.toolCallId
    : (r.role === 'assistant' && r.toolCalls ? 'calls[' + JSON.parse(r.toolCalls).map(c => c.id).join(',') + ']' : r.content)));
}
function latestUserText(list) { for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].role === 'user') return String(list[i].content); return ''; }
function turnProvider(turns) {
  let n = 0;
  return { priceOf: () => null, contextLimit: () => 0, stream: async function* () {
    const t = turns[Math.min(n++, turns.length - 1)];
    if (t.calls) {
      for (let i = 0; i < t.calls.length; i++) {
        yield { type: 'tool_start', index: i, id: t.calls[i].id, name: t.calls[i].name };
        yield { type: 'tool_args', index: i, chunk: JSON.stringify(t.calls[i].args || {}) };
      }
      yield { type: 'done', finishReason: 'tool_calls' };
    } else {
      yield { type: 'text', delta: t.text };
      yield { type: 'done', finishReason: 'stop' };
    }
  } };
}

// runOnceCore's wiring, verbatim in shape: markPersisted/adoptRecovery → setDirective → journal begin + initial
// checkpoint → runTranscript.start → loop with onCheckpoint (journal first, transcript second) → run-end drain.
function host(o) {
  const store = o.store;
  const journal = o.journal;
  const failures = [];
  const rt = makeRunTranscript({ store, streamId: o.streamId, agentId: 'a', runId: o.runId, onFailure: (stage, e) => failures.push(stage + ':' + e.message) });
  const msgs = o.messages;
  if (o.recovered) rt.adoptRecovery(msgs, o.recovered); else store.markPersisted(msgs);
  rt.setDirective(latestUserText(o.recovered ? msgs.slice(0, o.recovered.base) : msgs));
  const initial = new WeakSet(msgs);
  journal.begin({ runId: o.runId, agentId: 'a', streamId: o.streamId, recoveryOf: o.recoveryOf || '' });
  journal.checkpoint(o.runId, { phase: 'initial', turn: 0, messages: msgs });
  rt.start(msgs);
  const loop = runAgentLoop({
    messages: msgs, provider: o.provider, emit() {}, model: 'm', agentId: 'a', runId: o.runId, capCtx: {},
    onCheckpoint({ phase, messages, turn }) {
      journal.checkpoint(o.runId, { phase, turn, messages: messages.filter(m => m && typeof m === 'object' && !initial.has(m)) });
      rt.checkpoint({ phase, messages });
    },
    dispatch: async (call) => {
      const mutating = call.name === 'fs_write' || call.name === 'shell_exec';
      journal.toolIntent(o.runId, { callId: call.id, name: call.name, argsRaw: call.argsRaw, mutating, boundaryModel: DISPATCH_BOUNDARY_MODEL });
      journal.toolDispatch(o.runId, { callId: call.id, name: call.name, mutating });
      const out = await o.tool(call);
      journal.toolResult(o.runId, { callId: call.id, ok: true, content: out.content });
      return out;
    }
  });
  async function finish() {
    const result = await loop;
    rt.fallbackDirective(latestUserText(msgs));
    rt.drain(result.messages);   // run end (strict)
    journal.finishAndRetire(o.runId, { reason: result.reason, transcriptAck: true });
    return result;
  }
  return { rt, failures, loop, finish };
}

(async () => {
  try {
    // ---- 1. Per-turn persistence: the transcript is complete at every tool boundary, BEFORE run end ----------------
    {
      const store = openStore();
      const journal = makeRunJournal({ dir: JR, fs, path, clock });
      const snaps = {};
      const msgs = [{ role: 'system', content: 'you are an agent' }, { role: 'user', content: 'write a.txt, then run the build' }];
      let firstModelCall = null;
      const turns = [
        { calls: [{ id: 'c1', name: 'fs_write', args: { path: 'a.txt', content: 'ok' } }] },
        { calls: [{ id: 'c2', name: 'shell_exec', args: { cmd: 'npm run build' } }] },
        { text: 'Wrote a.txt and the build passed.' }
      ];
      const inner = turnProvider(turns);
      const provider = Object.assign({}, inner, { stream(req) { if (!firstModelCall) firstModelCall = shape(onDisk('ws1')); return inner.stream(req); } });
      const h = host({ store, journal, streamId: 'ws1', runId: 'r1', messages: msgs, provider,
        tool: async (call) => {
          if (call.id === 'c2') snaps.duringShell = shape(onDisk('ws1'));   // a hard kill here keeps only what is on disk
          return { ok: true, content: call.id === 'c1' ? 'wrote a.txt (2 bytes)' : 'build ok' };
        } });
      const result = await h.loop;
      snaps.beforeRunEnd = shape(onDisk('ws1'));
      A.eq(result.reason, 'done', 'the run completed');
      A.eq(firstModelCall, ['user:write a.txt, then run the build'], 'the user directive is durable BEFORE the first model call');
      A.eq(snaps.duringShell, ['user:write a.txt, then run the build', 'assistant:calls[c1]', 'tool:c1', 'assistant:calls[c2]'],
        'while the 2nd tool runs, disk already holds user + assistant(tool_calls) + the 1st tool result + the in-flight call turn');
      A.eq(snaps.beforeRunEnd, ['user:write a.txt, then run the build', 'assistant:calls[c1]', 'tool:c1', 'assistant:calls[c2]', 'tool:c2'],
        'after the last tool-results boundary every tool turn is durable; the text-only final answer waits for run end');
      // run end appends ONLY what is left
      h.rt.fallbackDirective(latestUserText(msgs));
      const appended = h.rt.drain(result.messages);
      A.eq(appended, 1, 'run end appends exactly the one row the boundaries had not written (the final answer)');
      const final = onDisk('ws1');
      A.eq(shape(final), ['user:write a.txt, then run the build', 'assistant:calls[c1]', 'tool:c1', 'assistant:calls[c2]', 'tool:c2', 'assistant:Wrote a.txt and the build passed.'],
        'after run end: the whole dialogue exactly once, in order — no duplicate of any per-turn row');
      A.ok(final.every(r => r.sourceRunId === 'r1'), 'every row carries its run id');
      A.eq(h.rt.drain(result.messages), 0, 'a second drain writes nothing (exactly-once)');
      A.eq(h.failures, [], 'no transcript write failed');
      const replay = openStore().reconstruct('ws1', { limit: 50 });
      A.eq(replay.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['c1', 'c2'], 'a restart resumes a provider-valid, fully paired history');
      A.eq(journal.finishAndRetire('r1', { reason: 'done', transcriptAck: true }).retired, true, 'the journal retires once run end proved every row');
    }

    // ---- 2. Hard kill mid-batch + a transient transcript failure, then an automatic continuation ----------------------
    let sourceRows;
    {
      // the FIRST attempt to write c3's tool result fails (disk hiccup): the run must not stop, must not reorder
      let failOnce = true;
      const flakyIo = makeSegmentedTranscriptIo({ fs, path, root: TX });
      const realDurable = flakyIo.appendDurable;
      flakyIo.appendDurable = function (entry, opts) {
        if (failOnce && entry.role === 'tool' && entry.toolCallId === 'c3') { failOnce = false; throw new Error('EIO: simulated'); }
        return realDurable.call(flakyIo, entry, opts);
      };
      const store = makeTranscriptStore({ io: flakyIo, clock });
      const journal = makeRunJournal({ dir: JR, fs, path, clock });
      const msgs = [{ role: 'system', content: 'you are an agent' }, { role: 'user', content: 'inspect x, save b.txt, then read y' }];
      let reachedKill;
      const killed = new Promise(res => { reachedKill = res; });
      const h = host({ store, journal, streamId: 'ws2', runId: 'r2', messages: msgs,
        provider: turnProvider([
          { calls: [{ id: 'c3', name: 'fs_read', args: { path: 'x' } }] },
          { calls: [{ id: 'c4', name: 'fs_write', args: { path: 'b.txt', content: 'B' } }, { id: 'c5', name: 'fs_read', args: { path: 'y' } }] }
        ]),
        tool: (call) => {
          if (call.id === 'c5') { reachedKill(); return new Promise(() => {}); }   // the process dies while c5 runs
          return Promise.resolve({ ok: true, content: call.id === 'c3' ? 'x contents' : 'wrote b.txt' });
        } });
      await killed;
      sourceRows = onDisk('ws2');
      A.eq(h.failures.length, 1, 'the failed mid-run write was reported (failNote in the host), not swallowed');
      A.ok(/^checkpoint:EIO/.test(h.failures[0] || ''), 'reported at the tool-results boundary');
      A.eq(shape(sourceRows), ['user:inspect x, save b.txt, then read y', 'assistant:calls[c3]', 'tool:c3', 'assistant:calls[c4,c5]'],
        'the failed row was retried IN ORDER at the next boundary — no hole, no reordering; the killed batch\'s assistant turn is durable');
    }
    // restart: fresh journal/store instances read the disk; the planner builds the continuation prompt
    {
      const journal = makeRunJournal({ dir: JR, fs, path, clock });
      const state = journal.inspect('r2');
      A.eq(state.status, 'resumable', 'the killed run is automatically resumable (c5 is a dispatched read)');
      A.eq(state.completed.map(p => p.result.callId), ['c3', 'c4'], 'c4\'s result is in the journal but was never checkpointed (killed mid-batch)');
      const plan = RunRecovery.automaticContinuationPlan(state);
      const msgs = JSON.parse(JSON.stringify(plan.messages));
      const base = recoveryBase(state, msgs);
      A.eq(base, 2, 'recoveryBase finds the source run\'s initial prompt at the head of the continuation prompt');
      A.eq(recoveryBase(state, msgs.slice(1)), 0, 'a prompt that does not begin with the journal base is "unknown" (host keeps mark-all)');
      const store = openStore();
      const rows = store.history('ws2', { sourceRunId: 'r2', limit: 5000 });
      A.eq(rows.length, 4, 'the source run\'s own rows are readable by run id');

      // REGRESSION WITNESS — the old rule (mark the whole recovered prompt persisted) on this exact prompt
      const old = makeTranscriptStore({ io: { readAll: () => [], append() {} }, clock });
      const oldMsgs = JSON.parse(JSON.stringify(plan.messages));
      old.markPersisted(oldMsgs);
      A.eq(old.appendNewStrict('ws2', 'a', oldMsgs), 0, 'the old rule records NONE of the recovered turns — c4\'s executed write result would be lost');

      const h = host({ store, journal, streamId: 'ws2', runId: 'r3', recoveryOf: 'r2', messages: msgs,
        recovered: { base, rows, sourceWasContinuation: false },
        provider: turnProvider([{ calls: [{ id: 'c6', name: 'fs_read', args: { path: 'y' } }] }, { text: 'Continued and finished.' }]),
        tool: async () => ({ ok: true, content: 'y contents' }) });
      A.eq(h.rt.directiveWritten(), true, 'the source already wrote the directive; the continuation must not repeat it');
      const res = await h.finish();
      A.eq(res.reason, 'done', 'the continuation finished');
      const all = onDisk('ws2');
      A.eq(shape(all), [
        'user:inspect x, save b.txt, then read y', 'assistant:calls[c3]', 'tool:c3', 'assistant:calls[c4,c5]',
        'tool:c4', 'tool:c5',                                  // recovered: journal-only result + the planner's pairing result
        'assistant:calls[c6]', 'tool:c6', 'assistant:Continued and finished.'
      ], 'continuation: the journal-only tool result and the pairing row are appended once, then only the new turns — no duplicates');
      A.eq(all.find(r => r.toolCallId === 'c4').content, 'wrote b.txt', 'the executed write\'s real result reached the transcript');
      A.ok(/AUTOMATIC RECOVERY/.test(all.find(r => r.toolCallId === 'c5').content), 'the unfinished call is paired with the host\'s truthful recovery result');
      A.eq(all.filter(r => r.role === 'user').length, 1, 'exactly one user directive row');
      A.eq(all.filter(r => r.sourceRunId === 'r3').length, 5, 'the continuation wrote exactly its 5 rows (2 recovered + 3 new)');
      const replay = openStore().reconstruct('ws2', { limit: 50 });
      let pending = new Set(), valid = true;
      for (const m of replay) {
        if (m.role === 'assistant' && m.tool_calls) { if (pending.size) valid = false; pending = new Set(m.tool_calls.map(c => c.id)); }
        else if (m.role === 'tool') { if (!pending.delete(m.tool_call_id)) valid = false; }
        else if (pending.size) valid = false;
      }
      A.ok(valid && !pending.size, 'the resumed history is provider-valid: every tool call is answered before later context');
    }

    // ---- 3. A source that wrote NOTHING (older build / killed before its first write): the continuation writes the
    //         directive first, then every recovered turn, still exactly once ---------------------------------------
    {
      const lines = [];
      const store = makeTranscriptStore({ io: { readAll: () => [], append: (e) => { lines.push(e); return e; } }, clock });
      const rt = makeRunTranscript({ store, streamId: 'ws3', agentId: 'a', runId: 'r5' });
      const msgs = [
        { role: 'system', content: 's' }, { role: 'user', content: 'old history' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'do it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'k1', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'k1', content: 'AUTOMATIC RECOVERY: reissue' },
        { role: 'system', content: '<automatic_recovery>…</automatic_recovery>' }
      ];
      rt.adoptRecovery(msgs, { base: 4, rows: [], sourceWasContinuation: false });
      rt.setDirective(latestUserText(msgs.slice(0, 4)));
      A.eq(rt.directiveWritten(), false, 'no source rows: the directive is still owed');
      rt.start(msgs);
      A.eq(lines.map(r => r.role + ':' + (r.toolCallId || r.content)), ['user:do it', 'assistant:', 'tool:k1'],
        'directive first, then the recovered turns; restored history and system fences are never re-appended');
      const rt2 = makeRunTranscript({ store, streamId: 'ws3', agentId: 'a', runId: 'r6' });
      rt2.adoptRecovery(msgs.map(m => Object.assign({}, m)), { base: 4, rows: [], sourceWasContinuation: true });
      A.eq(rt2.directiveWritten(), true, 'a source that was itself a continuation had its directive written by ITS source');
    }

    // ---- 4. Text-only turns wait: a finishReason:'length' partial is never frozen mid-merge ----------------------------
    {
      const lines = [];
      const store = makeTranscriptStore({ io: { readAll: () => [], append: (e) => { lines.push(e); return e; } }, clock });
      const rt = makeRunTranscript({ store, streamId: 'ws4', agentId: 'a', runId: 'r7' });
      const msgs = [{ role: 'user', content: 'long answer please' }];
      store.markPersisted(msgs);
      rt.setDirective('long answer please');
      rt.start(msgs);
      let n = 0;
      const provider = { priceOf: () => null, contextLimit: () => 0, stream: async function* () {
        n++;
        if (n === 1) { yield { type: 'text', delta: 'first half, ' }; yield { type: 'done', finishReason: 'length' }; return; }
        yield { type: 'text', delta: 'second half.' }; yield { type: 'done', finishReason: 'stop' };
      } };
      const res = await runAgentLoop({ messages: msgs, provider, emit() {}, model: 'm', agentId: 'a', runId: 'r7',
        onCheckpoint: ({ phase, messages }) => rt.checkpoint({ phase, messages }) });
      A.eq(lines.length, 1, 'mid-run, only the directive was written (the length partial waited)');
      rt.drain(res.messages);
      A.eq(lines.map(r => r.role + ':' + r.content), ['user:long answer please', 'assistant:first half, second half.'],
        'run end writes the merged answer once — not a frozen first fragment');
    }
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  A.report('transcript.per-turn-durable.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
