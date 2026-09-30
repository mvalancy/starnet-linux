/* node test/procledger.windows-orphan.test.js — REAL Windows proof that the boot sweep reaps the orphans of a dead
   cmd.exe wrapper (h2 process supervision, F1). Skips cleanly elsewhere.

   The audit's probe F: shellbg records only the cmd.exe wrapper; a force-killed sidecar takes the wrapper with it
   (its stdin pipe breaks) while the command it launched keeps running; the next boot's sweep counted the dead
   wrapper "gone" and the orphan stayed alive. Here, with real processes:
     1. shellbg starts `node grand.js` (cmd.exe wrapper W -> node B) with a real ledger in a TEMP dir; the ledger file
        is copied at that instant (exactly what a crashed sidecar leaves on disk); ONLY W is then force-killed.
     2. query failure (injected rejecting table) -> nothing killed, treeQueryFailed, receipt kept.
     3. a receipt whose root is NEWER than B (B would be a previous PID holder's child) -> B not killed.
     4. a receipt whose root was last provably held BEFORE B existed -> B not killed.
     5. a live PID whose creation time is OLDER than the recorded start (PID reuse) -> not killed.
     6. the real crash-state ledger -> the sweep kills B (and the conhost.exe the wrapper created for its console —
        also the wrapper's own child inside its window, and nothing else), confirmed by the table.
   SAFETY: this test kills only W (through the handle it holds) and B (only after re-proving B's exact pid + creation
   time, which it observed as W's child); every ledger lives in a temp dir; B also exits by itself after 120 s. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  if (process.platform !== 'win32') {
    A.ok(true, 'Windows-only orphan-sweep proof is intentionally skipped on ' + process.platform);
    return A.report('procledger.windows-orphan.test');
  }
  const { makeProcLedger } = require('../sidecar/procledger.js');
  const { makeShellBg } = require('../sidecar/shellbg.js');
  const { makeWin32ProcessTable } = require('../sidecar/proctree.js');
  const table = makeWin32ProcessTable(execFile, { timeoutMs: 30000 });
  const clock = { now: () => Date.now() };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-win-orphan-'));
  const grand = path.join(dir, 'grand.js');
  const pidFile = path.join(dir, 'b.pid');
  const ledgerFile = path.join(dir, 'live', 'proc-ledger.json');
  const crashFile = path.join(dir, 'crash-state.json');
  fs.writeFileSync(grand, "'use strict'; require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 120000);\n");

  let W = null, B = null, extraOwned = [];   // W = { pid } (handle held by shellbg), B = { pid, created } proven as W's child
  const aliveExact = (rows, p) => !!(p && rows.some(r => r.pid === p.pid && r.created === p.created));
  const sweepWith = async (procs, extra) => {
    const f = path.join(dir, 'sweep-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(f, JSON.stringify({ procs }));
    const L = makeProcLedger(Object.assign({ fs, pathMod: path, file: f, clock, log: () => {} }, extra || {}));
    const s = await L.sweep();
    return { s, left: JSON.parse(fs.readFileSync(f, 'utf8')).procs };
  };

  try {
    // ---- 1. start through shellbg with a real ledger; capture the crash state; kill ONLY the wrapper ----
    const ledger = makeProcLedger({ fs, pathMod: path, file: ledgerFile, clock, log: () => {} });
    const bg = makeShellBg({ spawn, clock, ledger, isWin: true });
    const started = bg.start({ agentId: 'orphan-test', cmd: '"' + process.execPath + '" "' + grand + '" "' + pidFile + '"', cwd: dir });
    A.ok(started.ok, 'shellbg started the wrapper');
    const rec = bg._internals.procs.get(started.bgId);
    W = { pid: rec.child.pid };
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await delay(50);
    const bPid = Number(fs.readFileSync(pidFile, 'utf8'));
    let rows = await table();
    const wRow = rows.find(r => r.pid === W.pid);
    const bRow = rows.find(r => r.pid === bPid);
    A.ok(wRow && bRow, 'wrapper and grandchild are both in the process table');
    A.eq(bRow && bRow.ppid, W.pid, 'the node process is the cmd.exe wrapper\'s child (ParentProcessId)');
    A.ok(bRow && wRow && bRow.created >= wRow.created, 'and was created after it');
    B = { pid: bPid, created: bRow.created };
    W.created = wRow.created;
    await ledger.pinIdentity(W.pid);
    A.eq(ledger.list()[0].created, W.created, 'the ledger pinned the wrapper\'s exact creation time');
    A.eq(bg.touchLedger(), 1, 'the owner vouches for the live wrapper (its handle is held)');
    const crashState = ledger.list();
    A.ok(crashState[0].seenAt >= B.created, 'the receipt\'s last-held instant covers the grandchild\'s creation');
    fs.writeFileSync(crashFile, JSON.stringify({ procs: crashState }));   // what a force-killed sidecar leaves behind

    const wExit = new Promise(r => rec.child.once('exit', r));
    process.kill(W.pid);                     // TerminateProcess on the WRAPPER ONLY (we hold its handle)
    await Promise.race([wExit, delay(10000)]);
    rows = await table();
    A.ok(!rows.some(r => r.pid === W.pid && r.created === W.created), 'the wrapper is dead');
    A.ok(aliveExact(rows, B), 'the grandchild survived its wrapper (the orphan the old sweep never saw)');

    // ---- 2. query failure: kill nothing, say so, keep the receipt ----
    {
      const { s, left } = await sweepWith(crashState, { processTable: () => Promise.reject(new Error('simulated CIM timeout')) });
      A.eq(s.treeQueryFailed, true, 'a failed table query is reported');
      A.eq(s.orphaned + s.orphansKilled + s.killed, 0, 'and nothing is killed on its basis');
      A.eq(left.length, 1, 'the receipt is kept for the next boot');
      A.ok(aliveExact(await table(), B), 'the grandchild is untouched');
    }
    // ---- 3. a recorded root NEWER than the orphan: B would be a previous PID holder's child -> not killed ----
    {
      const future = Date.now() + 3600000;
      const { s } = await sweepWith([{ pid: W.pid, cmd: 'x', kind: 'shell.bg', startedAt: future, created: future, seenAt: future }]);
      A.eq(s.orphaned, 0, 'a process older than the recorded root is not its orphan');
      A.ok(aliveExact(await table(), B), 'and is not killed');
    }
    // ---- 4. the root was last provably held BEFORE the process existed -> not killed ----
    if (B.created > W.created) {
      const { s } = await sweepWith([{ pid: W.pid, cmd: 'x', kind: 'shell.bg', startedAt: W.created, created: W.created, seenAt: W.created }]);
      A.eq(s.orphaned, 0, 'a process created after the root\'s last proven instant is not its orphan');
      A.ok(aliveExact(await table(), B), 'and is not killed');
    } else A.ok(true, 'grandchild shares the wrapper\'s creation millisecond — ceiling case not separable here');
    // ---- 5. a live PID held by a process OLDER than the recorded start (PID reuse) -> not killed ----
    {
      const { s } = await sweepWith([{ pid: B.pid, cmd: 'x', kind: 'shell.bg', startedAt: B.created + 5000, created: B.created + 5000, seenAt: B.created + 6000 }]);
      A.eq(s.reused, 1, 'the live PID with a different creation time is PID reuse');
      A.eq(s.killed, 0, 'and is never killed');
      A.ok(aliveExact(await table(), B), 'the process is untouched');
    }
    // ---- 6. the real crash state: the next boot's sweep reaps the orphan, confirmed ----
    {
      // what the owned-tree window names before the sweep: the grandchild, plus (on Windows 10+) the conhost.exe
      // the wrapper created for its console — also the wrapper's own child, created inside its window
      const { ownedTree } = require('../sidecar/proctree.js');
      const pre = await table();
      const expected = ownedTree(pre, { pid: W.pid, floor: W.created, ceiling: crashState[0].seenAt });
      const names = new Map((await new Promise((res) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process -Filter "' + (expected.map(e => 'ProcessId=' + e.pid).join(' OR ') || 'ProcessId=0') + '" | ForEach-Object { $_.ProcessId.ToString() + ":" + $_.Name }'],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (e, out) => res(String(out || '').trim().split(/\r?\n/).filter(Boolean).map(l => l.split(':'))))))
        .map(([p, n]) => [Number(p), n]));
      extraOwned = expected.map(e => ({ pid: e.pid, created: e.created }));
      console.log('owned tree of the dead wrapper: ' + expected.map(e => e.pid + ':' + (names.get(e.pid) || '?')).join(', '));
      A.ok(expected.some(e => e.pid === B.pid), 'the window names the grandchild');
      A.ok(expected.every(e => e.pid === B.pid || (e.ppid === W.pid && /^conhost\.exe$/i.test(names.get(e.pid) || ''))),
        'and nothing else but the wrapper\'s own console host');
      const L = makeProcLedger({ fs, pathMod: path, file: crashFile, clock, log: (m) => console.log('  ' + m) });
      const s = await L.sweep();
      A.eq(s.examined, 1, 'the sweep examined the wrapper receipt');
      A.eq(s.orphaned, 1, 'it found the dead wrapper\'s live orphans (was: counted "gone")');
      A.eq(s.orphansKilled, expected.length, 'and reaped every one of them, confirmed by the table');
      A.eq(s.survived, 0, 'nothing survived');
      A.eq(s.gone, 0, 'the receipt was not laundered into "gone"');
      rows = await table();
      A.ok(!aliveExact(rows, B), 'the grandchild is dead');
      A.eq(JSON.parse(fs.readFileSync(crashFile, 'utf8')).procs.length, 0, 'the receipt is consumed');
    }
  } finally {
    // kill ONLY what this test spawned, and only after re-proving its exact identity
    try {
      const rows = await table();
      for (const p of [B, W].concat(extraOwned)) {
        if (p && p.created && aliveExact(rows, p)) { try { process.kill(p.pid); console.log('cleanup: killed leftover test process ' + p.pid); } catch (_) {} }
      }
      await delay(300);
      const after = await table();
      A.ok(!aliveExact(after, B) && !aliveExact(after, W), 'nothing this test started is still running');
    } catch (e) { console.log('cleanup check failed: ' + (e && e.message)); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('procledger.windows-orphan.test');
})().catch(e => { console.log('FAIL: procledger.windows-orphan.test threw — ' + (e && e.stack || e)); process.exit(1); });
