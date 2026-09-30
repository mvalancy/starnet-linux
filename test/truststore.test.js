/* node test/truststore.test.js — the live wiring around the pure earned-autonomy engine
   (frontend/app/truststore.js), Growth Tier 3. The REAL Trust engine is wired in (integration, like
   autonomystore.test.js). Locks:
     - init subscribes read-only to the same feed xpstore folds (agent.run.end + memory.feedback), hero-only
     - currentOffer: thresholds via the live xp/posture reads; ceilings (never reach, GRANTABLE-only grants)
     - accept → AutonomyStore-style setInitiative applied WITH provenance + the manual floor recorded
     - decline / ignore-2× negative state per level band (persisted; a new band re-opens)
     - demotion: applied on the SAME event feed, earned-only, one rung, never below the manual floor, an
       explicit notice fired (never silent); stepping back to the floor clears the earned record
     - the dial read surface (earnedInitiative / onManualInitiative: user override retires the record)
     - beat priority with all FOUR participants through the REAL Study.makeBeatSlot (memory > study > arc > trust)
     - persistence round-trip, FIFO caps (the engine window), new-hero reset, corrupt-key hydrate, never emits */
'use strict';
const A = require('./_assert.js');

global.Trust = require('../frontend/app/trust.js');   // the real pure engine (we want the integration)
const Study = require('../frontend/app/study.js');    // the real beat-slot arbiter for the 4-participant test

const mem = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
const KEY = 'starnet.trust.v1';

const bus = A.makeBus();
let emitted = 0;
global.U = { bus: { on: bus.on.bind(bus), emit: (n, p) => { emitted++; bus.emit(n, p); } } };

const { TrustStore } = require('../frontend/app/truststore.js');

/* ---------- a controllable world: xp stats, posture, the dial writer, grants, notices ---------- */
let xp = { level: 1, confidence: 0, samples: 0, tasksDone: 0 };
let initiative = 'wait';
const setInitiativeCalls = [];
let grants = [];
const grantCalls = [];
const notices = [];

function initStore() {
  TrustStore.init({
    now: () => 424242,
    getStats: () => xp,
    getPosture: () => ({ initiative: initiative, reach: 'sandbox' }),
    setInitiative: (lvl) => { setInitiativeCalls.push(lvl); initiative = lvl; },
    grantable: ['cabinet:write'],
    getGrants: () => grants.slice(),
    grant: (key) => { grantCalls.push(key); grants.push(key); return true; },
    notify: (text, kind) => notices.push({ text, kind })
  });
}
initStore();

const fb = (reason) => bus.emit('memory.feedback', { agentId: 'agent', reason, delta: 2 });
const runEnd = (reason, agentId) => bus.emit('agent.run.end', { agentId: agentId || 'agent', runId: 'r' + Math.random(), reason });

