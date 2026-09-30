/* test/_multibay-floor.js — THE ACCEPTANCE FLOOR of multi-bay agents (Andrew's ruling, 2026-09-22):

     INBOX p1 → WRITER quill @ bay A (p2) → EDITOR mira @ bay B (p3) → WRITER quill @ bay C (p4) → OUTBOX p5

   one straight belt along y=0 (x 1..14, flowing E); each bay/box hooks it through its 1-tile ring.
   `geo()` is the floor; `plan()` compiles it (legal since DUP_AGENT was retired). `storedPlan()` builds the SAME
   floor the way a pre-dock sidecar would have stored it: compiled with a placeholder agent on bay C, renamed to
   quill, and stripped of the dock layer — exactly the shape planlines.healPlan must derive dock maps for. The
   two shapes must agree (test/pipeline.multibay.test.js). */
'use strict';
const Pipeline = require('../frontend/app/pipeline.js');

const BRIEF = { A: 'BRIEF-A: draft the piece from the notes.', B: 'BRIEF-B: edit the draft for clarity.', C: 'BRIEF-C: polish the edited draft into the final copy.' };
function geo(opt) {
  const o = opt || {};
  const belts = [];
  for (let x = 1; x <= 14; x++) belts.push({ x, y: 0, dir: 'E' });
  return {
    belts,
    props: [
      { id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'p2', t: 'bay', x: 3, y: 1, w: 1, h: 1, agentId: 'quill', role: 'WRITER', brief: BRIEF.A },
      { id: 'p3', t: 'bay', x: 7, y: 1, w: 1, h: 1, agentId: 'mira', role: 'EDITOR', brief: BRIEF.B },
      { id: 'p4', t: 'bay', x: 11, y: 1, w: 1, h: 1, agentId: o.cAgent || 'quill', role: 'WRITER', brief: BRIEF.C },
      { id: 'p5', t: 'outbox', x: 14, y: 1, w: 1, h: 1 }
    ]
  };
}
const plan = () => Pipeline.compileRoutingPlan(geo());
const DOCK_FIELDS = ['bayTileToDock', 'agentOfDock', 'docksOfAgent', 'dockChains', 'reachDock', 'gateDocks', 'lineOfDock', 'entryDock'];
function storedPlan() {
  const p = JSON.parse(JSON.stringify(Pipeline.compileRoutingPlan(geo({ cAgent: 'zed' }))));
  for (const k of DOCK_FIELDS) delete p[k];
  const ren = a => (a === 'zed' ? 'quill' : a);
  for (const b of p.bays) b.agentId = ren(b.agentId);
  for (const b of p.dockBays) b.agentId = ren(b.agentId);
  for (const k in p.bayTileToAgent) p.bayTileToAgent[k] = ren(p.bayTileToAgent[k]);
  p.reach = { quill: !!(p.reach.quill || p.reach.zed), mira: !!p.reach.mira };
  const zc = p.chains.zed; delete p.chains.zed;
  for (const a in p.chains) p.chains[a].next = p.chains[a].next.map(ren).filter((v, i, arr) => arr.indexOf(v) === i).sort();
  void zc;
  delete p.lineOfAgent.zed;
  for (const l of p.lines) l.agents = l.agents.map(ren).filter((v, i, arr) => arr.indexOf(v) === i).sort();
  return p;
}
module.exports = { geo, plan, storedPlan, BRIEF, DOCK_FIELDS };
