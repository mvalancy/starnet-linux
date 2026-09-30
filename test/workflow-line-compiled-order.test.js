/* test/workflow-line-compiled-order.test.js — the Workflow panel never shows a hand-off the plan lacks (2026-09-23).

   Found live in the conveyor playtest lane: a SPLITTER feeding two stacked BAYS (writer, researcher) that each ship
   to the OUTBOX, with the INBOX dragged off the line. The compiled plan held NO hand-off between the bays, yet the
   docked panel read "WRITER works on it then RESEARCHER works on it" and the writer's contract said
   "HANDS OFF TO → BAY 2 · RESEARCHER" — lineFlow laid unplaced docks out one column each in bay order, and
   neighbours() read prev/next off column adjacency. Locked here, on that exact floor:
     1. the plan's dock maps hold no hand-off, and neither does the flow (siblings, never a sequence);
     2. docks no INBOX reaches are ONE 'apart' group, flagged detached, and the sentence names them without "then";
     3. with the INBOX wired back, the two bays are ONE column of siblings (TAKE TURNS), still no hand-off;
     4. across every starter line (crewed and uncrewed), every hand-off neighbours() claims for a crewed dock is a
        compiled dockChains edge, and an uncrewed dock hands off to nothing;
     5. readiness blocks a crewed dock the INBOX never reaches. */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const W = require('../frontend/app/workflowline.js');

const nameOf = a => String(a).toUpperCase();
function read(s) {
  const geo = s.projectGeometry(), plan = P.compileRoutingPlan(geo);
  const comps = P.lineComponents(geo);
  return { geo, plan, comps };
}
const sentence = (flow, trig) => W.howItRuns(flow, { nameOf, triggers: trig || { schedules: [], channels: [] } }).map(x => x.s).join('');

/* ---------- the exact playtest floor ---------- */
function playtestFloor() {
  const s = WM.create();
  A.ok(s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 60, y2: 16 } }).ok, 'deck');
  const add = (t, x, y, w, h) => { const r = s.addProp({ t, x, y, w, h, block: w > 1 }); A.ok(r.ok, 'placed ' + t); return r.id; };
  const I = add('intake', 31, 6, 2, 2), S = add('splitter', 35, 7, 1, 1);
  const Wd = add('bay', 38, 6, 2, 2), Rd = add('bay', 38, 8, 2, 2), O = add('outbox', 42, 7, 2, 2);
  s.assignPropAgent(Wd, 'writer'); s.assignPropAgent(Rd, 'researcher');
  for (const [a, b] of [[I, S], [S, Wd], [S, Rd], [Wd, O], [Rd, O]]) A.ok(s.connectBelt(a, b).ok, 'BELT ' + a + ' -> ' + b);
  return { s, I, S, Wd, Rd, O };
}
{
  const { s, I, Wd, Rd } = playtestFloor();

  // wired: siblings under the splitter
  {
    const { plan, comps } = read(s), comp = comps.find(c => c.bays.some(b => b.propId === Wd));
    const flow = W.lineFlow(plan, comp, P, s.projectGeometry().props);
    const col = flow.cols.find(c => c.docks.some(d => d.propId === Wd));
    A.ok(col && col.docks.some(d => d.propId === Rd), 'wired: the two bays share ONE column (siblings)');
    A.eq(col && col.mode, 'turns', 'wired: a plain splitter reads TAKE TURNS');
    A.eq([W.neighbours(flow, Wd).next, W.neighbours(flow, Rd).prev], [[], []], 'wired: no hand-off between the siblings');
    const txt = sentence(flow);
    A.ok(/WRITER works on it or RESEARCHER works on it \(taking turns\)/.test(txt) && !/ then /.test(txt), 'wired sentence: ' + txt);
  }

  // the playtest: drag the INBOX off the line (its belts stay behind — the splitter lane is still there)
  A.ok(s.moveProp(I, 0, 6).ok, 'INBOX dragged away');
  const { plan, comps } = read(s), comp = comps.find(c => c.bays.some(b => b.propId === Wd));
  A.ok(!!comp && !comp.intakes.length, 'the line now has no INBOX');
  A.eq([plan.dockChains[Wd].next, plan.dockChains[Rd].next], [[], []], 'the compiled plan holds NO hand-off between the bays');
  A.ok(!plan.reachDock[Wd] && !plan.reachDock[Rd], '…and no INBOX reaches either');
  const flow = W.lineFlow(plan, comp, P, s.projectGeometry().props);
  const nbW = W.neighbours(flow, Wd), nbR = W.neighbours(flow, Rd);
  A.eq(nbW.next, [], 'the writer hands off to NOBODY (was "HANDS OFF TO → BAY 2 · RESEARCHER")');
  A.eq(nbR.prev, [], 'the researcher gets nothing from the writer');
  A.ok(nbW.detached && nbR.detached && !nbW.first && !nbR.first, 'both are flagged not connected — neither is the "first" step');
  A.eq(flow.cols.length, 1, 'ONE group, not a column per bay');
  A.ok(flow.cols[0].detached && flow.cols[0].mode === 'apart' && flow.cols[0].docks.length === 2, 'the group is the detached \'apart\' siblings');
  A.ok(flow.order.every(pid => !flow.docks[pid].routed), 'nothing is routed');
  A.ok(flow.outbox.reached && plan.dockChains[Wd].outbox, 'the OUTBOX claim is the compiled one: both bays still ship there');
  const txt = sentence(flow);
  A.ok(!/ then /.test(txt), 'the sentence never sequences them (was "WRITER works on it then RESEARCHER"): ' + txt);
  A.ok(/Not connected to an INBOX: WRITER, RESEARCHER/.test(txt), 'it names them as not connected: ' + txt);
  const r = W.readiness(flow, comp, { hasCompute: () => true, errors: plan.errors, briefOf: () => 'x' });
  A.ok(!r.ready && /add an INBOX/.test(r.blocking[0].what), 'readiness: add an INBOX first');
}

