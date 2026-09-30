/* node test/subagents.waiting-is-progress.test.js — a worker WAITING ON ITS MODEL is alive (2026-09-23, live-events).

   The liveness sweep (subagents.checkStalls, Step 2 F3) stales a background worker after STALL_MS (450s) with no
   progress event. A deep-reasoning model can legitimately stay silent that long, and before the live wait events
   nothing a worker emitted while waiting counted — so a slow-but-healthy worker was killed for thinking. Now:

     · agent.waiting heartbeats (the loop's beat while a model call shows nothing) keep a worker alive for 500s+
     · provider.retry (a ladder rung announced before its backoff) is progress too
     · a worker that emits NOTHING is still staled at 450s (the sweep is not weakened)
     · the in-tool window logic is untouched (1200s while a tool call is open)
     · a heartbeat whose wait has already outlasted the in-tool window (a stream trickling keep-alive bytes with no
       content for 20+ minutes) stops counting, so a wedged model call can still be caught

   Deterministic: the real manager over a temp dir, a hand-driven clock, no timers. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSubagentManager } = require('../sidecar/subagents.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const counter = (p) => { let n = 0; return () => (p || 'id_') + (++n); };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sub-waiting-'));
  try {
    let T = 2000000;
    const clock = { now: () => T };
    const mgr = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock, emit: () => {}, newId: counter('w_') });
    A.eq(mgr.stallPolicy(), { stallMs: 450000, inToolStallMs: 1200000 }, 'default thresholds unchanged');
    const held = {};
    const hang = key => async (h) => { held[key] = h; h.emit('agent.run.start', { agentId: 'x', runId: h.runId, trigger: 'directive', model: 'm' }); return new Promise(() => {}); };

    // ---- a worker whose model is silent for 500s, heartbeating every 15s, is NOT stale ----
    const slow = mgr.start({ leadId: 'agent', agentId: 'thinker', prompt: 'think hard' }, hang('slow'));
    // ---- a worker that emits nothing, started at the same instant ----
    const mute = mgr.start({ leadId: 'agent', agentId: 'mute', prompt: 'hang' }, hang('mute'));
    await tick();
    for (let s = 15; s <= 495; s += 15) {
      T += 15000;
      held.slow.emit('agent.waiting', { agentId: 'x', runId: held.slow.runId, phase: 'first_byte', sinceMs: s * 1000, model: 'm' });
      const stalled = mgr.checkStalls().map(r => r.id);
      A.ok(!stalled.includes(slow.id), 'heartbeating worker alive at ' + s + 's');
      if (s === 450) A.eq(stalled, [mute.id], 'the silent worker is staled at exactly 450s — the sweep is not weakened');
    }
    T += 5000;   // 500s since start
    A.eq(mgr.checkStalls(), [], '500s of model silence with heartbeats: not stale');
    A.eq(mgr.get(slow.id).status, 'running', 'still running');
    A.eq(mgr.get(mute.id).status, 'stale', 'the mute worker stayed stale');

    // ---- provider.retry is progress ----
    const retrier = mgr.start({ leadId: 'agent', agentId: 'retrier', prompt: 'flaky upstream' }, hang('retrier'));
    await tick();
    T += 440000;
    held.retrier.emit('provider.retry', { agentId: 'x', runId: held.retrier.runId, attempt: 5, reason: 'overloaded', delayMs: 30000 });
    T += 440000;
    A.ok(!mgr.checkStalls().map(r => r.id).includes(retrier.id), 'a retry 440s ago resets the clock');
    T += 10000;
    A.ok(mgr.checkStalls().map(r => r.id).includes(retrier.id), 'then 450s of real silence stalls it');

    // ---- a heartbeat whose wait outlasted the in-tool window no longer counts ----
    const wedged = mgr.start({ leadId: 'agent', agentId: 'wedged', prompt: 'keep-alive trickle' }, hang('wedged'));
    await tick();
    T += 440000;
    held.wedged.emit('agent.waiting', { agentId: 'x', runId: held.wedged.runId, phase: 'streaming', sinceMs: 1200001, model: 'm' });
    T += 10000;
    A.ok(mgr.checkStalls().map(r => r.id).includes(wedged.id), 'a beat reporting a 20-minute wait is not progress: the wedged call is caught');

    // ---- the in-tool window logic is untouched ----
    const tooly = mgr.start({ leadId: 'agent', agentId: 'builder', prompt: 'long build' }, hang('tooly'));
    await tick();
    held.tooly.emit('agent.tool_call', { agentId: 'x', runId: held.tooly.runId, callId: 'c1', name: 'shell_exec' });
    T += 1000000;
    A.eq(mgr.checkStalls(), [], 'an open tool call still gets the 1200s window');
    T += 200000;
    A.eq(mgr.checkStalls().map(r => r.id), [tooly.id], 'and is staled past it');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn('cleanup:', e && e.message); }
  }
  A.report('subagents.waiting-is-progress');
})().catch(e => { console.error(e); process.exit(1); });
