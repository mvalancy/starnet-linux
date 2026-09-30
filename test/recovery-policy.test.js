'use strict';
const A = require('./_assert.js');
const P = require('../sidecar/recovery-policy.js');

A.eq(P.providerFailure({ classification: { shouldCompress: true, reason: 'context_overflow' }, canCompress: true, recoveriesUsed: 0, maxRecoveries: 1 }),
  { action: 'compress', reason: 'context_overflow', retryable: true, delayMs: 0 }, 'compression is the first recovery path');
A.eq(P.providerFailure({ classification: { shouldFallback: true, reason: 'overloaded' }, hasFallback: true, recoveriesUsed: 0, maxRecoveries: 1 }).action,
  'fallback', 'available fallback outranks same-provider retry');
A.eq(P.providerFailure({ classification: { shouldFallback: true, retryable: true, reason: 'overloaded' }, hasFallback: false, retriesUsed: 0, maxRetries: 6 }).action,
  'retry', 'exhausted fallback chain uses bounded same-provider retry');
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'timeout', retryAfterMs: 2500 }, retriesUsed: 1, maxRetries: 6 }).delayMs,
  2500, 'server retry-after outranks the local rung');
A.eq(P.providerFailure({ classification: { retryable: true }, retriesUsed: 6, maxRetries: 6 }).action,
  'fail', 'retry budget is a hard bound');
A.eq(P.providerFailure({ classification: { retryable: true }, preStreamRetriesExhausted: true, retriesUsed: 0, maxRetries: 6 }).action,
  'fail', 'adapter-exhausted pre-stream ladder is never multiplied');
A.eq(P.providerFailure({ classification: { retryable: true }, cancelled: true }).action,
  'fail', 'cancellation cannot enter recovery');

// 2026-09-22 (Hermes audit F2): an adapter-exhausted TRANSIENT failure continues the same ladder, counted.
A.eq(P.providerFailure({ classification: { retryable: true, shouldFallback: true, reason: 'overloaded' }, preStreamRetriesExhausted: true, retriesUsed: 2, maxRetries: 6 }).action,
  'retry', 'adapter-exhausted overload with no fallback continues the loop ladder');
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'overloaded' }, preStreamRetriesExhausted: true, retriesUsed: 2, maxRetries: 6 }).delayMs,
  4000, 'it resumes at the rung after the ones the adapter spent');
for (const reason of ['auth', 'billing', 'quota_exhausted', 'content_policy_blocked', 'format_error', 'tls_certificate', 'local_error']) {
  A.eq(P.providerFailure({ classification: { retryable: false, reason }, preStreamRetriesExhausted: true, retriesUsed: 0, maxRetries: 6 }).action,
    'fail', reason + ' is never retried');
}
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'unknown' }, preStreamRetriesExhausted: true, retriesUsed: 2, maxRetries: 6 }).action,
  'fail', 'an exhausted unknown is evidence, not a blip');
A.eq(P.preStreamSpend({ preStreamRetriesExhausted: true, preStreamAttempts: 3, preStreamWaitMs: 1600 }), { rungs: 2, waitedMs: 1600 },
  'a stamped adapter spend is counted exactly');
A.eq(P.preStreamSpend({ preStreamRetriesExhausted: true }), { rungs: 2, waitedMs: 1600 }, 'an unstamped marker is assumed to be the standard ladder');
A.eq(P.preStreamSpend({ preStreamRetriesExhausted: true, preStreamAttempts: 1, preStreamWaitMs: 0 }), { rungs: 0, waitedMs: 0 }, 'a one-request rung spends nothing extra');
A.eq(P.preStreamSpend(new Error('mid-stream')), { rungs: 0, waitedMs: 0 }, 'a mid-stream failure spends no adapter rungs');
// jitter + patience
A.eq([P.jitteredDelay(10000, 0), P.jitteredDelay(10000, 0.5), P.jitteredDelay(10000, 1), P.jitteredDelay(10000)], [8000, 10000, 12000, 10000],
  '±20% jitter from the injected sample; no sample = the plain rung');
A.eq(P.RETRY_PATIENCE_MS, 105600, 'patience is the ladder sum');
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'timeout' }, retriesUsed: 5, maxRetries: 6, waitedMs: 100000, patienceMs: P.RETRY_PATIENCE_MS, jitterSample: 0.5 }).delayMs,
  5600, 'the last rung shrinks to the remaining patience');
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'timeout' }, retriesUsed: 3, maxRetries: 6, waitedMs: P.RETRY_PATIENCE_MS, patienceMs: P.RETRY_PATIENCE_MS }).action,
  'fail', 'spent patience ends the ladder');
const stated = P.providerFailure({ classification: { retryable: true, reason: 'rate_limit', retryAfterMs: 20000 }, retriesUsed: 0, maxRetries: 6, waitedMs: P.RETRY_PATIENCE_MS, patienceMs: P.RETRY_PATIENCE_MS, jitterSample: 1 });
A.eq([stated.action, stated.delayMs, stated.ladderMs], ['retry', 24000, 0], 'a server-stated wait is honored (upward jitter only) outside the local budget');
// output cap
A.eq(P.providerFailure({ classification: { reason: 'output_cap', allowedMaxTokens: 64000, shouldCompress: false }, canCompress: true, recoveriesUsed: 0, maxRecoveries: 1 }),
  { action: 'lower_output', reason: 'output_cap', retryable: true, delayMs: 0, maxTokens: 64000 }, 'an output cap lowers the budget instead of folding');
A.eq(P.providerFailure({ classification: { reason: 'output_cap', allowedMaxTokens: 64000 }, outputCapRetried: true }).action,
  'fail', 'the lowered retry happens once per turn');

const transientRead = { provenance: 'host', scope: 'read', readOnly: true };
A.eq(P.toolFailure({ tool: transientRead, result: { isError: true, summary: 'timeout', content: 'timed out' }, retriesUsed: 0, maxRetries: 1 }).action,
  'retry', 'a transient host-defined read is retryable');
A.eq(P.toolFailure({ tool: { provenance: 'host', scope: 'write', readOnly: false }, result: { isError: true, summary: 'timeout' } }).action,
  'fail', 'mutations are never retried automatically');
A.eq(P.toolFailure({ tool: { provenance: 'connector', scope: 'read', readOnly: true }, result: { isError: true, summary: 'timeout' } }).action,
  'fail', 'remote read-only metadata never grants retry authority');
A.eq(P.toolFailure({ tool: transientRead, result: { isError: true, summary: 'error', content: 'invalid arguments' } }).action,
  'fail', 'deterministic read failures are not retried');
A.eq(P.toolFailure({ tool: transientRead, result: { isError: true, summary: 'timeout' }, retriesUsed: 1, maxRetries: 1 }).action,
  'fail', 'tool retry budget is a hard one-attempt bound');
A.report('recovery-policy.test');
