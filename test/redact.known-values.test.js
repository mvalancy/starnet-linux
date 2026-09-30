/* node test/redact.known-values.test.js — redact() coverage added by the 2026-09-25 secrets audit:
   known-VALUE scrubbing (shapeless secrets), JSON-quoted credential fields, the missing vendor shapes, and the
   collector that feeds the known-value layer from the sidecar's live stores. */
'use strict';
const A = require('./_assert.js');
const { redact, setKnownSecretSource } = require('../sidecar/context.js');
const { collectSecretValues } = require('../sidecar/secret-values.js');

// ---- JSON-quoted credential fields (cat codex/tokens.json used to pass straight through) ----
{
  const tokensJson = JSON.stringify({ access_token: 'opaqueAccess123456', refresh_token: 'opaqueRefresh987654', id_token: 'opaqueId555555', client_secret: 'cs-plain-value-1' }, null, 2);
  const out = redact(tokensJson);
  for (const v of ['opaqueAccess123456', 'opaqueRefresh987654', 'opaqueId555555', 'cs-plain-value-1']) A.ok(out.indexOf(v) < 0, 'JSON-quoted field value scrubbed: ' + v);
  A.ok(/"refresh_token": "\[redacted-secret\]"/.test(out), 'the JSON stays readable around the marker');
  A.ok(redact("password: 'hunter22'").indexOf('hunter22') < 0, 'single-quoted YAML value scrubbed');
  A.eq(redact('api_key=abcd1234&x=1'), 'api_key=[redacted-secret]&x=1', 'unquoted query-string form unchanged');
  A.eq(redact('the token budget is fine'), 'the token budget is fine', 'prose mentioning "token" is untouched');
}

// ---- vendor shapes that were missing ----
{
  const samples = {
    discord: 'MTA5ODc2NTQzMjEwOTg3NjU0Mw.GAbCdE.abcdefghijklmnopqrstuvwxyz0123456789ab',
    slackApp: 'xapp-1-A0123456789-1234567890123-abcdef0123456789',
    slackRefresh: 'xoxe-1-My0xLTEyMzQ1Njc4OTAtMTIzNDU2',
    matrix: 'syt_YWxpY2U_ZlUJyXvZaOqPaQwRyNeF_1a2b3c',
    googleRefresh: '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    groq: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
    perplexity: 'pplx-abcdefghijklmnopqrstuvwxyz0123',
    notion: 'ntn_abcdefghijklmnopqrstuvwxyz0123456',
    linear: 'lin_api_abcdefghijklmnopqrstuvwxyz0123',
    sendgrid: 'SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789',
    triggerSecret: 'whk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_'
  };
  for (const [name, v] of Object.entries(samples)) A.ok(redact('value: ' + v + ' end').indexOf(v) < 0, 'vendor shape scrubbed: ' + name);
  A.eq(redact('see docs.example.com/a.b.c for v1.2.3'), 'see docs.example.com/a.b.c for v1.2.3', 'ordinary dotted text survives the Discord shape');
}

// ---- known-value layer ----
{
  A.eq(redact('plain shapeless ABCdef123456'), 'plain shapeless ABCdef123456', 'no source registered: shapeless value passes (baseline)');
  let live = ['ABCdef123456', 'short', ' padded-secret-value ', 'ABCdef123456-longer-variant'];
  setKnownSecretSource(() => live);
  A.eq(redact('echo -> ABCdef123456'), 'echo -> [redacted-secret]', 'a registered shapeless value is scrubbed');
  A.eq(redact('ABCdef123456-longer-variant'), '[redacted-secret]', 'longest match first: no partial tail survives');
  A.eq(redact('short and sweet'), 'short and sweet', 'values under 8 chars are ignored (too collision-prone)');
  A.ok(redact('x padded-secret-value y').indexOf('padded-secret-value') < 0, 'registered values are trimmed before matching');
  const nested = redact({ a: ['in array ABCdef123456'], b: { c: 'deep ABCdef123456' }, n: 5 });
  A.eq(nested, { a: ['in array [redacted-secret]'], b: { c: 'deep [redacted-secret]' }, n: 5 }, 'objects and arrays are scrubbed recursively');
  live = ['rotated-new-key-000111'];
  A.ok(redact('now rotated-new-key-000111').indexOf('rotated') < 0, 'the source is read live: a rotated key is covered immediately');
  setKnownSecretSource(() => { throw new Error('store locked'); });
  A.eq(redact('sk-or-v1-abcdefghijklmnop'), '[redacted-key]', 'a throwing source degrades to shape redaction, never a crash');
  setKnownSecretSource(null);
}

// ---- object copies never re-create __proto__ ----
{
  const parsed = JSON.parse('{"__proto__": {"polluted": true}, "ok": "v"}');
  const out = redact(parsed);
  A.eq(Object.keys(out), ['ok'], 'a parsed __proto__ member is dropped from the redacted copy');
  A.ok(out.polluted === undefined && Object.getPrototypeOf(out) === Object.prototype, 'the copy is not re-parented');
}

// ---- the collector over the sidecar's real store shapes ----
{
  const vals = collectSecretValues([
    { values: ['provider-key-aaaa', '', null, ['pool-key-bbbb', 'pool-key-cccc']] },
    { keyed: { telegram: { token: 'tg-token-dddd', model: 'm', ownerId: '12345' }, slack: { token: 'xoxb-part-eeee xapp-part-ffff' } } },
    { keyed: { access_token: 'codex-access-gggg', refresh_token: 'codex-refresh-hhhh', last_refresh: '2026-01-01', auth_mode: 'chatgpt' } },
    { keyed: { byId: { gh: { accessToken: 'oauth-at-iiii', refreshToken: 'oauth-rt-jjjj', tokenEndpoint: 'https://x/token' } }, clients: { 'https://as': { clientId: 'public-id', clientSecret: 'client-sec-kkkk' } } } },
    { keyed: [{ id: 'c1', url: 'https://mcp.example', token: 'conn-token-llll', headers: { 'X-Custom': 'hdr-val-mmmm' }, env: { ANYTHING: 'env-val-nnnn' } }], allUnder: ['headers', 'env'] },
    { keyed: [{ id: 'acme-api', name: 'Acme API', envVar: 'ACME_API_KEY', key: 'svc-key-oooo', last4: 'oooo' }] }
  ]);
  for (const v of ['provider-key-aaaa', 'pool-key-bbbb', 'pool-key-cccc', 'tg-token-dddd', 'xoxb-part-eeee', 'xapp-part-ffff', 'codex-access-gggg', 'codex-refresh-hhhh', 'oauth-at-iiii', 'oauth-rt-jjjj', 'client-sec-kkkk', 'conn-token-llll', 'hdr-val-mmmm', 'env-val-nnnn', 'svc-key-oooo'])
    A.ok(vals.indexOf(v) >= 0, 'collected: ' + v);
  for (const v of ['m', '12345', 'https://x/token', 'public-id', 'https://mcp.example', 'Acme API', 'ACME_API_KEY', 'chatgpt', '2026-01-01'])
    A.ok(vals.indexOf(v) < 0, 'non-secret config is NOT collected: ' + v);
  A.eq(collectSecretValues(null), [], 'no sources -> nothing');
  const cyclic = { token: 'cyc-token-pppp' }; cyclic.self = cyclic;
  A.ok(collectSecretValues([{ keyed: cyclic }]).indexOf('cyc-token-pppp') >= 0, 'a cyclic object is walked with a depth cap, not a hang');
}

A.report('redact.known-values.test');
