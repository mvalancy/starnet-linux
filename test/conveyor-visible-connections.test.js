/* test/conveyor-visible-connections.test.js — HIDDEN CONNECTIONS (2026-09-23 first-time-user playtest).

   The compiler hooks a machine to EVERY belt tile in its 1-tile ring (corners included). That routing law
   stays; what the playtest caught is that connections happened SILENTLY:
     1. two BAYS stacked touching under a SPLITTER, wired with the BELT tool, compiled as a hand-off CHAIN
        (writer "HANDS OFF TO researcher") — the lane into one bay ended on the CORNER of the other;
     2. a line stamped directly under another JOINED it while the placement ghost stayed green.
   Locked here:
     A. connectBelt no longer ends (or starts) a lane on a tile a THIRD machine touches when a clean tile
        exists — the stacked-bay floor compiles as two parallel branches, both fed by the INBOX;
     B. station.connectionPreview names the existing machines a placement WOULD hook (the ghost turns amber
        and says so) — stamp under a line = its machines; one row lower = nothing; a nudge along a machine's
        own lane is not a "new" connection; hookedBelts reports what a move would leave behind;
     C. no false alarms: every starter blueprint on a clear deck previews zero connections;
     D. the REFIT wiring: the ghosts ask connectionPreview, go amber with WILL CONNECT TO, and brushed
        hookups on an existing floor are drawn (brushedHookups) and explained on the hover card. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');

function freshFloor() {
  const s = WM.create();
  const r = s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 69, y2: 16 } });
  A.ok(r.ok, 'test deck placed');
  return s;
}
const add = (s, t, x, y, w, h) => { const q = s.addProp({ t, x, y, w, h, block: w > 1 || h > 1 ? true : false }); A.ok(q && q.ok, 'placed ' + t + ' at ' + x + ',' + y + (q && q.msg ? ' — ' + q.msg : '')); return q.id; };

/* ---------- A. the playtest floor: two stacked bays under a splitter, wired by clicks ---------- */
{
  const s = freshFloor();
  const I = add(s, 'intake', 32, 8, 2, 2), S = add(s, 'splitter', 36, 8, 1, 1);
  const Ba = add(s, 'bay', 39, 6, 2, 2), Bb = add(s, 'bay', 39, 8, 2, 2);   // TOUCHING: Ba's bottom edge meets Bb's top edge
  const O = add(s, 'outbox', 45, 7, 2, 2);
  s.assignPropAgent(Ba, 'writer'); s.assignPropAgent(Bb, 'researcher');
  for (const [a, b] of [[I, S], [S, Ba], [S, Bb], [Ba, O], [Bb, O]]) {
    const c = s.connectBelt(a, b);
    A.ok(c && c.ok, 'BELT connects ' + a + ' -> ' + b + (c && c.msg ? ' (' + c.msg + ')' : ''));
  }
  const plan = P.compileRoutingPlan(s.projectGeometry());
  const dc = plan.dockChains || {};
  A.eq((dc[Ba] && dc[Ba].next) || [], [], 'the writer bay does NOT hand off to the researcher bay it merely touches');
  A.eq((dc[Bb] && dc[Bb].next) || [], [], '…nor the researcher to the writer');
  A.ok(plan.reachDock[Ba] && plan.reachDock[Bb], 'both stacked bays are fed by the INBOX — two parallel branches, as drawn');
  A.ok(!!(dc[Ba] && dc[Ba].outbox) && !!(dc[Bb] && dc[Bb].outbox), 'each branch ships to the OUTBOX');
  A.eq(plan.errors.filter(e => !e.warn).length, 0, 'no blocking finding on the parallel floor');
  A.ok(!plan.errors.some(e => e.code === 'BAY_NOT_FED'), 'no bay is shamed NOT FED');
  // the laid lanes never end/start on a tile inside the OTHER bay's ring
  const ring = p => { const o = new Set(); for (let y = p.y - 1; y <= p.y + p.h; y++) for (let x = p.x - 1; x <= p.x + p.w; x++) if (!(x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)) o.add(x + ',' + y); return o; };
  const ra = ring(s.propById(Ba)), rb = ring(s.propById(Bb));
  const shared = s.belts().filter(b => ra.has(b.x + ',' + b.y) && rb.has(b.x + ',' + b.y));
  A.eq(shared.length, 0, 'no belt tile sits in BOTH stacked bays\' rings (the tile that made the hidden chain)');
  // and the preview agrees there is nothing hidden left to warn about on this floor
  A.eq(s.connectionPreview({ props: [] }), [], 'an empty candidate previews nothing');
}

