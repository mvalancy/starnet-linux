/* test/pipeline.test.js — headless tests for the belt-graph -> RoutingPlan compiler (frontend/app/pipeline.js).
   Pure function of geo {props, belts}; no DOM, no time, no RNG — loads with a plain require(). */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');

const geo = (props, belts) => ({ props, belts });
const belt = (x, y, dir) => ({ x, y, dir });
/* WORK BELONGS TO A LINE (2026-08-07): chainNext advances a dock ONLY for work that entered through that
   dock's own line. `onLine(plan, agentId)` is the ctx such a run carries — the shape every trigger
   (channel/routine/sample/INBOX crate) produces. A ctx WITHOUT lineId is a direct order and is terminal;
   that is asserted explicitly in the dedicated block near the end of this file. */
const onLine = (plan, aid, extra) => Object.assign({ lineId: P.lineOf(plan, aid) }, extra || {});

/* ---- a complete INTAKE -> belt -> BAY floor routes + validates clean ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')]
  ));
  A.eq(plan.sources.length, 1, 'one INTAKE source bound to its belt tile');
  A.eq(plan.bays.length, 1, 'one BAY bound to its belt tile');
  A.eq(plan.bays[0].agentId, 'coder', 'the bay carries its agentId');
  A.eq(plan.reach.coder, true, 'the coder bay is reachable from the source');
  A.eq(plan.errors.length, 0, 'a complete intake->belt->bay floor has no errors');
  A.ok(P.ok(plan), 'plan is deployable');
  A.eq(P.resolveTarget(plan, { tag: 'anything' }), 'coder', 'resolveTarget routes work to the single bay');
}

/* ---- ORPHAN_SOURCE: an intake with no adjacent belt ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }], [belt(8, 8, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'ORPHAN_SOURCE' && e.warn), 'an intake with no belt -> ORPHAN_SOURCE (warn)');
  A.ok(P.ok(plan), 'an unbelted intake is advice, never a deploy blocker (it contributes no source at all)');
}

/* ---- an unbelted INTAKE beside a WORKING line must not condemn the line (2026-07-26 audit) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'coder' },
     { id: 'i2', t: 'intake', x: 12, y: 9, w: 1, h: 1 }],            // decorative: nowhere near a belt
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'ORPHAN_SOURCE' && e.propId === 'i2'), 'the stray intake is still flagged');
  A.ok(P.ok(plan), 'one decorative intake does NOT make the whole floor non-deployable');
  A.eq(P.resolveTarget(plan, { tag: 'anything' }), 'coder', 'the working line still routes');
}

/* ---- detectCycle is iterative: a long connected run must compile, not blow the call stack ---- */
{
  const belts = [];                                    // 71x71 connected serpentine = 5041 chained tiles
  for (let y = 0; y < 71; y++) {
    const ltr = y % 2 === 0;
    for (let x = 0; x < 71; x++) {
      const endOfRow = ltr ? (x === 70) : (x === 0);
      belts.push({ x, y, dir: (endOfRow && y < 70) ? 'S' : (ltr ? 'E' : 'W') });
    }
  }
  let threw = null, plan = null;
  try { plan = P.compileRoutingPlan({ belts, props: [], origin: { tx: 0, ty: 0 } }); } catch (e) { threw = e; }
  A.ok(!threw, 'a 5041-tile connected belt run compiles (no RangeError: ' + (threw && threw.message) + ')');
  A.ok(plan && !plan.errors.some(e => e.code === 'CYCLE'), '...and is correctly seen as acyclic');
  // and a real loop inside a long run is still caught
  const loop = belts.slice(0, 200).concat([{ x: 0, y: 80, dir: 'E' }, { x: 1, y: 80, dir: 'S' }, { x: 1, y: 81, dir: 'W' }, { x: 0, y: 81, dir: 'N' }]);
  const lp = P.compileRoutingPlan({ belts: loop, props: [], origin: { tx: 0, ty: 0 } });
  A.ok(lp.errors.some(e => e.code === 'CYCLE'), 'a cycle is still detected after the iterative rewrite');
  A.ok(!P.ok(lp), 'a cyclic plan stays non-deployable');
}

/* ---- BAY_NOT_FED (was blocking DEAD_BAY): a hooked bay whose belt serves NEITHER direction ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 8, y: 8, w: 2, h: 2, agentId: 'lonely' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(9, 8, 'E')]   // bay's belt scrap: no intake feeds it, no outbox receives it
  ));
  A.eq(plan.reach.lonely, false, 'an unconnected bay is not reachable');
  A.ok(plan.errors.some(e => e.code === 'BAY_NOT_FED' && e.agentId === 'lonely' && e.warn), 'belt to nowhere -> BAY_NOT_FED (warn)');
  A.ok(P.ok(plan), 'a belt-to-nowhere is advice, never a deploy blocker (dispatch cannot route to it anyway)');
}

/* ---- LONE BAY IS A COMPLETE BUILD: no intake, no belts -> zero findings (the 2026-07-05 confusion bug) ---- */
{
  const plan = P.compileRoutingPlan(geo([{ id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'solo' }], []));
  A.eq(plan.errors.length, 0, 'a lone assigned bay has NO errors — the simplest build just works');
  A.ok(P.ok(plan), 'lone-bay plan is deployable');
  A.eq(plan.dockBays.length, 1, 'the lone bay is recorded as a working dock');
  A.eq(plan.bays.length, 0, 'a beltless bay never enters the dispatch bays (router semantics untouched)');
}

