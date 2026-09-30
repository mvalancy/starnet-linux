/* test/toolprops.test.js — the PURE tool->prop mapper (frontend/app/toolprops.js).
   Asserted against the REAL grant names in sidecar/capability/registry.js (CAP_REGISTRY), so a
   renamed/added tool that the floor would silently stop pulsing for fails HERE, not in a demo. */
'use strict';
const A = require('./_assert.js');
const ToolProps = require('../frontend/app/toolprops.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

const map = ToolProps.toolPropType;

/* ---- every REAL registry grant maps to exactly the prop its objectType implies ---- */
// objectType -> the prop type its tools must light (null = deliberately no cap-prop pulse:
// computer=the compute gate, workbench=dedicated shell/verify events, orchestrator=handoff boxes).
const EXPECT = {
  computer: null, notebook: 'notebook', cabinet: 'cabinet', dish: 'dish',
  connector: null, workbench: null, orchestrator: null, studio: 'studio', jukebox: 'jukebox'
};
for (const [objectType, grants] of Object.entries(CAP_REGISTRY)) {
  A.ok(objectType in EXPECT, 'registry objectType "' + objectType + '" has an expected mapping (update toolprops when the registry grows)');
  for (const g of grants) {
    A.eq(map(g.tool), EXPECT[objectType], g.tool + ' -> ' + EXPECT[objectType]);
  }
}

/* ---- family prefixes hold beyond the exact registry rows (future tools in a family) ---- */
A.eq(map('fs.read'), 'cabinet', 'fs.read -> cabinet');
A.eq(map('browser.navigate'), 'dish', 'browser.navigate -> dish');
A.eq(map('web_search'), 'dish', 'web_search -> dish');
A.eq(map('web_fetch'), 'dish', 'web_fetch -> dish');
A.eq(map('notebook.write'), 'notebook', 'notebook.write -> notebook');
A.eq(map('skill.view'), 'notebook', 'skill.view -> notebook');
A.eq(map('recall_conversation'), 'notebook', 'recall_conversation -> notebook');
A.eq(map('todo'), null, 'todo rides the computer (taskplan freebie, 2026-08-17) — no cap-prop pulse, same rule as quest.update');
A.eq(map('image_generate'), 'studio', 'image_generate -> studio');
A.eq(map('resolve_timeline_file'), 'studio', 'resolve_timeline_file -> studio');
A.eq(map('resolve_control'), 'studio', 'resolve_control -> studio');
A.eq(map('spotify_play'), 'jukebox', 'spotify_play -> jukebox');

/* ---- the no-double-fire law: tools with their OWN floor visual return null ---- */
A.eq(map('mcp__github__search_issues'), null, 'mcp__ tools stay with the connector portal pulse');
A.eq(map('shell.exec'), null, 'shell.exec stays with the workbench pulse');
A.eq(map('shell.bg.status'), null, 'shell.bg.* stays with the workbench');
A.eq(map('verify.run'), null, 'verify.run stays with the workbench pulse');
A.eq(map('browser.test_input'), null, 'browser.test_* stays with the workbench pulse');
A.eq(map('computer.use'), null, 'legacy computer.use has no floor prop pulse');
A.eq(map('team.dispatch'), null, 'team.* stays with the handoff boxes');
A.eq(map('routine.create'), null, 'routine.* has no cap-prop pulse');
A.eq(map('model.chat'), null, 'model.chat is the compute gate, not a prop tool');

/* ---- junk in, null out (pure + total) ---- */
A.eq(map(''), null, 'empty string -> null');
A.eq(map(null), null, 'null -> null');
A.eq(map(undefined), null, 'undefined -> null');
A.eq(map(42), null, 'non-string -> null');
A.eq(map('websearch'), null, 'near-miss name does not false-positive');
A.eq(map('fsread'), null, 'prefix requires the dot');

A.report('toolprops');
