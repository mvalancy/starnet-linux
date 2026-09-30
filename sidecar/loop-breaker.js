/* sidecar/loop-breaker.js — NO-PROGRESS LOOP DETECTION for the agent loop (Step 2, Hermes audit 2026-09-22).

   The loop guard in loop.js stops ONE byte-identical call that keeps FAILING; the evidence-progress guard
   (tool-progress-guard.js, host dispatch) stops identical successful READS. Three stuck shapes slipped between
   them and ran until a human noticed (audit probes, all unattended-capable):
     · UNKNOWN TOOLS — 15 turns of a hallucinated `launch_rocket` each answered "unknown tool", nothing stopped.
     · A FAILURE STREAK WITH VARYING ARGUMENTS — 15 net_get failures on 15 different URLs (30 executions after
       the transient-read retry); the identical-args guard never matched because no two calls were identical.
     · NO-PROGRESS SUCCESS POLLING on a non-read tool — the same call, the same arguments, the same answer, turn
       after turn. The progress guard only tracks reads/browser/tool.search, so e.g. a shell poll ran forever.

   This module is LOOP DETECTION, never a quota: nothing here counts spend, turns, or tool calls in aggregate
   ("quotas default off" is a locked product decision). Each detector fires only on evidence that the run is
   repeating itself without progress, and each resets the moment progress appears.

   Tiers (Hermes parity: warnings everywhere, hard stops only where nobody is watching):
     · (a) unknown-tool strikes — a tool turn whose attempted calls are ALL answered "unknown tool" (the host's
       registry summary 'unknown-tool') is a strike; any turn with a real call resets. STRIKE_MAX (3) consecutive
       strikes end the run on EVERY surface: a model that cannot name a real tool three turns running is not
       going to recover by being asked again, and the registry's answer already lists the closest real tools.
     · (b) same-tool failure streak — consecutive failures of ONE tool (any arguments), counted at most once per
       turn (a parallel fan-out failing together is one failed attempt). One system nudge at warnAfter (3) on every
       surface; a hard stop at stopAfter (8) on UNATTENDED runs only, never in the turn the nudge is first issued. A success of that
       tool clears it; a successful MUTATION of any tool (an edit, a command) clears every streak — the next
       failure is a new experiment, not a replay (Hermes PROGRESS_RESET).
     · (c) no-progress success polling — a tool turn whose calls ALL succeeded and whose (tool, canonical args,
       normalized result digest) set is identical to the previous tool turn's. One nudge at warnAfter (3) on every
       surface; a hard stop at stopAfter (5) on UNATTENDED runs only. Calls the host's evidence-progress guard
       already tracks (reads/browser/tool.search — injected as `isTracked`) are left to it: a turn containing one
       is not a candidate here, so the two guards never double-count the same repetition.

   "Unattended" is decided by the HOST (index.js: every surface except the watched interactive Commander chat),
   never here — the loop deliberately knows nothing about the surface it was launched from.

   Pure and deterministic: no clock, no randomness, no IO. Same turns in -> same decisions out. */
'use strict';

const { note: failNote } = require('./failopen.js');
const progressGuard = require('./tool-progress-guard.js');
const normalizeEvidence = (progressGuard && progressGuard._internals && progressGuard._internals.normalizeEvidence)
  || (v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim());

const UNKNOWN_TOOL_SUMMARY = 'unknown-tool';
const DEFAULTS = Object.freeze({
  unknownStrikes: 3,
  sameToolWarnAfter: 3,
  sameToolStopAfter: 8,
  noProgressWarnAfter: 3,
  noProgressStopAfter: 5
});
// A successful call of one of these CHANGED something, so every other tool's failure streak restarts (the next
// attempt is a new experiment). Wire-form (underscored, lowercase) names.
const PROGRESS_RESET = new Set([
  'fs_write', 'fs_edit', 'fs_patch', 'fs_append', 'shell_exec', 'terminal_write', 'notebook_write',
  'browser_click', 'browser_type', 'browser_press', 'browser_navigate', 'team_dispatch', 'team_spawn'
]);

const wireKey = n => String(n == null ? '' : n).replace(/\./g, '_').toLowerCase();

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}

// FNV-1a 32-bit — a cheap, deterministic digest so the breaker keeps one short key per turn, never whole results.
function digest(text) {
  const s = String(text == null ? '' : text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8) + ':' + s.length;
}