/* ---- OUTBOUND LANE IS VALID + GLOWS: bay -> belt -> OUTBOX with NO intake (Andrew's exact repro) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'b1', t: 'bay', x: 0, y: 0, w: 2, h: 2, agentId: 'coder' },
     { id: 'o1', t: 'outbox', x: 6, y: 0, w: 2, h: 2 }],
    [belt(2, 1, 'E'), belt(3, 1, 'E'), belt(4, 1, 'E'), belt(5, 1, 'E')]
  ));
  A.eq(plan.errors.length, 0, 'bay->belt->outbox with no intake: ZERO findings (a correct ship-out lane, not "NO ROUTE IN")');
  A.ok(P.ok(plan), 'the outbound lane deploys');
  const live = P.liveTiles(plan);
  A.ok(live['2,1'] && live['3,1'] && live['4,1'] && live['5,1'], 'the outbound lane GLOWS live end to end');
  const r = P.routeFrom(plan, 3, 1);
  A.ok(r.outbox && !r.deadEnd && r.agents.length === 0, 'hovering the outbound lane answers OUTBOX, not DEAD END');
}

/* ---- ORPHAN_BAY is contextual: beltless bay + an intake line elsewhere -> warn; without a line -> silent ---- */
{
  const withLine = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 8, y: 8, w: 2, h: 2, agentId: 'apart' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E')]
  ));
  A.ok(withLine.errors.some(e => e.code === 'ORPHAN_BAY' && e.warn), 'a line exists + bay not hooked -> NOT ON THE LINE (warn)');
  A.ok(P.ok(withLine), '...and it never blocks deploy');
  const noLine = P.compileRoutingPlan(geo([{ id: 'b1', t: 'bay', x: 8, y: 8, w: 2, h: 2, agentId: 'apart' }], [belt(1, 0, 'E')]));
  A.ok(!noLine.errors.some(e => e.code === 'ORPHAN_BAY'), 'no intake line anywhere -> a beltless bay is NOT a finding');
}

/* ---- CYCLE: a belt loop is a HARD error (a loop = infinite paid runOnce) ---- */
{
  const plan = P.compileRoutingPlan(geo([], [belt(0, 0, 'E'), belt(1, 0, 'S'), belt(1, 1, 'W'), belt(0, 1, 'N')]));
  A.ok(plan.errors.some(e => e.code === 'CYCLE'), 'a belt loop -> CYCLE');
  A.ok(!P.ok(plan), 'a cyclic plan is never deployable');
  // reach is never computed under a CYCLE, so "not fed" would be a guess: a FED bay on a working lane elsewhere on the
  // floor must not be shamed BAY_NOT_FED while the loop stands (station.layout audit 2026-09-28)
  const belts = [belt(0, 0, 'E'), belt(1, 0, 'S'), belt(1, 1, 'W'), belt(0, 1, 'N')];
  for (let x = 11; x <= 16; x++) belts.push(belt(x, 0, 'E'));
  const fed = P.compileRoutingPlan(geo([
    { id: 'in', t: 'intake', x: 10, y: 0, w: 1, h: 1 },
    { id: 'b1', t: 'bay', x: 13, y: 1, w: 1, h: 1, agentId: 'ada' },
    { id: 'out', t: 'outbox', x: 17, y: 0, w: 1, h: 1 }
  ], belts));
  A.ok(fed.errors.some(e => e.code === 'CYCLE'), 'the stray loop is still the (blocking) finding');
  A.ok(!fed.errors.some(e => e.code === 'BAY_NOT_FED'), 'and no bay is called "not fed" on a guess: ' + JSON.stringify(fed.errors.map(e => e.code)));
}

/* ---- ONE AGENT, TWO BAYS is legal (DUP_AGENT retired — Andrew's ruling 2026-09-22): each bay is its own dock ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
     { id: 'b2', t: 'bay', x: 5, y: 5, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 6, 'E')]
  ));
  A.ok(!plan.errors.some(e => e.code === 'DUP_AGENT'), 'two bays, one agent -> no DUP_AGENT any more');
  A.ok(P.ok(plan), '…and the plan is deployable');
  A.eq(plan.bays.map(b => b.propId), ['b1', 'b2'], 'BOTH bays are dispatch docks (the second is no longer dropped)');
  A.eq(plan.docksOfAgent.coder, ['b1', 'b2'], 'the agent crews both, oldest first');
  A.eq(plan.entryDock.coder, 'b1', 'its entry dock is the INBOX-fed one');
  A.ok(!plan.errors.some(e => e.code === 'SPLIT_CREW'), 'no SPLIT_CREW without capability-room facts on the geo');
  const split = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder', capRoom: 'r1' },
     { id: 'b2', t: 'bay', x: 5, y: 5, w: 2, h: 2, agentId: 'coder', capRoom: 'r2' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 6, 'E')]
  ));
  const w = split.errors.find(e => e.code === 'SPLIT_CREW');
  A.ok(w && w.warn === true && w.agentId === 'coder' && w.propId === 'b2', 'a desk-less agent with bays in two rooms -> SPLIT_CREW (a warning on its second bay)');
  A.ok(P.ok(split), 'SPLIT_CREW is advice, never a blocker');
}

/* ---- UNBOUND_BAY is a warning, not a blocker ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 3, y: 0, w: 2, h: 2 }],
    [belt(1, 0, 'E'), belt(2, 0, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'UNBOUND_BAY' && e.warn), 'a bay with no agent -> UNBOUND_BAY (warn)');
  A.ok(P.ok(plan), 'a warning does not block deploy');
}

/* ---- FILTER content-routing: code->coder (E lane), research->researcher (S lane), default->coder ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f1', t: 'filter', x: 2, y: 0, w: 1, h: 1, routes: { code: 'E', research: 'S' }, def: 'E' },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
     { id: 'br', t: 'bay', x: 1, y: 3, w: 2, h: 2, agentId: 'researcher' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),   // E lane -> coder bay (@4,0)
     belt(2, 1, 'S'), belt(2, 2, 'S')]                                      // S lane -> researcher bay (@2,2)
  ));
  A.eq(plan.errors.length, 0, 'a complete filter floor has no errors (default present, both bays reachable)');
  A.eq(plan.reach.coder, true, 'coder reachable via the E lane');
  A.eq(plan.reach.researcher, true, 'researcher reachable via the S lane');
  A.eq(P.resolveTarget(plan, { tag: 'code' }), 'coder', "a 'code' message routes to the coder bay");
  A.eq(P.resolveTarget(plan, { tag: 'research' }), 'researcher', "a 'research' message routes to the researcher bay");
  A.eq(P.resolveTarget(plan, { tag: 'misc' }), 'coder', 'an untagged message takes the default lane');
}

/* ---- FILTER never-drops: a route to a non-existent lane falls back to the default (visual == dispatch) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f1', t: 'filter', x: 2, y: 0, w: 1, h: 1, routes: { code: 'N' }, def: 'E' },   // 'N' lane has no belt
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')]
  ));
  A.eq(P.resolveTarget(plan, { tag: 'code' }), 'coder',
    'a filter route to a missing lane falls back to the default lane (resolveTarget mirrors the engine — work never dropped)');
}

/* ---- MERGER: a CONFIGLESS lane funnel; a box resolves straight through it (2026-07-26 audit) ----
   `bufferSize` used to be threaded in as a hold-K-then-combine barrier. Nothing in the harness batches, so
   that config could only ever animate a lie; it is no longer compiled, and a legacy K on a saved prop must
   be inert rather than resurrect the old behaviour. */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'm1', t: 'merger', x: 2, y: 0, w: 1, h: 1, bufferSize: 3 },   // a legacy K from an old save
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'a' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')]
  ));
  const j = plan.junctions['2,0'];
  A.ok(j && j.kind === 'merge', 'a merger compiles to a merge junction');
  A.eq(j.bufferSize, undefined, 'a legacy bufferSize is NOT compiled into the plan (a merger has no config)');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'a', 'a box resolves straight through a merge to the downstream bay');
  // the round-robin picker belongs to SPLITTERS: a merge has one exit, and must never burn a lane tick
  const picks = [];
  P.resolveTarget(plan, { tag: 'x' }, (k, n) => { picks.push(k); return 0; });
  A.eq(picks.length, 0, 'walking through a merger never consults the splitter round-robin picker');
}

