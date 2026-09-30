/* Safe continuation planning for interrupted run journals.
 *
 * This module is deliberately pure. It turns a resolved journal into provider-valid history and a host-enforced
 * replay barrier. Prompt context explains the operator's decision; the fingerprint barrier is the authority that
 * prevents an already-reviewed mutating call from executing again. */
'use strict';

const crypto = require('crypto');

function stable(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function canonicalArgs(argsRaw) {
  const raw = String(argsRaw == null ? '{}' : argsRaw);
  try { return stable(JSON.parse(raw)); } catch (_) { return raw; }
}

function replayFingerprint(name, argsRaw) {
  return crypto.createHash('sha256').update(String(name || '') + '\n' + canonicalArgs(argsRaw)).digest('hex');
}

function fail(message) {
  const e = new Error(message); e.code = 'RUN_CONTINUATION_BLOCKED'; throw e;
}

function cloneMessages(messages) {
  try { return JSON.parse(JSON.stringify(messages || [])); }
  catch (_) { fail('recovery checkpoint could not be cloned safely'); }
}

function checkpointWithPairedResults(state, options) {
  state = state || {};
  // A lone torn FINAL record (damage 'torn_tail') is the ordinary crash signature: that record never became
  // durable, so its hash-chain-valid prefix continues exactly like an intact journal. Every other damage class,
  // a repair that failed, or a forensic sibling on disk stays forensic-only.
  const tornTailOnly = state.damage === 'torn_tail' && !state.forensic;
  if ((state.corrupt && !tornTailOnly) || state.forensic || state.repairError || state.forensicOnly) fail('corrupt recovery journals remain forensic-only');
  const uncertain = Array.isArray(state.uncertain) ? state.uncertain : [];
  const reviewed = !!(options && options.reviewed);
  let outcomes = new Map();
  if (reviewed) {
    if (!state.resolution || !Array.isArray(state.resolution.outcomes)) fail('operator resolution is required');
    if (state.resolution.outcomes.some(x => !x || x.outcome === 'unknown')) fail('unknown outcomes cannot continue');
    if (state.resolution.outcomes.some(x => !/^(?:happened|did_not_happen)$/.test(String(x.outcome || '')))) fail('every outcome must be verified');
    if (!uncertain.length) fail('no reviewed uncertainty is available to continue');
    outcomes = new Map(state.resolution.outcomes.map(x => [String(x.callId || ''), String(x.outcome || '')]));
    if (uncertain.some(x => !outcomes.has(String(x.callId || '')))) fail('resolution does not cover every uncertain call');
  } else if (uncertain.length) {
    fail('uncertain mutations require operator review');
  }

  const messages = cloneMessages(state.checkpoint && state.checkpoint.messages);
  if (!messages.length) fail('provider checkpoint is missing');
  const pending = new Map();
  for (const m of messages) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (c && c.id) pending.set(String(c.id), c);
    } else if (m && m.role === 'tool' && m.tool_call_id) {
      pending.delete(String(m.tool_call_id));
    } else if (pending.size) {
      fail('provider checkpoint contains an unpaired tool call before later context');
    }
  }
  const uncertainById = new Map(uncertain.map(x => [String(x.callId || ''), x]));
  for (const id of uncertainById.keys()) if (!pending.has(id)) fail('uncertain call is absent from the provider checkpoint');
  const completedById = new Map();
  for (const pair of (Array.isArray(state.completed) ? state.completed : [])) {
    const id = String((pair && pair.intent && pair.intent.callId) || (pair && pair.result && pair.result.callId) || '');
    if (id) completedById.set(id, pair);
  }

  const blockedFingerprints = [];
  const contextLines = [];
  for (const [callId] of pending) {
    const reviewedCall = uncertainById.get(callId);
    if (reviewedCall) {
      const outcome = outcomes.get(callId);
      if (reviewedCall.mutating !== false) {
        const fp = String(reviewedCall.replayFingerprint || '');
        if (!/^[a-f0-9]{64}$/.test(fp)) fail('reviewed mutation lacks a durable replay fingerprint');
        blockedFingerprints.push(fp);
      }
      const name = String(reviewedCall.name || 'tool');
      const verdict = outcome === 'happened' ? 'happened' : 'did not happen';
      const replayRule = reviewedCall.mutating !== false
        ? ' This reviewed mutating call is closed; the host will not execute it again in this continuation.'
        : ' This reviewed read result is closed and supplied as operator-verified context.';
      messages.push({
        role: 'tool', tool_call_id: callId,
        content: 'OPERATOR-VERIFIED RECOVERY: the uncertain `' + name + '` effect ' + verdict + ' before the crash.' + replayRule
      });
      contextLines.push(name + ' (' + callId + '): verified ' + verdict + (reviewedCall.mutating !== false ? '; mutating replay blocked' : '; read result supplied'));
      continue;
    }
    const completed = completedById.get(callId);
    if (!completed || !completed.result) {
      if (!reviewed) continue; // automaticContinuationPlan validates this exact pending id as safely replayable
      fail('provider checkpoint has a tool call with no durable result or operator verdict');
    }
    const result = completed.result;
    const content = String(result.content == null ? '' : result.content);
    messages.push({ role: 'tool', tool_call_id: callId, content: result.isError ? ('ERROR: ' + content) : content });
    pending.delete(callId);
  }
  return { messages, pending, blockedFingerprints, contextLines };
}

