/* node test/crt-glprobe.test.js — the WebGL warp output sanity probe (source-locks + detector math).

   THE BUG THIS GUARDS (Andrew's mac report, 2026-07-20): on macOS the entire habitat rendered as a
   bright theme-colored wash. Every 2D color in the pipeline is hardcoded RGB (nothing paints theme
   phosphor full-frame), and the ONLY per-frame platform-divergent stage is drawCurveGL's round-trip
   (2D canvas → WebGL texture → warp shader → drawImage back): WKWebView's GL runs ANGLE-on-Metal,
   not the ANGLE-on-D3D Windows exercises, so a channel/format/premultiply divergence there recolors
   the WHOLE feed while every test on Windows stays green. There is no automated mac coverage (the
   canary is Windows-only; CDP-drive doesn't port to WKWebView — qa/STATUS 2026-07-14), so the fix is
   a runtime self-check: the warp only MOVES pixels and applies channel-neutral vignette, so the
   frame's global channel character must survive it. Three clean probes latch trust; a divergent one
   warns with both readings and hands the session to drawCurveCPU (pixel-identical by construction).

   Locked here: (1) the probe wiring exists in drawCurveGL (sample before upload, sample after blit,
   _glFailed on divergence, CPU-warp warn); (2) the detector math verdicts on the six canonical
   inputs — healthy identity, healthy vignette, the mac wash (bright + dim), a channel swap, and a
   black boot frame (must keep waiting, not judge). Thresholds are extracted FROM world.js source so
   this test cannot drift silently from the shipped predicate. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');

/* ---------- 1. wiring source-locks ---------- */
const glStart = src.indexOf('function drawCurveGL');
A.ok(glStart > 0, 'world.js still has drawCurveGL');
const glBody = src.slice(glStart, src.indexOf('function drawCurveCPU'));

A.ok(src.indexOf('function probeMeans') > 0, 'probeMeans sampler exists (16×16 downscale means)');
// 2026-09-23: one big drawImage to 16×16 point-samples the frame; scanlines/grain/texture aliased a healthy
// warp to "+27% brighter" and pinned sessions to the CPU warp. The sampler must reduce by 2:1 halvings.
const pmBody = src.slice(src.indexOf('function probeMeans'), src.indexOf('function probeMeans') + 1600);
A.ok(/w \/ 2/.test(pmBody) && /h \/ 2/.test(pmBody) && /for \(;;\)/.test(pmBody), 'probeMeans averages through a 2:1 halving chain, not one point-sampled step');
A.ok(!/drawImage\(src, 0, 0, src\.width, src\.height, 0, 0, 16, 16\)/.test(pmBody), 'no single-step full-frame → 16×16 downscale');
const preIdx = glBody.indexOf('pre = probeMeans(cv)');
const upIdx = glBody.indexOf('texImage2D');
const blitIdx = glBody.indexOf('drawImage(_glc');
const postIdx = glBody.indexOf('post = probeMeans(cv)');
A.ok(preIdx > 0 && upIdx > 0 && preIdx < upIdx, 'input sampled BEFORE the texture upload');
A.ok(blitIdx > 0 && postIdx > blitIdx, 'output sampled AFTER the GL blit lands back on the feed');
A.ok(/_glFailed = true/.test(glBody.slice(postIdx)), 'a divergent reading flips _glFailed (CPU fallback takes over)');
A.ok(glBody.indexOf('switching to the identical CPU warp') > 0, 'the divergence warn names the fallback');
A.ok(/_glProbeClean >= 3/.test(glBody), 'trust latches only after three clean probes');
A.ok(/_glProbeTries < 30/.test(glBody), 'probing is bounded (stops trying after 30 attempts)');
A.ok(glBody.indexOf('bright output minted from a dark input') > 0,
  'the dark-input wash arm exists (the reported mac scenario: wash over the dark awakening)');
const firstLossGuard = glBody.indexOf("glContextLost(gl)) return abandonCurveGL('WebGL context lost before draw')");
const drawIdx = glBody.indexOf('gl.drawArrays');
const secondLossGuard = glBody.indexOf("glContextLost(gl)) return abandonCurveGL('WebGL context lost during draw')");
const clearIdx = glBody.indexOf('ctx.clearRect');
A.ok(firstLossGuard > 0 && firstLossGuard < upIdx, 'context loss is detected before any GPU upload');
A.ok(secondLossGuard > drawIdx && secondLossGuard < clearIdx,
  'context loss is detected after GPU drawing and BEFORE the visible feed is cleared');