/* ---- FILTER_NO_DEFAULT is a WARN, not a blocker (2026-08-04): a def-less filter never drops work —
        engine and resolveTarget share the routed -> def -> FIRST-lane fallback, so it can neither loop
        nor void a crate, which is the bar a blocking error must meet ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f1', t: 'filter', x: 1, y: 0, w: 1, h: 1, routes: { code: 'E' } },   // no def
     { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'FILTER_NO_DEFAULT' && e.warn), 'a filter with no default lane -> FILTER_NO_DEFAULT (warn)');
  A.ok(P.ok(plan), 'a def-less filter is a nag, never a deploy blocker (fallback lane means work is never dropped)');
  A.eq(P.resolveTarget(plan, { tag: 'misc' }), 'coder', 'unrouted work still resolves via the first-lane fallback');
}

/* ---- ORPHAN_JUNCTION: a junction touching NO belt was silently inert — now it nags (warn) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'coder' },
     { id: 'f1', t: 'filter', x: 9, y: 9, w: 1, h: 1, routes: { code: 'E' }, def: 'E' }],   // nowhere near a belt
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
  ));
  A.ok(plan.errors.some(e => e.code === 'ORPHAN_JUNCTION' && e.propId === 'f1' && e.warn), 'a beltless junction -> ORPHAN_JUNCTION (warn), never silence');
  A.ok(P.ok(plan), 'an inert junction cannot loop or void work — the floor still deploys');
  A.eq(Object.keys(plan.junctions).length, 0, 'the orphan compiles to NO junction (still inert, just no longer silent)');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'coder', 'the working line is untouched');
}

/* ---- resolveTarget null fallback + replay-stable hash ---- */
{
  A.eq(P.resolveTarget({ sources: [] }, { tag: 'x' }), null, 'no source -> resolveTarget null (caller falls back, never stalls)');
  const mk = () => geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'a' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
  );
  A.eq(P.compileRoutingPlan(mk()).hash, P.compileRoutingPlan(mk()).hash, 'two identical floors -> identical plan.hash');
  const other = geo([{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 }], [belt(1, 0, 'E')]);
  A.ok(P.compileRoutingPlan(mk()).hash !== P.compileRoutingPlan(other).hash, 'a different floor -> a different hash');
}

/* ---- SPLITTER lane pick: resolveTarget round-robins split lanes via the pick callback (else first lane) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },       // E lane
     { id: 'br', t: 'bay', x: 1, y: 4, w: 2, h: 2, agentId: 'researcher' }], // S lane
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 1, 'S'), belt(2, 2, 'S'), belt(2, 3, 'S')]
  ));
  A.eq(plan.errors.length, 0, 'a splitter feeding two distinct bound bays is valid');
  A.eq(P.resolveTarget(plan, {}), P.resolveTarget(plan, {}), 'no pick -> the first lane every time (replay-stable read)');
  const rr = {}, pick = (k, n) => { const c = rr[k] || 0; rr[k] = (c + 1) % n; return c; };
  const seq = [P.resolveTarget(plan, {}, pick), P.resolveTarget(plan, {}, pick), P.resolveTarget(plan, {}, pick), P.resolveTarget(plan, {}, pick)];
  A.eq(seq.join(','), 'coder,researcher,coder,researcher', 'a round-robin pick spreads dispatch across the splitter lanes (' + seq.join(',') + ')');
}

/* ---- liveTiles: only tiles on a COMPLETE source->bound-bay route are energized ---- */
{
  // E lane reaches the coder bay; S branch off the splitter dead-ends; (8,8) is disconnected scrap
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 1, 'S'), belt(2, 2, 'S'),      // the dead branch: forward-reachable, never reaches a bay
     belt(8, 8, 'E')]                       // disconnected scrap: not even forward-reachable
  ));
  const live = P.liveTiles(plan);
  A.ok(live['1,0'] && live['2,0'] && live['3,0'] && live['4,0'], 'every tile on the source->bay route is live');
  A.ok(!live['2,1'] && !live['2,2'], 'a branch that never reaches a bound bay stays cold');
  A.ok(!live['8,8'], 'a disconnected belt stays cold');
}

