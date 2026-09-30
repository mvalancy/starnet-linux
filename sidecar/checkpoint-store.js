/* sidecar/checkpoint-store.js — the AMBIENT edge of the checkpoint rollback net (execution-spine Commit 1).

   The pure half (sidecar/checkpoint.js) owns the snapshot INDEX + rollback math; this file owns the actual
   content-addressed shadow store: a per-agent shadow GIT repo whose git-dir lives OUTSIDE the agent's fs jail
   (WORKSPACES/.checkpoints/<agentId>/git) with the agent's workspace (WORKSPACES/<agentId>) as its work-tree.
   `git add -A` + commit per snapshot gives content-addressing, dedup, and cheap restore for free with zero deps.
   Because the git-dir is a SIBLING of the jail (never inside WORKSPACES/<agentId>/), the agent's own fs.* and
   shell tools can neither read nor rewrite their own history.

   Every ambient dependency is INJECTED (fs, path, the git runner, the clock) so it is headless-testable with a
   real temp dir + real git + a fake clock; there is NO Date.now / Math.random / new Date() here (the snapshot id
   IS the git commit sha, content-derived, never minted), so it passes lint-determinism.js. core.autocrlf/safecrlf
   are forced off so an agent's files are stored and restored BYTE-EXACT (no line-ending mangling = no silent
   corruption). All git failures FAIL-OPEN (a snapshot/restore problem must never crash a run); the host decides
   whether a missing checkpoint should block a dangerous tool.

   makeCheckpointStore({ fs, pathMod, root, runGit, clock, keep?, scopeIdOf?, allowWorkTree? })
     -> { snapshot, restore, restoreDetailed, list, isValidId }
     runGit(args:string[], { cwd }) -> Promise<{ code:int|string, stdout, stderr }>   // resolves, never rejects
     snapshot(agentId, { runId, turn, label, workTree? }) -> Promise<{ id, created:bool, files, bytes } | null>
     restore(agentId, snapshotId)              -> Promise<bool>   // only restores an id IN this agent's index
     restoreDetailed(agentId, snapshotId)      -> Promise<{ ok, reason?, preRestoreId? }>   // + the pre-restore undo id
     list(agentId)                             -> { version, snapshots } */