A.ok(/addEventListener\('webglcontextlost'/.test(src) && /ev\.preventDefault\(\)/.test(src),
  'the offscreen curve canvas listens for the browser context-loss event');
A.ok(/function abandonCurveGL[\s\S]{0,400}_glFailed = true; _glReady = false/.test(src),
  'one abandon seam permanently routes the session to the CPU warp');
A.ok(/_dbgLoseCurveContext[\s\S]{0,500}getExtension\('WEBGL_lose_context'\)[\s\S]{0,300}loseContext\(\)/.test(src),
  'the deterministic live regression invokes WEBGL_lose_context on the production warp');
// tries must be consumed ONLY on judged (lit) frames — a long dark awakening must never
// exhaust the probe budget before the room first lights
const litArm = glBody.indexOf('preSum >= 15');
A.ok(litArm > 0 && glBody.indexOf('_glProbeTries++') > litArm,
  'the try counter increments inside the lit-frame arm, not on dark frames');

/* ---------- 2. detector math — thresholds extracted from the shipped source ---------- */
const magM = /postSum >= preSum \* ([\d.]+) - (\d+) && postSum <= preSum \* ([\d.]+) \+ (\d+)/.exec(glBody);
A.ok(!!magM, 'magnitude-plausibility predicate present');
const tintM = /spr\(post\) > spr\(pre\) \+ ([\d.]+)/.exec(glBody);
A.ok(!!tintM, 'minted-tint predicate present');
const driftM = /> ([\d.]+);\s*\n?\s*\}\s*\n?\s*if \(!plausibleMag/.exec(glBody);
A.ok(!!driftM, 'channel-ratio drift threshold present');
const sigM = /preSum >= (\d+)/.exec(glBody);
A.ok(!!sigM, 'signal floor present');

// the dark-arm threshold, extracted from source so the test can't drift from the shipped predicate
const darkM = /postSum > preSum \* ([\d.]+) \+ (\d+)\) \{\s*\n\s*\/\/ the reported mac scenario/.exec(glBody);
A.ok(!!darkM, 'dark-input brightening threshold present');

function judge(pre, post) {
  const preSum = pre[0] + pre[1] + pre[2], postSum = post[0] + post[1] + post[2];
  if (preSum < Number(sigM[1])) {
    return postSum > preSum * Number(darkM[1]) + Number(darkM[2]) ? 'DIVERGENT' : 'no-signal';
  }
  const spr = m => { const s = m[0] + m[1] + m[2]; if (s <= 0) return 0; return (Math.max(...m) - Math.min(...m)) / s; };
  const plausibleMag = postSum >= preSum * Number(magM[1]) - Number(magM[2]) && postSum <= preSum * Number(magM[3]) + Number(magM[4]);
  const mintedTint = spr(post) > spr(pre) + Number(tintM[1]);
  let ratioDrift = false;
  if (spr(pre) >= 0.04 && postSum > 0) {
    const ri = pre.map(v => v / preSum), ro = post.map(v => v / postSum);
    ratioDrift = (Math.abs(ri[0] - ro[0]) + Math.abs(ri[1] - ro[1]) + Math.abs(ri[2] - ro[2])) > Number(driftM[1]);
  }
  return (!plausibleMag || mintedTint || ratioDrift) ? 'DIVERGENT' : 'clean';
}

// the healthy frame is this station's REAL measured whole-frame means (seed :9243, 2026-07-20)
const healthy = [17.0, 17.1, 16.7];
A.eq(judge(healthy, [16.8, 16.9, 16.5]), 'clean', 'GL out ≈ in (near-identity) passes');
A.eq(judge(healthy, [13.5, 13.6, 13.2]), 'clean', 'uniform vignette dimming passes');
A.eq(judge(healthy, [55, 210, 90]), 'DIVERGENT', 'the mac bright theme-wash is caught');
A.eq(judge(healthy, [10, 45, 14]), 'DIVERGENT', 'a dim wash is still caught (minted tint)');
A.eq(judge([120, 80, 40], [40, 120, 80]), 'DIVERGENT', 'a channel swap on a chromatic frame is caught');
A.eq(judge([2, 2, 2], [0, 0, 0]), 'no-signal', 'a black boot frame keeps waiting, never judges');
A.eq(judge([2, 2, 2], [55, 210, 90]), 'DIVERGENT',
  'the wash over the DARK awakening is caught (the exact reported mac frame: near-black in, bright out)');
A.eq(judge([2, 2, 2], [3, 4, 3]), 'no-signal',
  'a dark frame with a plausibly dark output stays no-signal (no try burned, keeps waiting)');

A.report();