/* ---- liveTiles: no bound bay anywhere -> the whole line is cold (nothing can run) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b1', t: 'bay', x: 4, y: 0, w: 2, h: 2 }],   // bay UNBOUND
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
  ));
  A.eq(Object.keys(P.liveTiles(plan)).length, 0, 'an unbound bay powers nothing — the whole line is cold');
  A.ok(plan.unboundBays.length === 1 && plan.unboundBays[0].tile.x === 3, 'the unbound bay hookup tile is recorded for the legibility layer');
}

/* ---- routeFrom: the hover answer — agent / unbound bay / dead end, from any belt tile ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
     { id: 'bu', t: 'bay', x: 1, y: 3, w: 2, h: 2 }],                      // unbound bay on the S lane
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 1, 'S'), belt(2, 2, 'S')]
  ));
  const atSplit = P.routeFrom(plan, 1, 0);       // upstream of the splitter: both futures are possible
  A.eq(atSplit.agents.join(','), 'coder', 'upstream of the splitter the flow can reach the coder bay');
  A.eq(atSplit.unbound, 1, '...and can ride past one unbound bay hookup');
  A.ok(atSplit.deadEnd, '...and the unbound branch sinks (deadEnd flagged)');
  const eLane = P.routeFrom(plan, 3, 0);
  A.eq(eLane.agents.join(','), 'coder', 'on the E lane the flow reaches exactly the coder bay');
  A.ok(!eLane.deadEnd && eLane.unbound === 0, 'the E lane has no dead futures');
  const sLane = P.routeFrom(plan, 2, 2);
  A.eq(sLane.agents.length, 0, 'the S lane reaches no bound bay');
  A.eq(sLane.unbound, 1, 'the S lane passes the unbound bay hookup');
  const off = P.routeFrom(plan, 9, 9);
  A.ok(off.agents.length === 0 && !off.deadEnd, 'a non-belt tile answers empty (no false claims)');
}

/* ---- SPLIT_ONE_LANE: a splitter with <2 out-lanes fans nothing — warn (not a blocker) ---- */
{
  const one = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'a' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E')]   // single straight lane through the splitter
  ));
  A.ok(one.errors.some(e => e.code === 'SPLIT_ONE_LANE' && e.warn), 'a one-lane splitter -> SPLIT_ONE_LANE warning');
  A.ok(P.ok(one), 'the warning does not block deploy (the line still works, it just is not splitting)');
  const two = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'a' },
     { id: 'b2', t: 'bay', x: 1, y: 4, w: 2, h: 2, agentId: 'b' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(2, 1, 'S'), belt(2, 2, 'S'), belt(2, 3, 'S')]
  ));
  A.ok(!two.errors.some(e => e.code === 'SPLIT_ONE_LANE'), 'a splitter with two real out-lanes does not warn');
}

/* ---- junctionLaneOwners: each junction lane knows which bay owners it can reach (addressed crates ride home) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f', t: 'filter', x: 2, y: 0, w: 1, h: 1, routes: { code: 'S' }, def: 'E' },
     { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'nova' },
     { id: 'br', t: 'bay', x: 1, y: 3, w: 2, h: 2, agentId: 'coder' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 1, 'S'), belt(2, 2, 'S')]
  ));
  const own = P.junctionLaneOwners(plan);
  A.ok(own['2,0'], 'the filter tile carries lane owners');
  A.eq((own['2,0'].E || []).join(','), 'nova', 'E lane reaches nova');
  A.eq((own['2,0'].S || []).join(','), 'coder', 'S lane reaches coder');
  A.eq(P.junctionLaneOwners({ belts: {} })['x'], undefined, 'empty plan -> no owners (never throws)');
}

/* ---- MULTI-NETWORK LAW (the two-room bug): sourceFor picks the INBOX that reaches the agent; resolveTarget
        walks EVERY source and honors an explicit binding with a dock ---- */
{
  // room 1: intakeA -> bayA ('over')     room 2 (disjoint): intakeB -> bayB ('nova')
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'iA', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'bA', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'over' },
     { id: 'iB', t: 'intake', x: 0, y: 10, w: 1, h: 1 },
     { id: 'bB', t: 'bay', x: 4, y: 10, w: 2, h: 2, agentId: 'nova' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'),
     belt(1, 10, 'E'), belt(2, 10, 'E'), belt(3, 10, 'E')]
  ));
  A.eq(P.sourceFor(plan, 'over'), { x: 1, y: 0 }, "sourceFor('over') = room 1's INBOX hookup");
  A.eq(P.sourceFor(plan, 'nova'), { x: 1, y: 10 }, "sourceFor('nova') = room 2's INBOX hookup — never room 1's line");
  A.eq(P.sourceFor(plan, 'ghost'), null, 'no line reaches an unknown agent -> null (caller lands it at the dock)');
  A.eq(P.sourceFor(plan, null), null, 'unaddressed -> null (caller keeps first-INBOX behavior)');
  A.eq(P.resolveTarget(plan, { boundAgentId: 'nova' }), 'nova', 'an ADDRESSED message resolves to its addressee, not the first network');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'over', 'unaddressed work still takes the first network (deterministic default)');
  A.eq(P.resolveTarget(plan, { boundAgentId: 'ghost' }), 'over', 'a binding with NO dock on the floor falls through to the walk (work never stalls)');
}

