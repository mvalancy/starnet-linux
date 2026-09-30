/* node test/sidecar.security.test.js -- boot-level security composition tests.
   Boots the real sidecar and proves the API-token layer is visible to tests:
   sensitive GETs need authority, /api/session is not a loopback freebie, active
   deliverables are sandboxed, and both browser and Tauri trusted-origin flows work. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
async function tokenFromIndex(base) {
  const html = await (await fetch(base + '/')).text();
  const m = html.match(/window\.__STARNET_API_TOKEN__=("[^"]+")/);
  return m ? JSON.parse(m[1]) : '';
}

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-sec-' });
  await fixture.start();
  const ws = fixture.workspace;
  const B = fixture.baseUrl;
  try {
    const browserToken = await tokenFromIndex(B);
    A.ok(browserToken.length >= 32, 'browser-served index carries the boot API token');

    const getNoToken = await fetch(B + '/api/budget/status', { headers: { Origin: B } });
    A.eq(getNoToken.status, 403, 'sensitive GET without token -> 403');
    const getWithToken = await fetch(B + '/api/budget/status', { headers: { Origin: B, 'X-StarNet-Token': browserToken } });
    A.eq(getWithToken.status, 200, 'browser token authorizes sensitive GET');
    A.eq(getWithToken.headers.get('access-control-allow-origin'), B, 'browser CORS still mirrors the trusted loopback origin');

    const sessionGet = await fetch(B + '/api/session', { headers: { Origin: B } });
    A.eq(sessionGet.status, 403, 'GET /api/session is not freely retrievable');
    const sessionPostBrowser = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: B } });
    A.eq(sessionPostBrowser.status, 403, 'loopback browser pages cannot mint a fresh session token');
    const tokenedSession = await fetch(B + '/api/session', {
      method: 'POST',
      headers: { Origin: B, 'X-StarNet-Token': browserToken }
    });
    A.eq(tokenedSession.status, 200, 'browser token authorizes session liveness check');
    A.eq((await tokenedSession.json()).token, undefined, 'tokened session never returns the API token');

    const tauriOrigin = 'http://tauri.localhost';
    const tauriSessionNoToken = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: tauriOrigin } });
    A.eq(tauriSessionNoToken.status, 403, 'Tauri app origin still needs the boot token for /api/session');
    const tauriGet = await fetch(B + '/api/budget/status', { headers: { Origin: tauriOrigin, 'X-StarNet-Token': browserToken } });
    A.eq(tauriGet.status, 200, 'Tauri trusted origin with boot token authorizes sensitive GET');
    A.eq(tauriGet.headers.get('access-control-allow-origin'), tauriOrigin, 'Tauri CORS still mirrors the app origin');

    fs.mkdirSync(path.join(ws, 'agent', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', 'reports', 'active.html'), '<script>fetch("/api/session",{method:"POST"})</script>');
    const filePath = '/api/file?agent=agent&path=' + encodeURIComponent('reports/active.html');
    const fileNoToken = await fetch(B + filePath);
    A.eq(fileNoToken.status, 403, 'workspace deliverable GET without token -> 403');
    const fileWithToken = await fetch(B + filePath, { headers: { Origin: B, 'X-StarNet-Token': browserToken } });
    A.eq(fileWithToken.status, 200, 'header token authorizes media/file deliverable fetches');
    A.ok(/\bsandbox\b/.test(fileWithToken.headers.get('content-security-policy') || ''), 'deliverables are served under a CSP sandbox');
    A.ok(!fileWithToken.headers.get('content-security-policy').includes('allow-scripts'), 'deliverable sandbox does not allow scripts');
    const deliverableSession = await fetch(B + '/api/session', { method: 'POST', headers: { Origin: B, Referer: B + filePath } });
    A.eq(deliverableSession.status, 403, 'same-origin active deliverables cannot obtain API authority');

    /* audit P2: /api/fs/dirstat is JAILED to the user HOME + WORKSPACES. It may report exists/type for paths
       inside those roots, but must REFUSE (never stat) arbitrary absolute system paths so a token-holder can't
       enumerate the filesystem. ws is the WORKSPACES root here, so it (and a folder under it) must stat; a real
       system path outside HOME/WORKSPACES must come back exists:false + reason:'outside-allowed-roots'. */
    const dirstat = async (p) => { const r = await fetch(B + '/api/fs/dirstat?path=' + encodeURIComponent(p), { headers: { Origin: B, 'X-StarNet-Token': browserToken } }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
    const dsRoot = await dirstat(ws);
    A.ok(dsRoot.status === 200 && dsRoot.j.exists === true && dsRoot.j.isDir === true && dsRoot.j.reason == null, 'dirstat stats the WORKSPACES root (inside a jail root)');
    const subDir = path.join(ws, 'keep-here'); fs.mkdirSync(subDir, { recursive: true });
    const dsSub = await dirstat(subDir);
    A.ok(dsSub.j.exists === true && dsSub.j.isDir === true && dsSub.j.reason == null, 'dirstat stats a folder under WORKSPACES');
    const sysPath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
    const dsSys = await dirstat(sysPath);
    A.ok(dsSys.j.exists === false && dsSys.j.isDir === false && dsSys.j.reason === 'outside-allowed-roots', 'dirstat REFUSES an absolute system path outside HOME/WORKSPACES (no filesystem probe)');
    const dsRel = await dirstat('not/absolute');
    A.ok(dsRel.j.exists === false && dsRel.j.reason === 'not-absolute', 'dirstat rejects a non-absolute path');

    /* 2026-09-23 audit: the Host pin guards EVERY path, not just /api/*. `/` inlines the API token, so a
       DNS-rebound page (Host: attacker name) must not be able to read it. fetch() cannot forge Host, so this
       speaks raw http with the rebinding Host header a browser would send after the rebind. */
    const rawGet = (p, host) => new Promise((resolve, reject) => {
      const u = new URL(B);
      const req = require('http').request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers: { Host: host } }, (res) => {
        let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on('error', reject); req.end();
    });
    const port = new URL(B).port;
    const rebound = await rawGet('/', 'rebind.evil.example:' + port);
    A.eq(rebound.status, 403, 'a rebound Host cannot load the index page');
    A.ok(rebound.body.indexOf(browserToken) < 0 && !/__STARNET_API_TOKEN__/.test(rebound.body), 'the rebound response carries no API token');
    const reboundRun = await rawGet('/workshop-run/agent/x/index.html?token=' + browserToken, 'rebind.evil.example:' + port);
    A.eq(reboundRun.status, 403, 'workshop-run is behind the same Host floor');
    const localIndex = await rawGet('/', '127.0.0.1:' + port);
    A.eq(localIndex.status, 200, 'the loopback Host still loads the app');
    A.eq(localIndex.headers['x-frame-options'], 'SAMEORIGIN', 'the app refuses cross-site framing (X-Frame-Options)');
    A.ok(/frame-ancestors 'self'/.test(localIndex.headers['content-security-policy'] || ''), 'the app refuses cross-site framing (CSP frame-ancestors)');
    A.eq((await rawGet('/', 'localhost:' + port)).status, 200, 'localhost Host is loopback too');
    // The ONE exemption: a line-trigger webhook may arrive through the Commander's own tunnel carrying its public
    // Host. It must reach the trigger's secret check (here: an unknown trigger), never the Host floor.
    const tunnelHook = await new Promise((resolve, reject) => {
      const req = require('http').request({ host: '127.0.0.1', port, path: '/api/hooks/trg_nosuchtrigger01', method: 'POST', headers: { Host: 'abc.trycloudflare.com', 'Content-Type': 'application/json' } }, (res) => {
        let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject); req.end('{}');
    });
    A.ok(tunnelHook.status !== 403 || !/forbidden host/.test(tunnelHook.body), 'a tunnelled trigger webhook reaches its own secret check, not the Host floor');
    A.ok(tunnelHook.body.indexOf(browserToken) < 0, 'the trigger webhook answer carries no API token');
    A.eq((await rawGet('/api/hooks/trg_nosuchtrigger01', 'abc.trycloudflare.com')).status, 403, 'a non-POST on the hook path still meets the Host floor');
  } finally {
    await fixture.dispose();
  }
  A.report('sidecar.security.test');
})().catch(e => { console.log('FAIL: sidecar.security.test threw -- ' + (e && e.stack || e)); process.exit(1); });
