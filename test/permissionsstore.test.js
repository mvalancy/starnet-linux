'use strict';
// permissionsstore.test.js — the thin store behind the Permissions Panel (autonomy B1). Drives BOTH halves of a
// level (posture preset via AutonomyStore + the curated grant reconcile via the api), caches the server's grant
// snapshot, derives the current level, and locks down on new-hero reset. Injected fakes; nothing touches the DOM.
const assert = require('assert');
const fs = require('fs'); const path = require('path');
global.Permissions = require('../frontend/app/permissions.js');
const { PermissionsStore } = require('../frontend/app/permissionsstore.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// a fake sidecar: an in-memory grant Set + the token-gated api the store calls. Records every call.
function harness(initialGrants, startPosture) {
  const calls = { grant: [], revoke: [], load: 0 };
  const server = new Set(initialGrants || []);
  let posture = startPosture || { initiative: 'wait', actsUnattended: false };
  const presetMap = {
    wait:    { initiative: 'wait',    actsUnattended: false },
    suggest: { initiative: 'propose', actsUnattended: false },
    build:   { initiative: 'leash',   actsUnattended: true },
    free:    { initiative: 'free',    actsUnattended: true }
  };
  const api = {
    load: async () => { calls.load++; return { grants: Array.from(server).sort(), grantable: ['cabinet:write'] }; },
    grant: async (k) => { calls.grant.push(k); if (k === 'cabinet:write') server.add(k); return { ok: true, grants: Array.from(server).sort() }; },
    revoke: async (k) => { calls.revoke.push(k); server.delete(k); return { ok: true, grants: Array.from(server).sort() }; }
  };
  return { calls, server, api, applyPreset: (id) => { posture = presetMap[id] || posture; }, getPosture: () => posture };
}
const wire = (h) => PermissionsStore.init({ api: h.api, getPosture: h.getPosture, applyPreset: h.applyPreset, load: false });

(async () => {
  // --- load populates the cache + derives the level ---
  {
    const h = harness([]); wire(h);
    const snap = await PermissionsStore.refresh();
    ok(h.calls.load === 1, 'refresh hit the api');
    eq(snap.grants, [], 'no grants initially');
    eq(snap.grantable, ['cabinet:write'], 'grantable surfaced from the server');
    eq(snap.level, 'never', 'wait posture + no grants → never');
  }

  // --- setLevel('full') applies the free preset AND grants the write capability ---
  {
    const h = harness([]); wire(h);
    await PermissionsStore.refresh();
    const snap = await PermissionsStore.setLevel('full');
    eq(h.getPosture().initiative, 'free', 'full applied the free posture preset');
    ok(h.calls.grant.includes('cabinet:write'), 'full granted the local-write capability');
    ok(snap.grants.includes('cabinet:write'), 'cache reflects the grant');
    eq(snap.level, 'full', 'now fully autonomous');
  }

  // --- setLevel('never') from full revokes the write grant AND applies the wait preset ---
  {
    const h = harness(['cabinet:write'], { initiative: 'free', actsUnattended: true }); wire(h);
    await PermissionsStore.refresh();
    eq(PermissionsStore.snapshot().level, 'full', 'starts at full');
    const snap = await PermissionsStore.setLevel('never');
    eq(h.getPosture().initiative, 'wait', 'never applied the wait preset');
    ok(h.calls.revoke.includes('cabinet:write'), 'never revoked the write grant');
    eq(snap.level, 'never', 'back to never');
  }

  // --- a level change NEVER auto-touches a non-curated standing grant ---
  {
    const h = harness(['cabinet:write', 'net:send'], { initiative: 'free', actsUnattended: true }); wire(h);
    await PermissionsStore.refresh();
    await PermissionsStore.setLevel('draft');
    ok(h.calls.revoke.includes('cabinet:write'), 'draft revoked the curated write grant');
    ok(!h.calls.revoke.includes('net:send'), 'a non-curated standing grant is NEVER auto-revoked by a level change');
    ok(h.server.has('net:send'), 'net:send survived the level change');
  }

  // --- single grant / revoke ---
  {
    const h = harness([]); wire(h);
    await PermissionsStore.refresh();
    await PermissionsStore.grant('cabinet:write');
    ok(PermissionsStore._grants().includes('cabinet:write'), 'grant updates the cache');
    await PermissionsStore.revoke('cabinet:write');
    ok(!PermissionsStore._grants().includes('cabinet:write'), 'revoke updates the cache');
  }

  // --- new-hero reset locks down authoritatively and preserves unrelated standing grants ---
  {
    const h = harness(['cabinet:write', 'net:send'], { initiative: 'free', actsUnattended: true }); wire(h);
    await PermissionsStore.refresh();
    const p = PermissionsStore.reset();
    ok(h.calls.revoke.includes('cabinet:write'), 'reset revoked the write grant (a fresh hero starts locked)');
    ok(p && typeof p.then === 'function', 'reset returns an awaitable promise so onWake can await the lockdown (no inherit-window)');
    const snap = await p;
    ok(!snap.grants.includes('cabinet:write'), 'successful reset removes the confirmed curated grant');
    ok(snap.grants.includes('net:send'), 'successful reset preserves a non-curated standing grant');
  }

  // --- failed new-hero lockdown never fabricates an empty ledger or resolves as safe ---
  {
    const server = new Set(['cabinet:write']);
    const api = {
      load: async () => ({ ok: true, grants: Array.from(server), grantable: ['cabinet:write'] }),
      revoke: async () => ({ ok: false, reason: 'could not persist revoke — kept', grants: Array.from(server) })
    };
    PermissionsStore.init({ api, getPosture: () => ({ initiative: 'free' }), applyPreset: () => {}, load: false });
    await PermissionsStore.refresh();
    let rejected = null;
    try { await PermissionsStore.reset(); } catch (e) { rejected = e; }
    ok(rejected && /could not lock down standing permissions/i.test(rejected.message), 'failed reset rejects so commissioning cannot proceed');
    const snap = PermissionsStore.snapshot();
    ok(snap.grants.includes('cabinet:write'), 'failed reset preserves the last confirmed dangerous grant');
    ok(/persist revoke/i.test(snap.error), 'failed reset exposes the durable revoke failure');
  }

  // --- provenance (P0-5): the store caches the sidecar's meta map and exposes it in the snapshot ---
  {
    const server = new Set(['cabinet:write', 'net:send']);
    const api = {
      load: async () => ({ grants: Array.from(server).sort(), grantable: ['cabinet:write'], meta: { 'cabinet:write': { grantedAt: 1700000000000 }, 'net:send': { grantedAt: 1690000000000 } } }),
      grant: async () => ({ ok: true, grants: Array.from(server).sort() }),
      revoke: async (k) => { server.delete(k); return { ok: true, grants: Array.from(server).sort() }; }
    };
    PermissionsStore.init({ api, getPosture: () => ({ initiative: 'free', actsUnattended: true }), applyPreset: () => {}, load: false });
    const snap = await PermissionsStore.refresh();
    eq(snap.meta['cabinet:write'].grantedAt, 1700000000000, 'store cached the curated grant provenance');
    eq(snap.meta['net:send'].grantedAt, 1690000000000, 'store cached the non-curated grant provenance');
    // a revoke with no meta in the response still drops that key's provenance locally.
    const after = await PermissionsStore.revoke('net:send');
    ok(!after.meta['net:send'], 'revoke dropped the provenance for the withdrawn key');
    ok(after.meta['cabinet:write'], 'the surviving grant keeps its provenance');
  }

  // --- legacy store (no meta in the payload): snapshot.meta is always an object, never undefined ---
  {
    const api = { load: async () => ({ grants: ['cabinet:write'], grantable: ['cabinet:write'] }), grant: async () => ({ ok: true }), revoke: async () => ({ ok: true }) };
    PermissionsStore.init({ api, getPosture: () => ({ initiative: 'wait' }), applyPreset: () => {}, load: false });
    const snap = await PermissionsStore.refresh();
    ok(snap.meta && typeof snap.meta === 'object', 'a meta-less payload still yields an object meta (empty)');
  }

  // --- transport/persist failures never turn unknown authority into an empty, trusted ledger ---
  {
    let mode = 'ok';
    const api = {
      load: async () => mode === 'ok'
        ? { grants: ['cabinet:write'], grantable: ['cabinet:write'] }
        : { ok: false, reason: 'permissions service unavailable' },
      grant: async () => ({ ok: false, reason: 'could not persist grant — denied' }),
      revoke: async () => ({ ok: false, reason: 'could not persist revoke — kept' })
    };
    PermissionsStore.init({ api, getPosture: () => ({ initiative: 'free' }), applyPreset: () => {}, load: false });
    await PermissionsStore.refresh();
    ok(PermissionsStore.snapshot().grants.includes('cabinet:write'), 'successful load establishes the authoritative grant cache');
    mode = 'fail';
    let snap = await PermissionsStore.refresh();
    ok(snap.grants.includes('cabinet:write'), 'failed refresh preserves the last confirmed grants (never fabricates empty authority)');
    ok(/unavailable/i.test(snap.error), 'failed refresh exposes an explicit permissions-service error');
    snap = await PermissionsStore.revoke('cabinet:write');
    ok(snap.grants.includes('cabinet:write'), 'failed revoke keeps the active grant visible');
    ok(/persist revoke/i.test(snap.error), 'failed revoke exposes the backend reason instead of silently doing nothing');
    snap = await PermissionsStore.grant('cabinet:write');
    ok(/persist grant/i.test(snap.error), 'failed grant exposes the backend reason instead of silently doing nothing');
    mode = 'ok';
    snap = await PermissionsStore.refresh();
    ok(!snap.error, 'a later authoritative refresh clears the stale error');
  }

  // --- a first-load outage is UNKNOWN, not an authoritative empty approval ledger ---
  {
    const api = { load: async () => ({ ok: false, reason: 'offline' }) };
    PermissionsStore.init({ api, getPosture: () => ({ initiative: 'wait' }), applyPreset: () => {}, load: false });
    const snap = await PermissionsStore.refresh();
    ok(snap.loaded === false, 'failed first load never marks permission authority loaded');
    ok(/offline/i.test(snap.error), 'failed first load carries an explicit offline error');
  }

  // --- read-only citizen: never emits, no bus dependency ---
  {
    let grantCalls = 0;
    PermissionsStore.init({ load: false, getPosture: () => ({ initiative: 'wait' }),
      applyPreset: async () => ({ ok: false, error: 'posture offline' }),
      api: { grant: async () => { grantCalls++; return { ok: true, grants: ['cabinet:write'] }; } } });
    const snap = await PermissionsStore.setLevel('full');
    ok(/posture offline/.test(snap.error), 'permission preset reports failed posture');
    ok(grantCalls === 0, 'failed posture never proceeds to capability grants');
  }

  // --- read-only citizen: never emits, no bus dependency ---
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'permissionsstore.js'), 'utf8');
    ok(!/\.emit\s*\(/.test(src), 'permissionsstore never emits on the bus (read-only citizen)');
    ok(!/U\.bus\.(on|once|emit)\s*\(|require\(['"][^'"]*events/.test(src), 'permissionsstore makes no real U.bus calls / events require (read-only citizen)');
  }

  console.log('permissionsstore.test.js OK —', n, 'assertions');
})().catch(e => { console.error(e); process.exit(1); });