/* ---- sourceFor rides THROUGH a foreign dock (addressed physics): one line, two bays in series ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 2, y: 1, w: 1, h: 1, agentId: 'first' },    // hooked at (2,0) on the line
     { id: 'b2', t: 'bay', x: 6, y: 0, w: 2, h: 2, agentId: 'second' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E')]
  ));
  A.eq(P.sourceFor(plan, 'second'), { x: 1, y: 0 }, "an addressed item reaches 'second' RIDING THROUGH 'first's dock hookup");
}

/* ---- MULTI-LANE INTAKE (open since 2026-07-26, closed 2026-08-04): an intake records EVERY ring belt
        tile (mirroring the bay/outbox multi-hookup rule), and every source walker fans out from all of
        them. The exact prior-audit failure: the reaching lane starts on the SECOND-scanned ring tile —
        the first-scanned mouth dead-ends — and the bay was invisible to reach/resolve/live/sourceFor. ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 1, y: 1, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 5, y: 1, w: 2, h: 2, agentId: 'nova' }],
    [belt(1, 0, 'N'),                                        // mouth 1 (first-scanned): dead-ends immediately
     belt(2, 2, 'E'), belt(3, 2, 'E'), belt(4, 2, 'E')]      // mouth 2 (later ring tile): the reaching lane
  ));
  A.eq(plan.sources.length, 1, 'one intake, one source');
  A.eq(plan.sources[0].tile, { x: 1, y: 0 }, '`tile` stays the FIRST ring hit (backward compat)');
  A.eq(JSON.stringify(plan.sources[0].tiles), JSON.stringify([{ x: 1, y: 0 }, { x: 2, y: 2 }]), '`tiles` records EVERY ring belt tile, in ring-scan order');
  A.eq(plan.reach.nova, true, 'the bay is REACHABLE via the second-scanned mouth (was false)');
  A.eq(plan.errors.length, 0, 'no BAY_NOT_FED ghost on a genuinely fed bay');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'nova', 'resolveTarget walks past the dead first mouth to the reaching lane (was null)');
  A.eq(P.sourceFor(plan, 'nova'), { x: 2, y: 2 }, 'sourceFor answers the mouth whose lane actually leads home');
  const live = P.liveTiles(plan);
  A.ok(live['2,2'] && live['3,2'] && live['4,2'], 'the reaching lane is energized end to end (was cold)');
  A.ok(!live['1,0'], 'the dead-end mouth stays cold (no false glow)');
}

/* ---- an intake feeding TWO lanes to two bays: both energize, dispatch takes the first mouth's lane,
        addressed work still enters through the lane that leads home ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 1, y: 1, w: 1, h: 1 },
     { id: 'ba', t: 'bay', x: 5, y: 0, w: 1, h: 1, agentId: 'alpha' },     // fed by the (2,0) mouth
     { id: 'bb', t: 'bay', x: 5, y: 2, w: 1, h: 1, agentId: 'beta' }],     // fed by the (2,2) mouth
    [belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'),
     belt(2, 2, 'E'), belt(3, 2, 'E'), belt(4, 2, 'E')]
  ));
  A.eq(plan.reach.alpha, true, 'lane one reaches alpha');
  A.eq(plan.reach.beta, true, 'lane two reaches beta (was: only the first-recorded mouth existed)');
  const live = P.liveTiles(plan);
  A.ok(live['2,0'] && live['4,0'] && live['2,2'] && live['4,2'], 'BOTH lanes energize');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'alpha', 'unaddressed dispatch takes the first mouth in ring-scan order (deterministic)');
  A.eq(P.sourceFor(plan, 'beta'), { x: 2, y: 2 }, "an item addressed to beta enters through beta's lane, never alpha's");
  A.eq(P.resolveTarget(plan, { boundAgentId: 'beta' }), 'beta', 'addressed work resolves to its addressee');
}

/* ---- resolveTarget: a SECOND source feeding the only bay is found (sources[0] alone was the old blind spot) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'iA', t: 'intake', x: 0, y: 0, w: 1, h: 1 },      // source A: dead-ends, no bay
     { id: 'iB', t: 'intake', x: 0, y: 5, w: 1, h: 1 },
     { id: 'b', t: 'bay', x: 4, y: 5, w: 2, h: 2, agentId: 'solo' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'),
     belt(1, 5, 'E'), belt(2, 5, 'E'), belt(3, 5, 'E')]
  ));
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'solo', "source A sinks -> the walk continues to source B's network (was null)");
}

/* ======================= THE CHAIN LAYER (agentic graphs) =======================
   A dock's OUTPUT is the next dock's INPUT. Until this shipped the floor was a dispatcher: everything drawn
   downstream of the bay that consumed the crate was scenery. These pin the bay->bay edges. */

