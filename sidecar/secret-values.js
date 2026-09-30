/* sidecar/secret-values.js — collect the secret VALUES the sidecar currently holds, for known-value redaction.

   context.js redact() scrubs vendor-SHAPED secrets; this feeds its known-value layer (setKnownSecretSource) with
   the exact strings that have no shape: service keys, custom connector tokens/headers/env, OAuth access/refresh
   tokens and client secrets, channel bot tokens, provider keys from vendors without a prefix.

   collectSecretValues(sources) -> string[]
     sources: array of
       { values: [...] }                  every string (or array of strings) in the list is a secret
       { keyed: obj|array, allUnder? }    walk the tree; a string under a SECRET_KEY field is a secret, and every
                                          string anywhere beneath a field named in allUnder (e.g. headers, env) is too
   Whitespace-separated parts of a value are added as well: a Slack channel token is stored as the combined
   "xoxb-… xapp-…" pair and either half can surface alone. Short strings are filtered by context.js (KNOWN_MIN).
   Pure, bounded (depth + count caps), never throws on odd input. */
'use strict';
const { note: failNote } = require('./failopen.js');

const SECRET_KEY = /^(?:key|apikey|api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|bot[_-]?token|app[_-]?token|device[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|secret|password|passwd|bearer|authorization)$/i;
const MAX_DEPTH = 8;
const MAX_VALUES = 2000;

function collectSecretValues(sources) {
  const out = new Set();
  function add(v) {
    if (out.size >= MAX_VALUES || typeof v !== 'string') return;
    const t = v.trim();
    if (!t) return;
    out.add(t);
    const parts = t.split(/\s+/);
    if (parts.length > 1) for (const p of parts) if (p) out.add(p);
  }
  function addAll(v, depth) {
    if (depth > MAX_DEPTH || v == null) return;
    if (typeof v === 'string') return add(v);
    if (Array.isArray(v)) { for (const x of v) addAll(x, depth + 1); return; }
    if (typeof v === 'object') for (const k of Object.keys(v)) addAll(v[k], depth + 1);
  }
  function walk(v, depth, allUnder) {
    if (depth > MAX_DEPTH || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1, allUnder); return; }
    for (const k of Object.keys(v)) {
      const child = v[k];
      if (allUnder && allUnder.has(k)) addAll(child, depth + 1);
      else if (typeof child === 'string') { if (SECRET_KEY.test(k)) add(child); }
      else if (Array.isArray(child) && SECRET_KEY.test(k)) addAll(child, depth + 1);
      else walk(child, depth + 1, allUnder);
    }
  }
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || typeof s !== 'object') continue;
    try {
      if ('values' in s) addAll(s.values, 0);
      if ('keyed' in s) walk(s.keyed, 0, Array.isArray(s.allUnder) ? new Set(s.allUnder) : null);
    } catch (e) { failNote('secret-values.source', e); }   // one malformed source must not blind the others
  }
  return Array.from(out);
}

module.exports = { collectSecretValues, SECRET_KEY };
