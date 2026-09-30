/* node test/procledger.orphan-window.test.js — the boot sweep reaps the orphans of a DEAD root, by proof (h2, F1).

   The audit's probe: a force-killed sidecar takes the cmd.exe wrapper with it, the command it launched keeps running
   with ParentProcessId pointing at the dead wrapper, and the sweep counted the wrapper "gone" (procledger.js
   :241-242) and never looked further. This is the pure half of the fix, with an injected process table (no real
   processes — the real Windows proof is test/procledger.windows-orphan.test.js):
     - a live descendant of a dead root is reaped only if it was created inside [root created, root last-held];
       older (a previous PID holder's child) and newer (a stranger that got the PID later) are never touched;
     - a legacy receipt with no liveness stamp is never walked;
     - a failed table query kills nothing, says so, keeps the receipt for a bounded number of boots;
     - kills are confirmed; a survivor is reported and gets an exact receipt the next boot kills by identity;
     - seenAt only advances while the owner vouches (record / pin / touch) and freezes at markExited. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeProcLedger } = require('../sidecar/procledger.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-orphan-window-'));
let n = 0;
const fileOf = () => path.join(dir, 'l' + (++n) + '.json');
const writeLedger = (file, procs) => fs.writeFileSync(file, JSON.stringify({ procs }));
const confirm = { attempts: 2, pollMs: 0, sleep: async () => {} };

(async () => {
  try {
    // ---- 1. dead root + in-window orphan tree -> reaped from its top, confirmed, receipt consumed ----
    {
      const file = fileOf();
      writeLedger(file, [{ pid: 500, cmd: 'npm run dev', kind: 'shell.bg', startedAt: 10000, created: 9990, seenAt: 20000 }]);
      let rows = [
        { pid: 600, ppid: 500, created: 9995 },    // node (npm) — the wrapper's child, in window
        { pid: 700, ppid: 600, created: 12000 },   // vite server — child of a LIVE node, fine at any later time
        { pid: 800, ppid: 500, created: 9000 },    // older than the root: a previous holder of 500's child
        { pid: 900, ppid: 500, created: 25000 },   // newer than root-last-held: a stranger that later got pid 500
        { pid: 1, ppid: 0, created: 1 }
      ];
      const killed = [];
      const L = makeProcLedger({ fs, pathMod: path, file, clock: { now: () => 30000 },
        probe: async () => new Map(),               // the root (500) is gone
        processTable: async () => rows.map(r => Object.assign({}, r)),
        killTree: async (pid) => { killed.push(pid); const dead = new Set([pid]); let g = true; while (g) { g = false; for (const r of rows) if (!dead.has(r.pid) && dead.has(r.ppid) && r.pid !== 800 && r.pid !== 900) { dead.add(r.pid); g = true; } } rows = rows.filter(r => !dead.has(r.pid)); },
        confirm, protectPids: [] });
      const s = await L.sweep();
      A.eq(killed, [600], 'the orphaned subtree is killed from its top (the dead root\'s in-window child)');
      A.eq(s.orphaned, 1, 'the receipt is counted orphaned (not "gone")');
      A.eq(s.orphansKilled, 2, 'both owned descendants are confirmed dead');
      A.eq(s.gone, 0, 'nothing is laundered into "gone"');
      A.eq(s.survived, 0, 'no survivors');
      A.ok(rows.some(r => r.pid === 800) && rows.some(r => r.pid === 900), 'the older and the newer same-ppid processes are untouched');
      A.eq(JSON.parse(fs.readFileSync(file, 'utf8')).procs.length, 0, 'a confirmed reap consumes the receipt');
    }

    // ---- 2. a legacy receipt (no seenAt) cannot bound PID reuse: never walked ----
    {
      const file = fileOf();
      writeLedger(file, [{ pid: 500, cmd: 'npm run dev', kind: 'shell.bg', startedAt: 10000, created: 9990 }]);
      let tableReads = 0;
      const L = makeProcLedger({ fs, pathMod: path, file, clock: { now: () => 30000 }, probe: async () => new Map(),
        processTable: async () => { tableReads++; return [{ pid: 600, ppid: 500, created: 9995 }]; },
        killTree: async () => A.ok(false, 'a legacy receipt must never drive a kill'), confirm, protectPids: [] });
      const s = await L.sweep();
      A.eq(s.gone, 1, 'a legacy receipt with a dead root is simply gone (as before)');
      A.eq(s.orphaned, 0, 'and never orphan-walked');
    }

    // ---- 3. table query failure: kill NOTHING, say so, retain the receipt for a bounded number of boots ----
    {
      const file = fileOf();
      writeLedger(file, [{ pid: 500, cmd: 'npm run dev', kind: 'shell.bg', startedAt: 10000, created: 9990, seenAt: 20000 }]);
      const mk = () => makeProcLedger({ fs, pathMod: path, file, clock: { now: () => 30000 }, probe: async () => new Map(),
        processTable: async () => { throw new Error('simulated CIM timeout'); },
        killTree: async () => A.ok(false, 'nothing may be killed on the basis of a failed table query'), confirm, protectPids: [] });
      const s1 = await mk().sweep();
      A.eq(s1.treeQueryFailed, true, 'the failure is reported distinctly');
      A.eq(s1.treeUnverified, 1, 'the receipt is counted unverified');
      A.eq(s1.gone, 0, 'NOT counted gone');
      const kept = JSON.parse(fs.readFileSync(file, 'utf8')).procs;
      A.eq(kept.map(p => p.pid), [500], 'the receipt is retained for the next boot');
      A.eq(kept[0].treeRetries, 1, 'with a retry count');
      await mk().sweep();
      await mk().sweep();
      A.eq(JSON.parse(fs.readFileSync(file, 'utf8')).procs.length, 0, 'after 3 failed boots it is dropped (a CIM-denied host cannot accumulate receipts forever)');
    }

    // ---- 4. a survivor is reported and gets an exact receipt; the next boot kills it by identity ----
    {
      const file = fileOf();
      writeLedger(file, [{ pid: 500, cmd: 'npm run dev', kind: 'shell.bg', startedAt: 10000, created: 9990, seenAt: 20000 }]);
      const rows = [{ pid: 600, ppid: 500, created: 9995 }];
      const L = makeProcLedger({ fs, pathMod: path, file, clock: { now: () => 30000 }, probe: async () => new Map(),
        processTable: async () => rows.map(r => Object.assign({}, r)),
        killTree: async () => {},                   // "succeeds" but the process is still there
        confirm, protectPids: [] });
      const s = await L.sweep();
      A.eq(s.survived, 1, 'the survivor is counted');
      A.eq(s.survivors, [{ pid: 600, created: 9995 }], 'and named with its exact identity');
      A.eq(s.orphansKilled, 0, 'no kill is claimed for it');
      const kept = JSON.parse(fs.readFileSync(file, 'utf8')).procs;
      const sv = kept.find(p => p.pid === 600);
      A.ok(sv && sv.created === 9995 && /survivor/.test(sv.kind), 'an exact (pid, creation) receipt is retained for the survivor');
      const killed = [];
      const L2 = makeProcLedger({ fs, pathMod: path, file, clock: { now: () => 40000 },
        probe: async (pids) => new Map(pids.filter(p => p === 600).map(p => [p, { cmd: 'node', created: 9995 }])),
        processTable: async () => [], killTree: async (pid) => killed.push(pid), confirm, protectPids: [] });
      await L2.sweep();
      A.ok(killed.indexOf(600) >= 0, 'the next boot kills the survivor by its exact identity');
    }

    // ---- 5. a LIVE pinned root: its tree is captured before the kill and confirmed after ----
    {
      const file = fileOf();
      writeLedger(file, [{ pid: 500, cmd: 'npm run dev', kind: 'shell.bg', startedAt: 10000, created: 9990, seenAt: 20000 }]);
      let rows = [{ pid: 500, ppid: 4, created: 9990 }, { pid: 600, ppid: 500, created: 9995 }, { pid: 700, ppid: 600, created: 9999 }];
      const L = makeProcLedger({ fs, pathMod: path, file, clock: { now: () => 30000 },
        probe: async () => new Map([[500, { cmd: 'cmd.exe /c npm run dev', created: 9990 }]]),
        processTable: async () => rows.map(r => Object.assign({}, r)),
        killTree: async () => { rows = rows.filter(r => r.pid !== 500 && r.pid !== 600); },   // 700 escapes taskkill
        confirm, protectPids: [] });
      const s = await L.sweep();
      A.eq(s.killed, 1, 'the live root is killed');
      A.eq(s.survived, 1, 'the escaped grandchild is reported as a survivor, not hidden behind "killed"');
      A.ok(JSON.parse(fs.readFileSync(file, 'utf8')).procs.some(p => p.pid === 700 && p.created === 9999), 'and receipted exactly for the next boot');
    }

    // ---- 6. seenAt advances only while the owner vouches, and freezes at markExited ----
    {
      const file = fileOf();
      let T = 1000;
      const L = makeProcLedger({ fs, pathMod: path, file, clock: { now: () => T },
        probe: async () => new Map([[42, { cmd: 'x', created: 990 }]]), killTree: async () => {} });
      L.record({ pid: 42, cmd: 'x', kind: 'shell.bg' });
      A.eq(L.list()[0].seenAt, 1000, 'record stamps seenAt (the spawner holds the handle)');
      T = 1500; await L.pinIdentity(42);
      A.eq(L.list()[0].created, 990, 'pin records exact creation');
      A.eq(L.list()[0].seenAt, 1500, 'and advances seenAt (the probe saw it alive)');
      T = 5000; L.touch([42]);
      A.eq(L.list()[0].seenAt, 5000, 'touch advances seenAt');
      T = 6000; L.markExited(42);
      A.eq(L.list()[0].exitedAt, 6000, 'markExited records the exit');
      T = 9000; L.touch([42]);
      A.eq(L.list()[0].seenAt, 5000, 'after the exit no touch can move the window (the PID may be a stranger\'s now)');
      A.eq(JSON.parse(fs.readFileSync(file, 'utf8')).procs[0].exitedAt, 6000, 'the frozen window is durable on disk');
      L.record({ pid: 43, cmd: 'y', kind: 'survivor', created: 777 });
      A.eq(L.list().find(p => p.pid === 43).created, 777, 'an exact creation time can be supplied (no probe needed)');
    }

    // ---- 7. an injected probe/killTree never gets a REAL table (a fake ledger can't read the host's processes) ----
    {
      const file = fileOf();
      writeLedger(file, [{ pid: 500, cmd: 'x', kind: 'shell.bg', startedAt: 10000, created: 9990, seenAt: 20000 }]);
      const L = makeProcLedger({ fs, pathMod: path, file, clock: { now: () => 30000 }, isWin: true, probe: async () => new Map(), killTree: async () => A.ok(false, 'no kill') });
      const s = await L.sweep();
      A.eq(s.gone, 1, 'no table was built: the dead root is gone, nothing walked');
      A.eq(s.treeQueryFailed, false, 'and no real table query was attempted');
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('procledger.orphan-window.test');
})().catch(e => { console.log('FAIL: procledger.orphan-window.test threw — ' + (e && e.stack || e)); process.exit(1); });