function continuationPlan(state) {
  const built = checkpointWithPairedResults(state, { reviewed: true });
  const messages = built.messages;
  const context = 'Safe continuation of interrupted run ' + String(state.runId || '') + '. Operator resolution:\n- '
    + built.contextLines.join('\n- ')
    + '\nNo reviewed mutating call may be replayed. Continue from the paired results above; if further work would require an identical blocked call, stop and tell the operator.';
  messages.push({ role: 'system', content: '<operator_resolution>\n' + context + '\n</operator_resolution>' });
  return { messages, context, blockedFingerprints: Array.from(new Set(built.blockedFingerprints)).sort(), mode: 'reviewed' };
}

// A restart may continue automatically only when the journal proves that no side effect is uncertain. Pending
// reads and prepared-only calls are intentionally omitted from the paired checkpoint: the provider sees the
// outstanding call and may retry it, while the normal host dispatch gates and mutation journal run again.
function automaticContinuationPlan(state) {
  state = state || {};
  if (state.status !== 'resumable') fail('run is not automatically resumable');
  const built = checkpointWithPairedResults(state, { reviewed: false });
  const replayable = new Map();
  for (const row of (Array.isArray(state.replayableReads) ? state.replayableReads : [])) replayable.set(String(row.callId || ''), row);
  for (const row of (Array.isArray(state.replayablePrepared) ? state.replayablePrepared : [])) replayable.set(String(row.callId || ''), row);
  for (const callId of built.pending.keys()) {
    if (!replayable.has(callId)) fail('pending call lacks a safe replay classification');
  }
  // Provider protocols require every assistant tool_call to be followed by one tool result before later
  // context. Pair the interrupted call with host recovery truth; do not execute it here. The model may issue a
  // fresh call, which re-enters authority, consent, hooks, dispatch journaling, and the replay policy normally.
  for (const [callId] of built.pending) {
    const row = replayable.get(callId);
    const preparedMutation = row && row.mutating !== false;
    built.messages.push({
      role: 'tool', tool_call_id: callId,
      content: preparedMutation
        ? 'AUTOMATIC RECOVERY: this mutating call was prepared but provably never dispatched before restart. No effect occurred. Reissue it if it is still required.'
        : 'AUTOMATIC RECOVERY: this read-only call had no durable result before restart. Reissue the read if it is still required.'
    });
  }
  const context = 'Automatic safe continuation of interrupted run ' + String(state.runId || '') + '. The host proved there are no uncertain dispatched mutations. '
    + (built.pending.size
      ? 'The outstanding call was either read-only or prepared but never dispatched; its recovery result is paired below. Reissue it through the normal host gates if still required, then finish the original task.'
      : 'Continue from the last durable checkpoint and finish the original task.');
  built.messages.push({ role: 'system', content: '<automatic_recovery>\n' + context + '\n</automatic_recovery>' });
  return { messages: built.messages, context, blockedFingerprints: [], mode: 'automatic' };
}

function makeReplayBarrier(fingerprints) {
  const blocked = new Set((Array.isArray(fingerprints) ? fingerprints : []).map(String));
  return {
    check(name, argsRaw, mutating) {
      if (!mutating) return { ok: true };
      const fingerprint = replayFingerprint(name, argsRaw);
      return blocked.has(fingerprint)
        ? { ok: false, fingerprint, reason: 'reviewed mutation replay blocked' }
        : { ok: true, fingerprint };
    },
    fingerprints: () => Array.from(blocked).sort()
  };
}

module.exports = { replayFingerprint, continuationPlan, automaticContinuationPlan, makeReplayBarrier, _internals: { stable, canonicalArgs, checkpointWithPairedResults } };
