/* node test/steptest-restart-spend.test.js — a step test that dies mid-run keeps its spend (conveyor sweep 2026-09-25).

   The step's cost was noted only after runDock returned, so a sidecar restart mid-run dropped that money from the
   session's LINE BUDGET and from the line's day ledger. Now each step's run id is chosen by the engine and
   persisted with the running step BEFORE it starts; at boot, a session that was running reads that run's row: a
   recorded cost is counted (session + day ledger), and an unknown one is said to be unknown — never $0. */
'use strict';
const A = require('./_assert.js');
const { makeStepTest } = require('../sidecar/routing/steptest.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');

const belt = (x, y, dir) => ({ x, y, dir });
let T = 1000; const clock = () => (T += 10);
function floor() {
  return {
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research', brief: 'Dig.' },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer', brief: 'Write.' },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  };
}
function memStore() { let v = null; return { load: () => (v ? JSON.parse(v) : null), save: x => { v = JSON.stringify(x); } }; }

function rig(rows) {
  const router = makeRouter();
  const plan = P.compileRoutingPlan(floor());
  for (const b of plan.bays.concat(plan.dockBays || [])) b.objects = ['computer'];
  A.ok(router.setPlan(plan).ok, 'the floor deploys');
  const store = memStore();
  const ledger = [];
  const never = new Promise(() => {});
  const seen = [];
  let n = 0;
  const mk = () => makeStepTest({
    runDock: async (h) => { seen.push(h); if (h.agentId === 'writer') await never; return { text: 'findings', usd: 0.1, runId: h.runId, tools: 1 }; },
    store, now: clock, getTag: () => 'general', label: a => a.toUpperCase(),
    newRunId: () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'),
    runRow: (id) => rows[id] || null,
    daySpend: { spentToday: () => ledger.reduce((a, x) => a + x.usd, 0), note: (line, usd) => ledger.push({ line, usd }) },
    plan: {
      get: () => router.getPlan(),
      step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
      entryDock: (line, text) => { const a = router.resolveTarget({ tag: 'general', text, lineId: line }); return a && router.lineOriginFor(a) === line ? a : null; },
      lineOf: a => router.lineOfAgent(a), stageBrief: a => router.stageBrief(a),
      loopGateAfter: (a, l) => router.loopGateAfter(a, l), lineLimits: l => router.lineLimits(l),
      shipsToOutbox: a => router.chainShipsToOutbox(a)
    }
  });
  return { mk, lineId: P.lineOf(plan, 'research'), ledger, seen };
}

(async () => {
  for (const known of [true, false]) {
    const rows = {};
    const R = rig(rows);
    const st = R.mk();
    const r0 = st.start({ line: R.lineId, text: 'go' });
    A.ok(r0.ok, 'a step test starts');
    await st.settled(r0.session.id);
    A.eq(st.get(r0.session.id).session.state, 'paused', 'paused after the first dock');
    st.continue(r0.session.id, {});
    await new Promise(r => setTimeout(r, 10));
    const running = st.get(r0.session.id).session;
    A.eq(running.state, 'running', 'the writer is mid-run');
    const writerRun = R.seen[R.seen.length - 1];
    A.ok(/^00000000-/.test(writerRun.runId || ''), 'the engine chose the step\'s run id and handed it to the host: ' + writerRun.runId);
    A.eq(running.running.runId, writerRun.runId, 'and the running step carries it (persisted before the run started)');
    const ledgerBefore = R.ledger.length;
    if (known) rows[writerRun.runId] = { runId: writerRun.runId, usd: 0.25, reason: 'done' };
    else rows[writerRun.runId] = { runId: writerRun.runId, usd: 0, reason: 'interrupted', spendUnknown: true };
    const st2 = R.mk();   // the sidecar restarts
    const dead = st2.get(r0.session.id).session;
    A.eq(dead.state, 'failed', 'the session that was running comes back failed');
    if (known) {
      A.ok(Math.abs(dead.totalUsd - 0.35) < 1e-9, 'the dead step\'s recorded $0.25 is counted in the session total: ' + dead.totalUsd);
      A.eq(R.ledger.length, ledgerBefore + 1, 'and in the line\'s day ledger');
      A.ok(/already cost \$0\.2500/.test(dead.error), 'the error says what it cost: ' + dead.error);
    } else {
      A.ok(Math.abs(dead.totalUsd - 0.1) < 1e-9, 'an unknown cost is never invented: ' + dead.totalUsd);
      A.eq(dead.spendUnknown, true, 'the session says its spend is unknown');
      A.ok(/not known to this test/.test(dead.error), 'and the error says so: ' + dead.error);
      A.eq(R.ledger.length, ledgerBefore, 'nothing is noted in the day ledger');
    }
  }
  A.report('steptest-restart-spend.test');
})().catch(e => { console.log('FAIL: steptest-restart-spend.test threw - ' + (e && e.stack || e)); process.exit(1); });
