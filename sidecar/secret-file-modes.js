'use strict';
/* Boot-time tightening of credential files that an older build left group/world-readable.

   writeFileDurable creates every store 0600 since bf6679fa7, and a store is tightened on its next write. A
   file that is never rewritten keeps whatever mode it had: a ChatGPT sign-in whose refresh token has not
   rotated, a channel secrets.json nobody has touched since the upgrade, the .bak last-known-good copies.
   Reported against 0.12.4: codex/tokens.json and its .bak were 0644 on a shared machine. This pass runs once
   at boot and strips every group/other bit from each regular file in the credential folders (and
   diag.errors.json). It never widens a mode, never follows a symlink, never recurses, and on Windows
   (where mode bits other than read-only mean nothing) it does nothing.

   tightenSecretFileModes({ fs, path, root, platform, dirs?, files?, note? })
     -> { skipped: bool, checked: n, tightened: [relPath], failed: [relPath] }  */

const DEFAULT_DIRS = ['codex', 'grok', 'kimi', 'channels', 'connectors', '.secrets'];
const DEFAULT_FILES = ['diag.errors.json'];

function tightenSecretFileModes(d) {
  const fs = d.fs, pathMod = d.path, root = d.root;
  const note = typeof d.note === 'function' ? d.note : () => {};
  const out = { skipped: false, checked: 0, tightened: [], failed: [] };
  if (d.platform === 'win32') { out.skipped = true; return out; }
  const dirs = Array.isArray(d.dirs) ? d.dirs : DEFAULT_DIRS;
  const files = Array.isArray(d.files) ? d.files : DEFAULT_FILES;

  const candidates = files.slice();
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(pathMod.join(root, dir)); }
    catch (e) { if (!e || e.code !== 'ENOENT') note('secret-modes.readdir', e, dir); continue; }
    for (const name of names) candidates.push(dir + '/' + name);
  }

  for (const rel of candidates) {
    const file = pathMod.join(root, rel);
    let st;
    try { st = fs.lstatSync(file); }
    catch (e) { if (!e || e.code !== 'ENOENT') { note('secret-modes.stat', e, rel); out.failed.push(rel); } continue; }
    if (!st.isFile()) continue;              // symlinks, sub-folders, sockets: never touched
    out.checked++;
    if ((st.mode & 0o077) === 0) continue;   // already owner-only
    // keep the owner's own read/write bits as they were (a 0444 file stays read-only as 0400); only a file
    // the owner could not even read falls back to 0600, so the sidecar never locks itself out of a store
    const ownerBits = st.mode & 0o600;
    try { fs.chmodSync(file, ownerBits || 0o600); out.tightened.push(rel); }
    catch (e) { note('secret-modes.chmod', e, rel); out.failed.push(rel); }
  }
  return out;
}

module.exports = { tightenSecretFileModes, DEFAULT_DIRS, DEFAULT_FILES };