/* ---- INTAKE -> researcher -> writer -> OUTBOX: a two-stage pipeline compiles as one chain ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'bA', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'researcher' },
     { id: 'bB', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer' },
     { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'),
     belt(5, 0, 'E'), belt(6, 0, 'E'),
     belt(8, 0, 'E'), belt(9, 0, 'E')]
  ));
  A.ok(P.ok(plan), 'a two-stage pipeline is deployable');
  A.eq(plan.errors, [], 'and CLEAN — a stage-two dock is fed by an AGENT, not by a door, and must not be nagged for it');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'researcher', 'inbound work still enters at the FIRST dock');
  A.eq(plan.chains.researcher.next, ['writer'], "the researcher's output hands off to the writer");
  A.eq(plan.chains.researcher.tile, { x: 5, y: 0 }, 'it ships from the hookup whose flow reaches the next dock');
  A.eq(plan.chains.writer.next, [], 'the writer is the terminal stage');
  A.eq(plan.chains.writer.outbox, true, "the writer's output ships out");
  A.eq(P.chainNext(plan, 'researcher', onLine(plan, 'researcher')), 'writer', 'chainNext walks the belt to the next stage');
  A.eq(P.chainNext(plan, 'writer', onLine(plan, 'writer')), null, 'a terminal stage hands off to nobody (its reply IS the answer)');
}

/* ---- WORK BELONGS TO A LINE (Andrew's ruling, 2026-08-07) — line identity + the dispatch gate ----
   "each conveyor system built has a purpose and a different workflow — the conveyor system should visually
   run ONLY when the specific workflow is running." Two independent lines on ONE floor; each keeps its own
   identity, and neither can advance the other. */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'a_i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'a_1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'a1' },
     { id: 'a_2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'a2' },
     { id: 'b_i', t: 'intake', x: 0, y: 6, w: 1, h: 1 },
     { id: 'b_1', t: 'bay', x: 4, y: 6, w: 1, h: 1, agentId: 'b1' },
     { id: 'b_2', t: 'bay', x: 7, y: 6, w: 1, h: 1, agentId: 'b2' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'),
     belt(1, 6, 'E'), belt(2, 6, 'E'), belt(3, 6, 'E'), belt(5, 6, 'E'), belt(6, 6, 'E')]
  ));
  A.eq(plan.lines.length, 2, 'two separate belt networks compile to TWO lines');
  const la = P.lineOf(plan, 'a1'), lb = P.lineOf(plan, 'b1');
  A.eq(la, 'a_1', 'the line id is the lexicographically smallest member PROP id (stable in the save doc)');
  A.ok(la !== lb, 'the two lines have different ids');
  A.eq(P.lineOf(plan, 'a2'), la, 'every dock on a line answers that line');
  A.eq(P.lineOf(plan, 'b2'), lb, '...for both lines');
  A.eq(P.lineOf(plan, 'nobody'), null, 'an agent that crews no dock belongs to no line');
  A.eq(plan.dockBays.find(d => d.propId === 'a_2').lineId, la, 'each dock entry on the plan is stamped with its line');
  A.ok(plan.bays.every(b => b.lineId === undefined), 'the HASHED bay records are untouched — line identity rides outside the topology hash');
  // the gate
  A.eq(P.chainNext(plan, 'a1', { lineId: la }), 'a2', "work fed to line A's door advances line A");
  A.eq(P.chainNext(plan, 'a1', {}), null, 'a run with NO line — a direct order — is TERMINAL, nothing downstream fires');
  A.eq(P.chainNext(plan, 'a1', { lineId: lb }), null, "line B's trigger cannot advance a dock on line A");
  A.eq(P.chainNext(plan, 'a1', { lineId: 'made-up' }), null, 'an unknown line id is not a key — the plan decides');
  // work origin: only a dock the line's own door FEEDS is a line trigger
  A.eq(P.lineOriginOf(plan, 'a1'), la, "outside work arriving at a dock the line's own door feeds IS that line running");
  A.eq(P.lineOriginOf(plan, 'a2'), null, 'a MID-LINE stage no door feeds was triggered by nothing — no line, no downstream spend');
  A.eq(P.lineOriginOf(plan, 'nobody'), null, 'and an agent on no dock has no origin at all');
  A.eq(P.resolveTarget(plan, { tag: 'x' }), 'a1', 'resolveTarget still answers exactly what it always did');
}

/* ---- a LONE dock is terminal work by construction: no door feeds it, nothing is downstream ---- */
{
  const plan = P.compileRoutingPlan(geo([{ id: 'b1', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'solo' }], []));
  A.eq(plan.lines.length, 0, 'a beltless dock is on no line at all');
  A.eq(P.lineOf(plan, 'solo'), null, 'so it names none');
  A.eq(P.lineOriginOf(plan, 'solo'), null, 'and its work is always direct');
}

/* ---- a dock NEVER eats its own output: a lane running along the dock's edge is ridden through ---- */
{
  // the lane runs ALONG alpha's dock: (3,0)/(4,0)/(5,0) are all in its 1-tile ring, so the handoff crate
  // ships from the first and must ride through its own two other hookups to reach beta's at (6,0).
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'bA', t: 'bay', x: 4, y: 1, w: 1, h: 1, agentId: 'alpha' },
     { id: 'bB', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'beta' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E')]
  ));
  A.eq(plan.bayTileToAgent['5,0'], 'alpha', 'the lane touches alpha\'s ring three times');
  A.eq(plan.chains.alpha.next, ['beta'], "alpha's handoff rides past its own ring tiles to beta");
  A.eq(P.chainNext(plan, 'alpha', onLine(plan, 'alpha')), 'beta', 'a dock never consumes the crate it just shipped');
}

