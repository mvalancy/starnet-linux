/* node test/code-mode.test.js — code.run child isolation + bounded programmatic composition. */
'use strict';
const A = require('./_assert.js');
const Code = require('../sidecar/tools/builtin/code.js');

async function expectReject(p, pattern, label) {
  let error = null;
  try { await p; } catch (e) { error = e; }
  A.ok(error && pattern.test(String(error.message || error)), label);
}

(async () => {
  // Real child process: loop/filter/branch/aggregate. Intermediate records stay inside the child;
  // only the final reduced value becomes code.run's content.
  {
    const calls = [];
    const t = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool;
    const out = await t.run({ code: `
      const ids = [1,2,3,4];
      const rows = [];
      for (const id of ids) rows.push(await tool('records.get', { id }));
      const kept = rows.filter(row => row.score >= 6);
      if (kept.length < 2) return { status: 'too-few' };
      return { status: 'ok', ids: kept.map(row => row.id), total: kept.reduce((n,row) => n + row.score, 0) };
    ` }, { callId: 'outer', composeDispatch: async req => { calls.push(req); return { id: req.args.id, score: req.args.id * 3 }; } });
    A.eq(out.content, JSON.stringify({ status: 'ok', ids: [2,3,4], total: 27 }), 'loop/filter/branch/aggregation returns only its final value');
    A.eq(calls.length, 4, 'all four nested reads crossed the parent callback');
    A.eq(out.summary, 'code composed 4 read calls', 'summary truthfully counts parent-dispatched reads');
  }

  // The vm has no ambient Node authority and the fork gets a deliberately tiny environment.
  {
    process.env.STARNET_CODE_SECRET_TEST = 'must-not-cross';
    const t = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool;
    const out = await t.run({ code: `return { process: typeof process, require: typeof require, secret: typeof STARNET_CODE_SECRET_TEST };` }, { composeDispatch: async () => '' });
    A.eq(out.content, JSON.stringify({ process: 'undefined', require: 'undefined', secret: 'undefined' }), 'process, require, and parent env secrets are absent');
    delete process.env.STARNET_CODE_SECRET_TEST;
    await expectReject(t.run({ code: `return ({}).constructor.constructor('return process')();` }, { composeDispatch: async () => '' }), /code generation.*disallowed/i, 'Function-constructor escape is blocked');
    // Everything the model can touch is CONTEXT-realm (2026-09-25): tool, print, console, the Promise tool() returns
    // and the value it resolves to. None of their constructor chains can compile code.
    const reachable = await t.run({ code: `
      const p = tool('records.get', {});
      const v = await p;
      const probes = { tool, print, log: console.log, promise: p, value: v, then: p.then };
      const out = {};
      for (const k of Object.keys(probes)) {
        try { probes[k].constructor.constructor('return 1')(); out[k] = 'COMPILED'; }
        catch (e) { out[k] = /code generation/i.test(String(e && e.message)) ? 'blocked' : 'other:' + String(e && e.message); }
      }
      return out;` }, { composeDispatch: async () => ({ nested: { deep: [1] } }) });
    A.eq(reachable.content, JSON.stringify({ tool: 'blocked', print: 'blocked', log: 'blocked', promise: 'blocked', value: 'blocked', then: 'blocked' }),
      'no value reachable from model code leads to a Function that can compile code');
    const bridgeGone = await t.run({ code: `return { bridge: typeof __starnetBridge, run: typeof __starnetRun, fn: typeof __starnetUserFn };` }, { composeDispatch: async () => '' });
    A.eq(bridgeGone.content, JSON.stringify({ bridge: 'undefined', run: 'undefined', fn: 'undefined' }), 'the host bridge and runner are gone from the global before model code runs');
  }

  // Layer 2: the worker runs under Node's permission model and refuses to run model code without it.
  {
    const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
    const argv = Code._internals.workerExecArgv('X');
    A.ok(argv.includes('--permission') && argv.includes('--disallow-code-generation-from-strings') && argv.includes('--allow-fs-read=X'), 'the worker starts under the permission model with one fs-read grant');
    A.ok(!argv.some(a => /allow-(child-process|worker|addons|wasi|fs-write)/.test(a)), 'no process, worker, addon, WASI or fs-write grant is ever given');
    A.ok(Code._internals.permissionFlagSupported('v22.23.2') && Code._internals.permissionFlagSupported('v24.1.0') && !Code._internals.permissionFlagSupported('v22.12.0') && !Code._internals.permissionFlagSupported('v20.18.0'), 'the permission flag gate matches Node 22.13+/23.5+');
    await expectReject(Code.makeCodeTools({ nodeVersion: 'v20.18.0' }).codeTool.run({ code: 'return 1' }, { composeDispatch: async () => '' }), /needs the Node permission model/, 'an older Node refuses code.run instead of falling back');

    // A child started with the SAME flags cannot spawn, read outside its grant, or write.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeperm-'));
    const other = path.join(dir, 'other.txt'); fs.writeFileSync(other, 'secret');
    const probe = path.join(dir, 'probe.js');
    fs.writeFileSync(probe, `const r = {};
      const t = (k, f) => { try { f(); r[k] = 'ALLOWED'; } catch (e) { r[k] = e.code || 'threw'; } };
      t('spawn', () => require('child_process').spawnSync(process.execPath, ['-v']));
      t('read', () => require('fs').readFileSync(${JSON.stringify(other)}));
      t('write', () => require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'w.txt'))}, 'x'));
      t('worker', () => new (require('worker_threads').Worker)('1', { eval: true }));
      t('eval', () => { if (eval('1') !== 1) throw new Error('x'); });
      process.stdout.write(JSON.stringify(r));`);
    const res = cp.spawnSync(process.execPath, Code._internals.workerExecArgv(probe).concat([probe]), { encoding: 'utf8' });
    let seen = {};
    try { seen = JSON.parse(res.stdout); } catch (e) { seen = { parseError: res.stdout + res.stderr }; }
    A.eq(Object.keys(seen).filter(k => seen[k] === 'ALLOWED'), [], 'under the worker flags: spawn, foreign reads, writes, workers and eval are all denied (' + JSON.stringify(seen) + ')');
    fs.rmSync(dir, { recursive: true, force: true });

    // Fail closed: a worker started WITHOUT the permission model reports isolation unavailable and runs nothing.
    const unsafeFork = (p, a, o) => cp.fork(p, a, Object.assign({}, o, { execArgv: (o.execArgv || []).filter(x => x !== '--permission' && !/^--allow-fs-read=/.test(x)) }));
    await expectReject(Code.makeCodeTools({ fork: unsafeFork, limits: { timeoutMs: 3000 } }).codeTool.run({ code: 'return 1' }, { composeDispatch: async () => '' }),
      /isolation unavailable/, 'without the permission model the worker refuses to run model code');
  }

  // Parent denial remains authoritative and is catchable as a normal script error.
  {
    const t = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool;
    const out = await t.run({ code: `try { await tool('fs.write', {path:'x',content:'y'}); } catch (e) { return e.message; }` }, {
      composeDispatch: async () => { throw new Error('code.run v1 may compose only consent-free read tools; refused fs.write'); }
    });
    A.ok(/refused fs\.write/.test(out.content), 'a denied nested mutation reaches the program as an error, never executes');
  }

  // Host policy rejects recursion, team fan-out, mutations, connectors, and withheld reads before dispatch.
  {
    const R = Code._internals.refusalForNested;
    const granted = new Set(['code.run', 'fs.read', 'fs.write', 'team.spawn', 'mcp.read']);
    A.ok(/recursive/.test(R('code.run', { scope: 'read' }, granted)), 'recursive code.run denied');
    A.ok(/team/.test(R('team.spawn', { scope: 'read' }, granted)), 'team spawning denied');
    A.ok(/consent-free read/.test(R('fs.write', { scope: 'write', requiresConsent: true }, granted)), 'mutations denied before journal/dispatch');
    A.ok(/connector/.test(R('mcp.read', { scope: 'read', capability: 'mcp:x' }, granted)), 'connector ambiguity denied in v1');
    A.ok(/WITHHELD/.test(R('fs.search', { scope: 'read' }, granted)), 'a registered but ungranted read stays withheld');
    A.eq(R('fs.read', { scope: 'read', requiresConsent: false }, granted), '', 'a granted consent-free read is admitted');
  }

  // Output, nested-call count, wall time and cancellation are independently bounded.
  {
    const capped = Code.makeCodeTools({ limits: { timeoutMs: 3000, maxCalls: 2, maxOutputBytes: 64 } }).codeTool;
    const out = await capped.run({ code: `return 'x'.repeat(200);` }, { composeDispatch: async () => 'x' });
    A.ok(/truncated at 64 bytes/.test(out.content), 'final output cap is explicit');
    A.ok(Buffer.byteLength(out.content, 'utf8') <= 64, 'final output including its notice stays within the byte cap');
    A.eq(out.fullContent, 'x'.repeat(200), 'the exact pre-cap code result crosses the registry persistence seam');
    const callCapped = Code.makeCodeTools({ limits: { timeoutMs: 3000, maxCalls: 2, maxOutputBytes: 1000 } }).codeTool;
    const calls = await callCapped.run({ code: `
      let denied='';
      for (let i=0;i<3;i++) try { await tool('x', {i}); } catch(e) { denied=e.message; }
      return denied;
    ` }, { composeDispatch: async () => 'ok' });
    A.ok(/call limit exceeded/.test(calls.content), 'nested call cap refuses excess calls');

    const timed = Code.makeCodeTools({ limits: { timeoutMs: 100 } }).codeTool;
    await expectReject(timed.run({ code: 'while (true) {}' }, { composeDispatch: async () => '' }), /timed out/, 'CPU loop is killed by the parent deadline');

    let deadlineAbortedNested = false;
    // This case needs the isolated child to START a nested dispatch before the deadline can abort it.
    // 100ms is enough for the busy-loop case above (the parent timer needs no child handshake), but on
    // Windows a clean child-process launch can itself exceed 100ms. Then there is no in-flight dispatch
    // to observe and the test reports a false product failure. Keep the deadline short, but leave bounded
    // startup headroom so this assertion measures cancellation rather than process-launch scheduling.
    const nestedTimed = Code.makeCodeTools({ limits: { timeoutMs: 1000 } }).codeTool;
    await expectReject(nestedTimed.run({ code: `return await tool('slow.read', {});` }, {
      composeDispatch: async (_request, meta) => await new Promise((resolve, reject) => {
        meta.signal.addEventListener('abort', () => {
          deadlineAbortedNested = true;
          reject(Object.assign(new Error('nested aborted'), { name: 'AbortError' }));
        }, { once: true });
      })
    }), /timed out/, 'the code deadline still rejects with its timeout');
    A.eq(deadlineAbortedNested, true, 'the code deadline aborts an in-flight nested dispatch');

    const ctrl = new AbortController();
    const cancelling = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool.run(
      { code: `while (true) {}` },
      { signal: ctrl.signal, composeDispatch: async () => '' }
    );
    setTimeout(() => ctrl.abort(), 30);
    await expectReject(cancelling, /cancelled/, 'run cancellation kills the isolated worker');

    const nestedCtrl = new AbortController();
    let parentAbortedNested = false;
    let markNestedStarted;
    const nestedStarted = new Promise(resolve => { markNestedStarted = resolve; });
    const nestedCancelling = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool.run(
      { code: `return await tool('slow.read', {});` },
      { signal: nestedCtrl.signal, composeDispatch: async (_request, meta) => await new Promise((resolve, reject) => {
        markNestedStarted();
        meta.signal.addEventListener('abort', () => {
          parentAbortedNested = true;
          reject(Object.assign(new Error('nested aborted'), { name: 'AbortError' }));
        }, { once: true });
      }) }
    );
    await nestedStarted;
    nestedCtrl.abort();
    await expectReject(nestedCancelling, /cancelled/, 'parent cancellation retains the public cancellation result');
    A.eq(parentAbortedNested, true, 'parent cancellation also aborts the in-flight nested dispatch');
  }

  // Public shape + SECURITY STOPGAP (2026-09-23 audit): the vm child is not a proven isolation boundary,
  // so code.run is gated exactly like shell.exec until the worker is rebuilt on a primitive-only bridge.
  {
    const t = Code.makeCodeTools({}).codeTool;
    A.eq(t.name, 'code.run', 'stable public name');
    A.eq(t.scope, 'execute', 'code.run carries execute scope (autonomous exec lockout applies)');
    A.eq(t.requiresConsent, true, 'code.run asks the Commander before running model code');
    A.ok(/currently granted READ tools/.test(t.description), 'wire description states the authority boundary');

    const Taint = require('../sidecar/taint.js');
    const InputPolicy = require('../sidecar/inputpolicy.js');
    A.eq(InputPolicy.impactOfTool(t), 'workspace-process', 'code.run is classified as host process execution');
    A.eq(Taint.allowedWhenTainted(t), false, 'untrusted content (web/connector/attachment) revokes code.run for the rest of the run');

    const src = require('node:fs').readFileSync(require.resolve('../sidecar/capability/registry.js'), 'utf8');
    A.ok(/tool: 'code\.run', scope: 'execute', requiresConsent: true/.test(src), 'capability registry row agrees with the tool def');

    const { makeConsentBroker } = require('../sidecar/permissions.js');
    const call = { id: 'c1', name: 'code.run', args: { code: 'return 1' } };
    const unattended = makeConsentBroker({ surface: 'autonomous' })(call, t);
    A.eq(!!(unattended && unattended.allow), false, 'an autonomous run cannot execute code.run (no read-only auto-allow)');
    let asked = 0;
    const interactive = await makeConsentBroker({ surface: 'interactive', prompt: () => { asked++; return 'deny'; } })(call, t);
    A.eq(asked, 1, 'an interactive run asks the Commander before code.run');
    A.eq(!!(interactive && interactive.allow), false, 'a denied prompt blocks code.run');
  }

  A.report('code-mode.test');
})().catch(e => { console.error(e); process.exit(1); });