/* ---------- B. connectionPreview: stamping under a line, one row lower, a prop against a lane, a nudge ---------- */
{
  const s = freshFloor();
  const fd = s.stampBlueprint('front_desk', 32, 3);
  A.ok(fd && fd.ok, 'front desk stamped');
  const bp = WM.BLUEPRINTS.find(b => b.id === 'research_line');
  const cand = (ox, oy) => ({ props: bp.props.map(p => ({ t: p.t, x: ox + p.x, y: oy + p.y, w: p.w, h: p.h })), belts: bp.belts.map(b => ({ x: ox + b.x, y: oy + b.y, d: b.d })) });
  A.ok(s.canPlaceBlueprint('research_line', 30, 5).ok, 'the stamp right under the front desk IS legal (sandbox — the ghost never refuses it)');
  const under = s.connectionPreview(cand(30, 5));
  const types = under.map(l => l.t).sort();
  A.eq(types, ['bay', 'intake', 'outbox'], 'stamping right under the front desk previews joining its INBOX + BAY + OUTBOX (the silent join, now named)');
  A.eq(s.connectionPreview(cand(30, 6)), [], 'one row lower: nothing to join — the ghost stays green');
  // stamp it anyway and prove the preview told the truth: the compiled line really merges
  const st = s.stampBlueprint('research_line', 30, 5);
  A.ok(st && st.ok, 'stamped under');
  const comps = P.lineComponents(s.projectGeometry());
  A.eq(comps.length, 1, 'the compiled floor is ONE line after that stamp — exactly what the amber ghost warned');
  s.undo();
  A.eq(P.lineComponents(s.projectGeometry()).length, 1, 'undo: the front desk alone again');
  const st2 = s.stampBlueprint('research_line', 30, 6);
  A.ok(st2 && st2.ok, 'stamped one row lower');
  A.eq(P.lineComponents(s.projectGeometry()).length, 2, 'one row lower stays TWO separate lines — the green ghost was also true');

  // a single machine dropped against a lane previews that lane's machines
  const s2 = freshFloor();
  s2.stampBlueprint('front_desk', 32, 3);
  const near = s2.connectionPreview({ props: [{ t: 'bay', x: 35, y: 5, w: 2, h: 2 }] });
  A.ok(near.length >= 1 && near.some(l => l.t === 'bay' || l.t === 'intake'), 'a BAY dropped against the lane previews hooking it (' + JSON.stringify(near.map(l => l.t)) + ')');
  A.eq(s2.connectionPreview({ props: [{ t: 'bay', x: 35, y: 7, w: 2, h: 2 }] }), [], 'a BAY two rows clear previews nothing');
  A.eq(s2.connectionPreview({ props: [{ t: 'plant', x: 35, y: 5, w: 1, h: 1 }] }), [], 'decor never hooks a lane');

  // MOVE: a nudge along the machine's own lane is not a new connection; a move away leaves belts behind
  const intake = s2.props().find(p => p.t === 'intake');
  A.ok(s2.hookedBelts(intake.id).length >= 1, 'hookedBelts: the stamped INBOX is hooked to its lane');
  A.eq(s2.connectionPreview({ props: [{ t: 'intake', x: intake.x, y: intake.y + 1, w: 2, h: 2 }], ignoreId: intake.id }), [], 'nudging the INBOX along its own lane previews no NEW connection');
  const left = s2.hookedBelts(intake.id).filter(b => !(b.x >= intake.x - 1 && b.x <= intake.x + 2 && b.y >= intake.y + 5 - 1 && b.y <= intake.y + 5 + 2));
  A.ok(left.length >= 1, 'moving the INBOX 5 rows down would leave its belts behind (the move ghost says so)');
  A.eq(s2.hookedBelts('nope'), [], 'hookedBelts of an unknown prop is empty');
}

/* ---------- C. no false alarms: every starter line on a clear deck previews zero connections ---------- */
{
  for (const bp of WM.BLUEPRINTS) {
    const s = freshFloor();
    const c = { props: bp.props.map(p => ({ t: p.t, x: 32 + p.x, y: 2 + p.y, w: p.w, h: p.h })), belts: bp.belts.map(b => ({ x: 32 + b.x, y: 2 + b.y, d: b.d })) };
    A.eq(s.connectionPreview(c), [], bp.id + ': a stamp on a clear deck previews no connection (no false amber)');
  }
}

/* ---------- D. the REFIT wiring (source locks — build.js is a browser module) ---------- */
{
  const build = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'build.js'), 'utf8');
  const wm = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'worldmodel.js'), 'utf8');
  A.ok(/connectBelt, connectionPreview, hookedBelts,/.test(wm), 'the model exports connectionPreview + hookedBelts');
  A.ok(/const cleanGoals = /.test(wm) && /want\.has\(tk\)/.test(wm), 'connectBelt prefers a goal tile no third machine touches');
  const gi = build.slice(build.indexOf('function ghostInfo()'), build.indexOf('/* ---------- render loop ---------- */'));
  A.ok((gi.match(/ghostLinks\(/g) || []).length >= 3, 'the prop hover, prop drag-stamp and prop MOVE ghosts all ask connectionPreview');
  const lg = build.slice(build.indexOf('function lineGhost('), build.indexOf('function stampLine('));
  A.ok(/ghostLinks\(\{ props: bp\.props/.test(lg), 'the LINE (blueprint) ghost asks it too — machines AND belts');
  const dg = build.slice(build.indexOf('function drawGhost('), build.indexOf('/* ---------- tooltip ---------- */'));
  A.ok(/'WILL CONNECT TO ' \+ linkNames\(links\)/.test(dg), 'an amber ghost NAMES what it would join');
  A.ok(/const warn = !!\(ok && \(links \|\| g\.leftBehind\)\)/.test(dg), 'amber = legal but connecting (or leaving belts behind) — never a refusal');
  A.ok(/ITS BELTS STAY HERE/.test(dg), 'the move ghost says the belts stay behind');
  A.ok(/drawBrushedHookups\(t\);/.test(build) && /function brushedHookups\(\)/.test(build), 'brushed hookups on an existing floor are drawn');
  A.ok(/brushedHookups\(\)\.some\(h => h\.propId === placed\.id\)/.test(build), '…and explained on the machine\'s hover card');
}

A.report('conveyor-visible-connections.test');