/* ---- CHAIN_CYCLE: A ships into B's dock, B ships into A's dock — no BELT cycle anywhere ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'bA', t: 'bay', x: 2, y: 0, w: 1, h: 1, agentId: 'ping' },
     { id: 'bB', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'pong' }],
    [belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'),        // ping -> pong (top lane)
     belt(5, 2, 'W'), belt(4, 2, 'W'), belt(3, 2, 'W'),        // pong -> ping (return lane, y=2)
     belt(6, 1, 'S'), belt(6, 2, 'W'), belt(2, 2, 'N'), belt(2, 1, 'N')]
  ));
  A.eq(P.compileRoutingPlan(geo([], [belt(3, 0, 'E')])).errors.length, 0, 'sanity: a lone belt compiles clean');
  A.ok(!plan.errors.some(e => e.code === 'CYCLE'), 'there is NO physical belt cycle — detectCycle is blind to this');
  A.ok(plan.errors.some(e => e.code === 'CHAIN_CYCLE'), 'a bay->bay loop is caught by CHAIN_CYCLE');
  A.ok(!P.ok(plan), 'a chain loop is a BLOCKING error — it is an infinite chain of PAID runs');
}

/* ---- a FILTER downstream of a dock branches on the OUTPUT's tag ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'bA', t: 'bay', x: 0, y: 2, w: 1, h: 1, agentId: 'triage' },
     { id: 'f', t: 'filter', x: 3, y: 2, w: 1, h: 1, routes: { code: 'N' }, def: 'S' },
     { id: 'bC', t: 'bay', x: 5, y: 0, w: 1, h: 1, agentId: 'coder' },
     { id: 'bD', t: 'bay', x: 5, y: 4, w: 1, h: 1, agentId: 'writer' }],
    [belt(1, 2, 'E'), belt(2, 2, 'E'), belt(3, 2, 'E'),
     belt(3, 1, 'E'), belt(4, 1, 'E'),          // N lane -> coder
     belt(3, 3, 'E'), belt(4, 3, 'E')]          // S lane -> writer
  ));
  A.eq(plan.chains.triage.next, ['coder', 'writer'], 'both branches are reachable from the triage dock');
  A.eq(P.chainNext(plan, 'triage', onLine(plan, 'triage', { tag: 'code' })), 'coder', "a 'code' result takes the routed lane");
  A.eq(P.chainNext(plan, 'triage', onLine(plan, 'triage', { tag: 'prose' })), 'writer', 'anything else takes the default lane');
}

/* ---- a SPLIT downstream of a dock round-robins: ONE output crate is ONE downstream run, never a fan-out ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'bA', t: 'bay', x: 0, y: 2, w: 1, h: 1, agentId: 'lead' },
     { id: 's', t: 'splitter', x: 3, y: 2, w: 1, h: 1 },
     { id: 'bC', t: 'bay', x: 5, y: 1, w: 1, h: 1, agentId: 'w1' },
     { id: 'bD', t: 'bay', x: 5, y: 3, w: 1, h: 1, agentId: 'w2' }],
    [belt(1, 2, 'E'), belt(2, 2, 'E'), belt(3, 2, 'E'),
     belt(3, 1, 'E'), belt(4, 1, 'E'),
     belt(3, 3, 'E'), belt(4, 3, 'E')]
  ));
  A.eq(plan.chains.lead.next, ['w1', 'w2'], 'both lanes are reachable');
  let n = 0; const pick = (k, len) => (n++ % len);
  // lane 0 is 'S' (LANE_ORDER = E,S,W,N — the same fixed order resolveTarget and the engine use)
  A.eq(P.chainNext(plan, 'lead', onLine(plan, 'lead'), pick), 'w2', 'first handoff takes lane 0');
  A.eq(P.chainNext(plan, 'lead', onLine(plan, 'lead'), pick), 'w1', 'the next handoff spreads to lane 1');
  A.eq(P.chainNext(plan, 'lead', onLine(plan, 'lead'), pick), 'w2', 'and it round-robins back — one crate, one downstream run');
}

/* ---- a HANDOFF lane renders ENERGIZED: it carries real crates and buys real runs ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'bA', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'researcher' },
     { id: 'bB', t: 'bay', x: 8, y: 0, w: 1, h: 1, agentId: 'writer' },
     { id: 'stub', t: 'bay', x: 4, y: 5, w: 1, h: 1, agentId: 'idler' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'),
     belt(5, 0, 'E'), belt(6, 0, 'E'), belt(7, 0, 'E'),        // the researcher -> writer HANDOFF lane
     belt(4, 6, 'E'), belt(5, 6, 'E')]                          // a stub off the idler's dock, reaching nothing
  ));
  const live = P.liveTiles(plan);
  A.ok(live['2,0'], 'the intake feed lane is live');
  A.ok(live['6,0'], 'the dock->dock handoff lane is LIVE (it was cold before the chain layer)');
  A.ok(!live['5,6'], 'a stub that reaches no other dock stays COLD');
}

/* ---- a beltless dock and a lone dock have no chain (they are complete builds, not broken ones) ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'bA', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'solo' },
     { id: 'bB', t: 'bay', x: 9, y: 9, w: 1, h: 1, agentId: 'hermit' }],
    [belt(1, 0, 'E'), belt(2, 0, 'E')]
  ));
  A.eq(P.chainNext(plan, 'solo', onLine(plan, 'solo')), null, 'a dock at the end of the line hands off to nobody');
  A.eq(plan.chains.hermit, undefined, 'a beltless dock has no chain record at all');
  A.eq(P.chainNext(plan, 'hermit', onLine(plan, 'hermit')), null, 'and chainNext answers null for it');
  A.ok(P.ok(plan), 'neither is a deploy blocker');
}

/* ---- BELT_BURIED: a blocking prop over a belt run warns; machines and flat decor never do ---- */
{
  const plan = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'coder' },
     { id: 'crate', t: 'crate_stack', x: 3, y: 0, w: 1, h: 1, block: true },    // solid, ON the run
     { id: 'rug', t: 'rug', x: 4, y: 0, w: 1, h: 1, block: false },             // flat decor on the run
     { id: 'desk', t: 'desk', x: 3, y: 5, w: 2, h: 1, block: true }],           // solid, nowhere near a belt
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E')]
  ));
  const buried = plan.errors.filter(e => e.code === 'BELT_BURIED');
  A.eq(buried.length, 1, 'exactly ONE buried finding — the solid prop on the run');
  A.ok(buried[0].propId === 'crate' && buried[0].warn, '…naming the prop, as a warn');
  A.ok(buried[0].tile && buried[0].tile.x === 3 && buried[0].tile.y === 0, '…anchored on the covered belt tile');
  A.ok(P.ok(plan), 'a buried line still deploys (transport conserves crates; the floor just looks wrong)');
  // machines sitting on the line are the LINE, not a burial; props without a block field never trip it
  const clean = P.compileRoutingPlan(geo(
    [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
     { id: 'f1', t: 'filter', x: 2, y: 0, w: 1, h: 1 },
     { id: 'b1', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'coder' },
     { id: 'legacy', t: 'plant', x: 4, y: 0, w: 1, h: 1 }],                     // no block field (older geo)
    [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E')]
  ));
  A.ok(!clean.errors.some(e => e.code === 'BELT_BURIED'), 'junctions on the line and block-less legacy props never read as buried');
}

