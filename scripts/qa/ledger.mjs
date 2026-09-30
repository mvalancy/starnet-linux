#!/usr/bin/env node
/* scripts/qa/ledger.mjs — the Self-Testing Station's findings spine (lane Q0).
 *
 * WHY THIS EXISTS: five-plus sessions build in parallel and breakage is currently
 * found by Andrew using the app. The QA crew (Green Guardian / Beginner Run / Truth
 * Auditor / Visual Auditor / Overseer / Janitor) detect problems from scripts and
 * sessions; they ALL meet here, at one ledger. This module is the shared substrate:
 * append a finding, dedup by fingerprint so the same defect never files twice,
 * refuse anything already marked known/dismissed (the product's anti-nag law),
 * reject vibes-findings that carry no evidence, and render a readable morning
 * digest + a per-crew status summary for the Overseer.
 *
 * HOUSE PATTERN (matches sidecar/runstore.js + transcriptstore.js): the CORE is a
 * PURE factory `makeLedger({ io, clock })`. No ambient time, no ambient disk — the
 * host injects both, so it tests headlessly with an in-memory io and is
 * deterministic (no bare Date.now() in the core; the sibling stores are held to the
 * same bar by test/lint-determinism.js, and this core holds to it too). A
 * missing/corrupt store degrades to empty (fail-open; a finding is never lost to an
 * unreadable file). ESM here so the same file can also be the `node ... ledger.mjs`
 * CLI; the pure core is exported for the CJS test via Node's require(esm) support.
 *
 * The `io` contract (host owns real fs; core owns logic):
 *   io.listFindings()        -> array of finding objects already on disk (each a
 *                               parsed <id>.json). Corrupt/missing -> [] (fail-open).
 *   io.writeFinding(finding) -> persist one finding (host writes qa/findings/<id>.json).
 *   io.knownFingerprints()   -> Set|array of fingerprints seeded in KNOWN_ISSUES.md
 *                               (baseline the crew must never re-file). Optional.
 *
 * makeLedger({ io, clock }) -> {
 *   add(finding)             -> { ok, status, reason?, finding? }   // dedup + known-refusal + evidence-required
 *   dedupCheck(fingerprint)  -> { fingerprint, filed, known, status }
 *   digest({ date }?)        -> markdown morning report grouped by severity then crew
 *   status()                 -> { crews: {...}, markdown }           // per-crew last-run summary
 *   fingerprint({ crew, checkId, subject }) -> stable hash string    // helper for callers
 *   all()                    -> finding[]   (copies)
 *   count()                  -> int
 * }
 *
 * CLI (thin wrapper, real io + real clock):
 *   node scripts/qa/ledger.mjs --add --json '<inline JSON>'   (or --json <path-to.json>)
 *   node scripts/qa/ledger.mjs --digest [--date YYYY-MM-DD] [--write]
 *   node scripts/qa/ledger.mjs --dedup-check <fingerprint>
 *   node scripts/qa/ledger.mjs --status
 * Exit code: 0 on success; 2 when --add is rejected/refused (so a script can branch).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

const SEVERITIES = { P0: 0, P1: 1, P2: 2 };                    // ordering for the digest (P0 first)
const STATUSES = { open: 1, routed: 1, fixed: 1, dismissed: 1, known: 1 };
const CREW = {                                                 // the canonical crew, for STATUS.md rows
  'Green Guardian': 1, 'Beginner Run': 1, 'Truth Auditor': 1,
  'Visual Auditor': 1, 'Overseer': 1, 'Janitor': 1
};
const TITLE_MAX = 160;
const DETAIL_MAX = 4000;

function str(v) { return v == null ? '' : String(v); }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
function severity(v) { const s = str(v).toUpperCase(); return SEVERITIES[s] != null ? s : 'P2'; }
function statusOf(v) { const s = str(v).toLowerCase(); return STATUSES[s] ? s : 'open'; }
function crewOf(v) { const s = str(v).trim(); return s || 'Unknown'; }

// A stable, dependency-free hash (FNV-1a 32-bit -> hex). Deterministic: same input, same digits,
// forever — so the same defect fingerprints identically across runs and machines. NOT crypto; it
// only needs to be a stable dedup key.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}
// normalize a subject so cosmetic differences (case, whitespace, path slashes) don't split one
// defect into many fingerprints.
function normalizeSubject(s) {
  return str(s).toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}
export function fingerprintOf(parts) {
  parts = parts || {};
  const crew = normalizeSubject(parts.crew);
  const checkId = normalizeSubject(parts.checkId != null ? parts.checkId : parts.check);
  const subject = normalizeSubject(parts.subject);
  return fnv1a(crew + ' ' + checkId + ' ' + subject);
}

// Coerce arbitrary caller input into a clean list of evidence paths. Non-empty enforcement is the
// Evidence Law, applied by add() — not here.
function coerceEvidence(v) {
  if (Array.isArray(v)) return v.map(str).map(p => p.trim()).filter(Boolean);
  const one = str(v).trim();
  return one ? [one] : [];
}

function validateStoredFindings(raw) {
  if (!Array.isArray(raw)) throw new Error('ledger store must return an array');
  const ids = new Set();
  const fingerprints = new Set();
  return raw.map((row, index) => {
    const where = 'finding[' + index + ']';
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(where + ' must be an object');
    for (const field of ['id', 'fingerprint', 'title', 'crew']) {
      if (!str(row[field]).trim()) throw new Error(where + '.' + field + ' is required');
    }
    if (!Object.prototype.hasOwnProperty.call(SEVERITIES, str(row.severity).toUpperCase())) throw new Error(where + '.severity is invalid');
    if (!Object.prototype.hasOwnProperty.call(STATUSES, str(row.status).toLowerCase())) throw new Error(where + '.status is invalid');
    if (!Array.isArray(row.evidence) || coerceEvidence(row.evidence).length === 0) throw new Error(where + '.evidence is required');
    if (ids.has(str(row.id))) throw new Error(where + '.id is duplicated');
    if (fingerprints.has(str(row.fingerprint))) throw new Error(where + '.fingerprint is duplicated');
    ids.add(str(row.id)); fingerprints.add(str(row.fingerprint));
    return row;
  });
}

export function makeLedger(opts) {
  opts = opts || {};
  const io = opts.io || {};
  const clock = opts.clock || { now() { return 0; } };
  const listFindings = typeof io.listFindings === 'function' ? io.listFindings.bind(io) : () => [];
  const writeFinding = typeof io.writeFinding === 'function' ? io.writeFinding.bind(io) : () => {};
  const knownIo = typeof io.knownFingerprints === 'function' ? io.knownFingerprints.bind(io) : () => [];
  const strictRead = opts.strictRead === true;

  // Load the on-disk findings once into an in-memory mirror so add()/digest()/status() are O(n) over
  // RAM. Most detector lanes retain the historical fail-open behavior; aggregate release/product
  // authorities opt into strictRead so an unreadable ledger can never become a false zero-findings green.
  let rows = [];
  try {
    const raw = listFindings();
    if (strictRead) rows = validateStoredFindings(raw);
    else if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object');
  } catch (error) {
    if (strictRead) throw error;
    rows = [];
  }

  // fingerprints the baseline says must NEVER file (KNOWN_ISSUES.md) + any finding already on disk
  // whose status is dismissed/known. Both are refused on re-add (anti-nag law).
  function suppressedFingerprints() {
    const set = new Set();
    try {
      const seed = knownIo();
      const arr = seed instanceof Set ? Array.from(seed) : (Array.isArray(seed) ? seed : []);
      for (const fp of arr) { const s = str(fp).trim(); if (s) set.add(s); }
    } catch (_) { /* fail-open: no seed -> nothing suppressed by the baseline */ }
    for (const r of rows) {
      const s = statusOf(r.status);
      if (s === 'dismissed' || s === 'known') set.add(str(r.fingerprint).trim());
    }
    return set;
  }

  function existingByFingerprint(fp) {
    const want = str(fp).trim();
    if (!want) return null;
    for (const r of rows) if (str(r.fingerprint).trim() === want) return r;
    return null;
  }

  // The one write path. Returns a small verdict object; NEVER throws on a rejection (the caller
  // branches on `ok`). Real disk-write failures inside io.writeFinding are swallowed like the sibling
  // stores (RAM mirror still answers) but reported via ok:false so a CLI can exit nonzero.
  function add(input) {
    input = input || {};

    const evidence = coerceEvidence(input.evidence);
    if (evidence.length === 0) {
      // Evidence Law: no finding without an artifact path. Screenshots/logs or it didn't happen.
      return { ok: false, status: 'rejected', reason: 'evidence-required: a finding must carry at least one evidence path' };
    }

    const crew = crewOf(input.crew);
    const title = str(input.title).trim();
    if (!title) return { ok: false, status: 'rejected', reason: 'title-required: a finding must have a non-empty title' };

    // fingerprint: honor an explicit one, else derive a stable one from (crew + checkId + subject).
    const fp = str(input.fingerprint).trim()
      || fingerprintOf({ crew, checkId: input.checkId != null ? input.checkId : input.check, subject: input.subject != null ? input.subject : title });

    const suppressed = suppressedFingerprints();
    if (suppressed.has(fp)) {
      // Anti-nag law: a dismissed/known fingerprint never re-files. Loud, clear refusal.
      return { ok: false, status: 'refused', reason: 'known-or-dismissed: fingerprint ' + fp + ' is on the known/dismissed baseline — never re-filed', fingerprint: fp };
    }

    const dup = existingByFingerprint(fp);
    if (dup) {
      // Dedup: the same defect never files twice. Idempotent — return the existing finding.
      return { ok: true, status: 'duplicate', reason: 'fingerprint ' + fp + ' already filed as ' + dup.id, finding: Object.assign({}, dup) };
    }

    const ts = num(input.ts) || clock.now();
    const finding = {
      id: str(input.id).trim() || (fp + '-' + ts),        // stable, collision-resistant, and human-greppable
      fingerprint: fp,
      ts,
      crew,
      severity: severity(input.severity),
      title: title.slice(0, TITLE_MAX),
      detail: str(input.detail).slice(0, DETAIL_MAX),
      evidence,
      status: statusOf(input.status),
      routedTo: str(input.routedTo).trim()
    };

    rows.push(finding);
    let persisted = true;
    try { writeFinding(Object.assign({}, finding)); }
    catch (_) { persisted = false; /* RAM mirror still answers; report the write failure via ok */ }
    if (!persisted) return { ok: false, status: 'write-failed', reason: 'finding accepted in memory but io.writeFinding threw (disk problem)', finding: Object.assign({}, finding) };
    return { ok: true, status: 'added', finding: Object.assign({}, finding) };
  }

  function dedupCheck(fingerprint) {
    const fp = str(fingerprint).trim();
    const hit = existingByFingerprint(fp);
    const suppressed = suppressedFingerprints().has(fp);
    return {
      fingerprint: fp,
      filed: !!hit,
      known: suppressed,
      status: hit ? statusOf(hit.status) : (suppressed ? 'known' : 'new'),
      id: hit ? hit.id : ''
    };
  }

  // The Overseer's morning report: markdown, grouped by severity (P0 first) then crew. Deterministic
  // ordering (severity, then crew name, then ts) so two runs over the same ledger render identically.
  function digest(o) {
    o = o || {};
    const date = str(o.date).trim();
    const active = rows.filter(r => { const s = statusOf(r.status); return s !== 'fixed' && s !== 'dismissed'; });
    const bySev = { P0: [], P1: [], P2: [] };
    for (const r of active) bySev[severity(r.severity)].push(r);

    const lines = [];
    lines.push('# QA morning digest' + (date ? ' — ' + date : ''));
    lines.push('');
    const total = active.length;
    const nP0 = bySev.P0.length, nP1 = bySev.P1.length, nP2 = bySev.P2.length;
    lines.push('**' + total + '** open finding' + (total === 1 ? '' : 's') +
      ' — ' + nP0 + ' P0 · ' + nP1 + ' P1 · ' + nP2 + ' P2');
    lines.push('');
    if (total === 0) {
      lines.push('_No open findings. All crews report clean._');
      lines.push('');
      return lines.join('\n');
    }
    for (const sev of ['P0', 'P1', 'P2']) {
      const group = bySev[sev];
      if (!group.length) continue;
      lines.push('## ' + sev + ' (' + group.length + ')');
      lines.push('');
      // sub-group by crew
      const crews = {};
      for (const r of group) (crews[crewOf(r.crew)] = crews[crewOf(r.crew)] || []).push(r);
      for (const crew of Object.keys(crews).sort()) {
        lines.push('### ' + crew);
        const items = crews[crew].slice().sort((a, b) => num(a.ts) - num(b.ts) || str(a.id).localeCompare(str(b.id)));
        for (const r of items) {
          const st = statusOf(r.status);
          const badge = st === 'open' ? '' : ' _(' + st + (r.routedTo ? ' → ' + r.routedTo : '') + ')_';
          lines.push('- **' + str(r.title) + '**' + badge);
          if (r.detail) lines.push('  - ' + str(r.detail).split('\n').join(' ').slice(0, 300));
          const ev = coerceEvidence(r.evidence);
          if (ev.length) lines.push('  - evidence: ' + ev.map(p => '`' + p + '`').join(', '));
          lines.push('  - id: `' + str(r.id) + '` · fingerprint: `' + str(r.fingerprint) + '`');
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  // Per-crew last-run state, for the STATUS.md dashboard. "Last finding" = most recent finding ts per
  // crew; "open" = count of that crew's non-terminal findings. A crew with zero findings is still
  // reported so the dashboard shows every seat, even the quiet ones.
  //
  // STALENESS (2026-08-21): the raw Open count hid how OLD the backlog was — "427 open" reads as
  // 427 live defects when most are weeks-old housekeeping rows nobody re-checked (the ledger drifts
  // stale in the FIXED direction; scripts/qa/ledger-reconcile.mjs is the re-checker). Two extra
  // columns make the volume legible: the age of the OLDEST open finding and how many open findings
  // are older than STALE_DAYS. Ages come from the injected clock, never Date.now(); with the default
  // zero clock (or a finding with no ts) the age is unknown and renders '—', never a fake 0.
  const STALE_DAYS = 30;
  const DAY_MS = 86400000;
  function status() {
    const now = num(clock.now && clock.now());
    const seat = (name) => ({ crew: name, findings: 0, open: 0, lastTs: 0, worstSeverity: '', oldestOpenTs: 0, oldestOpenDays: null, staleOpen: 0 });
    const crews = {};
    for (const name of Object.keys(CREW)) crews[name] = seat(name);
    for (const r of rows) {
      const name = crewOf(r.crew);
      const c = crews[name] || (crews[name] = seat(name));
      c.findings++;
      const s = statusOf(r.status);
      const ts = num(r.ts);
      if (s !== 'fixed' && s !== 'dismissed') {
        c.open++;
        if (ts > 0 && (!c.oldestOpenTs || ts < c.oldestOpenTs)) c.oldestOpenTs = ts;
        if (now > 0 && ts > 0 && (now - ts) > STALE_DAYS * DAY_MS) c.staleOpen++;
      }
      if (ts > c.lastTs) c.lastTs = ts;
      const sev = severity(r.severity);
      if (!c.worstSeverity || SEVERITIES[sev] < SEVERITIES[c.worstSeverity]) c.worstSeverity = sev;
    }
    for (const name of Object.keys(crews)) {
      const c = crews[name];
      c.oldestOpenDays = (now > 0 && c.oldestOpenTs > 0) ? Math.max(0, Math.floor((now - c.oldestOpenTs) / DAY_MS)) : null;
    }
    const order = Object.keys(CREW).concat(Object.keys(crews).filter(k => !CREW[k]).sort());
    const md = [];
    md.push('| Crew | Findings | Open | Worst | Last finding (ts) | Oldest open | >' + STALE_DAYS + 'd |');
    md.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const name of order) {
      const c = crews[name];
      const oldest = c.oldestOpenDays == null ? '—' : (c.oldestOpenDays + 'd');
      md.push('| ' + name + ' | ' + c.findings + ' | ' + c.open + ' | ' + (c.worstSeverity || '—') + ' | ' + (c.lastTs || '—') +
        ' | ' + oldest + ' | ' + (c.open ? c.staleOpen : '—') + ' |');
    }
    return { crews, markdown: md.join('\n'), staleDays: STALE_DAYS };
  }

  // Count OPEN findings by severity, using the ledger's OWN severity()/statusOf() normalization so the
  // count is authoritative — the READY gate (scripts/qa/ready.mjs) reads THIS and never re-parses
  // status/severity itself. "Open" mirrors digest()'s `active` set exactly: everything that is NOT
  // terminal (fixed/dismissed). A 'known'/'routed' finding still counts as open (a known P0 is still a
  // release blocker; the anti-nag suppression only stops RE-FILING, it does not clear the defect).
  // Returns { P0, P1, P2, open, blocking:(P0+P1), rows:[{id,severity,status,title,fingerprint,crew}] }.
  function openBySeverity() {
    const counts = { P0: 0, P1: 0, P2: 0 };
    const openRows = [];
    for (const r of rows) {
      const st = statusOf(r.status);
      if (st === 'fixed' || st === 'dismissed') continue;
      const sev = severity(r.severity);
      counts[sev]++;
      openRows.push({ id: str(r.id), severity: sev, status: st, title: str(r.title).slice(0, TITLE_MAX), fingerprint: str(r.fingerprint), crew: crewOf(r.crew) });
    }
    return { P0: counts.P0, P1: counts.P1, P2: counts.P2, open: counts.P0 + counts.P1 + counts.P2, blocking: counts.P0 + counts.P1, rows: openRows };
  }

  return {
    add, dedupCheck, digest, status, openBySeverity,
    fingerprint: fingerprintOf,
    all() { return rows.map(r => Object.assign({}, r)); },
    count() { return rows.length; },
    _internals: { fnv1a, normalizeSubject, suppressedFingerprints }
  };
}

/* ───────────────────────────── THIN CLI WRAPPER ─────────────────────────────
 * Only runs when invoked directly (`node scripts/qa/ledger.mjs ...`), never when the pure core is
 * imported by the test. This block is the ONLY place ambient fs + Date.now() live — the composition
 * root — exactly like sidecar/index.js is the exempt root for the DI'd backend stores. The fs/path/url
 * imports are STATIC (top of file) and side-effect-free, so require(esm) from the CJS test still works
 * (no top-level await); they are only *used* when this block runs.
 */

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

if (INVOKED_DIRECTLY) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(__dirname, '..', '..');          // scripts/qa/ -> repo root
  const FINDINGS_DIR = path.join(ROOT, 'qa', 'findings');
  const KNOWN_FILE = path.join(ROOT, 'qa', 'KNOWN_ISSUES.md');
  const DIGESTS_DIR = path.join(ROOT, 'qa', 'digests');

  // A KNOWN_ISSUES.md line carries its fingerprint as `fingerprint: <hex>` (any case, any surrounding
  // markdown). We scrape every such token so the baseline suppresses re-files without a second file.
  const readKnownFingerprints = () => {
    try {
      const txt = fs.readFileSync(KNOWN_FILE, 'utf8');
      const out = new Set();
      const re = /fingerprint[:=]\s*`?([0-9a-fA-F]{6,})`?/g;
      let m;
      while ((m = re.exec(txt))) out.add(m[1].toLowerCase());
      return out;
    } catch (_) { return new Set(); }
  };

  const realIo = () => ({
    listFindings() {
      let names;
      try { names = fs.readdirSync(FINDINGS_DIR); } catch (_) { return []; }
      const out = [];
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(FINDINGS_DIR, n), 'utf8'))); }
        catch (_) { /* skip a corrupt finding file; fail-open */ }
      }
      return out;
    },
    writeFinding(finding) {
      fs.mkdirSync(FINDINGS_DIR, { recursive: true });
      const safe = String(finding.id).replace(/[^A-Za-z0-9._-]/g, '_');   // filesystem-safe id
      // Temp + rename: a failed write (disk full, crash) must never leave a torn <id>.json. Three
      // 0-byte findings from the 2026-09-19 disk-full event made every strict read (qa:ready) fail
      // for a week. The temp name does not end in .json, so readers never see it.
      const file = path.join(FINDINGS_DIR, safe + '.json');
      const tmp = file + '.tmp-' + process.pid;
      try {
        fs.writeFileSync(tmp, JSON.stringify(finding, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, file);
      } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* best effort; the .tmp name is never read */ }
        throw error;
      }
    },
    knownFingerprints() { return readKnownFingerprints(); }
  });

  const parseArgs = (argv) => {
    const a = { _: [] };
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (t === '--add') a.add = true;
      else if (t === '--digest') a.digest = true;
      else if (t === '--status') a.status = true;
      else if (t === '--dedup-check') a.dedupCheck = argv[++i] || '';
      else if (t === '--json') a.json = argv[++i] || '';
      else if (t === '--date') a.date = argv[++i] || '';
      else if (t === '--write') a.write = true;
      else a._.push(t);
    }
    return a;
  };

  const loadJsonArg = (v) => {
    const s = String(v || '').trim();
    if (!s) throw new Error('--json requires inline JSON or a path to a .json file');
    if (!s.startsWith('{') && !s.startsWith('[')) {
      try { if (fs.existsSync(s)) return JSON.parse(fs.readFileSync(s, 'utf8')); }
      catch (e) { throw new Error('could not read/parse JSON file ' + s + ': ' + e.message); }
    }
    try { return JSON.parse(s); } catch (e) { throw new Error('inline --json is not valid JSON: ' + e.message); }
  };

  const args = parseArgs(process.argv.slice(2));
  const ledger = makeLedger({ io: realIo(), clock: { now: () => Date.now() } });   // real clock: composition root only

  if (args.add) {
    let payload;
    try { payload = loadJsonArg(args.json); }
    catch (e) { console.error('[qa:ledger] ' + e.message); process.exit(2); }
    const findings = Array.isArray(payload) ? payload : [payload];
    let anyFail = false;
    for (const f of findings) {
      const res = ledger.add(f);
      if (res.ok && res.status === 'added') console.log('ADDED ' + res.finding.id + '  [' + res.finding.severity + ' · ' + res.finding.crew + ']  fp=' + res.finding.fingerprint);
      else if (res.ok && res.status === 'duplicate') console.log('DUPLICATE (already filed) — ' + res.reason);
      else { console.error((res.status === 'refused' ? 'REFUSED' : 'REJECTED') + ' — ' + res.reason); anyFail = true; }
    }
    process.exit(anyFail ? 2 : 0);
  } else if ('dedupCheck' in args) {
    console.log(JSON.stringify(ledger.dedupCheck(args.dedupCheck), null, 2));
    process.exit(0);
  } else if (args.digest) {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const md = ledger.digest({ date });
    if (args.write) {
      fs.mkdirSync(DIGESTS_DIR, { recursive: true });
      const file = path.join(DIGESTS_DIR, date + '.md');
      fs.writeFileSync(file, md + '\n', 'utf8');
      console.error('[qa:ledger] wrote ' + file);
    }
    process.stdout.write(md + '\n');
    process.exit(0);
  } else if (args.status) {
    process.stdout.write(ledger.status().markdown + '\n');
    process.exit(0);
  } else {
    console.error('usage: node scripts/qa/ledger.mjs [--add --json <json|file>] [--digest [--date YYYY-MM-DD] [--write]] [--dedup-check <fingerprint>] [--status]');
    process.exit(1);
  }
}
