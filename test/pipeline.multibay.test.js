/* test/pipeline.multibay.test.js — the DOCK LAYER of the belt-graph compiler (multi-bay agents, 2026-09-22).

   Andrew's ruling: a bay has exactly ONE agent, but ONE agent may crew MANY bays (writer@A → editor@B →
   writer@C). Routing is therefore keyed by DOCK (the bay prop id); every agent-keyed map is a VIEW.

   PARITY FIRST: test/fixtures/multibay-parity.json holds the agent-keyed answers the PRE-dock compiler
   (trunk 86ce3b338) gave for every floor the routing tests compile. On all of them (each agent crews one dock)
   the dock-keyed compiler must reproduce the plan, the hash and every executor answer EXACTLY — key order
   included, because older tests compare with JSON.stringify. */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');
const { answersFor } = require('./_multibay-parity.js');
const fx = require('./fixtures/multibay-parity.json');
const nodeAssert = require('assert');

/* ---- PARITY: every 1:1 floor answers exactly as it did before the dock layer ---- */
{
  A.ok(Array.isArray(fx.cases) && fx.cases.length >= 100, 'the parity corpus covers the routing tests’ floors (' + (fx.cases && fx.cases.length) + ')');
  let planDiff = 0, hashDiff = 0, ansDiff = 0; const firstBad = [];
  for (const c of fx.cases) {
    const got = answersFor(P, c.geo);
    if (got.hash !== c.want.hash) { hashDiff++; if (firstBad.length < 3) firstBad.push('hash ' + JSON.stringify(c.geo).slice(0, 120)); }
    try { nodeAssert.deepStrictEqual(got.plan, c.want.plan); } catch (e) { planDiff++; if (firstBad.length < 3) firstBad.push('plan ' + String(e.message).slice(0, 400)); }
    for (const k of ['per', 'resolve', 'live', 'owners']) {
      if (JSON.stringify(got[k]) !== JSON.stringify(c.want[k])) { ansDiff++; if (firstBad.length < 3) firstBad.push(k + ' ' + JSON.stringify(got[k]).slice(0, 300) + ' vs ' + JSON.stringify(c.want[k]).slice(0, 300)); }
    }
  }
  if (firstBad.length) console.log(firstBad.join('\n---\n'));
  A.eq(hashDiff, 0, 'plan.hash unchanged on every 1:1 floor');
  A.eq(planDiff, 0, 'every pre-dock plan field unchanged on every 1:1 floor');
  A.eq(ansDiff, 0, 'every agent-keyed executor answer unchanged (key order included) on every 1:1 floor');
}

/* ---- the dock maps themselves, on a 1:1 floor ---- */
{
  const plan = P.compileRoutingPlan({
    props: [{ id: 'p1', t: 'intake', x: 0, y: 0 }, { id: 'p2', t: 'bay', x: 3, y: 0, agentId: 'quill' }, { id: 'p3', t: 'outbox', x: 7, y: 0 }],
    belts: [{ x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 4, y: 0, dir: 'E' }, { x: 5, y: 0, dir: 'E' }, { x: 6, y: 0, dir: 'E' }]
  });
  A.eq(plan.agentOfDock, { p2: 'quill' }, 'agentOfDock: the bay prop id names the dock');
  A.eq(plan.docksOfAgent, { quill: ['p2'] }, 'docksOfAgent: one dock');
  A.eq(plan.entryDock, { quill: 'p2' }, 'entryDock: the only dock');
  A.eq(plan.reachDock, { p2: true }, 'reachDock: the INBOX reaches it');
  A.eq(plan.bayTileToDock['2,0'], 'p2', 'bayTileToDock keys hookups by dock');
  A.eq(plan.lineOfDock.p2, plan.lineOfAgent.quill, 'lineOfDock agrees with the agent view');
  A.eq(P.resolveDock(plan, { tag: 'general' }), { agentId: 'quill', dockId: 'p2' }, 'resolveDock names agent AND dock');
}

/* ---- derivation from a stored pre-dock plan is lossless (the restart heal relies on it) ---- */
{
  let same = 0, n = 0;
  for (const c of fx.cases) {
    const plan = P.compileRoutingPlan(c.geo);
    const stored = JSON.parse(JSON.stringify(plan));
    for (const k of ['bayTileToDock', 'agentOfDock', 'docksOfAgent', 'dockChains', 'reachDock', 'gateDocks', 'lineOfDock', 'entryDock']) delete stored[k];
    const L = P.deriveDockLayer(stored);
    n++;
    try {
      for (const k of ['bayTileToDock', 'agentOfDock', 'docksOfAgent', 'dockChains', 'reachDock', 'gateDocks', 'lineOfDock', 'entryDock']) nodeAssert.deepStrictEqual(L[k], plan[k], k);
      same++;
    } catch (e) { if (n - same < 3) console.log('derive mismatch: ' + String(e.message).slice(0, 300)); }
  }
  A.eq(same, n, 'deriveDockLayer(stored plan) reproduces the compiled dock maps on every corpus floor');
}

/* ---- THE ACCEPTANCE FLOOR COMPILES (DUP_AGENT retired): INBOX → quill@A → mira@B → quill@C → OUTBOX ---- */
{
  const F = require('./_multibay-floor.js');
  const plan = F.plan();
  A.eq(plan.errors, [], 'writer@A → editor@B → writer@C compiles with NO errors or warnings');
  A.ok(P.ok(plan), '…and is deployable');
  A.eq(plan.bays.map(b => b.agentId + '@' + b.propId), ['quill@p2', 'mira@p3', 'quill@p4'], 'three dispatch docks, quill twice');
  A.eq(Object.keys(plan.dockChains).map(d => d + '>' + plan.dockChains[d].next.join(',')), ['p2>p3', 'p3>p4', 'p4>'], 'dock chains: A→B→C, C ships out');
  A.eq(plan.dockChains.p4.outbox, true, 'bay C reaches the OUTBOX');
  A.eq(plan.entryDock, { quill: 'p2', mira: 'p3' }, 'entry docks: quill at bay A (INBOX-fed), mira at her only bay');
  A.eq(plan.chains.quill.next, ['mira'], 'the agent VIEW: quill (entry dock A) hands to mira');
  A.eq(plan.reach, { quill: true, mira: false }, 'the agent VIEW of reach');
  const line = P.lineOf(plan, 'quill');
  A.eq(P.chainStepDock(plan, 'p3', { lineId: line }), { dockId: 'p4', agentId: 'quill' }, 'B hands to quill AT bay C');
  // the heal of the same floor in its stored (pre-dock) shape derives the identical dock layer
  const { healPlan } = require('../sidecar/routing/planlines.js');
  const h = healPlan(F.storedPlan());
  for (const k of ['bayTileToDock', 'agentOfDock', 'docksOfAgent', 'dockChains', 'reachDock', 'lineOfDock', 'entryDock']) A.eq(h[k], plan[k], 'healed stored plan == compiled plan: ' + k);
}

module.exports = {};
A.report();
