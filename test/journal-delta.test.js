/* node test/journal-delta.test.js — the run journal writes DELTA checkpoints (journal-linear-growth, 2026-09-22).

   The old scheme re-serialized every run-created message at every checkpoint: 80 turns x 20 KB -> 131 MB (82x).
   checkpointMessages() now journals only messages not yet journaled, and a full snapshot whenever the loop REWROTE
   its working array. Proven here:
     A. property: seeded random runs of turns, tool results, in-place edits, folds, micro elisions, continuation
        collapses, reorders and clones -> after EVERY checkpoint the delta journal reconstructs exactly the messages
        the legacy every-checkpoint-is-a-snapshot journal records (same phase/turn/status), and is never larger;
     B. a run-created list over cloneSafe's 1000-element array bound is chunked, never truncated;
     C. a legacy journal written by the pre-delta writer (fixture captured from 09dd51454) analyzes identically;
     D. size + speed on the real fs writer: 80 turns x 20 KB -> journal < 5x content, inspect < 150 ms;
     E. a delta that does not extend the reconstructed list is never trusted (forensic, not silently merged).
   Deterministic: seeded PRNG, injected clock, a temp dir for the fs part. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../sidecar/run-journal.js');
const Recovery = require('../sidecar/run-recovery.js');

function memoryIo() {
  const files = new Map();
  return {
    create(id, line) { if (files.has(id)) throw new Error('exists'); files.set(id, line + '\n'); },
    append(id, line) { if (!files.has(id)) throw new Error('missing'); files.set(id, files.get(id) + line + '\n'); },
    read(id) { return files.get(id); }, list() { return Array.from(files.keys()); },
    readFile(id) { return files.get(id); }, remove(id) { files.delete(id); }, files
  };
}
function prng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- A. property: delta reconstruction === legacy snapshot at every checkpoint ------------------------------
let checkpoints = 0, mismatches = 0, snapshotsAfterRewrite = 0, rewrites = 0, deltaNotSmaller = 0;
const firstMismatch = [];
for (let seed = 1; seed <= 160; seed++) {
  const rnd = prng(seed);
  const pick = n => Math.floor(rnd() * n);
  let tick = 0;
  const deltaIo = memoryIo(), legacyIo = memoryIo();
  const dj = J.makeRunJournal({ io: deltaIo, clock: { now: () => ++tick } });
  const lj = J.makeRunJournal({ io: legacyIo, clock: { now: () => tick } });
  const base = [{ role: 'system', content: 'fixture system ' + seed }, { role: 'user', content: 'task ' + seed }];
  const messages = base.slice();
  const initial = new WeakSet(base);
  dj.begin({ runId: 'r', agentId: 'a' }); lj.begin({ runId: 'r', agentId: 'a' });
  dj.checkpoint('r', { phase: 'initial', turn: 0, messages }); lj.checkpoint('r', { phase: 'initial', turn: 0, messages });
  let turn = 0, callSeq = 0, rewrotePending = false;
  const runCreated = () => messages.filter(m => m && typeof m === 'object' && !initial.has(m));
  const rebuild = list => { messages.length = 0; for (const m of list) messages.push(m); };
  const text = () => 'w' + pick(1e6) + ' ' + 'x'.repeat(pick(40));
  // Records are read back incrementally (each new line JSON-parsed off the journal bytes) and analyzed with the real
  // analyzer; the full hash-chain parse runs once per seed below, so the property run stays fast.
  const recA = [], recB = [];
  const takeNew = (io, acc) => { const lines = io.files.get('r').split('\n').filter(Boolean); const from = acc.length; for (let k = from; k < lines.length; k++) acc.push(JSON.parse(lines[k])); return acc.slice(from); };
  takeNew(deltaIo, recA); takeNew(legacyIo, recB);
  function checkpoint(phase) {
    const fresh = runCreated();
    dj.checkpointMessages('r', { phase, turn, messages: fresh });
    lj.checkpoint('r', { phase, turn, messages: fresh });
    const written = takeNew(deltaIo, recA); takeNew(legacyIo, recB);
    if (rewrotePending) { rewrites++; if (written[0] && written[0].type === 'checkpoint') snapshotsAfterRewrite++; rewrotePending = false; }
    const a = J._internals.analyze(recA, false, 'none'), b = J._internals.analyze(recB, false, 'none');
    checkpoints++;
    const sa = JSON.stringify([a.checkpoint.phase, a.checkpoint.turn, a.checkpoint.messages, a.status, a.corrupt]);
    const sb = JSON.stringify([b.checkpoint.phase, b.checkpoint.turn, b.checkpoint.messages, b.status, b.corrupt]);
    if (sa !== sb) { mismatches++; if (firstMismatch.length < 1) firstMismatch.push({ seed, turn, phase, sa: sa.slice(0, 400), sb: sb.slice(0, 400) }); }
  }
  for (let op = 0; op < 45; op++) {
    const kind = pick(13);
    const made = runCreated();
    if (kind <= 2) {                                   // assistant text turn
      turn++; messages.push({ role: 'assistant', content: text() }); checkpoint('assistant');
    } else if (kind <= 5) {                            // tool-call turn + paired results
      turn++;
      const calls = [];
      for (let i = 0, n = 1 + pick(3); i < n; i++) calls.push({ id: 'c' + (++callSeq), type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: 'f' + pick(99) }) } });
      messages.push({ role: 'assistant', content: '', tool_calls: calls }); checkpoint('assistant');
      for (const c of calls) messages.push({ role: 'tool', tool_call_id: c.id, content: text() });
      checkpoint('tool_results');
    } else if (kind === 6 && made.length) {            // in-place content edit of an already-journaled message
      const m = made[pick(made.length)];
      if (typeof m.content === 'string') { m.content = m.content + '\n\n(explanation ' + pick(99) + ')'; rewrotePending = true; }
      if (pick(2)) { messages.push({ role: 'system', content: '<continuation>go on</continuation>' }); }
      checkpoint('assistant');
    } else if (kind === 7 && made.length > 3) {        // fold: a slice collapses into one summary (rebuilt in place)
      const i = pick(made.length - 2), j = i + 1 + pick(Math.min(4, made.length - i - 1));
      const gone = new Set(made.slice(i, j));
      const out = [];
      let placed = false;
      for (const m of messages) { if (gone.has(m)) { if (!placed) { out.push({ role: 'system', content: '<summary>folded ' + gone.size + '</summary>' }); placed = true; } } else out.push(m); }
      rebuild(out); rewrotePending = true; checkpoint('compact');
    } else if (kind === 8 && made.some(m => m.role === 'tool')) {   // micro elision: tool bodies replaced by new copies
      let elided = 0;
      rebuild(messages.map(m => (m.role === 'tool' && pick(2)) ? (elided++, Object.assign({}, m, { content: '[elided ' + String(m.content).length + ' chars]' })) : m));
      if (elided) rewrotePending = true;
      checkpoint('compact');
    } else if (kind === 9 && made.filter(m => m.role === 'assistant' && !m.tool_calls).length >= 2) {   // continuation collapse
      const parts = made.filter(m => m.role === 'assistant' && !m.tool_calls).slice(-2);
      parts[0].content = parts.map(m => String(m.content || '')).join('');
      rebuild(messages.filter(m => m !== parts[1])); rewrotePending = true; checkpoint('assistant');
    } else if (kind === 10 && made.length >= 2) {      // reorder / identical-content clone (identity changes)
      if (pick(2)) { const k = messages.indexOf(made[made.length - 1]); const k2 = messages.indexOf(made[made.length - 2]); const t = messages[k]; messages[k] = messages[k2]; messages[k2] = t; }
      else { const k = messages.indexOf(made[pick(made.length)]); messages[k] = JSON.parse(JSON.stringify(messages[k])); }
      rewrotePending = true; checkpoint('assistant');
    } else if (kind === 11 && made.some(m => Array.isArray(m.tool_calls))) {   // nested in-place edit (tool args)
      const m = made.filter(x => Array.isArray(x.tool_calls))[0];
      const next = JSON.stringify({ path: 'edited-' + pick(99) });
      if (m.tool_calls[0].function.arguments !== next) { m.tool_calls[0].function.arguments = next; rewrotePending = true; }
      checkpoint('assistant');
    } else if (kind === 12) {
      if (pick(2)) messages.push({ role: 'system', content: '<steering_note>nudge ' + pick(9) + '</steering_note>' });
      else if (messages.indexOf(base[1]) >= 0 && pick(4) === 0) rebuild(messages.filter(m => m !== base[1]));   // base prompt dropped
      checkpoint('assistant');   // possibly a no-new-message checkpoint
    } else {
      checkpoint('assistant');
    }
  }
  if (Buffer.byteLength(deltaIo.files.get('r')) > Buffer.byteLength(legacyIo.files.get('r'))) deltaNotSmaller++;
  // one full hash-chain-verified parse per seed: the bytes on "disk" reconstruct the same final state
  const fullA = dj.inspect('r'), fullB = lj.inspect('r');
  if (fullA.corrupt || fullA.forensic || JSON.stringify(fullA.checkpoint) !== JSON.stringify(fullB.checkpoint)) { mismatches++; if (firstMismatch.length < 1) firstMismatch.push({ seed, full: true }); }
}
console.log('  property: ' + checkpoints + ' checkpoints, ' + rewrites + ' rewrites, ' + mismatches + ' mismatches');
A.ok(checkpoints > 5000, 'property run exercised many checkpoints (' + checkpoints + ')');
A.eq(mismatches, 0, 'delta reconstruction equals the legacy full snapshot after every checkpoint' + (firstMismatch.length ? ' first=' + JSON.stringify(firstMismatch[0]) : ''));
A.ok(rewrites > 300, 'the property run exercised many in-place rewrites (' + rewrites + ')');
A.eq(snapshotsAfterRewrite, rewrites, 'every rewrite of already-journaled messages re-anchored with a full snapshot');
A.eq(deltaNotSmaller, 0, 'a delta journal is never larger than the legacy snapshot journal of the same run');

// ---- B. over-bound lists are chunked, never truncated --------------------------------------------------------
{
  const io = memoryIo();
  const j = J.makeRunJournal({ io, clock: { now: () => 7 } });
  j.begin({ runId: 'big', agentId: 'a' });
  const list = [];
  for (let i = 0; i < 2350; i++) list.push({ role: i % 2 ? 'tool' : 'assistant', content: 'm' + i });
  j.checkpointMessages('big', { phase: 'assistant', turn: 1, messages: list });
  let state = j.inspect('big');
  A.eq(state.checkpoint.messages.length, 2350, 'a 2350-message snapshot survives cloneSafe\'s 1000-element array bound');
  A.eq(state.checkpoint.messages[2349].content, 'm2349', 'the tail of an over-bound snapshot is intact');
  for (let i = 2350; i < 3600; i++) list.push({ role: 'assistant', content: 'm' + i });
  j.checkpointMessages('big', { phase: 'assistant', turn: 2, messages: list });
  state = j.inspect('big');
  A.eq(state.checkpoint.messages.map(m => m.content), list.map(m => m.content), 'an over-bound delta is chunked and reconstructs every message in order');
  A.eq(state.forensic, false, 'chunked records form a valid delta chain');
}

// ---- C. a journal written by the PRE-delta writer analyzes identically --------------------------------------
{
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'run-journal-legacy-snapshots.json'), 'utf8'));
  for (const c of fixture.cases) {
    const p = J._internals.parseRecords(c.jsonl);
    const now = J._internals.analyze(p.records, p.corrupt, p.damage);
    const picked = {};
    for (const k of Object.keys(c.expected)) picked[k] = now[k];
    A.eq(picked, c.expected, 'legacy journal "' + c.name + '" analyzes exactly as the pre-delta analyzer did');
  }
  A.ok(fixture.cases.length >= 3, 'legacy fixture covers several journal shapes');
  const plan = Recovery.automaticContinuationPlan(J._internals.analyze(J._internals.parseRecords(fixture.cases[0].jsonl).records, false, 'none'));
  A.ok(plan.messages.length > 2, 'a legacy snapshot journal still produces a continuation plan');
}

// ---- D. size + speed on the real fs writer ------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-journal-delta-'));
  try {
    let tick = 1000;
    const j = J.makeRunJournal({ dir, clock: { now: () => ++tick } });
    const rnd = prng(424242);
    const body = n => { let s = ''; while (s.length < n) s += 'line ' + Math.floor(rnd() * 1e9).toString(36) + ' of deterministic tool output; '; return s.slice(0, n); };
    const base = [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'do the long task' }];
    const messages = base.slice();
    const initial = new WeakSet(base);
    j.begin({ runId: 'long', agentId: 'a' });
    j.checkpoint('long', { phase: 'initial', turn: 0, messages });
    const TURNS = 80, SIZE = 20 * 1024;
    const fresh = () => messages.filter(m => !initial.has(m));
    for (let t = 1; t <= TURNS; t++) {
      const id = 'call-' + t;
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'fs_read', arguments: '{"path":"part-' + t + '.txt"}' } }] });
      j.checkpointMessages('long', { phase: 'assistant', turn: t, messages: fresh() });
      j.toolIntent('long', { callId: id, name: 'fs.read', argsRaw: '{"path":"part-' + t + '.txt"}', mutating: false, boundaryModel: J.DISPATCH_BOUNDARY_MODEL });
      j.toolDispatch('long', { callId: id, name: 'fs.read', mutating: false });
      const out = body(SIZE);
      j.toolResult('long', { callId: id, ok: true, content: out });
      messages.push({ role: 'tool', tool_call_id: id, content: out });
      j.checkpointMessages('long', { phase: 'tool_results', turn: t, messages: fresh() });
    }
    const file = path.join(dir, J._internals.runFileName('long'));
    const bytes = fs.statSync(file).size;
    const content = TURNS * SIZE;
    A.ok(bytes < 5 * content, '80 turns x 20 KB: journal ' + (bytes / 1048576).toFixed(2) + ' MB is under 5x content (' + (bytes / content).toFixed(2) + 'x)');
    let best = Infinity, state = null;
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      state = J.makeRunJournal({ dir, clock: { now: () => 0 } }).inspect('long');
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    A.ok(best < 150, 'inspect of the 80-turn journal takes ' + best.toFixed(1) + ' ms (< 150 ms)');
    console.log('  80 turns x 20 KB: journal ' + bytes + ' bytes = ' + (bytes / content).toFixed(2) + 'x content; best inspect ' + best.toFixed(1) + ' ms');
    A.eq(state.checkpoint.messages.length, 2 + 2 * TURNS, 'reconstruction holds the base prompt plus every turn');
    A.eq(state.checkpoint.messages[state.checkpoint.messages.length - 1].content.length, SIZE, 'the last tool body is intact');
    A.eq([state.status, state.forensic, state.damage], ['resumable', false, 'none'], 'the long journal is intact and resumable');
    const types = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).type);
    A.eq(types.filter(t => t === 'checkpoint').length, 2, 'only the base prompt and the first run checkpoint are snapshots');
    A.eq(types.filter(t => t === 'checkpoint_delta').length, 2 * TURNS - 1, 'every later checkpoint is a delta');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- E. a delta chain we did not write is never trusted -------------------------------------------------------
{
  const io = memoryIo();
  const j = J.makeRunJournal({ io, clock: { now: () => 3 } });
  j.begin({ runId: 'gap', agentId: 'a' });
  j.checkpointMessages('gap', { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: 'one' }] });
  j.checkpoint('gap', { phase: 'bogus', turn: 2, messages: [] });   // legitimately a snapshot of []
  const ok = j.inspect('gap');
  A.eq([ok.forensic, ok.checkpoint.messages.length], [false, 0], 'a later snapshot re-anchors reconstruction');
  // hand-craft a delta whose `from` skips ahead: the hash chain is valid, the delta chain is not
  const raw = io.files.get('gap').trim().split('\n').map(l => JSON.parse(l));
  const last = raw[raw.length - 1];
  const r = { v: 1, runId: 'gap', seq: last.seq + 1, ts: 4, type: 'checkpoint_delta', payload: { phase: 'assistant', turn: 3, from: 5, messages: [{ role: 'assistant', content: 'orphan' }] }, prev: last.hash };
  r.hash = J._internals.hashRecord(r);
  io.files.set('gap', io.files.get('gap') + JSON.stringify(r) + '\n');
  const bad = j.inspect('gap');
  A.eq([bad.forensic, bad.damage], [true, 'corrupt'], 'a delta that does not extend the reconstructed list is forensic, not merged');
  A.throws(() => Recovery.automaticContinuationPlan(bad), 'an inconsistent delta chain can never be continued');
}

A.report('journal-delta.test');
