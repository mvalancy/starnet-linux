/* sidecar/routing/trigger-folder.js — the FOLDER line trigger's watcher core (2026-09-23).

   Polls ONE folder (top level only, not subfolders) instead of fs.watch: a poll is honest on every platform
   (fs.watch double-fires on Windows and misses network drives) and it gives "the write has settled" for free —
   a file only fires once two scans at least `settleMs` apart saw the SAME size+mtime and its mtime is itself
   older than settleMs. Temp/partial names (.tmp .part .crdownload ~$lock …) and dotfiles are ignored.

   DEDUPE is by name+mtime+size (triggers.fileKey), recorded in a durable per-trigger `seen` map the host
   persists, so a restart never refires an old file and a CHANGED file (new mtime/size) fires once more.
   ARMING baselines the folder: every file already there when a trigger is created/enabled/re-pointed is
   recorded as seen (stamped with the arming time — trigger-runner create/update) and never fires — only files that
   land AFTER arming do.

   Injected fs/path/clock only (determinism law). The host owns the timer, the seen-store and admission.

   makeFolderWatcher({ fsp, pathMod, settleMs?, maxEntries?, readCap? })
     baseline(dir)                         -> Promise<{ ok, keys[], error? }>
     scan(dir, seen, pending, nowMs)       -> Promise<{ ok, ready:[{name, abs, size, mtimeMs, key}], pending, error? }>
     readItem(abs, name)                   -> Promise<{ ok, binary, content, truncated, error? }> */
'use strict';
const T = require('./triggers.js');
const { note: failNote } = require('../failopen.js');

