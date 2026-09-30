/* node test/embed.test.js — the embedding lane of hybrid recall (memory-compound lane), pure with an injected
   fetch. Proves: wire selection (OpenAI-compatible / OpenRouter / Gemini; Anthropic + Codex have NO wire => null,
   i.e. BM25 only), the request shapes + reply parsing for both wires, usage extraction (Gemini estimated),
   fail-loud on a bad reply, the store helpers (plan / merge / vectorsFor keyed by text hash + model), and that
   context.rank() admits a ZERO-lexical-overlap record on cosine alone while staying byte-identical without vectors. */
'use strict';
const A = require('./_assert.js');
const Embed = require('../sidecar/embed.js');
const { rank, cosine, SEMANTIC_FLOOR } = require('../sidecar/context.js');

(async () => {
  // ---- wire selection ----
  A.eq(Embed.wireFor('openai-compatible'), 'openai', 'openai-compatible adapters speak /embeddings');
  A.eq(Embed.wireFor('openrouter'), 'openai', 'OpenRouter speaks the OpenAI embeddings wire');
  A.eq(Embed.wireFor('gemini'), 'gemini', 'Gemini speaks batchEmbedContents');
  A.eq(Embed.wireFor('anthropic'), null, 'Anthropic has no embedding wire');
  A.eq(Embed.wireFor('codex'), null, 'Codex has no embedding wire');
  A.eq(Embed.makeEmbedder({ fetch: async () => {}, adapter: 'anthropic', baseUrl: 'https://x', key: 'k', model: 'm' }), null, 'no wire -> no embedder (BM25 only)');
  A.eq(Embed.makeEmbedder({ fetch: async () => {}, adapter: 'openrouter', baseUrl: 'https://x', key: 'k', model: '' }), null, 'no model -> no embedder');
  A.eq(Embed.makeEmbedder({ fetch: async () => {}, adapter: 'openrouter', baseUrl: '', key: 'k', model: 'm' }), null, 'no base url -> no embedder');

  // ---- OpenAI-compatible wire ----
  const seen = [];
  const fakeFetch = (reply, status) => async (url, init) => {
    seen.push({ url, init: Object.assign({}, init, { body: JSON.parse(init.body) }) });
    return { ok: (status || 200) < 300, status: status || 200, text: async () => (typeof reply === 'string' ? reply : JSON.stringify(reply)) };
  };
  {
    const e = Embed.makeEmbedder({ fetch: fakeFetch({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7, total_tokens: 7 } }),
      adapter: 'openrouter', baseUrl: 'https://or.example/api/v1/', key: 'sk-test', model: 'openai/text-embedding-3-small' });
    const r = await e.embed(['alpha', 'beta']);
    A.eq(seen[0].url, 'https://or.example/api/v1/embeddings', 'POSTs <base>/embeddings (trailing slash folded)');
    A.eq(seen[0].init.headers.Authorization, 'Bearer sk-test', 'bearer auth rides the key');
    A.eq(seen[0].init.body, { model: 'openai/text-embedding-3-small', input: ['alpha', 'beta'] }, 'request shape: model + input[]');
    A.eq(r.vectors, [[1, 0], [0, 1]], 'vectors re-ordered by index (a provider may reply out of order)');
    A.eq(r.usage.prompt_tokens, 7, 'usage extracted for the cost engine');
  }
  // fail-loud paths (the host swallows -> BM25 only)
  {
    const e = Embed.makeEmbedder({ fetch: fakeFetch({ error: 'nope' }, 500), adapter: 'openai-compatible', baseUrl: 'https://x', key: 'k', model: 'm' });
    let threw = null; try { await e.embed(['a']); } catch (err) { threw = err; }
    A.ok(threw && /HTTP 500/.test(threw.message), 'a non-2xx reply throws (never a silent empty vector)');
    const e2 = Embed.makeEmbedder({ fetch: fakeFetch({ data: [{ index: 0, embedding: [1] }] }), adapter: 'openai-compatible', baseUrl: 'https://x', key: 'k', model: 'm' });
    threw = null; try { await e2.embed(['a', 'b']); } catch (err) { threw = err; }
    A.ok(threw && /2 inputs/.test(threw.message), 'a vector-count mismatch throws');
    const e3 = Embed.makeEmbedder({ fetch: fakeFetch('<html>'), adapter: 'openai-compatible', baseUrl: 'https://x', key: 'k', model: 'm' });
    threw = null; try { await e3.embed(['a']); } catch (err) { threw = err; }
    A.ok(threw && /non-JSON/.test(threw.message), 'a non-JSON reply throws');
    const r0 = await e.embed([]);
    A.eq(r0.vectors.length, 0, 'an empty batch makes NO call and returns nothing');
  }
  // ---- Gemini wire ----
  {
    seen.length = 0;
    const e = Embed.makeEmbedder({ fetch: fakeFetch({ embeddings: [{ values: [0.5, 0.5] }] }), adapter: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta', key: 'AIza-test', model: 'gemini-embedding-001' });
    const r = await e.embed(['hello world']);
    A.eq(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents', 'Gemini: models/<id>:batchEmbedContents');
    A.eq(seen[0].init.headers['x-goog-api-key'], 'AIza-test', 'Gemini: x-goog-api-key header');
    A.eq(seen[0].init.body.requests[0].content.parts[0].text, 'hello world', 'Gemini: requests[].content.parts[].text');
    A.eq(r.vectors, [[0.5, 0.5]], 'Gemini: embeddings[].values parsed');
    A.ok(r.usage.estimated === true && r.usage.prompt_tokens > 0, 'Gemini reports no usage -> a truthful-shaped ESTIMATE is booked, never zero');
  }

  // ---- pure helpers ----
  A.eq(Embed.textHash('abc'), Embed.textHash('abc'), 'textHash deterministic');
  A.ok(Embed.textHash('abc') !== Embed.textHash('abd'), 'textHash distinguishes content');
  A.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9 && Math.abs(cosine([1, 0], [0, 1])) < 1e-9, 'cosine: identical 1, orthogonal 0');
  A.eq(cosine([1, 0], [1]), 0, 'cosine: dimension mismatch -> 0 (never NaN)');
  A.eq(Embed.quantize([0.123456789]), [0.12346], 'quantize: 5 decimals on disk');

  // ---- store helpers: plan / merge / vectorsFor keyed by (model, text hash) ----
  const recs = [
    { id: 'note_1', kind: 'fact', title: 'Fact', content: 'registry pushes rate-limit after repeated attempts' },
    { id: 'note_2', kind: 'fact', title: 'Fact', content: 'prefers npm start' }
  ];
  let store = undefined;
  let plan = Embed.planVectors(recs, store, 'm1');
  A.eq(plan.map(p => p.id), ['note_1', 'note_2'], 'empty store: every record needs a vector');
  A.eq(Embed.planVectors(recs, store, 'm1', 1).length, 1, 'the backfill cap bounds one pass');
  store = Embed.mergeVectors(store, 'm1', [{ id: 'note_1', h: plan[0].h, v: [1, 0] }], ['note_1', 'note_2']);
  A.eq(Embed.planVectors(recs, store, 'm1').map(p => p.id), ['note_2'], 'a stored vector is not re-planned');
  A.eq(Object.keys(Embed.vectorsFor(recs, store, 'm1')), ['note_1'], 'vectorsFor returns only the records that have a live vector');
  A.eq(Object.keys(Embed.vectorsFor(recs, store, 'OTHER')), [], 'a different model sees NO vectors (a model switch rebuilds)');
  const edited = [{ id: 'note_1', kind: 'fact', title: 'Fact', content: 'registry pushes rate-limit — batch retries' }];
  A.eq(Embed.planVectors(edited, store, 'm1').length, 1, 'an EDITED record (text hash changed) is re-planned');
  A.eq(Object.keys(Embed.vectorsFor(edited, store, 'm1')), [], '…and its stale vector is not served');
  const pruned = Embed.mergeVectors(store, 'm1', [], ['note_2']);
  A.eq(Object.keys(pruned.items), [], 'a forgotten record\'s vector is pruned on merge');

  // ---- hybrid rank: cosine admits a zero-overlap record; no vectors => byte-identical to BM25 ----
  const lesson = { id: 'L', kind: 'fact', title: 'Fact', content: 'registry pushes rate-limit after repeated attempts; batch retries with backoff', createdAt: 1000 };
  const other = { id: 'O', kind: 'fact', title: 'Fact', content: 'the commander prefers dark mode', createdAt: 1000 };
  const q = 'uploads to the package index keep getting throttled';
  A.eq(rank([lesson, other], q, { now: 1000 }).length, 0, 'BM25 alone: zero lexical overlap -> nothing surfaces (the gap the lane closes)');
  const vectors = { L: [1, 0], O: [0, 1] };
  A.eq(rank([lesson, other], q, { now: 1000, vectors, queryVec: [0.9, 0.1] }).map(r => r.id), ['L'], 'with vectors: the semantically-close lesson surfaces, the unrelated record does not');
  A.eq(rank([lesson, other], q, { now: 1000, vectors, queryVec: [0.1, 0.9] }).map(r => r.id), ['O'], 'the query vector decides which record clears the semantic floor');
  A.eq(rank([lesson, other], q, { now: 1000, vectors: { L: [1, 0] }, queryVec: [1, 0] }).map(r => r.id), ['L'], 'a record with no vector yet simply gets no semantic score (never an error)');
  A.eq(rank([lesson, other], 'registry', { now: 1000, vectors, queryVec: [0, 1] }).map(r => r.id).sort().join(','), 'L,O', 'lexical + semantic combine: the BM25 hit AND the semantic hit both surface');
  A.ok(SEMANTIC_FLOOR > 0 && SEMANTIC_FLOOR < 1, 'the semantic floor is a real threshold');
  A.eq(rank([lesson, other], q, { now: 1000, vectors: { L: [1, 0, 0], O: [0, 1, 0] }, queryVec: [0.2, 0.2, 0.96] }).length, 0, 'a below-floor cosine (~0.2) admits nothing (no false recall from a weak match)');

  A.report('embed.test');
})().catch(e => { console.log('FAIL: embed.test threw - ' + (e && e.stack || e)); process.exit(1); });
