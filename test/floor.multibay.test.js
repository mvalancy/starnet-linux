/* test/floor.multibay.test.js — the FLOOR + the WORKFLOW PANEL readings of a multi-bay line (2026-09-22).

   Acceptance floor INBOX → WRITER quill @A (p2) → EDITOR mira @B (p3) → WRITER quill @C (p4) → OUTBOX.
   Locks:
   · WorkflowLine.lineFlow orders the strip by DOCK: three columns, quill in two of them; the "how it runs"
     sentence names QUILL twice in order; readiness counts three steps.
   · lineRoutines judges a routine by the BAY it fires at (job.dockId): quill@A starts the line, quill@C does not.
   · conveyor physics by dock: a crate addressed to bay C (payload.dockId) rides PAST quill's bay A; a handoff
     crate produced at bay B (fromDockId) is consumed at bay C even though quill also crews bay A.
   · worldmodel.bayObjects(agent, dock): a desk-less agent gets the room of the bay the run is AT. */
'use strict';
const A = require('./_assert.js');
global.U = global.U || { shade: c => c, hash: s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; } };
const P = require('../frontend/app/pipeline.js');
const W = require('../frontend/app/workflowline.js');
const Conveyor = require('../frontend/app/conveyor.js');
const F = require('./_multibay-floor.js');

/* ---- the Workflow panel's strip + sentence ---- */
{
  const geo = F.geo();
  const plan = F.plan();                // the compiled acceptance floor (DUP_AGENT retired)
  const comp = P.lineComponents(geo)[0];
  const f = W.lineFlow(plan, comp, P, geo.props);
  A.eq(f.order, ['p2', 'p3', 'p4'], 'the strip runs bay A, bay B, bay C');
  A.eq(f.cols.length, 3, 'three columns — the writer’s second bay is its own step');
  A.eq(f.cols.map(c => c.docks.map(d => d.agentId + '@' + d.propId).join('|')), ['quill@p2', 'mira@p3', 'quill@p4'], 'each column is one dock');
  A.ok(f.docks.p4.routed && f.docks.p4.col === 2, 'bay C is ROUTED (compiled chain), not a physical-walk guess');
  A.eq(f.outbox.reached, true, 'the line reaches the OUTBOX');
  const segs = W.howItRuns(f, { nameOf: a => a.toUpperCase() });
  const agents = segs.filter(s => s.t === 'agent').map(s => s.s + '@' + s.propId);
  A.eq(agents, ['QUILL@p2', 'MIRA@p3', 'QUILL@p4'], 'the sentence names QUILL at bay A and again at bay C');
  const r = W.readiness(f, comp, { hasCompute: () => true, briefOf: () => 'x', errors: [], triggers: { schedules: ['daily'] } });
  A.eq(r.ready, true, 'the line is ready: ' + JSON.stringify(r.blocking));
  const nb = W.neighbours(f, 'p4');
  A.eq(nb.prev, ['p3'], 'bay C GETS from bay B');
  const rt = W.lineRoutines([{ id: 'a', agentId: 'quill', dockId: 'p2', runsLine: true }, { id: 'c', agentId: 'quill', dockId: 'p4', runsLine: true }, { id: 'x', agentId: 'quill', runsLine: true }],
    ['quill', 'mira'], ['quill'], ['p2']);
  A.eq(rt.map(x => x.id + ':' + x.startsLine), ['a:true', 'c:false', 'x:true'], 'a routine firing at bay C runs from mid-line; at bay A (or no bay) it starts the line');
}

/* ---- conveyor physics keyed by dock ---- */
{
  const belts = [];
  for (let x = 0; x <= 8; x++) belts.push({ x, y: 0, dir: 'E' });
  // quill crews bay A (tile 2,0) and bay C (tile 6,0); mira bay B (tile 4,0)
  const stops = { '2,0': { agentId: 'quill', dockId: 'p2' }, '4,0': { agentId: 'mira', dockId: 'p3' }, '6,0': { agentId: 'quill', dockId: 'p4' } };
  const run = (payload) => {
    const got = [];
    const cv = Conveyor.create({ onDeliver: (bx, x, y) => got.push(x + ',' + y) });
    cv.enqueueAt(0, 0, payload);
    let now = 0; for (let i = 0; i < 1200 && !got.length; i++) { now += 16; cv.tick(16, now, belts, null, stops); }
    return got[0] || null;
  };
  A.eq(run({ workitemId: 'w1', agentId: 'quill', dockId: 'p4' }), '6,0', 'a crate addressed to bay C rides past quill’s bay A and lands at bay C');
  A.eq(run({ workitemId: 'w2', agentId: 'quill', dockId: 'p2' }), '2,0', 'a crate addressed to bay A lands at bay A');
  A.eq(run({ workitemId: 'w3', agentId: 'quill' }), '2,0', 'a crate naming only the agent stops at its first bay (the pre-dock rule)');
  A.eq(run({ workitemId: 'w4' }), '2,0', 'unowned work stops at the first dock');
  // a handoff produced at bay A for quill@C: fromDockId p2 — rides past bay A (its producer) AND mira's bay
  A.eq(run({ workitemId: 'w5', agentId: 'quill', dockId: 'p4', fromAgentId: 'quill', fromDockId: 'p2' }), '6,0', 'a handoff from bay A to bay C (same agent) is consumed at bay C');
}

/* ---- per-dock capability room ---- */
{
  const WM = require('../frontend/app/worldmodel.js');
  const s = WM.create();
  const r0 = s.roomById(s.spawnRoomId());
  const rect = r0.rects[0];
  const a = s.addProp({ t: 'bay', x: rect.x1 + 1, y: rect.y1 + 1, w: 1, h: 1 });
  const bayA = a && (a.id || (a.prop && a.prop.id));
  A.ok(!!bayA, 'placed bay A');
  if (bayA) {
    s.assignBay ? s.assignBay(bayA, 'quill') : null;
    const pa = s.propById(bayA); if (pa && !pa.agentId) pa.agentId = 'quill';
    A.eq(s.agentRoomId('quill', bayA), s.spawnRoomId(), 'agentRoomId(agent, dock) resolves the room of THAT bay');
    A.eq(s.agentRoomId('quill', 'nope'), s.spawnRoomId(), 'an unknown dock falls back to the agent’s first bay');
  }
}

A.report('floor.multibay');