(async () => {   // the grant accept path is async (server-verified) — the whole suite runs in one async scope

/* ---------- 1. no track record → no offer; the un-calibrated meter never offers ---------- */
A.eq(TrustStore.currentOffer(), null, 'a fresh store offers nothing');
A.ok(TrustStore.canShow(), 'the session offer budget starts open');

/* ---------- 2. events fold; a worker's events are ignored (hero-only, like the beats) ---------- */
for (let i = 0; i < 5; i++) fb('kept');
A.eq(TrustStore._state().track.posStreak, 5, 'five positive feedbacks fold into a 5 streak');
bus.emit('memory.feedback', { agentId: 'researcher', reason: 'work_miss' });
A.eq(TrustStore._state().track.negStreak, 0, "a summoned worker's feedback never folds into the hero's track record");
runEnd('done', 'researcher');
A.eq(TrustStore._state().track.window.filter(x => !x.ok).length, 0, "…nor its runs");

/* ---------- 3. the offer fires at the thresholds and reads the LIVE posture ---------- */
xp = { level: 3, confidence: 74, samples: 6, tasksDone: 12 };
const offer1 = TrustStore.currentOffer();
A.eq([offer1.kind, offer1.to], ['initiative', 'propose'], 'thresholds met → the next-rung initiative offer, from the LIVE dial rung');
A.eq(offer1.provenance, { earnedAt: 424242, runs: 12, confidence: 74, streak: 5 }, 'the offer carries honest provenance (injected clock, real counters)');

/* ---------- 4. accept → applied through the injected dial writer, floor + provenance recorded ---------- */
A.ok(TrustStore.accept(offer1), 'accept applies');
A.eq(setInitiativeCalls, ['propose'], 'accept raised the dial THROUGH the injected setInitiative (the existing plumbing)');
A.eq(TrustStore._state().earned.initiative, { to: 'propose', floor: 'wait', provenance: offer1.provenance }, 'the earned record persists the rung, the manual FLOOR it was raised from, and provenance');
A.eq(TrustStore.earnedInitiative().to, 'propose', 'earnedInitiative reports the badge while the live rung matches');
A.ok(mem[KEY] && JSON.parse(mem[KEY]).earned.initiative.to === 'propose', 'the earned record persisted to the own key');

/* ---------- 5. climbing further keeps the ORIGINAL manual floor ---------- */
xp = { level: 4, confidence: 80, samples: 8, tasksDone: 20 };
const offer2 = TrustStore.currentOffer();
A.eq(offer2.to, 'leash', 'the next offer proposes the next rung up (propose → leash)');
A.ok(TrustStore.accept(offer2), 'the second accept applies');
A.eq(TrustStore._state().earned.initiative.floor, 'wait', 'a chained earn keeps the ORIGINAL manual floor (never moves the floor up to an earned rung)');

/* ---------- 6. the dial read surface: manual override retires the earned record ---------- */
A.eq(TrustStore.earnedInitiative().to, 'leash', 'the badge tracks the newly earned rung');
TrustStore.onManualInitiative('leash');
A.ok(TrustStore.earnedInitiative(), 'a manual set AT the earned rung keeps the record (nothing changed)');
TrustStore.onManualInitiative('free');   // the user grants beyond what was earned
A.eq(TrustStore._state().earned.initiative, undefined, 'a manual set ABOVE the earned rung retires the record — a user grant wears no badge');
A.eq(TrustStore.earnedInitiative(), null, '…and the badge is gone');

/* ---------- 7. demotion: earned-only, on the live feed, one rung, never below the floor, with a notice ---------- */
// re-earn: set the dial low, accept an offer so an earned rung is active again
initiative = 'propose';
xp = { level: 4, confidence: 80, samples: 8, tasksDone: 20 };
const offer3 = TrustStore.currentOffer();
A.eq(offer3.to, 'leash', 're-armed: a leash offer over a propose floor');
TrustStore.accept(offer3);
A.eq(initiative, 'leash', 'the dial sits at the earned leash rung');
notices.length = 0; setInitiativeCalls.length = 0;
fb('work_miss'); fb('work_miss');
A.eq(setInitiativeCalls, [], 'two rough runs do not demote (below the streak bar)');
fb('work_miss');
A.eq(setInitiativeCalls, ['propose'], 'the third consecutive miss demotes the earned rung one step — applied through the same dial writer');
A.eq(notices.length, 1, 'the demotion fired ONE explicit notice (never silent)');
A.ok(/rough runs|earn it back/.test(notices[0].text), 'the notice is the honest "stepping back — earn it back" line');
A.eq(TrustStore._state().earned.initiative, undefined, 'stepping back TO the manual floor clears the earned record');
fb('work_miss');
A.eq(setInitiativeCalls.length, 1, 'further misses with NO earned rung never touch the dial (the manual posture is untouchable)');
A.eq(initiative, 'propose', 'the dial never goes below the Commander\'s own floor');

/* ---------- 7b. REVIEW BLOCKER regression — a STALE earned record must never move the dial ----------
   Non-dial posture writers (settings-backup import, permissions-level preset) can move initiative without the
   dial's onManualInitiative retirement. A stale earned record must then RETIRE on the next demotion check —
   never demote "from" a rung the dial isn't at. Reproduces both directions of the blocker. */
// stale-HIGH: earn leash, posture then set DOWN to 'wait' by an import → 3 misses must NOT raise wait→propose.
for (let i = 0; i < 6; i++) fb('kept');
xp = { level: 4, confidence: 80, samples: 12, tasksDone: 20 };
initiative = 'propose';
const ofH = TrustStore.currentOffer();
A.eq(ofH && ofH.to, 'leash', 'stale-HIGH setup: a leash offer is live');
A.ok(TrustStore.accept(ofH), 'earned leash (floor propose); the dial sits at leash');
initiative = 'wait';                       // a settings-backup import rewrites the posture directly (no retirement hook)
setInitiativeCalls.length = 0; notices.length = 0;
fb('work_miss'); fb('work_miss'); fb('work_miss');
A.eq(setInitiativeCalls, [], 'stale-HIGH: the diverged record NEVER touches the dial — no silent escalation dressed as a step-back');
A.eq(initiative, 'wait', 'the imported posture stands untouched');
A.eq(TrustStore._state().earned.initiative, undefined, 'the stale record is retired (user override wins, recorded as such)');
A.eq(notices.length, 0, 'retirement is silent — no fake "stepping back" notice for a demotion that never happened');
// stale-LOW: earn leash, the user then raises the dial ABOVE it via a non-dial path → misses must not slash it.
for (let i = 0; i < 6; i++) fb('kept');
initiative = 'propose';
const ofL = TrustStore.currentOffer();
A.eq(ofL && ofL.to, 'leash', 'stale-LOW setup: a leash offer is live');
A.ok(TrustStore.accept(ofL), 'earned leash again');
initiative = 'free';                       // the user raised the dial through a path that skipped retirement
setInitiativeCalls.length = 0; notices.length = 0;
fb('work_miss'); fb('work_miss'); fb('work_miss');
A.eq(setInitiativeCalls, [], 'stale-LOW: a user-raised rung is never slashed by a stale earned record');
A.eq(initiative, 'free', 'the user\'s own rung stands');
A.eq(TrustStore._state().earned.initiative, undefined, 'the stale record is retired here too');

/* ---------- 7c. REVIEW NIT 5 — apply-FIRST: a throwing dial writer leaves the record + notice untouched ---------- */
for (let i = 0; i < 6; i++) fb('kept');
initiative = 'propose';
const ofT = TrustStore.currentOffer();
A.ok(TrustStore.accept(ofT), 'earned leash for the throwing-writer scenario');
TrustStore.init({   // same store state (re-hydrates from the key) but the dial writer now THROWS
  now: () => 424242, getStats: () => xp, getPosture: () => ({ initiative: initiative, reach: 'sandbox' }),
  setInitiative: () => { throw new Error('dial offline'); },
  grantable: ['cabinet:write'], getGrants: () => grants.slice(),
  grant: (key) => { grantCalls.push(key); grants.push(key); return true; },
  notify: (text, kind) => notices.push({ text, kind })
});
notices.length = 0;
fb('work_miss'); fb('work_miss'); fb('work_miss');
A.eq(TrustStore._state().earned.initiative.to, 'leash', 'a THROWING dial writer leaves the earned record untouched (apply-first, never a lying record)');
A.eq(notices.length, 0, '…and no demotion notice is claimed for a write that never landed');
A.eq(initiative, 'leash', 'the live dial rung is untouched by the failed write');
initStore();   // restore the standard deps; clear the leftover earned record via the dial's own retirement rule
TrustStore.onManualInitiative('propose'); initiative = 'propose';

/* ---------- 8. decline / ignore-2× negative state, per level band ---------- */
// rebuild a positive streak so offers can fire again
for (let i = 0; i < 6; i++) fb('kept');
xp = { level: 4, confidence: 80, samples: 12, tasksDone: 25 };
initiative = 'propose';
const offer4 = TrustStore.currentOffer();
A.eq(offer4.to, 'leash', 'a fresh offer is live again after the streak rebuilds');
TrustStore.decline(offer4);
A.eq(TrustStore.currentOffer(), null, 'a declined rung stops offering in this level band');
xp = Object.assign({}, xp, { level: 5 });
const offer5 = TrustStore.currentOffer();
A.eq(offer5 && offer5.to, 'leash', 'a NEW level band re-opens the declined rung (fresh mandate)');
// ignore-2×: two expiries in the same band exhaust the rung
TrustStore.ignore(offer5);
A.ok(TrustStore.currentOffer(), 'one ignore leaves the offer live (the second chance)');
TrustStore.ignore(offer5);
A.eq(TrustStore.currentOffer(), null, 'two ignores in the same band stop the rung (stop-forever per band)');
xp = Object.assign({}, xp, { level: 6 });
A.ok(TrustStore.currentOffer(), 'a new band resets the ignore tally');

/* ---------- 9. the GRANT offer path: applied through the injected grant plumbing ---------- */
initiative = 'free';   // initiative maxed → the grant path
xp = { level: 6, confidence: 88, samples: 12, tasksDone: 30 };
const gOffer = TrustStore.currentOffer();
A.eq([gOffer.kind, gOffer.to], ['grant', 'cabinet:write'], 'with initiative maxed + the grant bars met, the GRANTABLE pre-bless is offered');
A.ok(await TrustStore.accept(gOffer), 'the grant accept applies (awaited — the server grant is async)');
A.eq(grantCalls, ['cabinet:write'], 'accept blessed the capability THROUGH the injected grant (the existing permgrants plumbing, never a parallel path)');
A.ok(TrustStore.earnedGrant('cabinet:write'), 'the earned grant records provenance for the ledger');
A.eq(TrustStore.currentOffer(), null, 'a held grant is never re-offered');

/* ---------- 10. session cap: at most ONE trust offer shown per session ---------- */
A.ok(TrustStore.canShow(), 'budget open before any card renders');
TrustStore.markShown();
A.ok(!TrustStore.canShow(), 'SESSION_OFFER_CAP = 1: one shown card spends the session budget');
initStore();   // a new session (init) resets the in-memory cap
A.ok(TrustStore.canShow(), 'a new session re-opens the budget');

/* ---------- 11. FIFO caps: the rolling window through the store stays bounded ---------- */
for (let i = 0; i < Trust.WINDOW + 15; i++) runEnd('done');
A.eq(TrustStore._state().track.window.length, Trust.WINDOW, 'the folded window FIFO-caps at Trust.WINDOW through the live feed');

/* ---------- 12. persistence round-trip + corrupt-key hydrate ---------- */
initStore();   // re-hydrate from the key
A.ok(TrustStore._state().earned.grant && TrustStore._state().earned.grant['cabinet:write'], 'the earned-grant record survives a reload');
A.eq(TrustStore._state().ignores['initiative:leash'], { band: 5, n: 2 }, 'the band-scoped ignore tallies survive a reload (the {band,n} shape round-trips)');
A.ok(TrustStore._state().declined['initiative:leash'] >= 1, 'the declined bands survive a reload');
mem[KEY] = '{not valid json';
initStore();
A.eq(TrustStore._state().earned, {}, 'an unparseable key degrades to a clean record, never throws');
mem[KEY] = JSON.stringify({ track: { posStreak: 'x' }, earned: { initiative: { to: 'orbit', floor: 'wait' } }, declined: { 'initiative:leash': -2 }, ignores: { a: 'b' } });
initStore();
A.eq(TrustStore._state().earned.initiative, undefined, 'an out-of-enum earned rung is dropped on hydrate');
A.eq(TrustStore._state().declined, {}, 'malformed declined bands are dropped');
A.eq(TrustStore._state().ignores, {}, 'malformed ignore tallies are dropped');

/* ---------- 13. new-hero reset ---------- */
initStore();
for (let i = 0; i < 5; i++) fb('kept');
TrustStore.reset();
A.eq(mem[KEY], undefined, 'reset() removes the persisted key');
A.eq(TrustStore._state().track.posStreak, 0, 'a new hero starts with a clean track record');
A.eq(TrustStore._state().earned, {}, '…and no inherited earned rungs');

/* ---------- 13b. REVIEW FIX 2 — a FAILED server grant is never claimed as granted ----------
   PermissionsStore.grant swallows failures and always resolves, so accept must VERIFY the authoritative
   held-grants state actually carries the key before recording provenance or reporting success. */
grants = []; grantCalls.length = 0;
TrustStore.init({
  now: () => 424242,
  getStats: () => xp,
  getPosture: () => ({ initiative: initiative, reach: 'sandbox' }),
  setInitiative: (lvl) => { setInitiativeCalls.push(lvl); initiative = lvl; },
  grantable: ['cabinet:write'],
  getGrants: () => grants.slice(),
  grant: (key) => { grantCalls.push(key); return Promise.resolve({ ok: false }); },   // resolves, but the grant did NOT land
  notify: (text, kind) => notices.push({ text, kind })
});
for (let i = 0; i < 6; i++) fb('kept');
initiative = 'free';
xp = { level: 6, confidence: 88, samples: 12, tasksDone: 30 };
const gFail = TrustStore.currentOffer();
A.eq(gFail && gFail.kind, 'grant', 'the failing-grant scenario still mints the offer');
A.eq(await TrustStore.accept(gFail), false, 'accept resolves FALSE when the verified held-grants state lacks the key (no "✓ granted" lie)');
A.eq(grantCalls, ['cabinet:write'], 'the grant WAS attempted through the plumbing');
A.eq(TrustStore.earnedGrant('cabinet:write'), null, '…but NO earned-grant provenance is recorded on a failed grant');
// and a throwing grant dep also resolves false, never throws out
TrustStore.init({ now: () => 1, getStats: () => xp, getPosture: () => ({ initiative: 'free' }), grantable: ['cabinet:write'], getGrants: () => [], grant: () => { throw new Error('boom'); } });
A.eq(await TrustStore.accept({ kind: 'grant', to: 'cabinet:write', provenance: null }), false, 'a throwing grant dep resolves false (fail-open, never a crash)');

/* ---------- 14. THE ONE-BEAT DISCIPLINE — all FOUR participants (memory > study > arc > trust) ----------
   Behavioral state assertions through the REAL Study.makeBeatSlot: the trust offer is the LOWEST priority —
   it cedes to memory, study AND the arc, may only take a WHOLLY FREE slot, and never coexists with any beat.
   The T1/T2 surface is untouched: canStudy/canArc read a visible trust card as plain 'busy'. */
const slot = Study.makeBeatSlot();
// reflection in flight: everyone cedes to memory
slot.memoryProposed('run_1');
A.eq(slot.canStudy(), 'memory', 'reflection in flight → study cedes');
A.eq(slot.canArc(), 'memory', '…the arc cedes');
A.eq(slot.canTrust(), 'memory', '…and the trust offer cedes too (memory wins the moment)');
A.eq(slot.memoryDeck(), 'render', 'the memory deck renders');
A.eq(slot.canTrust(), 'busy', 'a visible memory deck blocks the trust offer (never two beats)');
slot.memoryDone('run_1', false);
// study takes the freed moment; trust cedes to the visible study card
A.eq(slot.canTrust(), 'free', 'the moment is free for trust when nothing else wants it');
slot.studyShown();
A.eq(slot.canTrust(), 'busy', 'a visible study card blocks the trust offer (study wins over trust)');
slot.studyDone(false);
// the arc takes the freed moment; trust cedes to the visible arc panel
slot.arcShown();
A.eq(slot.canTrust(), 'busy', 'a visible arc panel blocks the trust offer (arc wins over trust)');
slot.arcDone(false);
// only a WHOLLY FREE slot lets the trust card open — and while visible, nothing stacks on it
A.eq(slot.canTrust(), 'free', 'with memory + study + arc all resolved, the trust offer may take the moment');
slot.trustShown();
A.eq(slot.visibleBeat(), 'trust', 'the trust card is the one visible beat');
A.eq(slot.canStudy(), 'busy', 'a visible trust card blocks a study card (never two beats)');
A.eq(slot.canArc(), 'busy', '…and blocks the arc');
A.eq(slot.canTrust(), 'busy', '…and a second trust offer');
A.eq(slot.memoryDeck(), 'queue', 'a late memory deck QUEUES behind the visible trust card (never stacks)');
slot.trustDone(true);   // resolve WITH a deck queued → hand the slot straight over (the stranded-queue lesson)
A.eq(slot.visibleBeat(), 'memory', 'trustDone(true) hands the slot straight to the queued memory deck (no gap)');
slot.memoryShown(); slot.memoryDone('run_late', false);
A.eq(slot._pending(), 0, 'pendingMemory cleared — the claim cannot strand the lanes');
A.eq([slot.canStudy(), slot.canArc(), slot.canTrust()], ['free', 'free', 'free'], 'every lane is free after the drained deck resolves (no freeze)');
// and with NOTHING queued, trustDone(false) frees the slot outright
const slot2 = Study.makeBeatSlot();
slot2.trustShown(); slot2.trustDone(false);
A.eq(slot2.visibleBeat(), null, 'trustDone(false) frees the slot when nothing queued');

/* ---------- 15. read-only citizen: the store itself never emits on U.bus ---------- */
initStore();
emitted = 0;
xp = { level: 3, confidence: 74, samples: 6, tasksDone: 12 };
for (let i = 0; i < 5; i++) TrustStore._state().track = Trust.fold(TrustStore._state().track, { name: 'memory.feedback', payload: { reason: 'kept' } });
const o = TrustStore.currentOffer(); if (o) { TrustStore.accept(o); TrustStore.decline(o); TrustStore.ignore(o); }
TrustStore.reset();
A.eq(emitted, 0, 'TrustStore never emits on U.bus (read-only citizen; lint-emits stays green)');

// Initiative writes use the same acknowledgement rule as grants.
initiative = 'propose';
let finishWrite;
TrustStore.init({ getPosture: () => ({ initiative }), setInitiative: () => new Promise(r => { finishWrite = r; }) });
TrustStore.reset();
const acceptance = TrustStore.accept({ kind: 'initiative', to: 'leash' });
A.eq(TrustStore._state().earned.initiative, undefined, 'pending initiative has no earned provenance');
finishWrite({ ok: false });
A.eq(await acceptance, false, 'failed asynchronous initiative is not accepted');
A.eq(TrustStore._state().earned.initiative, undefined, 'failed initiative leaves no provenance');
const accepted = TrustStore.accept({ kind: 'initiative', to: 'leash' });
initiative = 'leash'; finishWrite({ ok: true });
A.eq(await accepted, true, 'confirmed asynchronous initiative is accepted');
A.eq(TrustStore._state().earned.initiative.to, 'leash', 'only confirmed initiative records provenance');

A.report('truststore.test');

})().catch(e => { console.log('FAIL: uncaught — ' + (e && e.stack || e)); process.exit(1); });