/* ---- PROMPT TEXT MAY NOT MOVE THE DISPATCH HASH (2026-08-07) ----
   `bays` is a hash input and the hash is what the sidecar dedupes re-posts on; router.setPlan resets the
   splitter round-robin whenever the topology changes. Carrying a dock's standing BRIEF on the hashed record
   meant typing one word into a step editor moved plan.hash, forced a re-post, and wiped dispatch balance —
   an edit to what an agent is TOLD perturbing which agent work is SENT to. The brief must still reach the
   sidecar (router.stageBrief injects it into entry runs and handoffs), so it rides `dockBays` instead. */
{
  const props = brief => [
    { id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
    { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'coder', brief: brief },
    { id: 'o1', t: 'outbox', x: 7, y: 0, w: 1, h: 1 }
  ];
  const belts = [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E')];
  const bare = P.compileRoutingPlan(geo(props(undefined), belts));
  const withBrief = P.compileRoutingPlan(geo(props('Answer in press style, three sentences.'), belts));
  const edited = P.compileRoutingPlan(geo(props('Answer in press style, five sentences, cite sources.'), belts));
  A.eq(withBrief.hash, bare.hash, 'ADDING a job brief does not move plan.hash — prompt text is not dispatch topology');
  A.eq(edited.hash, bare.hash, 'and EDITING it does not either');
  A.ok(bare.bays.every(b => b.brief === undefined), 'no brief on the HASHED dispatch records');
  A.ok(withBrief.bays.every(b => b.brief === undefined), '…not even when the dock has one');
  A.eq(withBrief.dockBays.find(d => d.propId === 'b1').brief, 'Answer in press style, three sentences.',
    'the brief still reaches the sidecar on dockBays (outside the hash) — legibility, never routing');
  A.eq(edited.dockBays.find(d => d.propId === 'b1').brief, 'Answer in press style, five sentences, cite sources.',
    '…and an edit is really carried, it is not being dropped to keep the hash still');
  // and the sidecar's reader finds it there
  const { makeRouter } = require('../sidecar/routing/router.js');
  const r = makeRouter();
  A.ok(r.setPlan(withBrief).ok, 'the briefed floor deploys');
  A.eq(r.stageBrief('coder'), 'Answer in press style, three sentences.', 'router.stageBrief reads the brief off dockBays');
  // a real topology edit STILL moves the hash — the point is precision, not deafness
  const moved = P.compileRoutingPlan(geo(props('Answer in press style, three sentences.'), belts.concat([belt(7, 1, 'E')])));
  A.ok(moved.hash !== bare.hash, 'laying a belt DOES move the hash — only prompt text is excluded');
}

/* ---- LINE IDENTITY SURVIVES THE TENTH PROP (2026-08-07 conveyor audit) ----
   A line's key is its OLDEST member prop id, and prop ids are minted 'p1','p2',… from a monotonic
   counter. `props.sort()` — the JS default — sorts them as STRINGS, where 'p10' < 'p9'. So the moment a
   line grew past nine props the key jumped to the newest one and the whole line was renamed underneath
   the running system: work already in flight carried the old lineId, failed Pipeline.chainNext's gate and
   stopped after stage one, and every localStorage latch keyed on the lineId (first ride, the
   finish-the-line registry) silently re-keyed. The line here is deliberately built so the string order and
   the creation order disagree. */
{
  const props = [
    { id: 'p3', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
    { id: 'p5', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'coder' },
    { id: 'p7', t: 'filter', x: 2, y: 0, w: 1, h: 1 },
    { id: 'p9', t: 'outbox', x: 6, y: 0, w: 1, h: 1 },
  ];
  const belts = [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E')];
  const before = P.lineComponents(geo(props, belts));
  A.eq(before.length, 1, 'the four machines form ONE line');
  A.eq(before[0].key, 'p3', 'keyed by its oldest prop');

  // the tenth prop joins the SAME line — this is the exact edit the string sort broke
  const after = P.lineComponents(geo(props.concat([{ id: 'p10', t: 'bay', x: 4, y: 2, w: 1, h: 1, agentId: 'writer' }]),
                                     belts.concat([belt(4, 1, 'S')])));
  A.eq(after.length, 1, 'p10 joins the same line');
  A.eq(after[0].key, 'p3', "…and the line KEEPS its identity ('p10' must not out-sort 'p3')");
  A.eq(after[0].props.indexOf('p9') < after[0].props.indexOf('p10'), true, 'members are in creation order, p9 before p10');
  A.eq(after[0].bays[0].propId, 'p5', 'bays too — the oldest dock is first, not the string-smallest');

  // and the compiled plan agrees: lineOf is the same id before and after
  const planA = P.compileRoutingPlan(geo(props, belts));
  const planB = P.compileRoutingPlan(geo(props.concat([{ id: 'p10', t: 'bay', x: 4, y: 2, w: 1, h: 1, agentId: 'writer' }]),
                                         belts.concat([belt(4, 1, 'S')])));
  A.eq(P.lineOf(planA, 'coder'), 'p3', 'the compiled plan names the line p3');
  A.eq(P.lineOf(planB, 'coder'), 'p3', '…and still does once the tenth prop lands (work in flight keeps passing the gate)');
}

/* ---- the comparator itself: numeric on minted ids, total on anything else ---- */
{
  const cmp = P._internals.propIdCmp;
  A.eq(['p10', 'p9', 'p1'].slice().sort(cmp).join(','), 'p1,p9,p10', 'minted ids sort by number, not by string');
  A.eq(['p2', 'legacy', 'p10'].slice().sort(cmp).join(','), 'p2,p10,legacy', 'a non-p<N> id sorts after the minted ones, deterministically');
  A.eq(cmp('zeta', 'alpha') > 0, true, 'two foreign ids fall back to string order');
  A.eq(cmp('p4', 'p4'), 0, 'and the comparator is reflexive');
}

A.report('pipeline');
