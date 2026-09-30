/* node test/codex-status.e2e.test.js — the dead-ChatGPT-token honesty seam, over real sockets.

   THE ESCAPE (2026-07-08): Andrew's Codex OAuth refresh token was consumed by another client; the run
   errored correctly, but GET /api/auth/codex/status kept answering connected:true, so Settings→Providers
   kept showing "● SIGNED IN · 1 key" with zero recovery actions.

   This boots the ACTUAL sidecar against an isolated workspace whose codex/tokens.json is pre-seeded with
   the persisted dead marker (exactly what ensureCodexAccessToken writes on a relogin-class refresh failure
   — the write path itself is unit-proven in codex-auth-state.test.js) and proves at the HTTP surface:
     · a booted sidecar reads the marker back → status = { connected:false, expired:true, reason } —
       RESTART STAYS HONEST, and connected NEVER reads true while known-dead.
     · the payload carries no token material.
     · POST /api/auth/codex/logout clears everything → { connected:false, expired:false }, and a cold
       restart cannot recover the old refresh token from the resilient backup.
     · a healthy envelope (no marker) still reads connected:true — the fix never breaks the good path.
   Zero network beyond localhost; no model spend. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const fs = require('fs');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const ACCESS = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE3ODM4NDAwMDB9.ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Q';
const REFRESH = 'rf-e2e-test-refresh-token-abcdefghijklmnopqrstuvwxyz-0123456789';

function seedTokens(ws, envelope) {
  const dir = path.join(ws, 'codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify(envelope));
}

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-codexstat-ws-', env: { SKYNET_DEV: '1' } });
  const ws = fixture.workspace;

  // ===== boot 1: a persisted DEAD marker (what a consumed-token refresh failure wrote before the restart) =====
  seedTokens(ws, {
    access_token: ACCESS, refresh_token: REFRESH, last_refresh: '2026-07-08T01:00:00.000Z', auth_mode: 'device',
    authDead: { reason: 'Codex refresh token was already consumed by another client (e.g. the Codex CLI or VS Code extension). Sign in with ChatGPT again.', code: 'refresh_token_reused', at: '2026-07-08T06:00:00.000Z' }
  });
  await fixture.start();
  let B = fixture.baseUrl;
  try {
    let token = fixture.token;
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const status = async () => (await fetch(B + '/api/auth/codex/status', { headers })).json();

    let raw = await (await fetch(B + '/api/auth/codex/status', { headers })).text();
    let s = JSON.parse(raw);
    A.eq(s.connected, false, 'a booted sidecar with a persisted dead marker NEVER claims connected (restart honesty)');
    A.eq(s.expired, true, 'status reports expired:true for the dead sign-in');
    A.ok(s.reason && /sign in with chatgpt again/i.test(s.reason), 'status carries the human reason for the death');
    A.eq(s.expiredAt, '2026-07-08T06:00:00.000Z', 'status carries when the token died');
    A.ok(raw.indexOf(ACCESS) === -1 && raw.indexOf(REFRESH) === -1, 'no token material rides the status payload');

    // ===== DISCONNECT (the Settings row action): logout clears tokens AND the dead state =====
    const lo = await (await fetch(B + '/api/auth/codex/logout', { method: 'POST', headers })).json();
    A.eq(lo.connected, false, 'logout answers connected:false');
    s = await status();
    A.eq(s.connected, false, 'after logout: not connected');
    A.eq(s.expired, false, 'after logout: no longer "expired" — the dead state was cleared with the credentials');
    // logout leaves a credential-free signed-out TOMBSTONE (security audit 2026-09-25): an absent file let boot
    // migrate a legacy workspace's token back in. Both copies must carry no token material.
    for (const f of ['tokens.json', 'tokens.json.bak']) {
      const onDisk = fs.readFileSync(path.join(ws, 'codex', f), 'utf8');
      A.ok(JSON.parse(onDisk).signedOut === true && onDisk.indexOf(ACCESS) < 0 && onDisk.indexOf(REFRESH) < 0,
        'logout leaves a credential-free signed-out tombstone in ' + f);
    }

    // ===== boot 2: logout survives a REAL sidecar restart — the recovery copy cannot resurrect it =====
    await fixture.restart();
    B = fixture.baseUrl;
    token = fixture.token;
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    s = await status();
    A.eq(s.connected, false, 'logout remains disconnected after a real sidecar restart');
    A.eq(s.expired, false, 'restart cannot recover the old dead credential from .bak');

    // ===== boot 3: a HEALTHY envelope (no marker) still reads connected — the good path is untouched =====
    await fixture.stop();
    seedTokens(ws, { access_token: ACCESS, refresh_token: REFRESH, last_refresh: '2026-07-08T01:00:00.000Z', auth_mode: 'device' });
    await fixture.start();
    B = fixture.baseUrl;
    token = fixture.token;
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    s = await status();
    A.eq(s.connected, true, 'a healthy persisted sign-in still reads connected:true');
    A.eq(s.expired, false, 'a healthy sign-in is not expired');
  } finally {
    await fixture.dispose();
  }
  A.report('codex-status.e2e.test');
})().catch(e => { console.error('codex-status.e2e.test FAILED:', e); process.exit(1); });
