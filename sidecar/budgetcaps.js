/* sidecar/budgetcaps.js — the PURE resolve+validate helper behind the SETTINGS → Budget panel (P0-2).
   Splits the two decisions out of the Node host so they're testable headlessly:

   • resolveCaps(envDefaults, overrides) -> effective caps. PRECEDENCE (additive, never breaks an env deploy):
     a persisted override wins for a key; else the env default. An override value of 0 is a REAL saved choice
     ("no cap" / ungoverned) and beats a non-zero env default — so the UI can dial a cap OFF. An override key
     that is absent means "use the env default" (that's how RESET works: clear the override, fall back to env).

   • validateOverridesPatch(patch) -> { ok, overrides?, error? }. Strictly parses an incoming
     { perRun?, perAgent?, perDay?, global? } patch against the current-nothing baseline: each present value must
     be a finite number >= 0 (0 = no cap) under a sane ceiling, or null/'' to CLEAR that key back to its default.
     Returns the SET of keys to persist (absent = cleared). No IO, no clock — trivially testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).budgetcaps = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEYS = ['perRun', 'perAgent', 'perDay', 'global'];
  const CAP_MAX = 1e7;   // $10M ceiling — guards a fat-fingered / overflow value, far above any real budget
  /* SHIPPED DEFAULTS — what a fresh install is governed by before the Commander saves anything and before any
     env var speaks. Every cap was 0 (ungoverned) until 2026-09-17, when a customer's agent spun 98 overnight
     iterations re-confirming that files existed and burned ~$98 with nothing between a stuck loop and the card.
     perDay is now a SOFT rail, not a wall: hitting it ends the run with reason 'budget' scope 'day', the Budget
     panel shows a one-click RESUME that grants another cap of headroom, and the value is editable (0 = off).
     Unmetered runs (OAuth / subscription sign-ins) never touch it — there is no $ to govern. Andrew's call,
     2026-09-17, amending the older "quotas default off" decision for this one runaway-spend case. */
  const DEFAULT_PER_DAY_USD = 25;
  const SHIPPED_DEFAULTS = Object.freeze({ perRun: 0, perAgent: 0, perDay: DEFAULT_PER_DAY_USD, global: 0 });
  function shippedDefaults() { return Object.assign({}, SHIPPED_DEFAULTS); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // a stored override is only honoured if it's a finite number >= 0 (0 = explicit "no cap"). Anything else is junk
  // and treated as "not set" (fall back to env) — a corrupt persisted value can never grant unintended headroom.
  function cleanOverrides(overrides) {
    const out = {};
    if (overrides && typeof overrides === 'object') {
      for (const k of KEYS) {
        const v = overrides[k];
        if (isNum(v) && v >= 0) out[k] = v;
      }
    }
    return out;
  }

  // effective caps = per key: (persisted override present ? override : env default). Env default itself falls to 0.
  function resolveCaps(envDefaults, overrides) {
    envDefaults = envDefaults || {};
    const ov = cleanOverrides(overrides);
    const out = {};
    for (const k of KEYS) {
      out[k] = Object.prototype.hasOwnProperty.call(ov, k)
        ? ov[k]
        : (isNum(envDefaults[k]) && envDefaults[k] >= 0 ? envDefaults[k] : 0);
    }
    return out;
  }

  // parse a POST /api/budget/caps body into the next override set. Only keys PRESENT in the patch are touched;
  // a present null/'' clears that key (-> env default); a present number sets it. Returns {ok:false,error} on any
  // invalid value so the endpoint can 400 without partial application. `base` = the current overrides to merge onto.
  function validateOverridesPatch(patch, base) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'body must be an object of caps' };
    const next = Object.assign({}, cleanOverrides(base));
    let touched = false;
    for (const k of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      touched = true;
      const raw = patch[k];
      if (raw === null || raw === '' || raw === undefined) { delete next[k]; continue; }   // clear -> env default
      const n = Number(raw);
      if (!isFinite(n) || n < 0) return { ok: false, error: k + ' must be a number >= 0 (0 = no cap), blank to reset to default' };
      if (n > CAP_MAX) return { ok: false, error: k + ' exceeds the $' + CAP_MAX.toLocaleString() + ' ceiling' };
      next[k] = Math.round(n * 1e6) / 1e6;   // micro-dollar precision, matching the ledger's $ granularity
    }
    if (!touched) return { ok: false, error: 'no cap fields provided (perRun, perAgent, perDay, global)' };
    return { ok: true, overrides: next };
  }

  return { KEYS, CAP_MAX, DEFAULT_PER_DAY_USD, shippedDefaults, resolveCaps, validateOverridesPatch, cleanOverrides };
});
