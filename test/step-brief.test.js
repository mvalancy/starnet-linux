/* test/step-brief.test.js — the STEP EDITOR's execution spine, headless.

   A dock's standing JOB BRIEF ("what this step does with arriving work") rides: the bay prop
   (worldmodel.setPropBrief -> migrate() whitelist -> projectGeometry) -> the compiled plan
   (pipeline bays/dockBays.brief) -> the router (stageBrief) -> the run prompts (the shared
   Pipeline.handoffPrompt 5th param; the chain runner's injected stageBrief seam). Line naming
   rides the INTAKE prop the same way (label — legibility only).

   THE LAW UNDER TEST EVERYWHERE: a brief is PROMPT TEXT ONLY. It must never change WHO runs
   (resolveTarget/chainNext identical with and without briefs) or WHAT tools they hold
   (stationFor reads objects, never brief). */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');

const BRIEF = 'Dig three primary sources and hand the writer a bulleted evidence pack.';
const HDR = 'YOUR STANDING BRIEF FOR THIS STATION:';

(async () => {

/* ================= worldmodel: the brief/label persistence spine ================= */
{
  const s = WM.create();
  const z = s.rooms()[0].rects[0];
  const bay = s.addProp({ t: 'bay', x: z.x1 + 1, y: z.y1 + 1, w: 2, h: 2, agentId: 'researcher' });
  A.ok(bay.ok, 'fixture: a bay places on the seed deck');
  const intake = s.addProp({ t: 'intake', x: z.x1 + 5, y: z.y1 + 1, w: 2, h: 2 });
  A.ok(intake.ok, 'fixture: an intake places on the seed deck');

  // set / read / clear
  const set = s.setPropBrief(bay.id, '  ' + BRIEF + '  ');
  A.ok(set.ok && set.brief === BRIEF, 'setPropBrief trims and stores the brief');
  A.eq(s.propById(bay.id).brief, BRIEF, 'the prop carries its brief');
  A.ok(!s.setPropBrief(intake.id, 'x').ok, 'a non-bay refuses a brief (BAD_TYPE)');
  A.ok(!s.setPropBrief('nope', 'x').ok, 'an unknown prop refuses (NOT_FOUND)');
  const long = s.setPropBrief(bay.id, 'x'.repeat(5000));
  A.eq(long.brief.length, 2000, 'a brief is bounded at 2000 chars');
  s.setPropBrief(bay.id, BRIEF);

  // line naming on the INTAKE
  const nm = s.setPropLabel(intake.id, '  PRESS DESK  ');
  A.ok(nm.ok && nm.label === 'PRESS DESK', 'setPropLabel trims and stores the line name');
  A.ok(!s.setPropLabel(bay.id, 'x').ok, 'a non-intake refuses a label (BAD_TYPE)');
  A.eq(s.setPropLabel(intake.id, 'y'.repeat(100)).label.length, 48, 'a label is bounded at 48 chars');
  s.setPropLabel(intake.id, 'PRESS DESK');

  // the save round-trip (migrate() whitelist — the documented trap this suite exists to lock)
  const s2 = WM.deserialize(s.serialize());
  const b2 = s2.props().find(p => p.t === 'bay');
  const i2 = s2.props().find(p => p.t === 'intake');
  A.eq(b2.brief, BRIEF, 'brief survives serialize -> migrate -> deserialize');
  A.eq(i2.label, 'PRESS DESK', 'label survives serialize -> migrate -> deserialize');

  // projectGeometry carries both (the compiler's input)
  const g = s2.projectGeometry();
  A.eq(g.props.find(p => p.t === 'bay').brief, BRIEF, 'projectGeometry emits the brief');
  A.eq(g.props.find(p => p.t === 'intake').label, 'PRESS DESK', 'projectGeometry emits the label');

  // clearing deletes the field (docs stay clean)
  s2.setPropBrief(b2.id, '');
  s2.setPropLabel(i2.id, '');
  const doc = s2.serialize();
  A.ok(!('brief' in doc.props.find(p => p.t === 'bay')), 'a cleared brief leaves no field in the doc');
  A.ok(!('label' in doc.props.find(p => p.t === 'intake')), 'a cleared label leaves no field in the doc');
}

/* ================= pipeline: the compiler carries briefs; routing NEVER reads them ================= */
const belt = (x, y, dir) => ({ x, y, dir });
const lineGeo = withBriefs => ({
  props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
          Object.assign({ id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'researcher' }, withBriefs ? { brief: BRIEF } : {}),
          Object.assign({ id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer' }, withBriefs ? { brief: 'Draft the result in press style.' } : {}),
          { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
  belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
});
{
  const plain = P.compileRoutingPlan(lineGeo(false));
  const briefed = P.compileRoutingPlan(lineGeo(true));
  A.eq(briefed.dockBays.find(b => b.agentId === 'researcher').brief, BRIEF, 'the compiled plan carries the dock brief (dockBays — a lone dock briefs too)');
  A.ok(!('brief' in plain.bays[0]) && !('brief' in briefed.bays[0]), 'and NEVER on the hashed dispatch record');
  /* PROMPT TEXT MAY NOT MOVE THE DISPATCH HASH (2026-08-07). The brief used to ride `bays`, which is a hash
     input, so typing one word into this editor moved plan.hash → forced a re-post → reset the router's
     splitter round-robin. An edit to what an agent is TOLD must not perturb which agent work is SENT to. */
  A.eq(plain.hash, briefed.hash, 'a brief does NOT move the plan hash — it is prompt text, not dispatch topology');

  // ROUTING NEUTRALITY (the mandate's explicit assertion): same resolveTarget, same chainNext.
  A.eq(P.resolveTarget(plain, { tag: 'general' }), P.resolveTarget(briefed, { tag: 'general' }), 'resolveTarget is identical with and without briefs');
  A.eq(P.resolveTarget(briefed, { tag: 'general' }), 'researcher', '(and it is the drawn entry dock)');
  // ctx carries the LINE the work entered on (work belongs to a line, 2026-08-07) — a brief must not
  // change that either: same line, same answer, briefed or not.
  const ctxP = { lineId: P.lineOf(plain, 'researcher') }, ctxB = { lineId: P.lineOf(briefed, 'researcher') };
  A.eq(ctxP.lineId, ctxB.lineId, 'a brief does not move the dock to another line');
  A.eq(P.chainNext(plain, 'researcher', ctxP), P.chainNext(briefed, 'researcher', ctxB), 'chainNext is identical with and without briefs');
  A.eq(P.chainNext(briefed, 'researcher', ctxB), 'writer', '(and it is the drawn downstream dock)');

  // an over-long brief is bounded AT COMPILE (no surface can post an unbounded blob)
  const geo = lineGeo(true); geo.props[1].brief = 'z'.repeat(9000);
  A.eq(P.compileRoutingPlan(geo).dockBays.find(b => b.agentId === 'researcher').brief.length, 2000, 'the compiler bounds a brief at 2000 chars');
}

/* ================= the shared handoff turn ================= */
{
  const plainTurn = P.handoffPrompt('the ask', 'researcher', 'the findings', 1);
  A.ok(plainTurn.indexOf(HDR) < 0, 'no brief -> no brief section (existing callers compose byte-identical turns)');
  const briefedTurn = P.handoffPrompt('the ask', 'researcher', 'the findings', 1, BRIEF);
  A.ok(briefedTurn.indexOf(HDR + '\n' + BRIEF) >= 0, 'the brief rides the handoff turn under its named section');
  A.ok(briefedTurn.indexOf('the ask') >= 0 && briefedTurn.indexOf('the findings') >= 0, 'original + upstream still ride alongside it');
  A.eq(P.handoffPrompt('a', 'b', 'c', 1, '   '), plainTurn.replace('the ask', 'a').replace('researcher', 'b').replace('the findings', 'c'), 'a whitespace brief composes the plain turn');
}

/* ================= router.stageBrief ================= */
{
  const r = makeRouter();
  A.eq(r.stageBrief('researcher'), null, 'no plan -> null');
  A.ok(r.setPlan(P.compileRoutingPlan(lineGeo(true))).ok, 'the briefed floor deploys');
  A.eq(r.stageBrief('researcher'), BRIEF, 'stageBrief serves the dock brief from the active plan');
  A.eq(r.stageBrief('writer'), 'Draft the result in press style.', 'each dock serves its own');
  A.eq(r.stageBrief('nobody'), null, 'an agent with no dock -> null');
  A.ok(r.setPlan(P.compileRoutingPlan(lineGeo(false))).ok, 'the plain floor re-deploys');
  A.eq(r.stageBrief('researcher'), null, 'no brief on the plan -> null');
  r.clearPlan();
  A.eq(r.stageBrief('researcher'), null, 'a cleared plan serves nothing');

  // a LONE dock (no belts — dockBays only) still serves its brief
  const lone = P.compileRoutingPlan({ props: [{ id: 'b', t: 'bay', x: 0, y: 0, w: 1, h: 1, agentId: 'solo', brief: 'Handle whatever lands here.' }], belts: [] });
  A.ok(r.setPlan(lone).ok, 'a lone briefed dock deploys');
  A.eq(r.stageBrief('solo'), 'Handle whatever lands here.', 'a beltless dock briefs through dockBays');

  // a plan with BLOCKING errors is refused for ROUTING but the brief — a fact about the PLACED floor —
  // still serves (same capsPlan precedence as stationFor: a broken belt graph must not strip the duty line).
  // (the fixture used to be a duplicate-binding floor; one agent may crew many bays since 2026-09-22, so the
  //  blocking error is now a belt CYCLE drawn beside the briefed dock)
  const dup = P.compileRoutingPlan({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'twin', brief: 'First twin duty.' },
            { id: 'b2', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'twin' }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'),
            belt(20, 0, 'E'), belt(21, 0, 'S'), belt(21, 1, 'W'), belt(20, 1, 'N')]
  });
  A.ok(!P.ok(dup), 'fixture: the cyclic floor has a blocking error');
  const r2 = makeRouter();
  A.ok(!r2.setPlan(dup).ok, 'the router refuses it for routing');
  A.eq(r2.resolveTarget({ tag: 'general' }), null, 'and routes nothing from it');
  A.eq(r2.stageBrief('twin'), 'First twin duty.', 'but the placed dock still serves its brief (capsPlan view)');
}

/* ================= the chain runner injects the RECEIVING dock's brief ================= */
{
  const log = [];
  const runAgent = async h => { log.push(h); return { text: h.agentId + ' output' }; };
  const briefs = { writer: 'Draft the result in press style.' };
  const c = makeChainRunner({
    nextAgent: a => ({ researcher: 'writer', writer: 'shipper', shipper: null })[a] || null,
    stageBrief: a => briefs[a] || null,
    runAgent, now: () => 0
  });
  const res = await c.advance({ agentId: 'researcher', text: 'the findings', originalText: 'the ask' });
  A.eq(res.agentId, 'shipper', 'the line ran to its end');
  A.ok(log[0].text.indexOf(HDR + '\nDraft the result in press style.') >= 0, "hop 1's handoff carries the WRITER's brief");
  A.ok(log[1].text.indexOf(HDR) < 0, 'hop 2 (no brief on that dock) composes the plain turn');
  A.eq(log[0].text, P.handoffPrompt('the ask', 'researcher', 'the findings', 1, briefs.writer), 'the runner composes EXACTLY the shared turn (no drift)');

  // a throwing stageBrief seam never kills the line (brief is an enhancement, not a gate)
  const log2 = [];
  const c2 = makeChainRunner({
    nextAgent: a => (a === 'a' ? 'b' : null),
    stageBrief: () => { throw new Error('boom'); },
    runAgent: async h => { log2.push(h); return { text: 'b out' }; }, now: () => 0
  });
  const r2 = await c2.advance({ agentId: 'a', text: 'seed' });
  A.eq(r2.agentId, 'b', 'a broken brief seam still runs the line');
  A.ok(log2[0].text.indexOf(HDR) < 0, 'and composes the plain turn');
}

A.report('step-brief');
})().catch(e => { console.log('FAIL: step-brief threw - ' + (e && e.stack || e)); process.exit(1); });
