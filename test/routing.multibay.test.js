/* test/routing.multibay.test.js — the ROUTER and the plan HEAL speak docks (multi-bay agents, 2026-09-22).

   1. A stored 1:1 plan from before the dock layer (the routing.plan.json every existing install has on disk)
      heals — planlines derives the dock maps (docksDerived:true) — and routes IDENTICALLY to a fresh compile.
      ⛔ The old healPlan returned early on `lineOfAgent` alone, which every plan since 2026-08-07 carries.
   2. A multi-dock floor (writer quill @A → editor mira @B → writer quill @C): resolveDock names the dock,
      entryDockOf is the oldest INBOX-fed dock, and brief / station / line / ship-out are per DOCK. */
'use strict';
const A = require('./_assert.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { healPlan } = require('../sidecar/routing/planlines.js');
const F = require('./_multibay-floor.js');
const fx = require('./fixtures/multibay-parity.json');

const strip = (p, keys) => { const c = JSON.parse(JSON.stringify(p)); for (const k of keys) delete c[k]; return c; };

/* ---- 1. the restart heal: an old 1:1 plan on disk routes identically after restart ---- */
{
  let same = 0, n = 0, healed = 0;
  for (const c of fx.cases) {
    const fresh = Pipeline.compileRoutingPlan(c.geo);
    if (!Pipeline.ok(fresh) || !(fresh.bays || []).length) continue;
    n++;
    const old = strip(fresh, F.DOCK_FIELDS);                    // the shape a pre-dock sidecar wrote to disk
    const h = healPlan(old);
    if (h.docksDerived === true && Pipeline.hasDockLayer(h)) healed++;
    const r1 = makeRouter(), r2 = makeRouter();
    r1.setPlan(fresh); r2.setPlan(JSON.parse(JSON.stringify(old)));   // r2 = the restart path (boot replays the file)
    const ans = r => {
      const out = [];
      for (const tag of ['general', 'code', 'research']) out.push(r.resolveTarget({ tag }), r.resolveDock({ tag }));
      for (const a of Object.keys(fresh.reach).sort()) {
        const lineId = r.lineOfAgent(a);
        out.push(lineId, r.lineOriginFor(a), r.stageBrief(a), JSON.stringify(r.stationFor(a)), r.chainShipsToOutbox(a), r.entryDockOf(a),
          r.chainStep(a, { lineId, tag: 'general' }), r.chainNext(a, { lineId, tag: 'general' }), r.fanSiblings(a), r.loopGateAfter(a, lineId));
      }
      return JSON.stringify(out);
    };
    if (ans(r1) === ans(r2)) same++; else if (n - same < 3) console.log('heal mismatch on ' + JSON.stringify(c.geo).slice(0, 160));
  }
  A.ok(n >= 50, 'the heal is exercised over the parity corpus (' + n + ' deployable floors)');
  A.eq(healed, n, 'every stored pre-dock plan heals: dock layer derived, marked docksDerived:true');
  A.eq(same, n, 'a healed old plan answers every routing question exactly like a fresh compile');
}
/* the early-return bug, pinned: a plan WITH a line map but WITHOUT dock maps is still healed */
{
  const fresh = Pipeline.compileRoutingPlan(F.geo({ cAgent: 'zed' }));
  const old = strip(fresh, F.DOCK_FIELDS);
  A.ok(!!old.lineOfAgent, 'the stored plan carries a line map (every plan since 2026-08-07 does)');
  const h = healPlan(old);
  A.ok(h !== old && h.docksDerived === true, 'healPlan does NOT early-return on lineOfAgent alone — the dock layer is derived');
  A.eq(h.entryDock, fresh.entryDock, 'the derived entry docks equal the compiled ones');
  A.eq(healPlan(fresh), fresh, 'a plan carrying both layers is returned as-is');
  // a pre-line-identity plan heals BOTH layers
  const older = strip(fresh, F.DOCK_FIELDS.concat(['lines', 'lineOfProp', 'lineOfAgent']));
  const h2 = healPlan(older);
  A.ok(h2.linesDerived === true && h2.docksDerived === true, 'a pre-line plan heals its line map AND its dock layer');
  A.eq(h2.lineOfDock, fresh.lineOfDock, '…and its docks land on the same lines');
}

/* ---- 2. the multi-dock floor — both as COMPILED and as a stored pre-dock plan that heals ---- */
for (const shape of ['compiled', 'stored']) {
  const r = makeRouter();
  const res = r.setPlan(shape === 'compiled' ? F.plan() : F.storedPlan());
  A.ok(res.ok, 'the writer→editor→writer plan is accepted');
  const p = r.getPlan();
  A.eq(p.docksOfAgent.quill, ['p2', 'p4'], 'quill crews two docks, oldest first');
  A.eq(p.agentOfDock.p4, 'quill', 'bay C is crewed by quill');
  A.eq(r.entryDockOf('quill'), 'p2', 'quill’s ENTRY dock is the oldest one an INBOX reaches (bay A)');
  A.eq(r.resolveDock({ tag: 'general' }), { agentId: 'quill', dockId: 'p2' }, 'unaddressed work enters at bay A, named');
  A.eq(r.resolveDock({ boundAgentId: 'quill' }), { agentId: 'quill', dockId: 'p2' }, 'work ADDRESSED to quill enters at its entry dock');
  A.eq(r.resolveTarget({ tag: 'general' }), 'quill', 'resolveTarget is the agent reading of the same answer');
  const line = r.lineOfAgent('quill');
  A.ok(!!line && r.lineOfAgent('quill', 'p4') === line && r.lineOfDock('p3') === line, 'all three docks sit on one line');
  A.eq(r.lineOriginFor('quill', 'p2'), line, 'bay A is INBOX-fed: work arriving there carries the line');
  A.eq(r.lineOriginFor('quill', 'p4'), null, 'bay C is mid-line: no door feeds it');
  A.eq(r.stageBrief('quill', 'p4'), F.BRIEF.C, 'bay C’s brief for a run AT bay C');
  A.eq(r.stageBrief('quill', 'p2'), F.BRIEF.A, 'bay A’s brief for a run at bay A');
  A.eq(r.stageBrief('quill'), F.BRIEF.A, 'no dock named -> the entry dock’s brief');
  A.eq(r.stageBrief('quill', 'p3'), F.BRIEF.A, 'a dock quill does not crew is ignored (falls back to the entry dock)');
  A.eq(r.chainStepDock('p2', { lineId: line }), { dockId: 'p3', agentId: 'mira' }, 'A hands to B');
  A.eq(r.chainStepDock('p3', { lineId: line }), { dockId: 'p4', agentId: 'quill' }, 'B hands to C — quill again, at its OTHER bay');
  A.eq(r.chainStepDock('p4', { lineId: line }), null, 'C is terminal (ships to the OUTBOX)');
  A.eq(r.chainStep('mira', { lineId: line }), { agentId: 'quill' }, 'the agent reading of B’s step is unchanged in shape');
  A.eq(r.chainStep('quill', { lineId: line, dockId: 'p4' }), null, 'ctx.dockId picks WHICH of quill’s docks the agent reading walks from');
  A.eq(r.chainShipsToOutbox('quill', 'p4'), true, 'bay C ships to the OUTBOX');
  A.eq(r.chainShipsToOutbox('quill', 'p2'), false, 'bay A does not');
  A.eq(r.dockRef('quill', line), { agentId: 'quill', dockId: 'p2' }, 'dockRef(agent) = its entry dock on the line');
  A.eq(r.dockRef('p4', line), { agentId: 'quill', dockId: 'p4' }, 'dockRef(dockId) = that bay');
  A.eq(r.dockRef('nobody', line), null, 'an unknown ref resolves to nothing');
  // station isolation: the dock record THIS run is at, never the union
  const sp = r.getPlan();
  for (const b of sp.bays) b.objects = b.propId === 'p4' ? ['computer', 'dish'] : ['computer'];
  for (const b of sp.dockBays) b.objects = b.propId === 'p4' ? ['computer', 'dish'] : ['computer'];
  const objs = st => st.rooms.bay.objects.map(o => o.objectType).join(',');
  A.eq(objs(r.stationFor('quill', 'p4')), 'computer,dish', 'a run at bay C gets bay C’s room');
  A.eq(objs(r.stationFor('quill', 'p2')), 'computer', 'a run at bay A gets bay A’s room — never the union');
  A.eq(objs(r.stationFor('quill')), 'computer', 'no dock named -> the entry dock’s room');
}

A.report('routing.multibay');
