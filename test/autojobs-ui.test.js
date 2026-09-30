/* node test/autojobs-ui.test.js — source-lock for the SELF-INITIATION entry point in the ROUTINES panel
   (stationui.js). stationui.js is browser-flow (DOM/terminal panels), not node-loadable, so — like
   autonomy-ui.test.js / newhero-reset.test.js — we lock the invariant by reading the source: the ROUTINES panel
   must expose a "propose standing jobs" control that routes through AutoJobStore.propose() and refreshes the list,
   so the manual entry point can never silently disappear or drift off the store API. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/routines.js'), 'utf8');   // ROUTINES window extracted from stationui.js (BUILDERS split)
const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const { AutoJobStore } = require('../frontend/app/autojobstore.js');

// the button exists in the ROUTINES panel.
A.ok(/id="rt-propose"/.test(src), 'the ROUTINES panel has a propose-standing-jobs button (#rt-propose)');
// it routes through the store's propose() (not some ad-hoc path).
A.ok(/AutoJobStore\.propose\(/.test(src), 'the button calls AutoJobStore.propose()');
// it is guarded so a missing store degrades, never throws.
A.ok(/typeof AutoJobStore\s*[!=]==\s*'undefined'/.test(src), 'the handler guards on AutoJobStore being present');
// after scheduling it refreshes the routines list so new jobs appear inline.
A.ok(/AutoJobStore\.propose\([\s\S]{0,200}refresh\(\)/.test(src), 'after proposing it refreshes the routines list');

// E-STOP preserves enabled intent while freezing the global scheduler. Every browser consumer must use BOTH
// facts or it promises work over a durable stop.
A.ok(/schedulerArmed\s*=\s*!!\(j\s*&&\s*j\.enabled\s*&&\s*!j\.halted\)/.test(src),
  'the ROUTINES panel derives runnable scheduler state from enabled and not halted');
A.ok(/const next\s*=\s*on\s*&&\s*schedulerArmed\s*&&\s*j\.nextRunAt\s*\?/.test(src),
  'routine rows show a countdown only while the scheduler is actually runnable');
A.eq(AutoJobStore._cronRunnable({ enabled: true, halted: true }), false,
  'self-initiation confirmations treat E-STOP as not runnable');
A.eq(AutoJobStore._cronRunnable({ enabled: true, halted: false }), true,
  'self-initiation confirmations recognize a genuinely armed scheduler');
A.ok(/j\s*&&\s*j\.halted\s*\?\s*'stopped \(E-STOP\)'/.test(chatSrc),
  '/cron names the durable E-STOP instead of reporting scheduler on');

/* ROUTINE ROW FEEDBACK (stranded-user sweep, 2026-08-22): a row must survive a job without `skills`
   (an unguarded `j.skills.length` threw and the catch painted "sidecar offline"), must say it runs the
   WHOLE line when the record carries runsLine, and must show the line's recorded spend (lastUsd). */
A.ok((src.match(/j\.skills\.length/g) || []).length === 1 && /Array\.isArray\(j\.skills\) \? j\.skills\.length/.test(src), 'routine row only reads j.skills.length behind the Array.isArray guard');
A.ok(/Array\.isArray\(j\.skills\)/.test(src), 'routine row guards the skills array');
A.ok(/runs the <b>/.test(src) && /j\.runsLine !== true\) return 'runs as '/.test(src), "a runsLine routine says it runs the line; others keep 'runs as'");
A.ok(/Build\.lineOfAgentInfo/.test(src), 'the line name/dock count come from the compiled plan (Build.lineOfAgentInfo), never guessed');
A.ok(/Number\(j\.lastUsd\)/.test(src) && /mc-spend/.test(src), 'the row shows the recorded spend (lastUsd)');

// the delivery-backlog ceiling is the SERVER's (GET /api/cron .maxPendingDeliveries), never a hardcoded copy; the
// EDIT TASK textarea is capped and the save refuses a request over the update route's 64 KB body limit
A.ok(/maxPendingDeliveries = (j && Number(j.maxPendingDeliveries)) || 0;/.test(src) && !/pending.length >= 100/.test(src), 'deliveryLine quotes the server backlog ceiling (no hardcoded 100)');
A.ok(/data-edit-prompt rows="5" maxlength="' \+ EDIT_PROMPT_MAX \+ '"/.test(src) && /EDIT_BODY_MAX = 1 << 16/.test(src), 'EDIT TASK is capped under the 64 KB update body');
const idx = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
A.ok(/maxPendingDeliveries: cronStore.MAX_PENDING_DELIVERIES/.test(idx), 'GET /api/cron exposes the backlog ceiling');
A.report('autojobs-ui.test');
