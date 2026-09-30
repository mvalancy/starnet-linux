/* STARNET — backup.js : export/import the whole local agent as one portable JSON file.

   Browser localStorage is the FRAGILE store. A cache wipe, a different browser, or a different
   machine loses the agent the user built up — identity, XP/level/confidence, personalization
   (dossier docs + persona), workstreams (chat history) and the station layout all live in
   localStorage under the `starnet.*` keys. This module is the safety net: one click bundles the
   nonsecret starnet.* records plus a read-only snapshot of the agent's backend memory (notebook) into a
   downloadable file, and import restores the local half on any browser. Back-compat: a backup
   exported BEFORE the Skynet→StarNet rename holds `skynet.*` keys + a `skynet.backup` schema; both
   import fine and are mapped forward to `starnet.*` on restore.

   v1 restores the browser-side state (which is what a wipe destroys). The notebook lives on the
   sidecar's own disk and is preserved IN the file for portability + a future restore route, but is
   not pushed back here — see docs note. Pure-ish: side effects are download + localStorage writes
   only; everything else returns plain summaries and never throws. */
'use strict';

const Backup = (() => {
  const SCHEMA = 'starnet.backup';
  const LEGACY_SCHEMA = 'skynet.backup';   // backups exported before the Skynet→StarNet rename
  const VERSION = 1;

  // every key we own lives under this prefix (starnet.save, starnet.specialties.v1, starnet.refit.seen,
  // theme/CRT prefs, ...). Capturing by prefix is future-proof: new keys ride along automatically
  // instead of needing this list kept in sync. LEGACY_PREFIX is the pre-rename name — still accepted on
  // IMPORT (an old backup file) and mapped forward, never written by a fresh export.
  const PREFIX = 'starnet.';
  const LEGACY_PREFIX = 'skynet.';
  const SAVE_KEY = 'starnet.save';
  const SECRET_POLICY = 'credentials-excluded';
  // BYOK is default-deny: only these known, nonsecret selections are portable. This keeps a future credential
  // field from silently entering a plaintext backup just because its storage key was added after this code.
  const SAFE_BYOK_KEYS = new Set([
    'starnet.byok.model',
    'starnet.byok.prov',
    'starnet.byok.reasoningEffort'
  ]);
  const SECRET_NAMESPACE_RE = /^starnet\.(?:channels?|oauth|auth|credentials?|secrets?)(?:[._:-]|$)/i;
  const SECRET_SEGMENT_RE = /(?:^|[._:-])(?:api[-_]?key|apikey|key|keys|token|tokens|secret|secrets|credential|credentials|password|passwd|pwd|authorization|bearer)(?:$|[._:-])/i;
  // map any captured key forward to its StarNet name (old backups hold skynet.* keys; new ones already starnet.*).
  function toCurrentKey(k) { return (k.indexOf(LEGACY_PREFIX) === 0) ? (PREFIX + k.slice(LEGACY_PREFIX.length)) : k; }

  function isCredentialKey(rawKey) {
    const key = toCurrentKey(String(rawKey || ''));
    if (key.indexOf('starnet.byok.') === 0) return !SAFE_BYOK_KEYS.has(key);
    return SECRET_NAMESPACE_RE.test(key) || SECRET_SEGMENT_RE.test(key);
  }

  function collectStore() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0 && !isCredentialKey(k)) out[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    return out;
  }

  function agentName() {
    try {
      const doc = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      return (doc && doc.agent && doc.agent.name) || 'agent';
    } catch (_) { return 'agent'; }
  }

  function slug(s) {
    return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  }

  function stamp(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // pull the agent's backend memory so the file is COMPLETE (portable to a fresh machine). Best-effort:
  // if the sidecar is unreachable we still export the local state.
  async function snapshotNotebook() {
    try {
      if (typeof Harness === 'undefined' || !Harness.notebook) return null;
      const notes = await Harness.notebook('agent');
      return Array.isArray(notes) ? notes : null;
    } catch (_) { return null; }
  }

  async function build() {
    return {
      schema: SCHEMA, version: VERSION, app: 'starnet',
      exportedAt: Date.now(),
      agentName: agentName(),
      secretsIncluded: false,
      secretPolicy: SECRET_POLICY,
      store: collectStore(),
      notebook: await snapshotNotebook()
    };
  }

  function triggerDownload(filename, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
      return true;
    } catch (e) { console.warn('[backup] download failed:', e); return false; }
  }

  async function exportAll() {
    const bundle = await build();
    const file = 'starnet-' + slug(bundle.agentName) + '-' + stamp(new Date()) + '.json';
    const ok = triggerDownload(file, JSON.stringify(bundle, null, 2));
    const records = Object.keys(bundle.store).length;
    return { ok, file, records, keys: records, secretsIncluded: false, notes: bundle.notebook ? bundle.notebook.length : 0 };
  }

  // validate a parsed bundle WITHOUT mutating anything — callers decide whether to apply.
  function validate(doc) {
    if (!doc || typeof doc !== 'object') return 'not a JSON object';
    if (doc.schema !== SCHEMA && doc.schema !== LEGACY_SCHEMA) return 'not a StarNet backup file';
    // FORWARD-VERSION GUARD (P0.3): a backup file whose envelope version is NEWER than this build understands
    // was exported by a later StarNet. Its store may carry key shapes/save schemas this code can't restore
    // faithfully, so refuse rather than importing a half-understood bundle. The import UI surfaces this string.
    if (Number(doc.version || 0) > VERSION) return 'backup was made by a newer StarNet (v' + Number(doc.version) + ') — update the app to import it';
    if (!doc.store || typeof doc.store !== 'object') return 'backup has no data';
    if (typeof doc.store[SAVE_KEY] !== 'string' && typeof doc.store['skynet.save'] !== 'string') return 'backup has no agent';
    return null;   // ok
  }

  // restore the local (browser) half: write every captured skynet.* key back verbatim. Returns a
  // summary; never throws. The notebook is preserved in the file but not pushed to the sidecar in v1.
  function applyBundle(doc) {
    const err = validate(doc);
    if (err) return { ok: false, error: err };
    let n = 0;
    try {
      const store = doc.store;
      for (const k in store) {
        if (!Object.prototype.hasOwnProperty.call(store, k) || typeof store[k] !== 'string') continue;
        if (k.indexOf(PREFIX) !== 0 && k.indexOf(LEGACY_PREFIX) !== 0) continue;   // ours (or a legacy ours) only
        if (isCredentialKey(k)) continue;                                        // portable files never grant credential authority
        localStorage.setItem(toCurrentKey(k), store[k]); n++;                       // map skynet.* -> starnet.* on the way in
      }
    } catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
    return { ok: true, records: n, keys: n, agentName: doc.agentName || agentName(), memories: Array.isArray(doc.notebook) ? doc.notebook.length : 0 };
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error || new Error('read failed'));
        fr.readAsText(file);
      } catch (e) { reject(e); }
    });
  }

  // push the bundle's memory snapshot back to the sidecar so a restored/moved agent isn't amnesiac. The route
  // merges additively (existing notes win), so this is safe to call even over an agent that already has memory.
  // Best-effort: a UI-only preview or unreachable sidecar just yields 0 restored.
  function restoreNotebook(notes) {
    return fetch('/api/notebook/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'agent', notes: notes })
    }).then(r => r.ok ? r.json() : null).then(j => (j && j.ok) ? (j.added || 0) : 0).catch(() => 0);
  }

  async function importFile(file) {
    let doc;
    try { doc = JSON.parse(await readFileText(file)); }
    catch (_) { return { ok: false, error: 'file is not valid JSON' }; }
    const res = applyBundle(doc);
    if (res.ok) {
      // A portable backup is an explicit restore, unlike an ordinary page load.
      // Restore its autonomy through the durable writer before claiming success.
      const posture = doc.store && (doc.store['starnet.autonomy.v1'] || doc.store['skynet.autonomy.v1']);
      if (posture && typeof AutonomyStore !== 'undefined' && AutonomyStore.importState) {
        try {
          const result = await AutonomyStore.importState(JSON.parse(posture));
          if (!result.ok) return { ok: false, error: 'Backup partly restored; autonomy was not confirmed. ' + (result.error || 'Try again when the station is connected.') };
        } catch (_) { return { ok: false, error: 'Backup partly restored; its autonomy setting could not be restored.' }; }
      }
    }
    if (res.ok) {
      // re-stamp the imported save to NOW and write it through to the durable sidecar mirror. The bundle carries
      // the export-time updatedAt; without this, a boot-reconcile on a machine whose sidecar holds a NEWER save
      // would silently revert the just-imported agent. Stamping now() makes the import win the anti-clobber guard.
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (raw) {
          const d = JSON.parse(raw); d.updatedAt = Date.now();
          localStorage.setItem(SAVE_KEY, JSON.stringify(d));
          if (typeof CloudSave !== 'undefined' && CloudSave.push) CloudSave.push(d);
        }
      } catch (_) {}
    }
    if (res.ok && Array.isArray(doc.notebook) && doc.notebook.length) {
      res.memoriesRestored = await restoreNotebook(doc.notebook);   // fold memory back into the sidecar
    }
    return res;
  }

  return { exportAll, importFile, applyBundle, validate, collectStore, build, isCredentialKey, SCHEMA, VERSION, SECRET_POLICY };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
