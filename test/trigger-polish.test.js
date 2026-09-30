/* node test/trigger-polish.test.js — LINE TRIGGERS polish pass (2026-09-24). Locks five verified findings:

     1. MULTI-BAY PREFLIGHT: an agent crewing bays on TWO lines has one lineOfAgent entry (its entry dock's line). The
        trigger preflight + the sample route read that agent view, so a working line-2 trigger was refused "routes
        work to no crewed dock" (blockedBy) and the floor painted NO FEED. They now read the DOCK layer
        (reachDock + lineOfDock); only a plan with no dock layer falls back to the agent view.
     2. A folder file that could not be READ (EBUSY / locked) is un-marked, so a later scan retries it — it used to be
        recorded as fired and dropped forever.
     3. The folder jail FAILS CLOSED: a throwing protected-root reader or an unresolvable realpath refuses the folder.
     4. A trigger-fired run starts TAINTED (hub entryTaint): a webhook body / a watched file is external data.
     5. A throwing onLineOutcome hook is logged through the failopen ledger, never silently swallowed. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const Pipeline = require('../frontend/app/pipeline.js');
const { makeTriggerRunner, crewedDocksOnLine } = require('../sidecar/routing/trigger-runner.js');
const { makeFolderPolicy } = require('../sidecar/routing/trigger-folder.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const failopen = require('../sidecar/failopen.js');

/* two lines, ONE writer crewing a bay on each: INBOX p1 → quill@p2 → OUTBOX p3 · INBOX p10 → quill@p12 → OUTBOX p13 */
function twoLineGeo() {
  const belts = [];
  for (let x = 1; x <= 8; x++) { belts.push({ x, y: 0, dir: 'E' }); belts.push({ x, y: 10, dir: 'E' }); }
  return { belts, props: [
    { id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'p2', t: 'bay', x: 3, y: 1, w: 1, h: 1, agentId: 'quill' }, { id: 'p3', t: 'outbox', x: 8, y: 1, w: 1, h: 1 },
    { id: 'p10', t: 'intake', x: 0, y: 10, w: 1, h: 1 }, { id: 'p12', t: 'bay', x: 3, y: 11, w: 1, h: 1, agentId: 'quill' }, { id: 'p13', t: 'outbox', x: 8, y: 11, w: 1, h: 1 }
  ] };
}
function fakeStore() {
  const hist = new Map(), recs = new Map();
  return {
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord(c) { return recs.get(String(c)); },
    saveChatRecord(c, r) { recs.set(String(c), r); }
  };
}

