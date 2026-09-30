#!/usr/bin/env node
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const C = await import('../scripts/lib/update-continuity.mjs');
  const fixture = C.populatedFixture('nonce', 100);
  const legacy = structuredClone(fixture.workstreams);
  const hydrated = legacy.map(w => ({ ...w, parentStreamId: null, projectHome: false }));
  A.eq(C.normalizeLegacyWorkstreamDefaults(hydrated), legacy, 'only neutral project defaults are equivalent to legacy absence');
  A.eq(hydrated[0].projectHome, false, 'normalization leaves captured evidence unchanged');
  for (const changed of [
    { parentStreamId: 'real-parent' }, { projectHome: true },
    { parentStreamId: '' }, { projectHome: 0 }, { history: [] }, { title: 'lost title' }
  ]) {
    const altered = [{ ...hydrated[0], ...changed }];
    A.eq(C.stableJson(C.normalizeLegacyWorkstreamDefaults(altered)) === C.stableJson(legacy), false, 'semantic change is not hidden: ' + JSON.stringify(changed));
  }
  // Agent colours: a missing colour becoming a crew palette suit is the one permitted change (roster hydration
  // since the 2026-09-23 security audit). Anything else about a colour must still fail the comparison.
  {
    const prior = C.continuityProjection({ local: fixture, durable: fixture });
    const paint = (state, color) => { const out = structuredClone(state); for (const k of ['local', 'durable']) out[k].agents[1].color = color; return out; };
    const same = (a, b) => C.stableJson(a) === C.stableJson(b);
    const assigned = paint(prior, '#7bc88a');
    A.eq(same(C.adoptAssignedSuitColors(prior, assigned), assigned), true, 'a missing colour may become a crew palette suit');
    const offPalette = paint(prior, '#123456');
    A.eq(same(C.adoptAssignedSuitColors(prior, offPalette), offPalette), false, 'a missing colour replaced by a non-palette colour still fails');
    const coloured = paint(prior, '#d99a5a');
    const recoloured = paint(prior, '#7bc88a');
    A.eq(same(C.adoptAssignedSuitColors(coloured, recoloured), recoloured), false, 'a change to an existing colour is never hidden');
    A.eq(same(C.adoptAssignedSuitColors(coloured, coloured), coloured), true, 'an unchanged colour compares equal');
    const suits = /const SUITS = (\[[^\]]+\])/.exec(fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8'));
    A.ok(suits, 'app.js still declares the crew SUITS palette');
    A.eq(suits ? JSON.parse(suits[1].replace(/'/g, '"')) : null, C.CREW_SUITS.slice(), 'verifier palette matches the app crew SUITS');
  }
  const snapshot = { sentinel: { nonce: 'nonce', purpose: 'update-continuity' }, local: fixture, durable: Object.assign({}, fixture, { updatedAt: 200 }) };
  const receipt = C.buildReceipt({
    before: snapshot, after: snapshot,
    beforeVersion: '1.2.3', targetVersion: '1.2.4', afterVersion: '1.2.4',
    installerArtifact: 'StarNet_1.2.4_setup.exe', installerArtifactSha256: 'a'.repeat(64), installerGone: true,
    relaunched: true, installedExeSha256: 'b'.repeat(64)
  });
  A.eq(receipt.state.equal, true, 'timestamps are excluded while semantic state remains equal');
  A.eq(C.validateReceipt(receipt), { ok: true, errors: [] }, 'complete exact receipt passes');
  const reset = JSON.parse(JSON.stringify(receipt));
  reset.state.afterFingerprint = '0'.repeat(64);
  A.eq(C.validateReceipt(reset).ok, false, 'reset-looking state parity fails closed');
  const hung = JSON.parse(JSON.stringify(receipt));
  hung.installer.processGone = false;
  A.eq(C.validateReceipt(hung).ok, false, 'hung installer fails closed');
  const noRelaunch = JSON.parse(JSON.stringify(receipt));
  noRelaunch.relaunch.observed = false;
  A.eq(C.validateReceipt(noRelaunch).ok, false, 'missing relaunch fails closed');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-promotion-'));
  try {
    const dist = path.join(temp, 'dist'); fs.mkdirSync(dist);
    const artifact = path.join(dist, 'StarNet_1.2.4_setup.exe'); fs.writeFileSync(artifact, 'exact-installer');
    const artifactHash = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    const make = updatePath => C.buildReceipt({
      path: updatePath, before: snapshot, after: snapshot,
      beforeVersion: updatePath === 'latest-to-next' ? '1.2.3' : '1.1.9', targetVersion: '1.2.4', afterVersion: '1.2.4',
      installerArtifact: path.basename(artifact), installerArtifactSha256: artifactHash, installerGone: true,
      relaunched: true, installedExeSha256: 'b'.repeat(64)
    });
    const receipts = ['latest-to-next', 'n-minus-one-to-next'].map((updatePath, index) => {
      const file = path.join(temp, 'receipt-' + index + '.json'); fs.writeFileSync(file, JSON.stringify(make(updatePath))); return file;
    });
    const gate = path.resolve(__dirname, '../scripts/release-promotion-gate.mjs');
    const run = spawnSync(process.execPath, [gate, '--receipt', receipts[0], '--receipt', receipts[1], '--dist', dist, '--version', '1.2.4', '--min-soak-hours', '0', '--out', path.join(temp, 'verdict.json')], { encoding: 'utf8' });
    A.eq(run.status, 0, 'promotion gate accepts both exact populated-state paths: ' + String(run.stderr || run.stdout));
    fs.writeFileSync(artifact, 'different-installer');
    const swapped = spawnSync(process.execPath, [gate, '--receipt', receipts[0], '--receipt', receipts[1], '--dist', dist, '--version', '1.2.4', '--min-soak-hours', '0', '--out', path.join(temp, 'bad.json')], { encoding: 'utf8' });
    A.eq(swapped.status, 1, 'promotion gate refuses an installer whose bytes differ from canary');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  A.report('update-continuity.test');
})().catch(error => { console.error(error); process.exit(1); });
