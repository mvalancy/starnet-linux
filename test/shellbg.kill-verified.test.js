/* node test/shellbg.kill-verified.test.js — shell.bg.kill is a claim only with proof (h2 process supervision, F3).

   The audit's probe: shell.bg.kill answered {ok:true} in 13 ms with both processes still alive — it returned the
   moment taskkill was LAUNCHED — and when taskkill failed, the fallback child.kill() reached only cmd.exe. Locked
   here with an injected process table + fake spawn (no real processes):
     - kill() does not answer until taskkill has given its verdict and the table shows the owned tree gone;
     - a tree that is still running afterwards is INCOMPLETE with the surviving PIDs (never ok), rec.killed stays
       false, the ledger receipt is kept and each survivor gets an exact (pid, creation) receipt;
     - a taskkill failure is followed by a second pass on the orphans the table still shows (not just cmd.exe);
     - no table / a failing table -> "unverified", never "killed";
     - a process whose ppid matches but is OLDER than the root is a previous PID holder's child and is never
       targeted;
     - POSIX: the group is signalled and confirmed empty with signal 0. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeShellBg } = require('../sidecar/shellbg.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

const tick = () => new Promise(r => setImmediate(r));

// A fake OS: a mutable process table + a spawn whose taskkill mutates it according to a policy.
function makeWorld() {
  const w = { rows: [], taskkills: [], tableCalls: 0, tableFails: false, policy: 'tree' };
  w.table = async () => { w.tableCalls++; if (w.tableFails) throw new Error('simulated CIM timeout'); return w.rows.map(r => Object.assign({}, r)); };
  w.remove = (pids) => { w.rows = w.rows.filter(r => pids.indexOf(r.pid) < 0); };
  w.children = [];
  w.spawn = function (cmd, argsOrOpts) {
    if (cmd === 'taskkill') {
      const args = argsOrOpts.map(String);
      w.taskkills.push(args.join(' '));
      const handlers = {};
      const killer = { pid: 0, on(ev, fn) { handlers[ev] = fn; }, unref() {} };
      setImmediate(() => {
        const pids = []; for (let i = 0; i < args.length; i++) if (args[i] === '/pid') pids.push(Number(args[i + 1]));
        const code = w.onTaskkill(pids, args);
        if (handlers.close) handlers.close(code);
      });
      return killer;
    }
    const h = {};
    const child = {
      pid: w.nextPid, killedDirect: false,
      stdout: { on() {} }, stderr: { on() {} },
      on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
      unref() {}, kill() { this.killedDirect = true; w.onDirectKill(this); },
      _exit(code) { (h.exit || []).forEach(f => f(code)); (h.close || []).forEach(f => f(code)); }
    };
    w.children.push(child);
    return child;
  };
  // default taskkill: kills the named pid and its whole live subtree (by ppid links), returns 0
  w.onTaskkill = (pids) => {
    const dead = new Set(pids);
    let grew = true;
    while (grew) { grew = false; for (const r of w.rows) if (!dead.has(r.pid) && dead.has(r.ppid)) { dead.add(r.pid); grew = true; } }
    w.remove([...dead]);
    for (const c of w.children) if (dead.has(c.pid)) setImmediate(() => c._exit(1));
    return 0;
  };
  w.onDirectKill = (c) => { w.remove([c.pid]); setImmediate(() => c._exit(1)); };
  return w;
}
function mkLedger() {
  const L = { records: [], released: [], exited: [] };
  L.record = (e) => { L.records.push(e); return e; };
  L.pinIdentity = async () => null;
  L.release = (pid) => L.released.push(pid);
  L.markExited = (pid) => L.exited.push(pid);
  return L;
}
const fast = { attempts: 3, pollMs: 0, sleep: async () => {} };

(async () => {
  // ---- 1. verified: the owned tree is confirmed gone; an OLDER same-ppid process is never targeted ----
  {
    const w = makeWorld(); w.nextPid = 1000;
    const ledger = mkLedger();
    const bg = makeShellBg({ spawn: w.spawn, isWin: true, clock: { now: () => 9000 }, ledger, processTable: w.table, killVerify: fast });
    bg.start({ agentId: 'a', cmd: 'npm run dev' });
    w.rows = [
      { pid: 1000, ppid: 1, created: 5000 },   // cmd.exe wrapper (ours)
      { pid: 2000, ppid: 1000, created: 5001 },  // npm (ours)
      { pid: 3000, ppid: 2000, created: 5002 },  // node server (ours)
      { pid: 4000, ppid: 1000, created: 4000 },  // older than the root: a previous holder of pid 1000's child — NOT ours
      { pid: 77, ppid: 1, created: 1 }
    ];
    w.onTaskkill = ((orig) => (pids, args) => {
      // taskkill /T on 1000 kills 1000 + its subtree, but must leave 4000 alone in a real OS only by accident of
      // its tree walk — the proof here is that shellbg never NAMES 4000 and never counts it
      const code = orig(pids, args);
      w.rows.push({ pid: 4000, ppid: 1000, created: 4000 });
      return code;
    })(w.onTaskkill);
    const p = bg.kill('a', 'bg_1');
    A.ok(p && typeof p.then === 'function', 'kill returns a promise (the answer waits for proof)');
    let settled = false; p.then(() => { settled = true; });
    A.eq(settled, false, 'kill has NOT answered synchronously (the old code said ok in 13 ms before taskkill even ran)');
    const r = await p;
    A.eq(r.ok, true, 'a confirmed kill is ok');
    A.eq(r.verified, true, 'and says verified');
    A.eq(r.killedPids.slice().sort(), [1000, 2000, 3000], 'killedPids is exactly the owned tree');
    A.ok(w.taskkills.every(t => t.indexOf('4000') < 0), 'the older same-ppid process is never named to taskkill');
    A.ok(w.rows.some(x => x.pid === 4000), 'and it is still alive');
    const st = bg.status('a', 'bg_1');
    A.eq(st.killed, true, 'status reports killed only after proof');
    A.eq(st.killState, 'verified', 'killState verified');
    A.eq(ledger.released, [1000], 'the ledger receipt is released once the kill is proven');
    A.ok(w.tableCalls >= 2, 'the table was read before the kill and again to confirm (' + w.tableCalls + ')');
  }

  // ---- 2. incomplete: a grandchild survives taskkill AND the second pass -> survivors reported, receipt kept ----
  {
    const w = makeWorld(); w.nextPid = 1000;
    const ledger = mkLedger();
    const bg = makeShellBg({ spawn: w.spawn, isWin: true, clock: { now: () => 9000 }, ledger, processTable: w.table, killVerify: fast });
    bg.start({ agentId: 'a', cmd: 'node server.js' });
    w.rows = [{ pid: 1000, ppid: 1, created: 5000 }, { pid: 2000, ppid: 1000, created: 5001 }, { pid: 3000, ppid: 2000, created: 5002 }];
    w.onTaskkill = (pids) => {   // access denied on 3000: everything else dies
      const kill = []; for (const r of w.rows) if (r.pid !== 3000 && (pids.indexOf(r.pid) >= 0 || r.ppid === 1000 || r.pid === 1000)) kill.push(r.pid);
      w.remove(kill);
      for (const c of w.children) if (kill.indexOf(c.pid) >= 0) setImmediate(() => c._exit(1));
      return pids.indexOf(3000) >= 0 ? 1 : 0;
    };
    const r = await bg.kill('a', 'bg_1');
    A.eq(r.ok, false, 'a kill that left a process running is NOT ok');
    A.eq(r.incomplete, true, 'it is reported incomplete');
    A.eq(r.survivors, [3000], 'naming the surviving PID');
    A.ok(w.taskkills.some(t => /\/pid 3000/.test(t)), 'a second pass targeted the survivor by pid');
    const st = bg.status('a', 'bg_1');
    A.eq(st.killed, false, 'rec.killed is NOT set without proof');
    A.eq(st.killState, 'incomplete', 'killState incomplete');
    A.eq(st.survivors, [3000], 'status carries the survivors');
    A.eq(ledger.released.length, 0, 'the root receipt is KEPT for the next boot sweep');
    A.ok(ledger.exited.indexOf(1000) >= 0, 'the root exit froze its orphan window (markExited)');
    const sr = ledger.records.find(e => e.pid === 3000);
    A.ok(sr && sr.created === 5002 && /survivor/.test(sr.kind), 'the survivor got an exact (pid, creation) receipt');

    // the TOOL turns it into an error naming the survivors (not "Killed background process")
    const fs = { mkdirSync() {}, existsSync() { return true; } };
    const w2 = makeWorld(); w2.nextPid = 1000;
    const bg2 = makeShellBg({ spawn: w2.spawn, isWin: true, processTable: w2.table, killVerify: fast });
    const tools = makeShellTool({ spawn: w2.spawn, fs, pathMod: path, root: path.join('root'), bg: bg2, platform: 'win32' });
    bg2.start({ agentId: 'a', cmd: 'node server.js' });
    w2.rows = [{ pid: 1000, ppid: 1, created: 5000 }, { pid: 2000, ppid: 1000, created: 5001 }];
    w2.onTaskkill = () => 1;   // taskkill refuses everything
    w2.onDirectKill = (c) => { w2.remove([c.pid]); setImmediate(() => c._exit(1)); };   // child.kill reaches only cmd.exe
    let thrown = null;
    try { await tools.bgKillTool.run({ id: 'bg_1' }, { agentId: 'a' }); } catch (e) { thrown = e; }
    A.ok(thrown && /INCOMPLETE/.test(thrown.message) && /2000/.test(thrown.message), 'shell.bg.kill throws an INCOMPLETE error naming the survivor PID');
    A.eq(thrown && thrown.toolSummary, 'kill incomplete', 'with an honest tool summary');
    A.ok(w2.children[0].killedDirect, 'the root fallback still ran');
  }

  // ---- 3. taskkill fails outright: the orphan cmd.exe left behind is found and killed by a second pass ----
  {
    const w = makeWorld(); w.nextPid = 1000;
    const bg = makeShellBg({ spawn: w.spawn, isWin: true, processTable: w.table, killVerify: fast });
    bg.start({ agentId: 'a', cmd: 'node server.js' });
    w.rows = [{ pid: 1000, ppid: 1, created: 5000 }, { pid: 2000, ppid: 1000, created: 5001 }];
    let first = true;
    w.onTaskkill = ((orig) => (pids, args) => { if (first) { first = false; return 128; } return orig(pids, args); })(w.onTaskkill);
    const r = await bg.kill('a', 'bg_1');
    A.ok(w.children[0].killedDirect, 'taskkill failure falls back to the direct root kill');
    A.eq(r.verified, true, 'the orphan the fallback could not reach was killed by the identity-proven second pass');
    A.ok(!w.rows.some(x => x.pid === 2000), 'the node child is gone (the old fallback left it running)');
  }

  // ---- 4. no table / a failing table: "unverified", never "killed" ----
  {
    const w = makeWorld(); w.nextPid = 1000;
    const bg = makeShellBg({ spawn: w.spawn, isWin: true, killVerify: fast });   // no processTable
    bg.start({ agentId: 'a', cmd: 'x' });
    const r = await bg.kill('a', 'bg_1');
    A.eq(r.ok, false, 'without a process table the kill is not claimed');
    A.eq(r.unverified, true, 'it is unverified');
    A.eq(r.rootExited, true, 'but says the root itself did exit');
    A.eq(bg.status('a', 'bg_1').killed, false, 'rec.killed stays false');

    const w2 = makeWorld(); w2.nextPid = 1000; w2.tableFails = true;
    const bg2 = makeShellBg({ spawn: w2.spawn, isWin: true, processTable: w2.table, killVerify: fast });
    bg2.start({ agentId: 'a', cmd: 'x' });
    const r2 = await bg2.kill('a', 'bg_1');
    A.eq(r2.unverified, true, 'a failing table query is unverified');
    A.ok(/simulated CIM timeout/.test(r2.error), 'and names why');
    A.eq(w2.taskkills.length, 1, 'nothing beyond the root taskkill is killed on the basis of a table it could not read');

    const fs = { mkdirSync() {}, existsSync() { return true; } };
    const w3 = makeWorld(); w3.nextPid = 1000;
    const bg3 = makeShellBg({ spawn: w3.spawn, isWin: true, killVerify: fast });
    const tools = makeShellTool({ spawn: w3.spawn, fs, pathMod: path, root: path.join('root'), bg: bg3, platform: 'win32' });
    bg3.start({ agentId: 'a', cmd: 'x' });
    const out = await tools.bgKillTool.run({ id: 'bg_1' }, { agentId: 'a' });
    A.ok(/NOT confirmed/.test(out.content) && out.summary === 'kill unconfirmed', 'the tool says the kill is unconfirmed, not "Killed"');
  }

  // ---- 5. a second kill joins the first; killAll starts kills without a pre-kill snapshot ----
  {
    const w = makeWorld(); w.nextPid = 1000;
    const bg = makeShellBg({ spawn: w.spawn, isWin: true, processTable: w.table, killVerify: fast });
    bg.start({ agentId: 'a', cmd: 'x' });
    w.rows = [{ pid: 1000, ppid: 1, created: 5000 }];
    const p1 = bg.kill('a', 'bg_1'), p2 = bg.kill('a', 'bg_1');
    A.ok(p1 === p2, 'a second kill request joins the in-flight one');
    A.eq(bg.count('a'), 0, 'the cap slot frees as soon as the kill is requested');
    await p1;
    const w2 = makeWorld(); w2.nextPid = 1000;
    const bg2 = makeShellBg({ spawn: w2.spawn, isWin: true, processTable: w2.table, killVerify: fast });
    bg2.start({ agentId: 'a', cmd: 'x' });
    w2.rows = [{ pid: 1000, ppid: 1, created: 5000 }];
    A.eq(bg2.killAll(), 1, 'killAll returns the count synchronously');
    A.eq(w2.taskkills.length, 1, 'the taskkill was launched immediately, in the same tick');
    A.eq(w2.tableCalls, 0, 'killAll does not delay the kill behind a table snapshot (shutdown has a 3s deadline)');
    for (let i = 0; i < 20 && bg2.status('a', 'bg_1').killState === 'pending'; i++) await tick();
    A.eq(bg2.status('a', 'bg_1').killState, 'verified', 'and confirmed afterwards');
  }

  // ---- 6. POSIX: group SIGKILL, confirmed empty with signal 0 ----
  {
    const w = makeWorld(); w.nextPid = 1000;
    const sigs = [];
    let groupAlive = true;
    const signalProcess = (pid, sig) => {
      sigs.push(pid + ':' + sig);
      if (sig === 'SIGKILL' && pid === -1000) { setImmediate(() => w.children[0]._exit(137)); setImmediate(() => { groupAlive = false; }); return true; }
      if (sig === 0) { if (groupAlive) return true; const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
      return true;
    };
    const bg = makeShellBg({ spawn: w.spawn, isWin: false, signalProcess, killVerify: { attempts: 20, pollMs: 0, sleep: () => tick() } });
    bg.start({ agentId: 'a', cmd: 'npm run dev' });
    const r = await bg.kill('a', 'bg_1');
    A.eq(sigs[0], '-1000:SIGKILL', 'the whole process GROUP is killed');
    A.ok(sigs.indexOf('-1000:0') >= 0, 'and probed with signal 0');
    A.eq(r.verified, true, 'an empty group (ESRCH) is a verified kill');

    const w2 = makeWorld(); w2.nextPid = 1000;
    const stuck = (pid, sig) => { if (sig === 'SIGKILL') { setImmediate(() => w2.children[0]._exit(137)); } return true; };   // group never empties
    const bg2 = makeShellBg({ spawn: w2.spawn, isWin: false, signalProcess: stuck, killVerify: fast });
    bg2.start({ agentId: 'a', cmd: 'npm run dev' });
    const r2 = await bg2.kill('a', 'bg_1');
    A.eq(r2.incomplete, true, 'a group that still has members after the kill is incomplete');
    A.eq(bg2.status('a', 'bg_1').killed, false, 'and never marked killed');
  }

  // ---- 7. an UNSETTLED kill is retryable: it keeps its cap slot, a second kill re-runs it, killAll retries it ----
  {
    const denyOn3000 = (w) => (pids) => {   // access denied on 3000: everything else dies
      const kill = []; for (const r of w.rows) if (r.pid !== 3000 && (pids.indexOf(r.pid) >= 0 || r.ppid === 1000 || r.pid === 1000)) kill.push(r.pid);
      w.remove(kill);
      for (const c of w.children) if (kill.indexOf(c.pid) >= 0) setImmediate(() => c._exit(1));
      return pids.indexOf(3000) >= 0 ? 1 : 0;
    };
    const w = makeWorld(); w.nextPid = 1000;
    const ledger = mkLedger();
    const bg = makeShellBg({ spawn: w.spawn, isWin: true, clock: { now: () => 9000 }, ledger, processTable: w.table, killVerify: fast, maxPerAgent: 1 });
    bg.start({ agentId: 'a', cmd: 'node server.js' });
    w.rows = [{ pid: 1000, ppid: 1, created: 5000 }, { pid: 2000, ppid: 1000, created: 5001 }, { pid: 3000, ppid: 2000, created: 5002 }];
    const defaultTk = w.onTaskkill;
    w.onTaskkill = denyOn3000(w);
    const r1 = await bg.kill('a', 'bg_1');
    A.eq(r1.incomplete, true, 'first kill leaves 3000 alive (incomplete)');
    A.eq(bg.status('a', 'bg_1').running, false, 'the root itself did exit');
    A.eq(bg.count('a'), 1, 'a failed kill whose survivor is still running KEEPS its cap slot (it used to free it)');
    // the OS lets go of 3000 now: a retry must actually run, not hand back the stale incomplete verdict
    w.onTaskkill = defaultTk;
    const before = w.taskkills.length;
    const r2 = await bg.kill('a', 'bg_1');
    A.eq(r2.verified, true, 'a second kill after an incomplete verdict is re-run and can succeed');
    A.ok(w.taskkills.length > before, 'the retry launched taskkill again');
    A.ok(w.taskkills.slice(before).every(t => !/\/pid 1000\b/.test(t)), 'the retry never names the exited root PID (it may be a stranger now)');
    A.ok(w.taskkills.slice(before).some(t => /\/pid 3000/.test(t)), 'it names the survivor by its re-proven identity');
    A.ok(!w.rows.some(x => x.pid === 3000), 'the survivor is gone');
    A.eq(bg.status('a', 'bg_1').killState, 'verified', 'killState is now verified');
    A.eq(bg.count('a'), 0, 'and the slot frees only now');
    A.eq(ledger.released, [1000], 'the receipt is released on the proven retry');
    A.ok((await bg.kill('a', 'bg_1')).verified, 'a verified verdict is final: a later kill returns it');

    // E-STOP / shutdown: killAll retries a record whose earlier kill was not proven
    const w2 = makeWorld(); w2.nextPid = 1000;
    const bg2 = makeShellBg({ spawn: w2.spawn, isWin: true, clock: { now: () => 9000 }, processTable: w2.table, killVerify: fast });
    bg2.start({ agentId: 'a', cmd: 'node server.js' });
    w2.rows = [{ pid: 1000, ppid: 1, created: 5000 }, { pid: 2000, ppid: 1000, created: 5001 }, { pid: 3000, ppid: 2000, created: 5002 }];
    const defaultTk2 = w2.onTaskkill;
    w2.onTaskkill = denyOn3000(w2);
    A.eq((await bg2.kill('a', 'bg_1')).incomplete, true, 'the agent kill is incomplete');
    w2.onTaskkill = defaultTk2;
    A.eq(bg2.killAll(), 1, 'killAll counts and retries the unsettled record (it used to skip every killRequested record)');
    for (let i = 0; i < 40 && bg2.status('a', 'bg_1').killState === 'pending'; i++) await tick();
    A.eq(bg2.status('a', 'bg_1').killState, 'verified', 'and the retry is confirmed');
    A.ok(!w2.rows.some(x => x.pid === 3000), 'the survivor E-STOP was owed is gone');
    A.eq(bg2.killAll(), 0, 'a verified record is never re-killed');
  }

  // ---- 8. shell.bg.kill's registry backstop covers the whole verify budget (the 30s default cut it off) ----
  {
    const { killBudgetMs } = require('../sidecar/shellbg.js');
    const def = killBudgetMs();
    // snapshot 15s + taskkill 10s + root wait 16x250 + confirm (15s + 15x250) + 2nd taskkill 10s + 2nd confirm
    A.eq(def, 15000 + 10000 + 4000 + 18750 + 10000 + 18750, 'the default kill budget is the sum of its bounded steps');
    A.ok(def > 30000, 'and it is longer than the registry\'s 30s default tool timeout');
    const w = makeWorld(); w.nextPid = 1000;
    const bgDefault = makeShellBg({ spawn: w.spawn, isWin: true, processTable: w.table });
    A.eq(bgDefault.killBudgetMs, def, 'a manager with production settings reports the default budget');
    const fsx = { mkdirSync() {}, existsSync() { return true; } };
    const tools = makeShellTool({ spawn: w.spawn, fs: fsx, pathMod: path, root: path.join('root'), bg: bgDefault, platform: 'win32' });
    A.ok(tools.bgKillTool.timeoutMs > def, 'shell.bg.kill declares a timeoutMs above the verify budget (' + tools.bgKillTool.timeoutMs + ')');
    const bgSlow = makeShellBg({ spawn: w.spawn, isWin: true, processTable: w.table, killVerify: { attempts: 40, pollMs: 500, taskkillMs: 20000, tableMs: 30000 } });
    const t2 = makeShellTool({ spawn: w.spawn, fs: fsx, pathMod: path, root: path.join('root'), bg: bgSlow, platform: 'win32' });
    A.ok(t2.bgKillTool.timeoutMs > bgSlow.killBudgetMs && bgSlow.killBudgetMs > def, 'a slower configured manager widens the tool timeout with it');
  }

  A.report('shellbg.kill-verified.test');
})().catch(e => { console.log('FAIL: shellbg.kill-verified.test threw — ' + (e && e.stack || e)); process.exit(1); });