/* ---------- an INBOX on the line that never reaches a crewed bay: blocked, and not "fed by the INBOX" ---------- */
{
  const s = WM.create();
  s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 60, y2: 16 } });
  const st = s.stampBlueprint('front_desk', 32, 3);
  A.ok(st.ok, 'front desk');
  const bay = s.props().find(p => p.t === 'bay'); s.assignPropAgent(bay.id, 'nova');
  const out = s.props().find(p => p.t === 'outbox');
  // a second bay hooked ONLY to the outbound lane's tail (fed by nothing) — on the same line, reached by no INBOX
  const b2 = s.addProp({ t: 'bay', x: out.x - 1, y: out.y + 3, w: 2, h: 2, block: true });
  A.ok(b2.ok, 'second bay placed');
  s.assignPropAgent(b2.id, 'scout');
  A.ok(s.connectBelt(b2.id, out.id).ok, 'second bay belted to the OUTBOX');
  const { plan, comps } = read(s), comp = comps.find(c => c.bays.some(b => b.propId === bay.id));
  A.ok(comp.bays.some(b => b.propId === b2.id), 'both bays are on one line');
  const flow = W.lineFlow(plan, comp, P, s.projectGeometry().props);
  A.ok(flow.docks[b2.id].detached && !flow.docks[bay.id].detached, 'the unreached bay is detached; the fed one is not');
  const nb = W.neighbours(flow, b2.id);
  A.ok(nb.detached && !nb.prev.length, 'the detached bay claims no upstream');
  A.eq(W.neighbours(flow, bay.id).next, [], 'the fed bay does not "hand off" to the detached one');
  const r = W.readiness(flow, comp, { hasCompute: () => true, errors: plan.errors, briefOf: () => 'x', triggers: { schedules: ['daily'] } });
  A.ok(!r.ready && r.blocking.some(b => /BAY 2 is not connected to the INBOX/.test(b.what) && b.propId === b2.id), 'readiness blocks: ' + JSON.stringify(r.blocking));
  A.ok(/NOVA .*; not connected to the INBOX: SCOUT/.test(sentence(flow)), 'sentence: ' + sentence(flow));
}

/* ---------- every starter line: a crewed dock's hand-offs are exactly its compiled edges ---------- */
{
  for (const bp of WM.BLUEPRINTS) for (const bind of [true, false]) {
    const s = WM.create();
    s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 69, y2: 14 } });
    A.ok(s.stampBlueprint(bp.id, 32, 2).ok, bp.id + ' stamps');
    let n = 0;
    if (bind) for (const p of s.props()) if (p.t === 'bay') s.assignPropAgent(p.id, 'a' + (++n));
    const { geo, plan, comps } = read(s);
    for (const comp of comps) {
      const flow = W.lineFlow(plan, comp, P, geo.props);
      for (const b of comp.bays) {
        const nb = W.neighbours(flow, b.propId), ch = plan.dockChains[b.propId];
        if (b.agentId) {
          const want = ch ? ch.next.filter(x => comp.bays.some(y => y.propId === x)).sort() : [];
          A.eq(nb.next.slice().sort(), want, bp.id + (bind ? '' : ' (uncrewed)') + ': ' + b.propId + ' claims exactly its compiled hand-offs');
          for (const p of nb.prev) { const pc = plan.dockChains[p]; A.ok(!comp.bays.find(y => y.propId === p).agentId || (pc && pc.next.indexOf(b.propId) >= 0), bp.id + ': GETS from ' + p + ' is a compiled edge'); }
        } else A.eq(nb.next, [], bp.id + ' (uncrewed): an uncrewed dock hands off to nothing yet');
      }
      if (bind) A.ok(!flow.cols.some(c => c.detached) === !!comp.intakes.length, bp.id + ': a freshly stamped, crewed line has a detached dock only when it has no INBOX');
    }
  }
}

A.report('workflow-line-compiled-order.test');
