/* node test/provider.error-body.test.js — every adapter keeps the provider's parsed error body on the error it
   throws (err.body), so errorClass decides on the CODE, not on prose (Hermes audit Step 2, 2026-09-22).

   Audit finding (29bb21d80): anthropic.js, openai-compatible.js, openrouter.js and gemini.js built
   `new Error('<p> http N - ' + detail)` from error.message alone; codex.js was fixed in Step 1. Pinned per adapter:
     · err.body is the parsed JSON body, and a code-bearing error classifies by its code (OpenAI/OpenRouter
       `insufficient_quota` behind a generic message = billing; Anthropic `overloaded_error`; Gemini
       `RESOURCE_EXHAUSTED` mid-stream = a rate limit, not an empty wallet);
     · the REPORTED message stays the adapter's own sentence (label + "http N") — the UI routes on it
       (friendlyerror.js /(grok|kimi).*http 40[13]/ -> the RECONNECT door) — the body rides along for its code;
     · existing verdicts hold (Anthropic 529 overloaded, "prompt is too long" overflow, a plain 429 rate limit).
   Injected fetch only — no network. */
'use strict';
const A = require('./_assert.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { makeGeminiProvider } = require('../sidecar/providers/gemini.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');

const REQ = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], preStreamRetries: 0 };
function jsonFetch(status, body, calls) {
  return async (url, init) => {
    if (!init || !init.body) return new Response('{"data":[],"models":[]}', { status: 200 });
    calls.push(status);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
const sseFetch = lines => async (url, init) => {
  if (!init || !init.body) return new Response('{"data":[],"models":[]}', { status: 200 });
  return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
async function thrown(p, req) {
  try { for await (const _ of p.stream(req || REQ)) { /* drain */ } }
  catch (e) { return e; }
  return null;
}
const line = o => 'data: ' + JSON.stringify(o);

(async () => {
  // ---- OpenAI-compatible: the body rides; a generic message with code insufficient_quota is billing ----
  {
    const calls = [];
    const body = { error: { message: 'Request failed', type: 'insufficient_quota', code: 'insufficient_quota' } };
    const err = await thrown(makeOpenAICompatibleProvider({ key: 'k', baseUrl: 'https://compat.test/v1', fetch: jsonFetch(429, body, calls) }));
    A.eq(err && err.body, body, 'openai-compatible: the parsed error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'm' });
    A.eq(cls.reason, 'billing', 'openai-compatible: insufficient_quota on a 429 is an empty wallet, not a rate limit');
    A.eq(cls.retryable, false, 'openai-compatible: …and is not retried');
    A.eq(calls.length, 1, 'openai-compatible: one request, no retry ladder');
    A.ok(/^openai-compatible http 429 - /.test(cls.message), 'openai-compatible: the reported message keeps the adapter\'s own sentence');

    // a device-OAuth provider's dead token must still read as "<Name> http 401" — the RECONNECT door keys on it
    const kimi = await thrown(makeOpenAICompatibleProvider({ label: 'Kimi For Coding', key: 'tok', baseUrl: 'https://api.kimi.com/coding/v1',
      fetch: jsonFetch(401, { error: { message: 'The access token is invalid', type: 'invalid_authentication_error' } }, []) }));
    const kcls = classifyApiError(kimi, { model: 'kimi-for-coding' });
    A.eq(kcls.reason, 'auth', 'kimi 401: auth');
    A.ok(/(grok|kimi).*http 40[13]/.test(kcls.message.toLowerCase()), 'kimi 401: the message the UI routes on is intact (' + kcls.message + ')');
    A.ok(kimi.body && kimi.body.error.type === 'invalid_authentication_error', 'kimi 401: the body rides alongside');

    // a mid-stream error frame carries its body too
    const mid = await thrown(makeOpenAICompatibleProvider({ key: 'k', baseUrl: 'https://compat.test/v1',
      fetch: sseFetch([line({ error: { message: 'This model\'s maximum context length is 8192 tokens', code: 'context_length_exceeded' } })]) }));
    A.eq(mid && mid.body && mid.body.error.code, 'context_length_exceeded', 'openai-compatible: a stream error frame keeps its body');
    A.eq(classifyApiError(mid, { model: 'm' }).reason, 'context_overflow', 'openai-compatible: …and classifies by its code');
  }

  // ---- OpenRouter: code only in the body (the message is generic) ----
  {
    const calls = [];
    const body = { error: { message: 'Request failed', code: 'insufficient_quota' } };
    const err = await thrown(makeOpenRouterProvider({ key: 'k', fetch: jsonFetch(429, body, calls) }));
    A.eq(err && err.body, body, 'openrouter: the parsed error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'm' });
    A.eq(cls.reason, 'billing', 'openrouter: the code decides (the message alone read as a plain rate limit)');
    A.ok(/^openrouter http 429 — /.test(cls.message), 'openrouter: the reported message keeps the adapter\'s own sentence');
    const plain = await thrown(makeOpenRouterProvider({ key: 'k', fetch: jsonFetch(429, { error: { message: 'Rate limit exceeded: free-models-per-min', code: 429 } }, []) }));
    A.eq(classifyApiError(plain, { model: 'm' }).reason, 'rate_limit', 'openrouter: a plain 429 (numeric code) stays a rate limit');
  }

  // ---- Anthropic: the typed error rides; verdicts hold ----
  {
    const calls = [];
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    const err = await thrown(makeAnthropicProvider({ key: 'k', fetch: jsonFetch(529, body, calls) }));
    A.eq(err && err.body, body, 'anthropic: the parsed error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'claude-test' });
    A.eq(cls.reason, 'overloaded', 'anthropic: 529 overloaded_error is overloaded');
    A.eq(cls.retryable, true, 'anthropic: …and retryable');
    A.ok(/^anthropic http 529 - Overloaded/.test(cls.message), 'anthropic: the reported message keeps the adapter\'s own sentence');

    const tooLong = await thrown(makeAnthropicProvider({ key: 'k', fetch: jsonFetch(400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 215000 tokens > 200000 maximum' } }, []) }));
    A.eq(classifyApiError(tooLong, { model: 'claude-test' }).reason, 'context_overflow', 'anthropic: "prompt is too long" still folds history (no regression)');

    // mid-stream: Anthropic can send an error EVENT after a 200; its type decides even when the prose is generic
    const mid = await thrown(makeAnthropicProvider({ key: 'k', fetch: sseFetch([
      line({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
      line({ type: 'error', error: { type: 'overloaded_error', message: 'upstream hiccup' } })
    ]) }));
    A.eq(mid && mid.body && mid.body.error.type, 'overloaded_error', 'anthropic: a stream error event keeps its body');
    A.eq(classifyApiError(mid, { model: 'claude-test' }).reason, 'overloaded', 'anthropic: the typed error decides (the prose alone was "unknown")');
  }

  // ---- Gemini: RESOURCE_EXHAUSTED is a rate limit, mid-stream too ----
  {
    const calls = [];
    const body = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } };
    const err = await thrown(makeGeminiProvider({ key: 'k', fetch: jsonFetch(429, body, calls) }));
    A.eq(err && err.body, body, 'gemini: the parsed error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'gemini-test' });
    A.eq(cls.reason, 'rate_limit', 'gemini: an HTTP 429 RESOURCE_EXHAUSTED is a rate limit');
    A.ok(/^gemini http 429 - /.test(cls.message), 'gemini: the reported message keeps the adapter\'s own sentence');

    const mid = await thrown(makeGeminiProvider({ key: 'k', fetch: sseFetch([line(body)]) }));
    A.eq(mid && mid.body, body, 'gemini: a stream error frame keeps its body');
    const mcls = classifyApiError(mid, { model: 'gemini-test' });
    A.eq(mcls.reason, 'rate_limit', 'gemini: mid-stream RESOURCE_EXHAUSTED is a rate limit by its status code (the prose alone read "quota" -> billing)');
    A.eq(mcls.retryable, true, 'gemini: …and retryable');
    const daily = await thrown(makeGeminiProvider({ key: 'k', fetch: sseFetch([line({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
      message: 'You have hit your daily quota for this model; quota resets in 20 hours.' } })]) }));
    A.eq(classifyApiError(daily, { model: 'gemini-test' }).reason, 'quota_exhausted', 'gemini: a spent DAILY allowance under the same status is quota_exhausted');
  }

  // ---- Codex (Step 1 already kept the body): the message keeps its sentence too; a failed stream keeps its code ----
  {
    const err = await thrown(makeCodexProvider({ token: 't', fetch: jsonFetch(429, { error: { message: 'Codex quota exceeded', code: 'usage_limit_reached' } }, []) }));
    const cls = classifyApiError(err, { model: 'gpt-5.5' });
    A.eq(cls.reason, 'quota_exhausted', 'codex: usage_limit_reached is a spent quota');
    A.ok(/^codex http 429 — Codex quota exceeded/.test(cls.message), 'codex: the reported message is the adapter\'s sentence, label + status intact');
    const failed = await thrown(makeCodexProvider({ token: 't', fetch: sseFetch([line({ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'The usage limit has been reached' } } })]) }));
    A.eq(classifyApiError(failed, { model: 'gpt-5.5' }).reason, 'quota_exhausted', 'codex: a response.failed carrying usage_limit_reached is a spent quota');
  }

  A.report('provider.error-body.test');
})().catch(e => { console.log('FAIL: provider.error-body.test threw -- ' + (e && e.stack || e)); process.exit(1); });
