/* test/crate-honesty.test.js — the floor must show something TRUE for a run that really happened.

   world.js is a browser IIFE over live canvas/bus globals (not node-loadable), so this asserts the law
   against the SOURCE, the same idiom kitout.test.js and refit-card-stack.test.js use.

   THE LAW (2026-08-07 conveyor audit). A finished, productive run draws exactly ONE crate:
     • if this dock hands off to another dock on its own line, the handoff crate the sidecar places IS
       its product — the dock must not ALSO ship its own, or the same work is drawn leaving twice;
     • but the handoff is decided by the sidecar, LATER, against a plan that may have been re-posted in
       between (a floor edit re-keys the line and the chain gate then refuses to advance). Nothing is
       placed, and the old code had already suppressed the dock's crate — so a run the Commander paid
       for left NO mark on the floor at all.
   Never both, and NEVER NEITHER. The suppression is therefore a WAIT that the real handoff cancels and
   that ships the dock's own crate if the handoff never comes.

   Two supporting facts this also pins, because getting either wrong silently re-breaks the law:
     • the crate's MASS is captured when the run ends, not when the timer fires — run.end drops
       runUsdRecon immediately, so a deferred read would weigh every deferred crate 0 (crate-mass
       honesty);
     • the run-id dedup happens BEFORE the wait is armed — agent.run.end is observed twice (local
       harness + SSE echo) and two waits would ship two crates. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const world = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'world.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

const ship = world.slice(world.indexOf('function shipProductCrate(p)'), world.indexOf('function enqueueSlag'));
A.ok(ship.length > 200 && ship.length < 4000, 'shipProductCrate was located');
const shipCode = strip(ship);

/* ---- the suppression is a WAIT, not a drop ---- */
A.ok(/deferredShip\.set\(/.test(shipCode), 'a suppressed crate is HELD, not dropped');
A.ok(/setTimeout\(/.test(shipCode), '…on a timer');
A.ok(/emitProductCrate\(cAid, spec(, runDock)?\)/.test(shipCode), '…that ships the dock’s own crate when it expires');
// the branch must not simply `return` without arming something
const branch = shipCode.slice(shipCode.indexOf('dockLineTake(cAid)'), shipCode.indexOf('dockLineTake(cAid)') + 500);
A.ok(/deferredShip\.set/.test(branch), 'the line-work branch arms the wait before it returns');
/* ---- OVERLAP SAFETY (2026-08-11 audit #5): one dock, several runs in flight ---- */
// arming a NEW wait must never cancel a sibling run's held crate — the old single-timer slot did
A.ok(!/cancelDeferredShip\(cAid\)/.test(shipCode), 'arming a wait never cancels a sibling wait (K waits in, K crates out)');
A.ok(/deferredShip\.get\(cAid\) \|\| \[\]/.test(shipCode), 'waits queue per dock instead of overwriting one slot');
// the line-identity latch is consumed per run (FIFO), not read-and-kept — a stale latch must not
// re-answer for a later, unrelated run
A.ok(/function dockLineTake\(/.test(world), 'line identity is TAKEN per ended run, oldest first');
A.ok(/q\.shift\(\)/.test(strip(world.slice(world.indexOf('function dockLineTake('), world.indexOf('function dockLineTake(') + 300))),
  '…consuming the oldest placement');
// proven work is tallied PER RUN (runId), so overlapping runs at one dock cannot wipe each other
A.ok(/const runWork = new Map\(\);\s*\/\/ runId/.test(world) || /runId \(or agentId when the event has none\)/.test(world),
  'runWork is keyed per run, not per agent');
A.ok(/runWorked\(p\)\) shipProductCrate\(p\)/.test(strip(world)), 'the ship gate reads the ENDING run’s own tally');
// and the un-suppressed path still ships immediately
A.ok(shipCode.trim().endsWith('emitProductCrate(cAid, spec);\n  }') || /emitProductCrate\(cAid, spec(, runDock)?\);\s*\}\s*$/.test(shipCode),
  'a dock with no downstream handoff ships its crate immediately');

/* ---- the real handoff CANCELS the wait (never both crates) ---- */
A.ok(/function cancelDeferredShip\(/.test(world), 'there is a cancel path');
A.ok(/if \(p\.kind === 'chain' && p\.from\) cancelDeferredShip\(String\(p\.from\)\);/.test(world),
  'a chain work-item cancels the wait held by the dock that PRODUCED it');
/* The cancel must run before EVERY early return in intakeMessage. Cancelling is bookkeeping about a run
   that already happened; it must not depend on this floor currently having a conveyor to draw on, or on a
   compiled plan being present. It shipped behind `if (!convey) return;` — this is what caught that. */
const intake = strip(world.slice(world.indexOf('function intakeMessage(payload)'),
                                world.indexOf('function intakeMessage(payload)') + 4000));
const iCancel = intake.indexOf('cancelDeferredShip');
A.ok(iCancel > 0, 'intakeMessage cancels the wait');
A.ok(iCancel < intake.indexOf('if (!convey) return;'), '…before the no-conveyor early return');
A.ok(iCancel < intake.indexOf("p.kind === 'chain' && routingPlan"), '…and before the branch that needs a compiled plan');

/* ---- mass is read at run.end, not when the timer fires ---- */
A.ok(/function productCrateSpec\(p\)[\s\S]{0,400}?runUsdRecon\.get\(/.test(world),
  'the crate spec reads the reconciled cost');
A.ok(shipCode.indexOf('productCrateSpec(p)') < shipCode.indexOf('deferredShip.set'),
  'the spec (and its mass) is captured BEFORE the wait is armed — run.end drops runUsdRecon right after');
A.ok(!/setTimeout\([^)]*productCrateSpec/.test(shipCode), 'and the timer never re-reads it');

/* ---- dedup precedes the wait, so an SSE echo cannot arm two ---- */
A.ok(shipCode.indexOf('shippedRunIds.add(rid)') < shipCode.indexOf('deferredShip.set'),
  'the run-id dedup runs before the wait is armed (run.end is observed twice)');

/* ---- a wait never survives the floor it belongs to ---- */
A.ok(/function clearDeferredShips\(/.test(world), 'pending waits can be cleared wholesale');
const load = world.slice(world.indexOf('function loadStation(st)'), world.indexOf('function loadStation(st)') + 900);
A.ok(/clearDeferredShips\(\);/.test(load), 'loading a different station clears them — a crate must not land on the wrong floor');
A.ok(/dockLineWork\.clear\(\);/.test(load), '…and the per-dock line-work memory is cleared with it');

A.report('crate-honesty');
