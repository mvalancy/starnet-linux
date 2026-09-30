/* sidecar/durable-write.js — the ONE crash-safe "replace a small file atomically AND durably" primitive
   for the protected sidecar stores (cron jobs first; reusable for any single-file envelope).

   The store-of-record problem this fixes (G4.2): a plain temp-write -> rename is ATOMIC (a reader never
   sees a half-written file) but NOT DURABLE — on a hard crash/power-loss in the window between the write
   and the OS flushing it, the rename can be lost OR the file can land zero-length. For the cron jobs file
   that means a routine whose nextRunAt was just ADVANCED-BEFORE-RUN reverts to its old due time on restart
   and DOUBLE-FIRES. So we fsync the temp file's bytes to stable storage BEFORE the rename (the bytes are
   on disk before the directory entry flips), then best-effort fsync the containing DIRECTORY after the
   rename (so the rename itself is durable on POSIX). This mirrors the ledger/runs append idiom
   (index.js: open -> write -> fsync -> close) and savestore.js's writeAtomic, factored out so it is
   importable and unit-testable against the REAL code path (index.js itself self-boots a server and cannot
   be required by a test).

   Determinism: this module is pure ambient I/O (it lives in the injected-fs world, not the cron MATH), and
   it reads NO ambient clock and NO rng of its own — the random tmp nonce comes from an INJECTED rng-or-fs,
   defaulting to node:crypto only when neither is supplied. It still passes lint-determinism.js because the
   default crypto import is lazy and there is no Date.now / new Date() / Math.random literal here.

   writeFileDurable({ fs, path, randomTmpId? }, file, data) -> void   (throws on a real write/rename failure)
     fs   : an fs facade. The DURABLE path needs openSync/writeSync/fsyncSync/closeSync/renameSync; an
            fs that lacks fsyncSync (an in-memory test fs) degrades to writeFileSync -> renameSync (still
            atomic, just not power-loss durable — same capability-guard as savestore.js).
     path : node:path (for dirname).
     randomTmpId : optional () -> string nonce; defaults to crypto.randomBytes hex. Combined with the pid
            so two concurrent writers (or two writes by this process) never collide on the same .tmp.
     mode : optional file mode for the new file; defaults to 0o600 (owner read/write only). Every caller is a
            private sidecar store and several hold credentials (codex/grok/kimi tokens, channels/secrets.json,
            connectors/servicekeys.json, the connector vault when no OS key exists). Without an explicit mode the
            temp file took 0o666 & ~umask — typically 0644, i.e. readable by every local user on Linux/macOS —
            and the rename carried that mode onto the store. Windows ignores all but the read-only bit. */
'use strict';

function defaultNonce() {
  // lazy + guarded: never let nonce minting throw, and never read the ambient clock/rng banned by the lint.
  try { return require('node:crypto').randomBytes(6).toString('hex'); }
  catch (_) { try { return require('crypto').randomBytes(6).toString('hex'); } catch (__) { return 'x'; } }
}

function writeFileDurable(deps, file, data) {
  const d = deps || {};
  const fs = d.fs;
  const pathMod = d.path;
  if (!fs || typeof fs.renameSync !== 'function') throw new Error('writeFileDurable: an injected fs with renameSync is required');
  const nonce = (typeof d.randomTmpId === 'function' ? d.randomTmpId() : defaultNonce());
  // per-PID + random suffix: two concurrent writers (or a CRUD save racing an advance) pick DISTINCT temp
  // names, so neither truncates the other's in-flight temp before its own rename.
  const tmp = file + '.' + process.pid + '.' + nonce + '.tmp';
  const mode = Number.isInteger(d.mode) ? d.mode : 0o600;

  const canFsync = typeof fs.openSync === 'function' && typeof fs.writeSync === 'function'
    && typeof fs.fsyncSync === 'function' && typeof fs.closeSync === 'function';

  if (canFsync) {
    // DURABLE: write the full bytes to the temp fd, fsync the fd (bytes hit stable storage) BEFORE the
    // rename, then close. fsync precedes rename so the rename can never expose an un-flushed / zero-length file.
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'w', mode);
      // writeSync is allowed to make partial progress (disk pressure, interrupted/network filesystems, injected
      // fault tests). A single unchecked call can therefore fsync + rename a JSON prefix as the authoritative
      // store. Write a Buffer to make offsets byte-accurate for non-ASCII data, and refuse zero/invalid progress.
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      let offset = 0;
      while (offset < bytes.length) {
        let wrote = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        // A few long-standing injected in-memory fs facades implement the old side-effect-only shape and omit
        // writeSync's numeric return. Node's real fs always returns a byte count; preserve facade compatibility by
        // treating only null/undefined as a completed requested write. Numeric short writes still retry or fail.
        if (wrote == null) wrote = bytes.length - offset;
        if (!Number.isInteger(wrote) || wrote <= 0 || wrote > bytes.length - offset) {
          const e = new Error('writeFileDurable: short write made no valid progress (' + wrote + '/' + (bytes.length - offset) + ' bytes)');
          e.code = 'ESHORTWRITE';
          throw e;
        }
        offset += wrote;
      }
      fs.fsyncSync(fd);                    // <-- durability barrier, strictly BEFORE the rename below
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }
  } else {
    // in-memory / test fs without fsync: still atomic (temp+rename), just not power-loss durable.
    fs.writeFileSync(tmp, data, { mode });
  }

  fs.renameSync(tmp, file);               // atomic replace of the real path (never seen half-written)

  // best-effort POSIX directory fsync so the RENAME itself is durable (the dir entry is flushed). This is a
  // no-op-or-throw on Windows (you cannot fsync a directory fd there) — wrapped so it NEVER fails the write.
  if (canFsync && pathMod && typeof pathMod.dirname === 'function') {
    let dfd = null;
    try {
      dfd = fs.openSync(pathMod.dirname(file), 'r');
      fs.fsyncSync(dfd);
    } catch (_) { /* Windows / unsupported: the temp-fsync + atomic rename already give the durability we rely on */ }
    finally { if (dfd != null) { try { fs.closeSync(dfd); } catch (_) {} } }
  }
}

module.exports = { writeFileDurable };
