/* node test/logbound-torn-tail-append.test.js — H2 twin of transcript-torn-tail-append: logbound.appendJsonlDurable
   (spend ledger, run history, autonomy ledger) after a TORN last line.

   The old append wrote the new row straight after a crash-torn fragment: one unparsable line, so every reader that
   skips bad lines (readBoundedJsonl) dropped the NEW row while the append had reported success. Now a lone '\n'
   isolates the fragment, the fsync'd row is read back and proven a complete line, and a rejected append rolls back. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { appendJsonlDurable, loadBounded } = require('../sidecar/logbound.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-logbound-torn-'));
const FILE = path.join(DIR, 'runs.jsonl');
// exactly index.js readBoundedJsonl: bounded tail, unparsable lines skipped
const readRows = () => loadBounded({ fs }, FILE, 1 << 20).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
function withFs(prop, impl) { return new Proxy(fs, { get(target, key) { return key === prop ? impl(target) : target[key]; } }); }

try {
  // ---- 1. torn tail → the new row survives, the fragment is isolated ------------------------------------------------
  appendJsonlDurable({ fs }, FILE, { id: 'first' });
  fs.appendFileSync(FILE, '{"id":"torn","usd":0.1');           // crash mid-append: no closing brace, no newline
  appendJsonlDurable({ fs }, FILE, { id: 'after' });
  A.eq(readRows().map(r => r.id), ['first', 'after'], 'the row appended after a torn tail is readable (it was lost before the fix)');
  const lines = fs.readFileSync(FILE, 'utf8').split('\n');
  A.eq(lines.length, 4, 'row, isolated fragment, new row, trailing newline');
  A.eq(lines[1], '{"id":"torn","usd":0.1', 'the fragment is alone on its own line, byte-for-byte');
  const size = fs.statSync(FILE).size;
  appendJsonlDurable({ fs }, FILE, { id: 'clean' });
  A.eq(fs.statSync(FILE).size - size, Buffer.byteLength(JSON.stringify({ id: 'clean' }) + '\n'), 'a clean tail gets no separator (byte-exact append)');

  // ---- 2. the read-back proves the LINE: a lying tail probe cannot produce a glued "success" -------------------------
  fs.appendFileSync(FILE, '{"id":"torn2"');
  const before = fs.readFileSync(FILE);
  const lying = withFs('readSync', (real) => function (fd, buf, off, len, pos) {
    if (len === 1 && pos === before.length - 1) { buf[off] = 0x0a; return 1; }   // "the file ends in a newline"
    return real.readSync(fd, buf, off, len, pos);
  });
  A.throws(() => appendJsonlDurable({ fs: lying }, FILE, { id: 'glued' }), 'a row glued onto a fragment fails the read-back');
  A.eq(fs.readFileSync(FILE).toString('hex'), before.toString('hex'), 'the rejected append rolled back to the prior byte boundary');
  appendJsonlDurable({ fs }, FILE, { id: 'recovered' });
  A.eq(readRows().map(r => r.id), ['first', 'after', 'clean', 'recovered'], 'the next honest append isolates that fragment too');

  // ---- 3. short writes still complete; a stalled write still throws and rolls back ------------------------------------
  let calls = 0;
  const trickle = withFs('writeSync', (real) => function (fd, buf, off, len, pos) { calls++; return real.writeSync(fd, buf, off, Math.min(len, 3), pos); });
  appendJsonlDurable({ fs: trickle }, FILE, { id: 'trickled' });
  A.ok(calls > 3, 'short writes are continued (' + calls + ' writes)');
  const mid = fs.readFileSync(FILE);
  let first = true;
  const stalled = withFs('writeSync', (real) => function (fd, buf, off, len, pos) { if (!first) return 0; first = false; return real.writeSync(fd, buf, off, 2, pos); });
  A.throws(() => appendJsonlDurable({ fs: stalled }, FILE, { id: 'stalled' }), 'a zero-progress write throws');
  A.eq(fs.readFileSync(FILE).toString('hex'), mid.toString('hex'), 'and rolls back');
  A.eq(readRows().map(r => r.id).slice(-1), ['trickled'], 'the log is intact');
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}
A.report('logbound-torn-tail-append.test');
