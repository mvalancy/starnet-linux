/* test/agent-skin-thumbs.test.js — Andrew (2026-09-24): "Agents need to be shown by their skin not a letter."
   The Workflow surfaces (Who works here?, the strip, trigger rows, the step-test log) and the crate card show an
   agent by its SKIN through ONE shared path, AgentPortraits.thumbHTML — the dossier portrait's native-resolution
   pipeline (renderBody), fitted at thumb size without ever blowing pixel art up with smoothing. Held here:
     · the fit law (pure): an integer NN factor when it fills the box, a sharp NN-prescale + smooth DOWNSCALE when
       it would not, a smooth downscale when the box is smaller than the art — never a fractional upscale;
     · the dossier portrait and the thumbs share renderBody (no second copy of the pipeline);
     · no letter avatar survives in the Workflow panel; the RECRUIT card keeps its "+";
     · the crate card's skin shows only once a run is PROVEN (runBy), never for a merely queued crate. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const rd = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', f), 'utf8');
const AP = require('../frontend/app/agentportraits.js');
const LW = require('../frontend/app/linewatch.js');

// ---- the fit law ----
let p = AP.fitPlan(30, 43, 64, 80);            // t = 1.49 → ×1 fills 67% → sharp: NN ×2 then smooth down
A.eq(p.mode, 'sharp', 'a poor integer fill takes the sharp path');
A.eq(p.pre, 2, 'the prescale is the next WHOLE factor');
A.ok(p.dh <= 80 && p.dw <= 64 && p.dh >= 78, 'the sharp path fills the box without overflowing');
p = AP.fitPlan(30, 43, 64, 90);                // t = 2.09 → ×2 fills 96% → pure NN
A.eq(p.mode, 'nn', 'a good integer fill is pure nearest-neighbour');
A.eq([p.pre, p.dw, p.dh], [2, 60, 86], 'integer factor, exact multiples');
p = AP.fitPlan(30, 43, 30, 38);                // t < 1 → the floor's law: smooth downscale
A.eq(p.mode, 'smooth', 'a box smaller than the art is a smooth downscale, never an NN crush');
A.eq(p.pre, 1, 'no prescale on a downscale');
A.ok(p.dh <= 38 && p.dw <= 30, 'the downscale fits');
p = AP.fitPlan(30, 43, 30, 43);
A.eq([p.mode, p.pre, p.dw, p.dh], ['nn', 1, 30, 43], 'an exact fit is 1:1');
for (const [sw, sh, W, H] of [[28, 39, 32, 38], [43, 46, 60, 76], [31, 44, 90, 120], [20, 40, 17, 23]]) {
  const q = AP.fitPlan(sw, sh, W, H);
  A.ok(q.dw <= W && q.dh <= H, 'never overflows the box ' + [sw, sh, W, H]);
  A.ok(q.mode !== 'nn' || (q.dw === sw * q.pre && q.dh === sh * q.pre), 'NN is always an integer multiple ' + [sw, sh, W, H]);
  A.ok(q.mode === 'nn' || q.dw < sw * q.pre || q.dh < sh * q.pre, 'every smoothed step is a DOWNSCALE ' + [sw, sh, W, H]);
}
A.eq(AP.fitPlan(0, 0, 10, 10), null, 'no art, no plan');

// ---- one pipeline, shared ----
const su = rd('app/stationui.js'), ap = rd('app/agentportraits.js');
A.ok(/AgentPortraits\.renderBody\(a, performance\.now\(\)\)/.test(su), 'the dossier portrait renders through the shared renderBody');
A.ok(!/drawPortrait\._buf/.test(su), 'the dossier no longer keeps its own copy of the 1:1 render');
A.ok(/SPRITES\.bodyScale/.test(ap) && /SPRITES\.drawBody\(/.test(ap), 'renderBody cancels the floor scale and draws the real body');
A.ok(/SPRITES\.ensureSkin\(a\.skin\)/.test(ap) && /agt-sil/.test(ap), 'a late skin loads through ensureSkin behind a silhouette');
A.ok(/thumbs\.has\(key\)/.test(ap) && /crops\.has\(bk\)/.test(ap), 'thumbs and native crops are cached (repaints never re-run the pipeline)');

// ---- no letter avatar in the Workflow panel ----
const panel = rd('app/workflowpanel.js'), code = panel.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');
A.ok(!/\)\[0\][^;\n]{0,40}toUpperCase\(\)/.test(code), 'no first-letter avatar');
A.ok(/thumb\(a\.id, 34, 42, 'av'\)/.test(code), 'Who works here? shows each agent by skin');
A.ok(/<span class="av">\+<\/span><span class="nm">RECRUIT<\/span>/.test(code), 'the RECRUIT card keeps its "+"');
A.ok(/thumb\(d\.agentId, 22, 28, 'wf-nthumb'\)/.test(code), 'the strip shows each bay\'s crew by skin');
A.ok(/fires at ' \+ thumb\(r\.agentId/.test(code) && /thumb\(h\.agentId, 16, 20/.test(code), 'trigger rows and the run log show the skin');
A.ok(/const agentOf = aid => \(aid && \(H\.agents\(\) \|\| \[\]\)\.find/.test(code), 'an unknown id gets the silhouette, not a guessed skin');
A.ok(/agents: \(\) => liveAgents\(\)\.map\(a => \(\{ id: a\.id, name: a\.name, color: a\.color, model: a\.model, skin: a\.skin/.test(rd('app/app.js')), 'the REFIT roster carries each agent\'s skin');

// ---- the crate card: skin only for a proven run ----
const names = { agentName: a => String(a).toUpperCase(), dockName: d => d, lineName: l => l, usd: n => '$' + n };
let card = LW.crateCard({ workitemId: 'q', agentId: 'quill', dockId: 'bA', lineId: 'L', kind: 'sample', preview: 'x', box: 'ore' }, Object.assign({ run: null, row: null, nowMs: 0 }, names));
A.eq(card.runBy, null, 'a queued crate names no worker');
card = LW.crateCard({ workitemId: 'q', agentId: 'mira', dockId: 'bB', lineId: 'L', kind: 'chain', preview: 'd', box: 'product' },
  Object.assign({ run: { runId: 'rr', agentId: 'mira', startedAt: 1000, usd: 0, ended: null }, row: null, nowMs: 2000 }, names));
A.eq(card.runBy, 'mira', 'a confirmed run names its agent');
const cc = rd('app/cratecard.js');
A.ok(/card\.runBy && typeof cur\.agentOf === 'function'/.test(cc) && /r\[0\] === 'RUN'/.test(cc), 'the crate card draws the skin on the RUN row only');
A.ok(/agentOf: aid => bodyForAgent\(aid\)/.test(rd('app/world.js')), 'the floor hands the card the body\'s own skin');

A.report('agent skin thumbs');
