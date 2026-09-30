/* node test/child-env.e2e.test.js — a REAL sidecar's git never hands the station's secrets to a user repo's code.

   Audit 2026-09-25 #13: the project scan runs `git` inside the user's approved repos, where the repo's own config
   runs code (hooks, core.fsmonitor). That git inherited the sidecar's whole env — API/IPC tokens, desktop-injected
   provider keys, the service keys the sidecar exports. This boots a real sidecar on a scratch workspace with a
   planted station secret, stores a service key, approves a scratch repo whose core.fsmonitor dumps its env, forces
   one discovery scan, and reads what the repo's code actually saw. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const STATION_CANARY = 'stationCanaryZq81Planted0Secret';
const SERVICE_KEY = 'svcKeyCanaryPw4417Exported0Value';

(async () => {
  let gitOk = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (_) { gitOk = false; }
  if (!gitOk) { A.ok(true, 'git unavailable here — skipped'); return A.report('child-env.e2e.test'); }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-childenv-'));
  const repo = path.join(scratch, 'repo');
  const dump = path.join(scratch, 'fsmonitor-env.txt');
  const hook = path.join(scratch, 'fsmonitor.sh');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), '# probe\n');
  fs.writeFileSync(hook, '#!/bin/sh\nenv > "' + dump.replace(/\\/g, '/') + '"\nexit 1\n');
  try { fs.chmodSync(hook, 0o755); } catch (_) { /* Windows: git runs it through sh */ }
  execFileSync('git', ['config', 'core.fsmonitor', hook.replace(/\\/g, '/')], { cwd: repo });

  const fixture = SidecarFixture.create({ prefix: 'starnet-childenv-', timeoutMs: 20000, env: {
    STARNET_PLANTED_STATION_SECRET: STATION_CANARY, SKYNET_PLANTED_STATION_SECRET: STATION_CANARY,
    HERMES_HOME: path.join(scratch, 'hermes-home'),
    MY_USER_VAR: 'user-value-keep-me', NPM_TOKEN: 'npm-user-own-token-keep-me',
    SKYNET_ENV_DISCOVERY: '1'
  } });
  try {
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ allow: ['path:' + fs.realpathSync(repo)] }));
    await fixture.start();
    const put = await fixture.json('POST', '/api/servicekeys', { name: 'Acme API', key: SERVICE_KEY });
    A.eq(put.status, 200, 'service key stored (the sidecar exports it into its own env)');
    const scan = await fixture.json('POST', '/api/discovery/scan', {});
    A.eq(scan.status, 200, 'discovery scan ran (' + JSON.stringify(scan.body).slice(0, 200) + ')');
    A.ok(fs.existsSync(dump), 'the repo\'s own code (core.fsmonitor) ran under the sidecar\'s git — the check below is not vacuous');
    const seen = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
    const names = seen.split(/\r?\n/).map(l => l.split('=')[0]);
    A.ok(seen.indexOf(STATION_CANARY) < 0, 'the planted station secret never reached the repo');
    A.ok(seen.indexOf(SERVICE_KEY) < 0, 'the exported service key never reached the repo');
    A.eq(names.filter(n => /^(STARNET|SKYNET)_/i.test(n)), [], 'no STARNET_/SKYNET_ variable reached the repo (API/IPC tokens, keys, workspace)');
    A.ok(names.some(n => /^PATH$/i.test(n)), 'PATH is kept');
    A.ok(/MY_USER_VAR=user-value-keep-me/.test(seen), 'the user\'s own var is kept');
    A.ok(/NPM_TOKEN=npm-user-own-token-keep-me/.test(seen), 'the user\'s own NPM_TOKEN is kept (theirs, not the station\'s)');
  } finally {
    await fixture.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  A.report('child-env.e2e.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