function makeFolderWatcher(deps) {
  const d = deps || {};
  const fsp = d.fsp, P = d.pathMod;
  if (!fsp || !P) throw new Error('trigger-folder: fsp and pathMod are required');
  const settleMs = (typeof d.settleMs === 'number' && d.settleMs >= 0) ? d.settleMs : 2000;
  const maxEntries = (typeof d.maxEntries === 'number' && d.maxEntries > 0) ? d.maxEntries : 500;
  const readCap = (typeof d.readCap === 'number' && d.readCap > 0) ? d.readCap : T.CONTENT_CAP;

  async function listFiles(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (out.length >= maxEntries) break;
      if (!e.isFile() || T.isIgnoredName(e.name)) continue;
      const abs = P.join(dir, e.name);
      let st = null;
      try { st = await fsp.stat(abs); } catch (_) { st = null; }   // vanished between readdir and stat: not a file any more
      if (st && st.isFile()) out.push({ name: e.name, abs, size: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  async function baseline(dir) {
    try { const files = await listFiles(dir); return { ok: true, keys: files.map(f => T.fileKey(f.name, f)) }; }
    catch (e) { return { ok: false, keys: [], error: (e && e.code === 'ENOENT') ? 'the folder no longer exists: ' + dir : ('cannot read the folder: ' + ((e && e.message) || e)) }; }
  }

  /* scan — `seen` is a key->firedAt map (read-only here), `pending` the previous scan's name->{size,mtimeMs,since}.
     Returns the files that have SETTLED and were never seen, plus the next pending map to carry forward. */
  async function scan(dir, seen, pending, nowMs) {
    let files;
    try { files = await listFiles(dir); }
    catch (e) { return { ok: false, ready: [], pending: new Map(), error: (e && e.code === 'ENOENT') ? 'the folder no longer exists: ' + dir : ('cannot read the folder: ' + ((e && e.message) || e)) }; }
    const prev = pending instanceof Map ? pending : new Map();
    const next = new Map(), ready = [];
    for (const f of files) {
      const key = T.fileKey(f.name, f);
      if (seen && Object.prototype.hasOwnProperty.call(seen, key)) continue;
      const p = prev.get(f.name);
      const same = !!(p && p.size === f.size && p.mtimeMs === f.mtimeMs);
      const since = same ? p.since : nowMs;
      next.set(f.name, { size: f.size, mtimeMs: f.mtimeMs, since });
      if (same && (nowMs - since) >= settleMs && (nowMs - f.mtimeMs) >= settleMs) ready.push({ name: f.name, abs: f.abs, size: f.size, mtimeMs: f.mtimeMs, key });
    }
    return { ok: true, ready, pending: next };
  }

  async function readItem(abs, name) {
    let fh = null;
    try {
      fh = await fsp.open(abs, 'r');
      const buf = Buffer.alloc(readCap + 1);
      const r = await fh.read(buf, 0, readCap + 1, 0);
      const got = buf.subarray(0, r.bytesRead);
      if (T.looksBinary(name, got)) return { ok: true, binary: true, content: '', truncated: false };
      const truncated = got.length > readCap;
      let text = got.subarray(0, Math.min(got.length, readCap)).toString('utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      return { ok: true, binary: false, content: text, truncated };
    } catch (e) {
      return { ok: false, binary: false, content: '', truncated: false, error: 'cannot read ' + name + ': ' + ((e && e.code) || (e && e.message) || e) };
    } finally {
      if (fh) { try { await fh.close(); } catch (e) { failNote('trigger.folder.close', e); } }
    }
  }

  return { baseline, scan, readItem, settleMs };
}

/* makeFolderPolicy — may this folder be watched? The SAME jail the station already applies to paths a user
   names: pathtrust's hardlines (no NUL, no UNC/network path, never inside .git, never a .env), must exist, must
   be a directory, judged by its REALPATH (a junction/symlink cannot smuggle a system dir in). Then:
     • never a whole drive / filesystem root, never a system folder (Windows, Program Files, ProgramData,
       /etc, /usr, /System …), never inside the station's own data (WORKSPACES — agents write there, a line
       that fed on its own output would loop);
     • it must sit inside the owner's HOME folder or inside a project folder they already added (the blessed
       roots) — the same two places the station treats as the owner's own ground. Home itself is too broad.
   deps: { fsp, pathMod, hardlineReason(raw, resolved)->reason|null, homeRoots()->[abs], blessedRoots()->[abs],
           forbiddenRoots()->[abs], systemRoots()->[abs], lineRoots()->[abs] (every line's working folder), winish:bool }
   A folder equal to or inside a LINE's working folder (its trusted project — where that line's stages write) is
   refused too: the line would feed on its own output. The runner re-asks this at every fire (lineOutputError).
   check(raw) -> Promise<{ ok:true, path:<realpath> } | { ok:false, code, error }> — never throws. */
const lineOutputError = (root) => 'that folder is inside ' + root + ', the working folder a line\'s stages write to — the line would feed on its own output. Choose a folder outside it.';
function makeFolderPolicy(deps) {
  const d = deps || {};
  const fsp = d.fsp, P = d.pathMod;
  if (!fsp || !P) throw new Error('trigger-folder policy: fsp and pathMod are required');
  const winish = d.winish === true;
  /* FAIL CLOSED (2026-09-24): a root reader that THROWS answers null, never [] — an empty system/forbidden list
     would silently skip the very checks that keep the Windows folder and the station's own data out. check() refuses on null. */
  const list = fn => { try { return (typeof fn === 'function' ? fn() : []) || []; } catch (e) { failNote('trigger.folder.policy.roots', e); return null; } };
  const hardline = typeof d.hardlineReason === 'function' ? d.hardlineReason : () => null;
  const norm = s => { let v = P.resolve(String(s)); const root = P.parse(v).root; while (v.length > root.length && /[\\/]$/.test(v)) v = v.slice(0, -1); return winish ? v.toLowerCase() : v; };
  function inside(child, parent) {
    const c = norm(child), p = norm(parent);
    if (c === p) return true;
    const rel = P.relative(p, c);
    return !!rel && !rel.startsWith('..') && !P.isAbsolute(rel);
  }
  // the REALPATH or null: an unresolvable path is refused, never judged by its unresolved spelling (a junction the
  // jail cannot see through could otherwise smuggle a system folder past every check below)
  async function realOr(p) { try { return await fsp.realpath(p); } catch (e) { failNote('trigger.folder.policy.realpath', e); return null; } }

  async function check(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, code: 'missing', error: 'choose a folder to watch' };
    if (!P.isAbsolute(s)) return { ok: false, code: 'relative', error: 'enter the full folder path (e.g. C:\\Users\\you\\Drops or /home/you/drops)' };
    const hr = hardline(s, P.resolve(s));
    if (hr) return { ok: false, code: 'hardline', error: hr };
    let st;
    try { st = await fsp.stat(s); } catch (e) { void e; return { ok: false, code: 'missing', error: 'that folder does not exist: ' + s }; }
    if (!st.isDirectory()) return { ok: false, code: 'notdir', error: 'that path is a file, not a folder: ' + s };
    const real = await realOr(P.resolve(s));
    if (!real) return { ok: false, code: 'unresolved', error: 'the folder\'s real location could not be resolved — refused: ' + s };
    const rhr = hardline(real, real);
    if (rhr) return { ok: false, code: 'hardline', error: rhr };
    if (norm(real) === norm(P.parse(real).root)) return { ok: false, code: 'system', error: 'a whole drive cannot be watched — choose a specific folder' };
    const sysRoots = list(d.systemRoots), forbidden = list(d.forbiddenRoots);
    if (!sysRoots || !forbidden) return { ok: false, code: 'policy', error: 'the station could not read its protected-folder list — refused (try again)' };
    for (const sys of sysRoots) if (sys && inside(real, sys)) return { ok: false, code: 'system', error: 'system folders cannot be watched: ' + real };
    for (const f of forbidden) if (f && inside(real, f)) return { ok: false, code: 'station', error: 'the station\'s own data folder cannot be watched (agents write there): ' + real };
    // A LINE'S OWN OUTPUT (sweep 2026-09-25): a folder equal to or inside the working folder a line's stages write to
    // (its trusted project) would feed that line its own results — a loop that spends on every file it writes.
    const lineRoots = list(d.lineRoots);
    if (!lineRoots) return { ok: false, code: 'policy', error: 'the station could not read its lines\' working folders — refused (try again)' };
    for (const lr of lineRoots) if (lr && inside(real, lr)) return { ok: false, code: 'lineoutput', error: lineOutputError(lr) };
    const homes = (list(d.homeRoots) || []).filter(Boolean);
    for (const h of homes) if (norm(real) === norm(h)) return { ok: false, code: 'broad', error: 'your whole home folder is too broad — choose a specific folder inside it' };
    const blessed = (list(d.blessedRoots) || []).filter(Boolean);
    const allowed = homes.some(h => inside(real, h)) || blessed.some(b => inside(real, b));
    if (!allowed) return { ok: false, code: 'outside', error: 'only folders inside your home folder or a project you added can be watched: ' + real };
    return { ok: true, path: real };
  }
  return { check, inside };
}

module.exports = { makeFolderWatcher, makeFolderPolicy, lineOutputError };
