/* node test/newhero-reset.test.js — source-level lock for the new-hero clean slate (Slice 8 #8).

   The whole-build sweep found the new-hero (onWake) path reset only Pitch/Suggest/Seed and silently OMITTED
   CuriosityStore + MintStore, so a second Commander inherited the prior one's waved-off dimensions and recurring-
   task shapes — the latter feeds the seed shelf, so a brand-new agent could offer to author a stranger's chore
   ("you keep asking me to …"), a direct app-lie. Every per-agent advice store MUST be reset on commission.

   app.js is browser-flow (an IIFE over the DOM / sidecar), not node-loadable, so — like beat-coordination.test.js
   / onboarding.test.js — we lock the invariant by reading the source: the onWake new-hero block must call reset()
   on ALL five self-persisting advice stores. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const i = src.indexOf('async function onWake');
A.ok(i >= 0, 'app.js has an onWake (new-hero commission) path');

// the reset block lives at the head of onWake, before the new agent enters the game.
const enter = src.indexOf('enterGame(', i);
A.ok(enter > i, 'onWake reaches enterGame() (the new-hero path)');
const seg = src.slice(i, enter);

for (const store of ['PitchStore', 'SuggestStore', 'SeedStore', 'CuriosityStore', 'MintStore', 'AutonomyStore', 'AutoJobStore', 'AutopilotStore', 'PermissionsStore', 'QuestStateStore', 'ReturnStore', 'PrideStore', 'ConfBeats', 'StationQuestStore']) {
  A.ok(new RegExp('\\b' + store + '\\.reset\\(\\)').test(seg),
    'new-hero onWake resets ' + store + ' — no prior-Commander state bleeds into a fresh agent');
}

// Permission lockdown is an authority gate, not one more best-effort cache reset. It must finish before the
// new hero assignment (the commit point); otherwise a failed durable revoke leaves a half-reset station and
// lets the fresh Commander inherit the previous station's cabinet:write grant.
const permissionsReset = seg.indexOf('await PermissionsStore.reset()');
const heroCommit = seg.indexOf("agent = { id: 'agent'");
const autonomyReset = seg.indexOf('await AutonomyStore.reset()');
A.ok(autonomyReset >= 0 && autonomyReset < heroCommit, 'new hero waits for durable autonomy reset before committing');
A.ok(/if \(!autonomyReset.ok\)/.test(seg), 'failed autonomy reset blocks commissioning');
A.ok(permissionsReset >= 0 && heroCommit >= 0 && permissionsReset < heroCommit,
  'new-hero permission lockdown completes before the hero/state commit point');
const savedResume = seg.indexOf('if (resumingSaved)');
A.ok(savedResume >= 0 && savedResume < permissionsReset,
  'saved-station resume returns before new-hero lockdown and keeps its existing grants');
const journeyReset = seg.indexOf('await JourneyStore.reset(newCommanderEpoch)');
A.ok(journeyReset >= 0 && journeyReset < heroCommit,
  'new-hero journey reset is acknowledged before the hero/state commit point');
A.ok(/if \(!journeyResetResult \|\| !journeyResetResult\.ok\)/.test(seg),
  'a failed durable journey reset blocks commissioning instead of inheriting the prior Commander');
A.ok(seg.indexOf('createdAt: newCommanderEpoch') > journeyReset,
  'the committed hero uses the exact generation accepted by the journey reset');

// SERVER-SIDE bleed: the frontend stores above are localStorage; the notebook + the NEW declined denylist live on
// the sidecar. onWake must ALSO wipe them, or a fresh hero inherits a stranger's kept/declined memories (app-lie).
A.ok(/Harness\.memoryReset\(/.test(seg),
  'new-hero onWake wipes SERVER-SIDE memory (notebook/declined/todo) so no prior-Commander memory bleeds into a fresh agent');

A.report('newhero-reset.test');
