/* node test/shellbg.prune.test.js — finished background records are bounded (h2 process supervision, F5).

   Every record used to live forever (procs.set with no delete), each holding up to 256KB of output, so a long
   session of short background jobs grew without limit. Locked: running records are NEVER dropped; finished ones
   beyond maxFinished go, oldest exit first; a record whose kill is still being confirmed is kept until its verdict. */
'use strict';
const A = require('./_assert.js');
const { makeShellBg } = require('../sidecar/shellbg.js');

function makeFakeSpawn() {
  const spawn = function (cmd) {
    if (cmd === 'taskkill') { const h = {}; spawn.killers.push(h); return { pid: 0, on(ev, fn) { h[ev] = fn; }, unref() {} }; }   // answers only when the test says so
    let dataCb = null; const h = {};
    const child = {
      pid: 1000 + spawn.children.length,
      stdout: { on: (ev, fn) => { if (ev === 'data') dataCb = fn; } }, stderr: { on() {} },
      on: (ev, fn) => { (h[ev] = h[ev] || []).push(fn); }, unref() {}, kill() {},
      _emit: (s) => { if (dataCb) dataCb(Buffer.from(String(s))); },
      _close: (code) => { (h.exit || []).forEach(f => f(code)); (h.close || []).forEach(f => f(code)); }
    };
    spawn.children.push(child);
    return child;
  };
  spawn.children = []; spawn.killers = [];
  return spawn;
}

let T = 0; const clock = { now: () => T };
const spawn = makeFakeSpawn();
const bg = makeShellBg({ spawn, clock, isWin: true, maxPerAgent: 1000, maxFinished: 64,
  killVerify: { attempts: 1, pollMs: 0, taskkillMs: 60000, sleep: async () => {} } });

// 5 long-lived processes that stay running the whole time
for (let i = 0; i < 5; i++) bg.start({ agentId: 'dev', cmd: 'server ' + i });
// 100 short jobs that each print output and exit, in order
for (let i = 0; i < 100; i++) {
  const r = bg.start({ agentId: 'job', cmd: 'job ' + i });
  const c = spawn.children[spawn.children.length - 1];
  c._emit('x'.repeat(1000) + '\n');
  T += 10;
  c._close(0);
  A.ok(r.ok, 'job ' + i + ' started');
}
const procs = bg._internals.procs;
const finished = [...procs.values()].filter(r => !r.running);
A.eq(finished.length, 64, 'finished records are capped at maxFinished (' + finished.length + ')');
A.eq(bg.status('dev').length, 5, 'every RUNNING record survives the prune');
A.ok(bg.status('dev').every(v => v.running), 'and they are all still running');
A.eq(bg.status('job', 'bg_6'), null, 'the OLDEST finished job (first to exit) was dropped');
A.ok(bg.status('job', 'bg_105') && bg.status('job', 'bg_105').exitCode === 0, 'the newest finished job is kept');
A.eq(bg.status('job').length, 64, 'the agent sees exactly the retained finished jobs');

// a record whose kill is still pending confirmation is not pruned out from under its verdict
bg.start({ agentId: 'k', cmd: 'stubborn' });
const kc = spawn.children[spawn.children.length - 1];
bg.kill('k', 'bg_106');                      // taskkill never answers in this fake -> stays 'pending'
T += 10; kc._close(1);                       // the root exits; the kill verdict is still outstanding
for (let i = 0; i < 70; i++) {               // push 70 more finished jobs through the cap
  bg.start({ agentId: 'job', cmd: 'late ' + i });
  const c = spawn.children[spawn.children.length - 1];
  T += 10; c._close(0);
}
A.ok(bg.status('k', 'bg_106') != null, 'a record whose kill is still being confirmed is kept');
A.eq(bg.status('k', 'bg_106').killState, 'pending', 'and still says the kill is unconfirmed');
A.ok([...procs.values()].filter(r => !r.running && r.killState !== 'pending').length <= 64, 'the cap still holds for everything else');

// release the held taskkill so the kill reaches its verdict and no timer outlives the test
(async () => {
  spawn.killers.forEach(h => { if (h.close) h.close(0); });
  for (let i = 0; i < 20 && bg.status('k', 'bg_106') && bg.status('k', 'bg_106').killState === 'pending'; i++) await new Promise(r => setImmediate(r));
  const v = bg.status('k', 'bg_106');
  A.ok(!v || v.killState !== 'pending', 'the held kill reached a verdict once taskkill answered');
  A.report('shellbg.prune.test');
})().catch(e => { console.log('FAIL: shellbg.prune.test threw — ' + (e && e.stack || e)); process.exit(1); });
