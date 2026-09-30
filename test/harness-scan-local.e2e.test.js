/* node test/harness-scan-local.e2e.test.js — POST /api/harness/scan only reads LOCAL folders (audit 2026-09-25 #19).

   The import-an-agent scan accepted any absolute root, including a UNC \\host\share: the very first stat() is an
   SMB connection that can hand the user's NTLM hash to whoever runs that server. This boots a REAL sidecar on a
   scratch workspace (HERMES_HOME forced to scratch too) and proves UNC and device-namespace roots are refused by
   name before any filesystem call, while an ordinary local OpenClaw workspace still scans. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-harness-scan-'));
  const ws = path.join(scratch, 'openclaw-state', 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'SOUL.md'), '# Soul\nA careful local agent.\n');
  fs.writeFileSync(path.join(ws, 'IDENTITY.md'), '- **Name:** Localbot\n');
  const fixture = SidecarFixture.create({ prefix: 'starnet-harness-scan-', timeoutMs: 20000, env: {
    HERMES_HOME: path.join(scratch, 'hermes-home'), OPENCLAW_STATE_DIR: path.join(scratch, 'openclaw-state')
  } });
  try {
    await fixture.start();
    const scan = (root) => fixture.json('POST', '/api/harness/scan', { harness: 'openclaw', root });

    const local = await scan(ws);
    A.eq(local.status, 200, 'a local workspace still scans (' + JSON.stringify(local.body).slice(0, 160) + ')');

    const refusals = [
      ['\\\\starnet-unc-probe.invalid\\share\\workspace', /network \(UNC\)/],
      ['//starnet-unc-probe.invalid/share/workspace', /network \(UNC\)/],
      ['\\\\?\\' + ws, /device paths/],
      ['\\\\.\\' + ws, /device paths/]
    ];
    for (const [root, re] of refusals) {
      const t0 = Date.now();
      const r = await scan(root);
      A.eq(r.status, 400, 'refused with 400: ' + root);
      A.ok(re.test(String(r.body && r.body.reason)), 'the refusal names why (' + String(r.body && r.body.reason) + ')');
      A.ok(Date.now() - t0 < 5000, 'refused before any network lookup: ' + root);
    }
  } finally {
    await fixture.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  A.report('harness-scan-local.e2e.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
