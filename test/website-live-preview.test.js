/* The homepage preview embeds the real frontend and crops to #stage. The stage geometry
   changes as the application shell evolves, so the crop must come from the live iframe DOM,
   never from another hard-coded snapshot that can silently age out. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'website', 'live-preview.js'), 'utf8');
// the preview's clip/iframe rules are homepage-only, so they live in home.css (loaded only by index.html)
const css = fs.readFileSync(path.join(ROOT, 'website', 'home.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'website', 'index.html'), 'utf8');
const demo = fs.readFileSync(path.join(ROOT, 'website', 'app', 'demo-boot.js'), 'utf8');

A.ok(/contentDocument/.test(js) && /querySelector\(['"]#stage['"]\)/.test(js),
  'the homepage derives its crop from the embedded app stage');
A.ok(/getBoundingClientRect\(\)/.test(js) && /--appx/.test(js) && /--appy/.test(js) && /--app-aspect/.test(js),
  'the measured stage rectangle drives offset, scale, and aspect ratio');
A.ok(/ResizeObserver/.test(js) && /frame\.addEventListener\(['"]load['"]/.test(js),
  'the crop re-measures after iframe load and later layout changes');
A.ok(/aspect-ratio:var\(--app-aspect/.test(css) && /translate\(var\(--appx/.test(css),
  'the preview CSS consumes the live geometry variables');
A.eq(/clip\.clientWidth\s*\/\s*666/.test(js), false,
  'the current preview scale is not pinned to the retired 666px stage width');
A.ok(/live-preview\.js\?v=20260921/.test(html),
  'the homepage cache-busts the corrected preview controller');
A.ok(/app\/embed\.htm\?v=20260922-current-starter-v6/.test(html),
  'the homepage uses the cache-busted dashboard-upload-safe station document');
A.ok(/app\/assets\/sprites\/blank\/rot_south\.png/.test(html) && /fetchpriority="high"/.test(html),
  'the marketing page starts the embedded default-skin request before the iframe boot');

function bootDemo(initial) {
  const rows = Object.assign({}, initial || {});
  const localStorage = {
    getItem: (key) => Object.prototype.hasOwnProperty.call(rows, key) ? rows[key] : null,
    setItem: (key, value) => { rows[key] = String(value); }
  };
  vm.runInNewContext(demo, {
    window: {}, localStorage,
    setInterval: () => 1,
    clearInterval: () => {},
    console
  });
  return rows;
}

const upgraded = bootDemo({ 'starnet.save': '{"retired":"station"}' });
const upgradedSave = JSON.parse(upgraded['starnet.save']);
const upgradedRoom = upgradedSave.station.rooms.r1;
const starter = require('../frontend/app/worldmodel.js').starterDoc();
starter.meta.createdAt = 0;
const starterRevision = 'starter-' + require('crypto').createHash('sha256')
  .update(JSON.stringify(starter)).digest('hex').slice(0, 16);
starter.props.find(p => p.t === 'desk').agentId = upgradedSave.agent.id;
A.eq(upgradedSave.station, starter,
  'the complete website layout comes from the current product starter factory, including materials and all eight props');
A.eq(upgradedRoom.floorStyle, 'hull', 'the website demo uses the standard starter floor style');
A.eq(upgradedRoom.floorMat, 'resin', 'the website demo uses the actual starter floor material');
A.eq(upgradedRoom.wallMat, 'panelled', 'the website demo uses the actual starter wall material');
A.eq(upgradedRoom.hullStyle, 'bone', 'the website demo uses the actual starter hull style');
A.eq(upgradedRoom.hullMat, null, 'the website demo uses the standard station hull material');
A.eq(upgraded['starnet.website.demo.rev'], starterRevision,
  'a layout-derived revision moves returning visitors off obsolete starter saves automatically');

const currentRev = upgraded['starnet.website.demo.rev'];
const alreadyCurrent = bootDemo({
  'starnet.website.demo.rev': currentRev,
  'starnet.save': '{"preserved":true}'
});
A.eq(alreadyCurrent['starnet.save'], '{"preserved":true}',
  'the demo revision migrates once instead of overwriting storage on every page load');

A.report('website-live-preview.test');
