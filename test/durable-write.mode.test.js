/* node test/durable-write.mode.test.js — credential-bearing stores are written owner-only (0o600).

   writeFileDurable is the ONE writer behind codex/grok/kimi tokens.json, channels/secrets.json,
   connectors/servicekeys.json and the connector vault. It used to open its temp file with no mode, so the file
   landed 0o666 & ~umask (typically 0644: readable by every local user on Linux/macOS) and the rename carried
   that mode onto the store. The spy proves the mode reaches the OS call on every platform; on POSIX the real
   file mode is checked too (Windows only honours the read-only bit, so there the spy is the proof). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeSpotifyStore } = require('../sidecar/spotify/store.js');

const DIR = path.join(os.tmpdir(), 'starnet-durable-mode-' + process.pid);

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  // ---- the durable (fsync) path passes 0o600 to openSync ----
  const opened = [];
  const spy = Object.assign({}, fs, { openSync: (p, flags, mode) => { opened.push({ p: String(p), flags, mode }); return fs.openSync(p, flags, mode); } });
  const file = path.join(DIR, 'tokens.json');
  writeFileDurable({ fs: spy, path }, file, JSON.stringify({ refresh_token: 'rt-canary' }));
  const tmpOpen = opened.find(o => /\.tmp$/.test(o.p));
  A.ok(!!tmpOpen, 'the temp file was opened through the injected fs');
  A.eq(tmpOpen && tmpOpen.mode, 0o600, 'the temp file is created owner-only (0o600)');
  A.eq(JSON.parse(fs.readFileSync(file, 'utf8')).refresh_token, 'rt-canary', 'the store still round-trips');
  if (process.platform !== 'win32') {
    A.eq(fs.statSync(file).mode & 0o777, 0o600, 'POSIX: the renamed store is 0600 on disk');
    fs.chmodSync(file, 0o644);   // a store written by an older build
    writeFileDurable({ fs, path }, file, '{}');
    A.eq(fs.statSync(file).mode & 0o777, 0o600, 'POSIX: the next write tightens a legacy 0644 store');
  }
  // an explicit mode is honoured (no caller needs it today; the option keeps the primitive general)
  opened.length = 0;
  writeFileDurable({ fs: spy, path, mode: 0o640 }, path.join(DIR, 'shared.json'), '{}');
  A.eq((opened.find(o => /\.tmp$/.test(o.p)) || {}).mode, 0o640, 'an explicit mode overrides the default');

  // ---- the no-fsync (in-memory facade) path passes the mode to writeFileSync ----
  const writes = [];
  const mem = { renameSync() {}, writeFileSync(p, data, opts) { writes.push({ p: String(p), opts }); } };
  writeFileDurable({ fs: mem, path }, '/virtual/x.json', '{}');
  A.eq(writes[0] && writes[0].opts && writes[0].opts.mode, 0o600, 'the facade path also requests 0o600');

  // ---- spotify store (its own writer) holds a refresh token and is owner-only too ----
  const sp = path.join(DIR, 'secrets');
  const seen = [];
  const fspSpy = Object.assign({}, fsp, { writeFile: (p, data, opts) => { seen.push({ p: String(p), opts }); return fsp.writeFile(p, data, opts); } });
  const store = makeSpotifyStore({ fsp: fspSpy, pathMod: path, dir: sp, fetchImpl: async () => { throw new Error('offline'); }, now: () => 1 });
  await store.setClientId('client-abc');
  const spWrite = seen.find(s => /spotify\.json\.tmp$/.test(s.p));
  A.eq(spWrite && spWrite.opts && spWrite.opts.mode, 0o600, 'spotify.json is written owner-only');
  if (process.platform !== 'win32') A.eq(fs.statSync(path.join(sp, 'spotify.json')).mode & 0o777, 0o600, 'POSIX: spotify.json is 0600 on disk');

  fs.rmSync(DIR, { recursive: true, force: true });
  A.report('durable-write.mode.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