// A call that was never attempted (cancelled before dispatch, skipped after terminal evidence, paused behind a
// Task Brief question) says nothing about whether the tool works — it neither counts nor clears anything.
function isSkip(result) { return /^skipped\b/i.test(String((result && result.summary) || '')); }

function threshold(v, dflt) {
  if (v === 0 || v === false) return 0;
  const n = Number(v);
  return (Number.isFinite(n) && n >= 1) ? Math.floor(n) : dflt;
}

function makeLoopBreaker(options) {
  const o = options || {};
  const cfg = o.limits;
  const off = cfg === false;
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const STRIKE_MAX = off ? 0 : threshold(c.unknownStrikes, DEFAULTS.unknownStrikes);
  const ST_WARN = off ? 0 : threshold(c.sameToolWarnAfter, DEFAULTS.sameToolWarnAfter);
  const ST_STOP = off ? 0 : threshold(c.sameToolStopAfter, DEFAULTS.sameToolStopAfter);
  const NP_WARN = off ? 0 : threshold(c.noProgressWarnAfter, DEFAULTS.noProgressWarnAfter);
  const NP_STOP = off ? 0 : threshold(c.noProgressStopAfter, DEFAULTS.noProgressStopAfter);
  const unattended = o.unattended === true;
  const isTracked = typeof o.isTracked === 'function' ? o.isTracked : () => false;

  let strikes = 0;
  const strikeNames = [];
  const fails = new Map();     // wire name -> consecutive failures
  const warned = new Set();    // wire names already nudged in their current streak
  const warnedAt = new Map();  // wire name -> the observe() turn its current streak's nudge was issued on
  let turn = 0;                // observe() calls that reached the same-tool detector
  let npKey = '', npStreak = 0, npWarned = false, npName = '';

  function tracked(name) {
    try { return !!isTracked(name); } catch (e) { failNote('loopBreaker.isTracked', e); return false; }   // an injected predicate that throws tracks nothing
  }

  /* observe(calls, results, info) -> { notes: string[], stop: null | { failureStage, failureCode, message } }
     calls: the turn's parsed calls ({ id, name, args, parseError }); results: the paired results ({ callId,
     isError, summary, content }). info.loopGuardWarned: wire names loop.js's identical-failure guard nudged this
     turn — the same-tool nudge stays quiet for those so one repetition never earns two lectures. */
  function observe(calls, results, info) {
    const notes = [];
    if (off) return { notes, stop: null };
    const lgWarned = (info && info.loopGuardWarned instanceof Set) ? info.loopGuardWarned : new Set();
    const byId = new Map();
    for (const r of (results || [])) if (r) byId.set(r.callId, r);
    const attempted = [];
    for (const call of (calls || [])) {
      const r = byId.get(call && call.id);
      if (r && !isSkip(r)) attempted.push({ call, r });
    }
    if (!attempted.length) return { notes, stop: null };

    // ---- (a) unknown-tool strikes ----
    const unknown = attempted.filter(x => x.r.isError && String(x.r.summary || '') === UNKNOWN_TOOL_SUMMARY);
    if (unknown.length === attempted.length) {
      strikes++;
      for (const x of unknown) { const n = String(x.call.name || '').slice(0, 60); if (n && strikeNames.indexOf(n) < 0 && strikeNames.length < 5) strikeNames.push(n); }
      if (STRIKE_MAX && strikes >= STRIKE_MAX) {
        return { notes, stop: {
          failureStage: 'tool_loop', failureCode: 'unknown_tools',
          message: 'loop breaker: the model called tools that do not exist (' + strikeNames.join(', ') + ') on ' + strikes
            + ' turns in a row — stopping instead of letting it keep guessing at tool names'
        } };
      }
    } else {
      strikes = 0; strikeNames.length = 0;
    }

    // ---- (b) same-tool failure streak (any arguments) ----
    /* ONE FAILURE PER TOOL PER TURN. The streak counts TURNS in which a tool failed, not results: eight parallel
       web_fetch calls failing in one turn are one failed attempt at a strategy, not eight — counting each result
       hard-stopped an unattended run on its FIRST turn, before the model ever saw a warning. And a stop never
       lands in the same turn the warning is first issued: the nudge must reach the model before the run can end
       for ignoring it (a disabled warning, or one configured past the stop, leaves the stop unconditioned). */
    turn++;
    const countedThisTurn = new Set();
    const stopNeedsWarning = ST_WARN > 0 && ST_WARN <= ST_STOP;
    for (const x of attempted) {
      const key = wireKey(x.call.name);
      if (!key) continue;
      if (x.r.isError) {
        if (String(x.r.summary || '') === UNKNOWN_TOOL_SUMMARY) continue;   // (a) owns a tool that does not exist
        if (countedThisTurn.has(key)) continue;
        countedThisTurn.add(key);
        const n = (fails.get(key) || 0) + 1;
        fails.set(key, n);
        const label = String(x.call.name || key).slice(0, 80);
        const warnedEarlier = warned.has(key) && warnedAt.get(key) < turn;
        if (unattended && ST_STOP && n >= ST_STOP && (!stopNeedsWarning || warnedEarlier)) {
          return { notes, stop: {
            failureStage: 'tool_loop', failureCode: 'repeated_tool_failure',
            message: 'loop breaker: ' + label + ' failed ' + n + ' times in a row (with varying arguments) on an unattended run — stopping a run that is not making progress'
          } };
        }
        if (ST_WARN && n >= ST_WARN && !warned.has(key)) {
          warned.add(key); warnedAt.set(key, turn);
          if (!lgWarned.has(key)) {
            notes.push('<failure_streak>' + label + ' has now failed ' + n + ' times in a row. Varying the arguments has not worked. '
              + 'Stop repeating this tool with small changes: read the error text above, check your assumptions (names, paths, inputs, whether the resource exists), '
              + 'then take a genuinely different approach or tool — or stop and report the exact blocker.'
              + (unattended && ST_STOP ? ' This run is unattended: if ' + label + ' keeps failing it will be stopped after ' + ST_STOP + ' consecutive failures.' : '')
              + '</failure_streak>');
          }
        }
      } else {
        fails.delete(key); warned.delete(key); countedThisTurn.delete(key);
        if (PROGRESS_RESET.has(key)) { fails.clear(); warned.clear(); countedThisTurn.clear(); }
      }
    }

    // ---- (c) no-progress success polling (non-read tools) ----
    const eligible = attempted.every(x => !x.r.isError && !tracked(x.call.name) && !x.call.parseError);
    if (!eligible) {
      npKey = ''; npStreak = 0; npWarned = false; npName = '';
    } else {
      const parts = attempted.map(x => wireKey(x.call.name) + '\u0000' + canonicalJson(x.call.args == null ? {} : x.call.args)
        + '\u0000' + digest(normalizeEvidence(x.r.content)));
      parts.sort();
      const key = parts.join('\n');
      if (key === npKey) npStreak++;
      else { npKey = key; npStreak = 1; npWarned = false; npName = attempted.map(x => String(x.call.name || 'tool').slice(0, 60)).join(', '); }
      if (unattended && NP_STOP && npStreak >= NP_STOP) {
        return { notes, stop: {
          failureStage: 'tool_loop', failureCode: 'no_progress',
          message: 'loop breaker: ' + npName + ' returned the identical result ' + npStreak + ' turns in a row with identical arguments on an unattended run — stopping a run that is not making progress'
        } };
      }
      if (NP_WARN && npStreak >= NP_WARN && !npWarned) {
        npWarned = true;
        notes.push('<no_progress>You have made the identical call (' + npName + ') ' + npStreak + ' turns in a row and received the identical result each time. '
          + 'Repeating it is not progress. Use the result you already have, change the arguments or the approach, or — if you are waiting on something that has not changed — say so and stop.'
          + (unattended && NP_STOP ? ' This run is unattended: an unchanged repeat will stop it after ' + NP_STOP + ' identical turns.' : '')
          + '</no_progress>');
      }
    }
    return { notes, stop: null };
  }

  return { observe, snapshot: () => ({ strikes, fails: Array.from(fails.entries()), noProgressStreak: npStreak, unattended }) };
}

module.exports = { makeLoopBreaker, UNKNOWN_TOOL_SUMMARY, DEFAULTS, _internals: { digest, canonicalJson, wireKey, isSkip, PROGRESS_RESET } };
