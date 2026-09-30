/* sidecar/embed.js — the EMBEDDING LANE of memory recall (memory-compound lane): a PURE adapter over an
   ALREADY-CONFIGURED provider's embedding endpoint + the vector math context.rank() blends with BM25.

   Why this shape: the shipped desktop bundle carries NO node_modules, so a native/ONNX local embedder cannot
   ship. Instead the lane borrows the embedding endpoint of a provider the Commander has already configured
   (OpenAI-compatible `/embeddings` — OpenAI, OpenRouter, Groq, Mistral, Together, Ollama local, … — or Gemini's
   `:batchEmbedContents`). No model configured, or a provider without an embedding wire (Anthropic, Codex) =>
   makeEmbedder returns null and recall stays pure BM25 — byte-identical to the pre-lane behaviour.

   No ambient IO: `fetch` is injected (lint-determinism), hashing is FNV-1a (deterministic), vectors are
   quantized before they are persisted so the on-disk store stays small. The host owns spend bookkeeping
   (cost.reconcile + ledger.record on the returned usage) and the personalization-pause gate. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).embed = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_BATCH = 64;          // inputs per embedding call (every wire accepts far more; this bounds one run's spend)
  const MAX_CHARS = 2000;        // per-input clip — a memory is short; a query is the last few user turns
  const QUANT = 1e5;             // 5 decimals on disk: cosine error < 1e-4, file ~40% smaller than raw floats

  // adapters that speak an embedding wire. 'openrouter' is OpenAI-compatible on this endpoint too.
  const WIRE = { 'openai-compatible': 'openai', openrouter: 'openai', gemini: 'gemini' };
  function wireFor(adapter) { return WIRE[String(adapter == null ? '' : adapter)] || null; }

  // FNV-1a 32-bit over UTF-16 code units — a deterministic content fingerprint (NOT a security hash) so a
  // stored vector is reused only while the record text it embedded is unchanged.
  function textHash(s) {
    const str = String(s == null ? '' : s);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { const x = Number(a[i]) || 0, y = Number(b[i]) || 0; dot += x * y; na += x * x; nb += y * y; }
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  function quantize(vec) {
    return (Array.isArray(vec) ? vec : []).map(x => Math.round((Number(x) || 0) * QUANT) / QUANT);
  }

  function clip(s) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t; }
  function cleanBase(u) { return String(u == null ? '' : u).trim().replace(/\/+$/, ''); }
  function geminiModelPath(id) {
    const s = String(id || '').trim();
    return s.indexOf('/') >= 0 ? s.replace(/^\/+/, '') : ('models/' + s);
  }

  /* makeEmbedder({ fetch, adapter, baseUrl, key, model, headers, timeoutMs }) -> embedder | null
       embedder.embed(texts, { signal }) -> { vectors: number[][], usage: { prompt_tokens, total_tokens } }
     null when no model is named, the adapter has no embedding wire, or the base URL is empty — the caller
     treats null as "BM25 only". embed() throws on a non-2xx / malformed reply (the host swallows + logs). */
  function makeEmbedder(opts) {
    opts = opts || {};
    const doFetch = opts.fetch;
    const model = String(opts.model == null ? '' : opts.model).trim();
    const wire = wireFor(opts.adapter);
    const baseUrl = cleanBase(opts.baseUrl);
    if (typeof doFetch !== 'function' || !model || !wire || !baseUrl) return null;
    const key = String(opts.key == null ? '' : opts.key);
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;

    async function post(url, headers, body, signal) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);   // abort() never throws
      const onOuter = () => ac.abort();
      if (signal) { if (signal.aborted) onOuter(); else signal.addEventListener('abort', onOuter, { once: true }); }
      try {
        const res = await doFetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ac.signal });
        const text = await res.text();
        if (!res.ok) throw new Error('embeddings HTTP ' + res.status + ': ' + String(text || '').slice(0, 200));
        let json; try { json = JSON.parse(text); } catch (_) { throw new Error('embeddings: non-JSON reply'); }
        return json;
      } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onOuter); }
    }

    async function embedOpenAI(texts, signal) {
      const headers = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, opts.headers || {});
      if (key) headers.Authorization = 'Bearer ' + key;
      const json = await post(baseUrl + '/embeddings', headers, { model: model, input: texts }, signal);
      const rows = Array.isArray(json && json.data) ? json.data.slice() : null;
      if (!rows || rows.length !== texts.length) throw new Error('embeddings: reply carried ' + (rows ? rows.length : 0) + ' vectors for ' + texts.length + ' inputs');
      rows.sort((a, b) => (Number(a && a.index) || 0) - (Number(b && b.index) || 0));
      const vectors = rows.map(r => Array.isArray(r && r.embedding) ? r.embedding.map(Number) : null);
      if (vectors.some(v => !v || !v.length)) throw new Error('embeddings: a vector was missing or empty');
      const u = (json && json.usage) || {};
      const pt = Number(u.prompt_tokens) || Number(u.total_tokens) || 0;
      return { vectors: vectors, usage: { prompt_tokens: pt, completion_tokens: 0, total_tokens: Number(u.total_tokens) || pt, cost: (u.cost != null ? u.cost : undefined) } };
    }

    async function embedGemini(texts, signal) {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      if (key) headers['x-goog-api-key'] = key;
      const mp = geminiModelPath(model);
      const body = { requests: texts.map(t => ({ model: mp, content: { parts: [{ text: t }] } })) };
      const json = await post(baseUrl + '/' + mp + ':batchEmbedContents', headers, body, signal);
      const rows = Array.isArray(json && json.embeddings) ? json.embeddings : null;
      if (!rows || rows.length !== texts.length) throw new Error('embeddings: reply carried ' + (rows ? rows.length : 0) + ' vectors for ' + texts.length + ' inputs');
      const vectors = rows.map(r => Array.isArray(r && r.values) ? r.values.map(Number) : null);
      if (vectors.some(v => !v || !v.length)) throw new Error('embeddings: a vector was missing or empty');
      // Gemini reports no usage on this wire: estimate ~4 chars/token so the ledger books a truthful-shaped
      // (never zero-for-free) figure; the catalog price (usually 0 for embedding models) turns it into dollars.
      const est = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
      return { vectors: vectors, usage: { prompt_tokens: est, completion_tokens: 0, total_tokens: est, estimated: true } };
    }

    async function embed(texts, o) {
      const list = (Array.isArray(texts) ? texts : []).map(clip);
      if (!list.length) return { vectors: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      if (list.length > MAX_BATCH) throw new Error('embeddings: batch of ' + list.length + ' exceeds ' + MAX_BATCH);
      if (list.some(t => !t)) throw new Error('embeddings: an input was empty');
      const signal = o && o.signal;
      return wire === 'gemini' ? embedGemini(list, signal) : embedOpenAI(list, signal);
    }

    return { embed: embed, model: model, wire: wire };
  }

  /* planVectors(records, store, model) — which records still need a vector: every record whose text hash
     differs from the stored one (new record, edited record, or a vector from a different model). Pure; the
     host embeds the plan (capped) and merges the results. `textOf` mirrors context.recordText so the vector
     covers exactly the text BM25 indexes. */
  function recordText(r) {
    if (!r) return '';
    if (r.content != null && r.kind && r.kind !== 'note') return String(r.title != null ? r.title : '') + ' ' + String(r.content);
    return String(r.title != null ? r.title : '') + ' ' + String(r.body != null ? r.body : (r.content != null ? r.content : ''));
  }
  function planVectors(records, store, model, cap) {
    const items = (store && store.model === model && store.items && typeof store.items === 'object') ? store.items : {};
    const out = [];
    for (const r of (Array.isArray(records) ? records : [])) {
      if (!r || !r.id) continue;
      const text = clip(recordText(r));
      if (!text) continue;
      const h = textHash(text);
      const cur = items[r.id];
      if (cur && cur.h === h && Array.isArray(cur.v) && cur.v.length) continue;
      out.push({ id: r.id, text: text, h: h });
      if (cap && out.length >= cap) break;
    }
    return out;
  }
  // the id -> vector map rank() consumes, restricted to the LIVE records (a forgotten record's vector is dropped)
  function vectorsFor(records, store, model) {
    const items = (store && store.model === model && store.items && typeof store.items === 'object') ? store.items : {};
    const out = {};
    for (const r of (Array.isArray(records) ? records : [])) {
      if (!r || !r.id) continue;
      const cur = items[r.id];
      if (cur && cur.h === textHash(clip(recordText(r))) && Array.isArray(cur.v) && cur.v.length) out[r.id] = cur.v;
    }
    return out;
  }
  // fold freshly embedded rows into the store (a model switch starts a fresh store; stale ids are pruned to the live set)
  function mergeVectors(store, model, rows, liveIds) {
    const base = (store && store.model === model && store.items && typeof store.items === 'object') ? store.items : {};
    const items = {};
    const live = new Set(Array.isArray(liveIds) ? liveIds : Object.keys(base));
    for (const id of Object.keys(base)) if (live.has(id)) items[id] = base[id];
    for (const row of (Array.isArray(rows) ? rows : [])) if (row && row.id && Array.isArray(row.v) && row.v.length) items[row.id] = { h: row.h, v: quantize(row.v) };
    return { model: model, items: items };
  }

  return { makeEmbedder, wireFor, textHash, cosine, quantize, planVectors, vectorsFor, mergeVectors, recordText, MAX_BATCH, MAX_CHARS };
});