(async () => {
  /* ---- 1. multi-bay preflight ---- */
  const plan = Pipeline.compileRoutingPlan(twoLineGeo());
  A.ok(Pipeline.ok(plan) && Pipeline.hasDockLayer(plan), 'the two-line floor compiles with a dock layer');
  A.eq(plan.lineOfAgent.quill, 'p1', 'precondition: the agent view names only quill\'s ENTRY line (the bug\'s cause)');
  A.eq(crewedDocksOnLine(plan, 'p10'), ['p12'], 'line 2 reaches its crewed dock p12 (read off the dock layer)');
  A.eq(crewedDocksOnLine(plan, 'p1'), ['p2'], 'line 1 reaches p2');
  A.eq(crewedDocksOnLine(plan, null).sort(), ['p12', 'p2'], 'no line named = every reached crewed dock');
  A.eq(crewedDocksOnLine(plan, 'nope'), [], 'an unknown line reaches nothing');
  A.eq(crewedDocksOnLine(null, 'p1'), [], 'no plan reaches nothing');
  // an older compile with NO dock layer falls back to the agent view (the only view it has)
  const old = JSON.parse(JSON.stringify(plan));
  for (const k of ['bayTileToDock', 'agentOfDock', 'docksOfAgent', 'dockChains', 'reachDock', 'gateDocks', 'lineOfDock', 'entryDock']) delete old[k];
  A.ok(!Pipeline.hasDockLayer(old), 'the stripped plan has no dock layer');
  A.eq(crewedDocksOnLine(old, 'p1'), ['quill'], 'no dock layer -> the agent view answers');

  const disk = { triggers: { triggers: [] }, seen: {} };
  let n = 0;
  const R = makeTriggerRunner({
    load: () => JSON.parse(JSON.stringify(disk.triggers)), save: v => { disk.triggers = JSON.parse(JSON.stringify(v)); },
    seen: { load: () => JSON.parse(JSON.stringify(disk.seen)), save: v => { disk.seen = JSON.parse(JSON.stringify(v)); } },
    makeHub: () => ({ onInbound() { return Promise.resolve(); }, close() {} }), plan: () => plan,
    now: () => 1e12, newId: () => 'id' + (++n) + 'abcdef0123456789'
  });
  const t2 = R.create({ kind: 'webhook', lineId: 'p10', name: 'line two' }, { secretHash: 'a'.repeat(64) });
  A.ok(t2.ok, 'a webhook trigger on line 2 is created');
  A.eq(R.preflight(R.get(t2.trigger.id)), null, 'the line-2 trigger is NOT refused (it used to say "routes work to no crewed dock")');
  A.eq(R.view(t2.trigger.id).blockedBy, null, '…so blockedBy is null and the floor counts it as a FEED');

  /* ---- 2. an unreadable file is retried, not dropped ---- */
  {
    const d2 = { triggers: { triggers: [] }, seen: {} };
    let readOk = false, reads = 0;
    const fired = [];
    const watcher = {
      scan: async (dir, seen) => ({ ok: true, pending: new Map(), ready: Object.prototype.hasOwnProperty.call(seen, 'k1') ? [] : [{ name: 'a.txt', abs: path.join(dir, 'a.txt'), size: 3, mtimeMs: 5, key: 'k1' }] }),
      readItem: async () => { reads++; return readOk ? { ok: true, binary: false, content: 'abc', truncated: false } : { ok: false, error: 'cannot read a.txt: EBUSY' }; }
    };
    const R2 = makeTriggerRunner({
      load: () => JSON.parse(JSON.stringify(d2.triggers)), save: v => { d2.triggers = JSON.parse(JSON.stringify(v)); },
      seen: { load: () => JSON.parse(JSON.stringify(d2.seen)), save: v => { d2.seen = JSON.parse(JSON.stringify(v)); } },
      makeHub: () => ({ onInbound(m) { fired.push(m.text); return Promise.resolve(); }, close() {} }), plan: () => plan,
      watcher, now: () => clk2, newId: () => 'f' + (++n) + 'abcdef0123456789'
    });
    let clk2 = 1e12;
    const cf = R2.create({ kind: 'folder', lineId: 'p1', config: { path: os.tmpdir() } }, { baselineKeys: [] });
    A.ok(cf.ok, 'a folder trigger is created');
    await R2.tickFolders();
    A.eq(reads, 1, 'the ready file was read once');
    A.ok(!R2.seenFor(cf.trigger.id).k1, 'a file whose READ failed is NOT recorded as fired');
    A.ok(!(d2.seen[cf.trigger.id] || {}).k1, '…not on disk either');
    A.ok(/EBUSY/.test(R2.view(cf.trigger.id).lastError || ''), 'the read failure is recorded honestly: ' + R2.view(cf.trigger.id).lastError);
    readOk = true;
    await R2.tickFolders();
    A.eq(reads, 1, '(sweep 2026-09-25) an unreadable file backs off — not re-opened on the very next 3 s poll');
    clk2 += 20000;   // past the first backoff step
    await R2.tickFolders();
    await new Promise(r => setTimeout(r, 20));
    A.eq(reads, 2, 'the next scan retries the file');
    A.ok(R2.seenFor(cf.trigger.id).k1, 'once read it is recorded as fired');
    A.eq(fired.length, 1, '…and it fired exactly once');
  }

  /* ---- 3. the folder jail fails closed ---- */
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-trg-polish-'));
    const home = path.join(root, 'home'), inbox = path.join(home, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const base = { fsp, pathMod: path, winish: path.sep === '\\', homeRoots: () => [home], blessedRoots: () => [], forbiddenRoots: () => [], systemRoots: () => [] };
    A.ok((await makeFolderPolicy(base).check(inbox)).ok, 'baseline: a folder inside home is allowed');
    const sysThrows = await makeFolderPolicy(Object.assign({}, base, { systemRoots: () => { throw new Error('env unreadable'); } })).check(inbox);
    A.ok(!sysThrows.ok && sysThrows.code === 'policy', 'a throwing system-root reader REFUSES (was: checks skipped): ' + JSON.stringify(sysThrows));
    const fbThrows = await makeFolderPolicy(Object.assign({}, base, { forbiddenRoots: () => { throw new Error('x'); } })).check(inbox);
    A.ok(!fbThrows.ok && fbThrows.code === 'policy', 'a throwing station-root reader REFUSES');
    const noReal = await makeFolderPolicy(Object.assign({}, base, { fsp: { stat: fsp.stat, realpath: async () => { throw new Error('EPERM'); } } })).check(inbox);
    A.ok(!noReal.ok && noReal.code === 'unresolved', 'an unresolvable realpath REFUSES (was: judged by its unresolved spelling)');
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  /* ---- 4 + 5. the hub: entry taint + a throwing outcome hook ---- */
  {
    const router = makeRouter();
    A.ok(router.setPlan(Pipeline.compileRoutingPlan(twoLineGeo())).ok, 'the floor arms on a real router');
    const chain = makeChainRunner({
      nextAgent: (a, ctx) => router.chainNext(a, ctx), stepAgent: (a, ctx) => router.chainStep(a, ctx), fanSiblings: a => router.fanSiblings(a),
      stepDock: (d, ctx) => router.chainStepDock(d, ctx), fanSiblingsDock: d => router.fanSiblingsDock(d), entryDockOf: a => router.entryDockOf(a),
      stageBrief: (a, d) => router.stageBrief(a, d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
      loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), lineLimits: l => router.lineLimits(l)
    });
    const mkHub = (extra, runs) => makeChannelHub(Object.assign({
      runOnce: async (o) => {
        runs.push({ agentId: o.agentId, initialTaint: o.initialTaint });
        o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'done' });
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
      },
      store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm/x', configured: true }),
      classify: () => true, emit: () => {}, newId: () => 'h' + (++n), bindChats: false,
      resolveAgent: (ctx) => router.resolveDock(Object.assign({}, ctx, { lineId: 'p10' })), lineOriginFor: (a, d) => router.lineOriginFor(a, d),
      stageBriefFor: (a, d) => router.stageBrief(a, d), resolveStation: (a, d) => router.stationFor(a, d), chain
    }, extra));
    const tainted = [];
    const before = failopen.counts()['channels.hub.lineOutcome'] || 0;
    const hub = mkHub({ entryTaint: 'line trigger payload', onLineOutcome: () => { throw new Error('host bug'); } }, tainted);
    await hub.onInbound({ channel: 'trigger', chatId: 'trg-x', chatType: 'dm', userId: 'trigger', text: '[Line trigger] webhook body', messageId: '1', ts: 1 });
    A.ok(tainted.length >= 1 && tainted[0].agentId === 'quill', 'the trigger-fired entry run ran at the line-2 dock');
    A.eq(tainted[0].initialTaint, 'line trigger payload', 'a trigger-fired FIRST run starts TAINTED');
    A.eq((failopen.counts()['channels.hub.lineOutcome'] || 0) - before, 1, 'a throwing onLineOutcome is recorded in the failopen ledger (not swallowed)');
    const plain = [];
    await mkHub({}, plain).onInbound({ channel: 'telegram', chatId: '9', chatType: 'dm', userId: 'u', text: 'hello', messageId: '2', ts: 2 });
    A.eq(plain[0].initialTaint, null, 'a hub without entryTaint keeps the old rule (no attachment -> untainted entry)');
  }

  A.report('trigger-polish');
})().catch(e => { console.log('FAIL: trigger-polish threw - ' + (e && e.stack || e)); process.exit(1); });
