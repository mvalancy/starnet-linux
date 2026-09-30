/* Exercise the notarization test's interpreter boundary in isolated Node processes. */
'use strict';
const A = require('./_assert.js');
const { spawnSync } = require('child_process');
const path = require('path');

function run(platform, outcome, earlierFailure = false) {
  const script = `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const cp = require('child_process');
    const original = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
      if (command !== ${JSON.stringify(platform === 'win32' ? 'python' : 'python3')}) throw new Error('unexpected interpreter: ' + command);
      if (${JSON.stringify(outcome)} === 'missing') return original('starnet-missing-python-issue-40', args, options);
      if (${JSON.stringify(outcome)} === 'denied') return { status: null, error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) };
      if (${JSON.stringify(outcome)} === 'store-alias') return { status: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.\\r\\n' };
      if (${JSON.stringify(outcome)} === 'passed') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stderr: 'fixture Python assertion failed' };
    };
    if (${earlierFailure}) require('./test/_assert.js').ok(false, 'earlier workflow assertion failed');
    require('./test/desktop-build-macos-notarization.test.js');
  `;
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000, windowsHide: true
  });
}

const okCount = (out) => { const m = /OK \((\d+) assertions\)/.exec(out || ''); return m ? Number(m[1]) : -1; };
for (const platform of ['win32', 'linux']) {
  const passed = run(platform, 'passed');
  A.eq(passed.status, 0, platform + ' a passing probe passes: ' + passed.stderr);
  const full = okCount(passed.stdout);
  A.ok(full > 1, platform + ' the passing run reports its assertion count (' + full + ')');
  const missing = run(platform, 'missing');
  A.eq(missing.status, 0, platform + ' missing Python does not block the static checks: ' + missing.stderr);
  A.ok(missing.stdout.includes('SKIP: ' + (platform === 'win32' ? 'python' : 'python3') + ' not on PATH'),
    platform + ' reports the skipped probe visibly');
  // robust to static assertions being added: the skipped run has exactly ONE fewer assertion than a passing run
  A.eq(okCount(missing.stdout), full - 1, platform + ' does not count the skipped probe as passed');
}
const alias = run('win32', 'store-alias');
A.eq(alias.status, 0, 'the Windows Store python alias stub (exit 9009, no stdout) is treated as missing, not a failure: ' + alias.stdout.slice(-300));
A.ok(alias.stdout.includes('SKIP: python not on PATH') && /Store alias/.test(alias.stdout), 'and the skip says so');
A.eq(okCount(alias.stdout), okCount(run('win32', 'passed').stdout) - 1, 'the alias skip is not counted as a pass');
const denied = run('linux', 'denied');
A.eq(denied.status, 1, 'other spawn errors fail');
A.ok(denied.stdout.includes('EACCES') && !denied.stdout.includes('SKIP:'), 'spawn error retains its diagnostic');
const failed = run('linux', 'failed');
A.eq(failed.status, 1, 'Python probe failures fail');
A.ok(failed.stdout.includes('fixture Python assertion failed'), 'Python stderr remains visible');
const earlier = run('linux', 'missing', true);
A.eq(earlier.status, 1, 'missing interpreter cannot hide a preceding workflow failure');
A.ok(earlier.stdout.includes('earlier workflow assertion failed'), 'preceding failure remains visible');
A.report('desktop-build-macos-python-host.test');