'use strict';
(function (root, factory) {
  const cp = typeof require === 'function' ? require('./checkpoint.js') : (root.SK && root.SK.checkpoint);
  // durable single-file replace (fsync-before-rename); the injected-fs primitive degrades to writeFileSync+rename
  // for a test/in-memory fs without fsync, so it stays deterministic + testable.
  let dw = null;
  try { dw = typeof require === 'function' ? require('./durable-write.js') : (root.SK && root.SK.durableWrite); } catch (_) {}
  const api = factory(cp, dw && dw.writeFileDurable);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).checkpointStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cp, writeFileDurableInjected) {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  // fallback: if durable-write couldn't be loaded (browser bundle), do a plain atomic temp+rename.
  const writeFileDurable = typeof writeFileDurableInjected === 'function' ? writeFileDurableInjected
    : function (deps, file, data) { const f = deps.fs; const tmp = file + '.' + (typeof process !== 'undefined' ? process.pid : 'p') + '.tmp'; f.writeFileSync(tmp, data); f.renameSync(tmp, file); };

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;            // the notebook/fs-jail agentId grammar
  const SCOPE_RE = /^[a-f0-9]{16,64}$/;               // host-derived digest of one canonical project root
  const KEEP_DEFAULT = 50;                            // snapshots retained per agent (prune oldest beyond this)
  const MAX_REPO_BYTES_DEFAULT = 500 * 1024 * 1024;   // shadow-repo size ceiling (500MB) before a gc/re-init sweep

  function makeCheckpointStore(deps) {
    const d = deps || {};
    const fs = d.fs, pathMod = d.pathMod, root = d.root, runGit = d.runGit;
    const clock = d.clock || { now: function () { return 0; } };
    const scopeIdOf = typeof d.scopeIdOf === 'function' ? d.scopeIdOf : null;
    const allowWorkTree = typeof d.allowWorkTree === 'function' ? d.allowWorkTree : function () { return false; };
    const keep = d.keep != null ? d.keep : KEEP_DEFAULT;
    const maxRepoBytes = d.maxRepoBytes != null ? d.maxRepoBytes : MAX_REPO_BYTES_DEFAULT;
    if (!fs || !pathMod || !root || typeof runGit !== 'function') throw new Error('checkpoint-store: fs/pathMod/root/runGit are required');

    const defaultWorkTreeFor = (aid) => pathMod.join(root, aid);
    const scopeBaseFor = (aid, scopeId) => scopeId
      ? pathMod.join(root, '.checkpoints', aid, 'roots', scopeId)
      : pathMod.join(root, '.checkpoints', aid);
    const gitDirFor = (aid, scope) => pathMod.join(scopeBaseFor(aid, scope && scope.id), 'git');
    const workTreeFor = (aid, scope) => (scope && scope.workTree) || defaultWorkTreeFor(aid);
    const indexFileFor = (aid) => pathMod.join(root, '.checkpoints', aid, 'index.json');
    const scopeFileFor = (aid, scopeId) => pathMod.join(scopeBaseFor(aid, scopeId), 'scope.json');

    function samePath(a, b) {
      let x = pathMod.resolve(String(a || '')), y = pathMod.resolve(String(b || ''));
      if (pathMod.sep === '\\') { x = x.toLowerCase(); y = y.toLowerCase(); }
      return x === y;
    }
    function canonicalWorkTree(p) {
      let out = pathMod.resolve(String(p || ''));
      try { if (typeof fs.realpathSync === 'function') out = fs.realpathSync(out); } catch (_) {}
      return out;
    }
    function externalScope(aid, requested, authorized) {
      if (!requested) return { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      const workTree = canonicalWorkTree(requested);
      if (samePath(workTree, defaultWorkTreeFor(aid))) return { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      if (!scopeIdOf || (authorized !== true && allowWorkTree(workTree, aid) !== true)) return null;
      const id = String(scopeIdOf(workTree) || '').toLowerCase();
      if (!SCOPE_RE.test(id)) return null;
      return { id: id, workTree: workTree, prefix: id + ':' };
    }
    function readScopeSaved(aid, scopeId) {
      if (!scopeId) return { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      if (!SCOPE_RE.test(String(scopeId || ''))) return null;
      try {
        const saved = JSON.parse(fs.readFileSync(scopeFileFor(aid, scopeId), 'utf8'));
        if (!saved || saved.scopeId !== scopeId || !saved.workTree) return null;
        const workTree = canonicalWorkTree(saved.workTree);
        if (!samePath(workTree, saved.workTree)) return null;
        return { id: scopeId, workTree: workTree, prefix: scopeId + ':' };
      } catch (_) { return null; }
    }
    function readScope(aid, scopeId) {
      const scope = readScopeSaved(aid, scopeId);
      return scope && allowWorkTree(scope.workTree, aid) === true ? scope : null;
    }
    function saveScope(aid, scope) {
      if (!scope || !scope.id) return true;
      const file = scopeFileFor(aid, scope.id);
      try {
        const prior = readScopeSaved(aid, scope.id);
        if (prior) return samePath(prior.workTree, scope.workTree);
        fs.mkdirSync(pathMod.dirname(file), { recursive: true });
        writeFileDurable({ fs: fs, path: pathMod }, file, JSON.stringify({ version: 1, scopeId: scope.id, workTree: scope.workTree }));
        return true;
      } catch (_) { return false; }
    }

    // the leading git args that pin the shadow git-dir + work-tree and force byte-exact, identity-stable commits.
    function base(aid, scope) {
      return ['--git-dir', gitDirFor(aid, scope), '--work-tree', workTreeFor(aid, scope),
        '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
        '-c', 'user.email=starnet@local', '-c', 'user.name=starnet'];
    }
    const git = (aid, scope, args) => runGit(base(aid, scope).concat(args), { cwd: workTreeFor(aid, scope) });

    // read the index file into a tagged result so the caller can distinguish a genuinely-empty index (no
    // snapshots recorded) from a torn/corrupt one that should trigger a git-log rebuild.
    //   { status:'ok', index }   — parsed to a non-empty index
    //   { status:'empty' }       — parsed but zero snapshots (or a legitimately empty index)
    //   { status:'corrupt' }     — file present but unparseable / absent
    function readIndexRaw(aid) {
      let raw;
      try { raw = fs.readFileSync(indexFileFor(aid), 'utf8'); }
      catch (e) {
        // ENOENT alone means "no index" (recovery/rebuild allowed). Any OTHER errno is a TRANSIENT read
        // failure (AV/backup software holding the file, fd exhaustion) — the durable-store law: conflating
        // it with absent let the LOSSY git rebuild (runId/turn are not recoverable from git) overwrite a
        // perfectly good index the moment one read hiccuped, permanently killing rollback-by-run.
        return { status: (e && e.code === 'ENOENT') ? 'corrupt' : 'unreadable' };
      }
      if (raw == null || String(raw).length === 0) return { status: 'corrupt' };   // torn write
      let obj; try { obj = JSON.parse(raw); } catch (e) { return { status: 'corrupt' }; }
      const idx = cp.loadIndex(obj);
      return idx.snapshots.length ? { status: 'ok', index: idx } : { status: 'empty', index: idx };
    }
    // SYNC load: main index file, else its <file>.bak last-known-good, else empty. Never rebuilds (git is async).
    // Callers that CAN await use loadIndexResilient below to rebuild from the commit history when both are gone.
    function loadIndex(aid) {
      const m = readIndexRaw(aid);
      if (m.status === 'ok' || m.status === 'empty') return m.index;
      // main torn/corrupt/absent -> try the .bak snapshot.
      try {
        const braw = fs.readFileSync(indexFileFor(aid) + '.bak', 'utf8');
        if (braw && String(braw).length) { const b = cp.loadIndex(JSON.parse(braw)); if (b.snapshots.length) return b; }
      } catch (_) {}
      return cp.toIndex([]);                           // missing/corrupt + no .bak -> empty (fail-closed)
    }
    function saveIndex(aid, index) {                  // atomic + durable temp+rename with a .bak snapshot; throws on failure (the caller fail-opens)
      const f = indexFileFor(aid);
      fs.mkdirSync(pathMod.dirname(f), { recursive: true });
      // snapshot the current clean index to <file>.bak (durably) before overwriting, so a torn replace of the
      // index can be recovered from the prior committed copy. Best-effort — a .bak failure never blocks the save.
      try {
        const cur = fs.readFileSync(f, 'utf8');
        if (cur && String(cur).length) { try { JSON.parse(cur); writeFileDurable({ fs: fs, path: pathMod }, f + '.bak', cur); } catch (_) {} }
      } catch (_) {}
      writeFileDurable({ fs: fs, path: pathMod }, f, JSON.stringify(cp.toIndex(index.snapshots)));
    }

    // does this agent have a real shadow git repo on disk? (its commits are the ground truth for a rebuild.)
    function repoExists(aid, scope) {
      try { return fs.existsSync(pathMod.join(gitDirFor(aid, scope), 'HEAD')); } catch (_) { return false; }
    }
    function recordedScopes(aid) {
      const scopes = [{ id: '', workTree: defaultWorkTreeFor(aid), prefix: '' }];
      let names = [];
      try { names = fs.readdirSync(pathMod.join(root, '.checkpoints', aid, 'roots')); } catch (_) {}
      for (const name of names) {
        // Rebuilding the index reads only the station-owned shadow git + scope metadata. Keep revoked roots in
        // the list as unavailable restore points; do not erase their recoverable history just because authority
        // is currently absent. Actual restore still re-checks readScope() and fails closed.
        const scope = readScopeSaved(aid, String(name));
        if (scope) scopes.push(scope);
      }
      return scopes;
    }
    /* rebuildIndexFromGit — the shadow git COMMITS are the truth; the index.json is just a cache of them. When
       the index is empty/corrupt but the repo has commits, reconstruct the index by walking `git log`. The
       commit subject is what snapshot() wrote as `label`; runId/turn aren't recoverable from git, so they come
       back empty/0 (rollback-by-run degrades, but per-id restore + the list view are fully restored). Oldest-
       first so lineage (parentId defaults to the prior snapshot) threads correctly through cp.record. */
    async function rebuildIndexFromGit(aid) {
      const rows = [];
      for (const scope of recordedScopes(aid)) {
        if (!repoExists(aid, scope)) continue;
        // %H = full sha, %ct = committer unix seconds, %s = subject. Cross-root rows are sorted by timestamp
        // below, while parentId remains scoped to the prior commit in this exact root.
        const r = await git(aid, scope, ['log', '--reverse', '--format=%H%x09%ct%x09%s']);
        if (!r || r.code !== 0 || !r.stdout) continue;
        for (const line of r.stdout.split('\n')) rows.push({ line: line, scope: scope });
      }
      if (!rows.length) return cp.toIndex([]);
      const parsed = [];
      for (const row of rows) {
        const line = row.line;
        if (!line.trim()) continue;
        const tab1 = line.indexOf('\t'); if (tab1 < 0) continue;
        const tab2 = line.indexOf('\t', tab1 + 1);
        const sha = line.slice(0, tab1).trim();
        const ctSec = Number(line.slice(tab1 + 1, tab2 < 0 ? undefined : tab2).trim());
        const label = tab2 < 0 ? '' : line.slice(tab2 + 1);
        if (!cp.isValidId(sha)) continue;
        parsed.push({ sha: sha, ts: isFinite(ctSec) ? ctSec * 1000 : clock.now(), label: label, scope: row.scope });
      }
      parsed.sort(function (a, b) { return a.ts - b.ts; });
      let index = cp.toIndex([]);
      const heads = {};
      for (const row of parsed) {
        const fullId = row.scope.prefix + row.sha;
        try {
          index = cp.record(index, {
            id: fullId, runId: '', turn: 0, label: row.label, files: 0, bytes: 0,
            parentId: heads[row.scope.id] || null, scopeId: row.scope.id,
            workTree: row.scope.id ? row.scope.workTree : '', gitCommit: row.sha
          }, { now: row.ts, keep: keep });
          heads[row.scope.id] = fullId;
        } catch (_) { /* skip a record git surfaced that cp rejects */ }
      }
      return index;
    }
    /* loadIndexResilient — the ASYNC load: the sync index/.bak first, and if BOTH are gone/empty while the
       shadow repo still holds commits, rebuild the index from git and RE-PERSIST it so subsequent sync reads
       are fast again. Used by every await-capable caller (snapshot/restore/the list route). */
    async function loadIndexResilient(aid) {
      const m = readIndexRaw(aid);
      if (m.status === 'ok') return m.index;
      // TRANSIENT read failure: serve .bak/empty for THIS pass and never rebuild — the rebuild's
      // re-persist would overwrite the (still intact) index with the lossy git reconstruction.
      if (m.status === 'unreadable') return loadIndex(aid);
      // main empty/corrupt -> try .bak (sync), then git rebuild.
      const viaBak = loadIndex(aid);                   // consults main + .bak
      if (viaBak.snapshots.length) return viaBak;
      const rebuilt = await rebuildIndexFromGit(aid);
      if (rebuilt.snapshots.length) {
        try { saveIndex(aid, rebuilt); } catch (e) { failNote('checkpoint.index.persist', e); }
        try { console.warn('[checkpoint] rebuilt index for ' + aid + ' from ' + rebuilt.snapshots.length + ' shadow-git commits (index.json was empty/corrupt)'); } catch (_) {}
        return rebuilt;
      }
      return m.status === 'empty' ? m.index : cp.toIndex([]);
    }

    // best-effort size of the snapshot (cosmetic, for the event) — tracked file count + summed bytes.
    async function measure(aid, scope) {
      try {
        const r = await git(aid, scope, ['ls-files']);
        const files = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
        let bytes = 0;
        for (const rel of files) { try { bytes += fs.statSync(pathMod.join(workTreeFor(aid, scope), rel)).size; } catch (_) {} }
        return { files: files.length, bytes: bytes };
      } catch (e) { return { files: 0, bytes: 0 }; }
    }

    // recursive byte size of a directory (best-effort; a stat failure counts 0 for that entry). Used to decide
    // whether the shadow repo's object store has grown past the ceiling.
    function dirBytes(dir) {
      let total = 0;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
      for (const ent of entries) {
        const full = pathMod.join(dir, ent.name);
        try {
          if (ent.isDirectory && ent.isDirectory()) total += dirBytes(full);
          else total += fs.statSync(full).size;
        } catch (_) {}
      }
      return total;
    }

    /* enforceSizeCeiling — bound the shadow repo's on-disk footprint. `git add -A` on every mutating turn writes
       a fresh blob per changed file; over months of 24/7 use the object store bloats even though only the last
       `keep` snapshots are reachable via the index (rollback older than that is already impossible). Strategy:
       1) `git gc --prune=now` — the cheap, LOSSLESS reclaim of loose/unreferenced objects (the dominant bloat
          from add churn + pruned blobs). Every indexed snapshot SHA stays intact + restorable.
       2) if it's STILL over ceiling after gc, RE-INIT from the current tree: the object store is unbounded only
          because deep history is retained, yet that history is unreachable via the index (>keep). Re-init makes a
          fresh single-commit repo of the current worktree, then RE-STAMPS the index to that one commit. This
          sacrifices the older in-index rollback points to keep disk bounded — a disclosed, honest tradeoff, taken
          ONLY past the ceiling. Fail-open: any git failure leaves the repo as-is (never crash a run).
       Returns { swept, reinit, bytesBefore, bytesAfter } for tests/telemetry. */
    async function enforceSizeCeiling(aid, scope) {
      if (!(maxRepoBytes > 0) || !repoExists(aid, scope)) return { swept: false, reinit: false };
      const gitDir = gitDirFor(aid, scope);
      const before = dirBytes(gitDir);
      if (before <= maxRepoBytes) return { swept: false, reinit: false, bytesBefore: before, bytesAfter: before };
      try { await git(aid, scope, ['gc', '--prune=now', '-q']); } catch (_) {}
      let after = dirBytes(gitDir);
      let reinit = false;
      if (after > maxRepoBytes) {
        reinit = await reinitFromCurrentTree(aid, scope);
        after = dirBytes(gitDir);
      }
      try { console.warn('[checkpoint] shadow repo for ' + aid + ' over ceiling (' + before + 'B) -> ' + (reinit ? 're-init' : 'gc') + ' -> ' + after + 'B'); } catch (_) {}
      return { swept: true, reinit: reinit, bytesBefore: before, bytesAfter: after };
    }
    // wipe the shadow git-dir and re-create a single baseline commit of the CURRENT worktree, then re-stamp the
    // index to that one snapshot. Returns true on success. Fail-open (false) leaves the repo untouched on error.
    async function reinitFromCurrentTree(aid, scope) {
      try {
        const gitDir = gitDirFor(aid, scope);
        /* BUILD THE REPLACEMENT FIRST, DESTROY SECOND. Deleting the history and only then running
           init/add/commit meant any failure — disk full (the very state that trips the ceiling), or a
           stale index.lock — returned false with the WHOLE shadow repo already gone while the index kept
           advertising snapshots whose objects no longer existed: every rewind point a silent lie, and
           readIndexRaw's 'ok' meant the git rebuild never ran to notice. The fresh baseline is now proven
           in a SIDE git-dir; the old repo is removed only after commit + rev-parse succeed, and the swap
           is two renames with a restore on failure. */
        const fresh = gitDir + '.reinit';
        const cleanup = () => { try { fs.rmSync(fresh, { recursive: true, force: true }); } catch (e) { failNote('checkpoint.reinit.cleanup', e); } };
        cleanup();
        fs.mkdirSync(fresh, { recursive: true });
        const gitAt = (dir, args) => runGit(['--git-dir', dir, '--work-tree', workTreeFor(aid, scope),
          '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
          '-c', 'user.email=starnet@local', '-c', 'user.name=starnet'].concat(args), { cwd: workTreeFor(aid, scope) });
        if ((await gitAt(fresh, ['init', '-q'])).code !== 0) { cleanup(); return false; }
        if ((await gitAt(fresh, ['add', '-A'])).code !== 0) { cleanup(); return false; }
        const com = await gitAt(fresh, ['commit', '-q', '--allow-empty', '-m', 'baseline (repo re-init: size ceiling)']);
        if (com.code !== 0) { cleanup(); return false; }
        const sha = (await gitAt(fresh, ['rev-parse', 'HEAD'])).stdout.trim();
        if (!cp.isValidId(sha)) { cleanup(); return false; }
        const old = gitDir + '.old';
        try { fs.rmSync(old, { recursive: true, force: true }); } catch (e) { failNote('checkpoint.reinit.old', e); }
        try { fs.renameSync(gitDir, old); } catch (_) { cleanup(); return false; }
        try { fs.renameSync(fresh, gitDir); }
        catch (_) {
          // failed swap: put the original history back — a restore failure here is the one truly bad exit
          try { fs.renameSync(old, gitDir); } catch (e) { failNote('checkpoint.reinit.restore', e); }
          cleanup(); return false;
        }
        try { fs.rmSync(old, { recursive: true, force: true }); } catch (e) { failNote('checkpoint.reinit.old', e); }
        try {
          const size = await measure(aid, scope);
          const existing = await loadIndexResilient(aid);
          const others = existing.snapshots.filter(function (s) { return String((s && s.scopeId) || '') !== String((scope && scope.id) || ''); });
          const fullId = (scope && scope.prefix || '') + sha;
          saveIndex(aid, cp.record(cp.toIndex(others), {
            id: fullId, runId: '', turn: 0, parentId: null, label: 'baseline (re-init)', files: size.files, bytes: size.bytes,
            scopeId: (scope && scope.id) || '', workTree: scope && scope.id ? scope.workTree : '', gitCommit: sha
          }, { now: clock.now(), keep: keep }));
        } catch (e) { failNote('checkpoint.index.persist', e); }
        return true;
      } catch (_) { return false; }
    }

    /* snapshot — capture the agent's CURRENT workspace state (taken BEFORE a mutating tool, so it is the
       pre-mutation rollback point). Deduped by content: if nothing changed since the last snapshot, no new
       commit is made and the existing head is returned (created:false). Fail-open: returns null on any git error. */
    async function snapshot(agentId, meta) {
      meta = meta || {};
      if (!AID_RE.test(String(agentId || ''))) return null;
      const aid = String(agentId);
      const scope = externalScope(aid, meta.workTree, meta.authorizedWorkTree === true);
      if (!scope || !saveScope(aid, scope)) return null;
      return commitSnapshot(aid, scope, meta, null);
    }
    /* commitSnapshot — the one snapshot code path, on an already-resolved scope. opts.always: commit even when
       nothing changed (--allow-empty) so the index gets its OWN labelled row (restore's pre-restore undo point);
       opts.skipCeiling: don't run the size-ceiling sweep, whose re-init could drop the very history a caller is
       about to restore from. Fail-open: null on any git error. */
    async function commitSnapshot(aid, scope, meta, opts) {
      meta = meta || {}; opts = opts || {};
      try {
        fs.mkdirSync(workTreeFor(aid, scope), { recursive: true });
        fs.mkdirSync(gitDirFor(aid, scope), { recursive: true });
        // init the shadow repo once (idempotent: re-running init on an existing repo is harmless).
        if (!fs.existsSync(pathMod.join(gitDirFor(aid, scope), 'HEAD'))) {
          const ini = await git(aid, scope, ['init', '-q']);
          if (ini.code !== 0) return null;
        }
        const add = await git(aid, scope, ['add', '-A']);
        if (add.code !== 0) return null;
        const hasHead = (await git(aid, scope, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
        if (hasHead && !opts.always) {
          const diff = await git(aid, scope, ['diff', '--cached', '--quiet', 'HEAD']);   // code 0 => nothing staged changed
          if (diff.code === 0) {
            const head = (await git(aid, scope, ['rev-parse', 'HEAD'])).stdout.trim();
            const fullId = scope.prefix + head;
            return cp.isValidId(head) && cp.isValidId(fullId)
              ? { id: fullId, created: false, files: 0, bytes: 0, workTree: scope.id ? scope.workTree : '' }
              : null;
          }
        }
        const label = meta.label != null ? String(meta.label) : 'snapshot';
        const commitArgs = ['commit', '-q', '-m', label];
        if (!hasHead || opts.always) commitArgs.push('--allow-empty');           // baseline even for an empty workspace
        const com = await git(aid, scope, commitArgs);
        if (com.code !== 0) return null;
        const sha = (await git(aid, scope, ['rev-parse', 'HEAD'])).stdout.trim();
        if (!cp.isValidId(sha)) return null;
        const fullId = scope.prefix + sha;
        if (!cp.isValidId(fullId)) return null;
        const size = await measure(aid, scope);
        try {
          /* THE RESILIENT LOADER, not the sync one. `loadIndex` reads only index.json + index.json.bak and returns
             an EMPTY index on failure — it deliberately never rebuilds, because git is async. snapshot() IS async,
             and it was the one await-capable caller still using the sync loader (the module's own docstring says
             loadIndexResilient is "used by every await-capable caller (snapshot/restore/the list route)").

             The cost of the shortcut: after a crash that lost index.json AND its .bak while the shadow repo
             survived, the very next mutating tool call recorded on top of an EMPTY index and persisted ONE entry.
             From then on readIndexRaw reports 'ok', so loadIndexResilient short-circuits and never reaches the
             git-log rebuild again — the rewind UI showed a single restore point and restore() refused every
             surviving commit, permanently. The header's law is "the shadow git COMMITS are the truth; index.json
             is just a cache of them", and this was the one writer that did not honour it. It also made the catch
             below false: a commit missing from a NON-empty index is not restorable via restore() at all. */
          const prior = await loadIndexResilient(aid);
          const priorInScope = prior.snapshots.slice().reverse().find(function (s) {
            return String((s && s.scopeId) || '') === scope.id;
          });
          const index = cp.record(prior,
            { id: fullId, runId: meta.runId, turn: meta.turn, parentId: priorInScope ? priorInScope.id : null,
              label: label, files: size.files, bytes: size.bytes, scopeId: scope.id,
              workTree: scope.id ? scope.workTree : '', gitCommit: sha },
            { now: clock.now(), keep: keep });
          saveIndex(aid, index);
        } catch (e) { failNote('checkpoint.index.persist', e); }
        // bound the shadow repo's on-disk footprint after each real commit (no-op unless past the ceiling).
        if (!opts.skipCeiling) { try { await enforceSizeCeiling(aid, scope); } catch (e) { failNote('checkpoint.sizeCeiling', e); } }
        return { id: fullId, created: true, files: size.files, bytes: size.bytes, workTree: scope.id ? scope.workTree : '' };
      } catch (e) { return null; }                                               // fail-open
    }

    /* restore — hard-reset the agent's work-tree to a snapshot (and remove files created since). Only restores a
       snapshotId that is RECORDED in this agent's index — never an arbitrary ref. Returns false on any failure.

       UNDO THE UNDO. `reset --hard` + `clean -fd` used to run with no snapshot of the CURRENT state: the
       Commander's own hand edits since the last agent snapshot, and any new untracked file, were destroyed and
       existed nowhere in the shadow history (audit probe 09-22: an edited v3 and a new draft-by-commander.txt,
       both gone). Before touching the tree, restore now commits the current work tree — tracked changes AND
       untracked non-ignored files, through the SAME `add -A` path every snapshot uses, so the same ignore rules
       apply — as its own labelled 'pre-restore' row in this agent's index (always a new row, even when nothing
       changed, so the undo point is explicit). Restoring THAT id brings the edits and the untracked files back.
       If the pre-restore snapshot cannot be taken AND proven in the index, the restore REFUSES and the tree is
       untouched: a rewind must never destroy state it cannot give back. Files the ignore rules exclude are
       neither snapshotted nor removed (`clean -fd` without -x), exactly as before.
         restoreDetailed(agentId, id) -> { ok, reason?, preRestoreId? }   restore(agentId, id) -> bool */
    async function restoreDetailed(agentId, snapshotId) {
      if (!AID_RE.test(String(agentId || '')) || !cp.isValidId(String(snapshotId || ''))) return { ok: false, reason: 'invalid' };
      const aid = String(agentId), fullId = String(snapshotId);
      // resilient load: if index.json was wiped but the commit still exists, a git-log rebuild re-admits it so
      // a rollback target survives an index loss (the commits are the truth).
      const record = cp.findById(await loadIndexResilient(aid), fullId);
      if (!record) return { ok: false, reason: 'unknown' };                       // refuse an id we didn't record
      const scope = record.scopeId ? readScope(aid, String(record.scopeId))
        : { id: '', workTree: defaultWorkTreeFor(aid), prefix: '' };
      if (!scope) return { ok: false, reason: 'unavailable' };                    // revoked/missing/mismatched project root
      const sha = record.gitCommit || fullId;
      if (!cp.isValidId(String(sha || ''))) return { ok: false, reason: 'invalid' };
      if (scope.id && fullId !== scope.prefix + sha) return { ok: false, reason: 'invalid' };   // root identity is part of the id
      const pre = await commitSnapshot(aid, scope,
        { runId: '', turn: 0, label: 'pre-restore (before rewinding to ' + String(sha).slice(0, 12) + ')' },
        { always: true, skipCeiling: true });
      let preRecorded = false;
      try { preRecorded = !!(pre && pre.created && cp.findById(await loadIndexResilient(aid), pre.id)); }
      catch (e) { failNote('checkpoint.restore.preRestoreIndex', e); }
      if (!preRecorded) return { ok: false, reason: 'pre_restore_failed' };       // nothing touched: no undo point, no rewind
      try {
        const reset = await git(aid, scope, ['reset', '--hard', '-q', sha]);
        if (reset.code !== 0) return { ok: false, reason: 'git_failed', preRestoreId: pre.id };
        const clean = await git(aid, scope, ['clean', '-fd', '-q']);             // drop files added after the snapshot
        if (clean.code !== 0) return { ok: false, reason: 'git_failed', preRestoreId: pre.id };
        return { ok: true, preRestoreId: pre.id };
      } catch (e) { failNote('checkpoint.restore.git', e); return { ok: false, reason: 'git_failed', preRestoreId: pre.id }; }
    }
    async function restore(agentId, snapshotId) { return (await restoreDetailed(agentId, snapshotId)).ok === true; }

    function withAvailability(aid, index) {
      return cp.toIndex((index && index.snapshots || []).map(function (s) {
        return Object.assign({}, s, { restoreAvailable: !s.scopeId || !!readScope(aid, String(s.scopeId)) });
      }));
    }
    function list(agentId) {
      if (!AID_RE.test(String(agentId || ''))) return cp.toIndex([]);
      const aid = String(agentId);
      return withAvailability(aid, loadIndex(aid));
    }
    // async list that rebuilds from the shadow git commits when the index.json is empty/corrupt but the repo
    // has history — so the "rewind" UI repopulates after an index loss. The route awaits this.
    async function listResilient(agentId) {
      if (!AID_RE.test(String(agentId || ''))) return cp.toIndex([]);
      const aid = String(agentId);
      return withAvailability(aid, await loadIndexResilient(aid));
    }

    return { snapshot: snapshot, restore: restore, restoreDetailed: restoreDetailed, list: list, listResilient: listResilient, rebuild: rebuildIndexFromGit, enforceSizeCeiling: enforceSizeCeiling, isValidId: cp.isValidId };
  }

  return { makeCheckpointStore: makeCheckpointStore };
});
