/* node test/secret-file-modes.test.js — the boot pass that tightens credential files an older build left
   group/world-readable. Reported against 0.12.4: codex/tokens.json and its .bak were 0644. The durable writer
   creates new stores 0600, but a file that is never rewritten kept its old mode. Runs against a REAL temp
   folder on POSIX (the mode bits are the thing under test); on Windows it proves the pass is a no-op and
   drives the logic through an injected fs instead. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { tightenSecretFileModes } = require('../sidecar/secret-file-modes.js');

// ---- injected fs: the decision logic, on every platform ----
{
  const modes = {
    'codex/tokens.json': 0o100644, 'codex/tokens.json.bak': 0o100644,
    'channels/secrets.json': 0o100600,            // already owner-only: untouched
    'connectors/servicekeys.json': 0o100640,
    '.secrets/spotify.json': 0o100444,            // owner read-only stays read-only (0400), never widened
    'diag.errors.json': 0o100664,
    'grok/link': 0o120777,                        // symlink: never followed or changed
  };
  const dirs = { codex: ['tokens.json', 'tokens.json.bak'], channels: ['secrets.json'], connectors: ['servicekeys.json'], '.secrets': ['spotify.json'], grok: ['link'] };
  const chmods = {};
  const enoent = () => Object.assign(new Error('nope'), { code: 'ENOENT' });
  const fake = {
    readdirSync: (p) => { const k = p.split('/').slice(1).join('/'); if (dirs[k]) return dirs[k]; throw enoent(); },
    lstatSync: (p) => {
      const k = p.split('/').slice(1).join('/'); const m = modes[k];
      if (m === undefined) throw enoent();
      return { mode: m, isFile: () => (m & 0o170000) === 0o100000 };
    },
    chmodSync: (p, m) => { chmods[p.split('/').slice(1).join('/')] = m; },
  };
  const out = tightenSecretFileModes({ fs: fake, path: path.posix, root: 'ROOT', platform: 'linux' });
  A.eq(chmods['codex/tokens.json'], 0o600, 'codex/tokens.json 0644 -> 0600');
  A.eq(chmods['codex/tokens.json.bak'], 0o600, 'its .bak too');
  A.eq(chmods['connectors/servicekeys.json'], 0o600, 'servicekeys 0640 -> 0600');
  A.eq(chmods['.secrets/spotify.json'], 0o400, 'a read-only 0444 file becomes 0400, not 0600');
  A.eq(chmods['diag.errors.json'], 0o600, 'diag.errors.json 0664 -> 0600');
  A.ok(!('channels/secrets.json' in chmods), 'an already-0600 file is not rewritten');
  A.ok(!('grok/link' in chmods), 'a symlink is never chmodded');
  A.eq(out.tightened.length, 5, 'five files reported tightened');
  A.eq(out.failed.length, 0, 'no failures; missing folders (kimi) are not failures');

  const win = tightenSecretFileModes({ fs: { readdirSync() { throw new Error('must not be called'); } }, path: path.posix, root: 'ROOT', platform: 'win32' });
  A.ok(win.skipped === true && win.checked === 0, 'on Windows the pass does nothing at all');
}

// ---- real files, real modes (POSIX only) ----
if (process.platform !== 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-modes-'));
  try {
    fs.mkdirSync(path.join(root, 'codex'));
    const tok = path.join(root, 'codex', 'tokens.json');
    fs.writeFileSync(tok, '{"refresh_token":"x"}'); fs.chmodSync(tok, 0o644);
    fs.writeFileSync(tok + '.bak', '{}'); fs.chmodSync(tok + '.bak', 0o644);
    const out = tightenSecretFileModes({ fs, path, root, platform: process.platform });
    A.eq(fs.statSync(tok).mode & 0o777, 0o600, 'REAL: codex/tokens.json is 0600 on disk');
    A.eq(fs.statSync(tok + '.bak').mode & 0o777, 0o600, 'REAL: codex/tokens.json.bak is 0600 on disk');
    A.eq(out.tightened.length, 2, 'REAL: two files tightened');
    const again = tightenSecretFileModes({ fs, path, root, platform: process.platform });
    A.eq(again.tightened.length, 0, 'REAL: a second boot changes nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

A.report('secret-file-modes.test');
