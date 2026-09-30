/* node test/provider.codex-quota-body.test.js — a ChatGPT-plan 429 whose body says code 'usage_limit_reached'
   is a SPENT QUOTA, not a transient rate limit. The Codex adapter used to keep only error.message ("Codex quota
   exceeded") and drop the body, so the classifier saw a plain 429 -> rate_limit (retryable); once the loop's
   pre-stream ladder learned to ride out transient 429s, a spent plan was retried for ~100 s before failing
   (caught by test/saved-provider-fallback.e2e.test.js on the integration branch). The error must carry the body,
   classify as quota_exhausted, and the adapter must not spend its own retries on it. A genuinely transient 429
   (no quota code) still retries. Zero network: injected fetch. */
'use strict';
const A = require('./_assert.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');

const jsonFetch = (status, body, calls) => async () => {
  calls.push(status);
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};
async function firstError(provider, req) {
  try { for await (const e of provider.stream(req)) { if (e && e.type === 'error') return e.error || e; } }
  catch (e) { return e; }
  return null;
}
const req = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] };

(async () => {
  // A. spent plan quota: body code usage_limit_reached -> quota_exhausted, not retryable, ONE request
  {
    const calls = [];
    const p = makeCodexProvider({ fetch: jsonFetch(429, { error: { message: 'Codex quota exceeded', code: 'usage_limit_reached' } }, calls), token: 'acc' });
    const err = await firstError(p, req);
    A.ok(err, 'a 429 surfaces as an error');
    A.ok(err && err.body && err.body.error && err.body.error.code === 'usage_limit_reached', 'the provider error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'gpt-5.5' });
    A.eq(cls.reason, 'quota_exhausted', 'usage_limit_reached classifies as a spent quota');
    A.eq(cls.retryable, false, 'a spent quota is not retryable');
    A.eq(cls.shouldFallback, true, 'a spent quota fails over when a fallback exists');
    A.eq(calls.length, 1, 'the adapter spends no retries on a spent quota');
    A.ok(!(err && err.preStreamRetriesExhausted), 'not marked as an exhausted transient retry');
  }

  // B. a transient 429 (no quota code) is still a retryable rate limit the adapter retries
  {
    const calls = [];
    const p = makeCodexProvider({ fetch: jsonFetch(429, { error: { message: 'Rate limit reached, slow down', code: 'rate_limit_exceeded' } }, calls), token: 'acc' });
    const err = await firstError(p, Object.assign({}, req, { preStreamRetries: 0 }));
    const cls = classifyApiError(err, { model: 'gpt-5.5' });
    A.eq(cls.reason, 'rate_limit', 'a plain 429 stays a rate limit');
    A.eq(cls.retryable, true, 'a plain 429 stays retryable');
  }

  A.report('provider.codex-quota-body.test');
})().catch(e => { console.log('FAIL: provider.codex-quota-body.test threw -- ' + (e && e.stack || e)); process.exit(1); });
