/* node test/cron.dispatch.test.js — TRANSACTIONAL DISPATCH + GENERATION FENCE (2026-07-15 reliability audit).

   Locks the two launch-integrity guarantees added to sidecar/cron-driver.js:
     · TRANSACTIONAL DISPATCH: a launch is CONDITIONAL on a verified durable advance/claim. When setJobs
       returns false (the host's persist did not reach disk), the tick fires NOTHING — every planned fire is
       deferred, the jobs stay due, and the next tick (with a working disk) fires exactly once. Launching
       over an unpersisted advance is the crash-restart double-fire window this closes.
     · GENERATION FENCE: only the run that still OWNS the job's lease may settle its record. A reclaimed
       (zombie-swept) run that settles late must NOT markRun — its stale completion would overwrite the
       replacement run's fresher state. It still emits an honest cron.result (reason 'stale-lease'). */
'use strict';
const A = require('./_assert.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');

const T0 = 1700000000000;
const flush = () => new Promise(r => setImmediate(r));

// a harness variant of cron.tick.test.js's setup with a CONTROLLABLE setJobs receipt and hand-settled runs.
function setup(jobs, opts) {
  opts = opts || {};
  const clock = makeClock(T0);
  let store = (jobs || []).slice();
  const events = [];
  const runs = [];            // { opts, resolve, reject } — settle a run by hand
  let idN = 0;
  let failPersist = false;    // when true, setJobs refuses (returns false) WITHOUT applying — the host
                              // rolls its mirror back to disk on failure, so "not applied" models it.
  const driver = makeCronDriver({
    getJobs: () => store,
    setJobs: (j) => { if (failPersist) return false; store = j; return true; },
    runOnce: (o) => new Promise((resolve, reject) => {
      runs.push({
        opts: o,
        resolve: () => { o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); resolve(); },
        reject
      });
    }),
    emit: (name, payload) => { events.push({ name, payload }); },
    newId: () => 'run-' + (++idN),
    newAbort: () => new AbortController(),
    now: () => clock.now(),
    getKey: () => 'sk-test',
    defaultModel: 'test/model',
    persona: 'PERSONA',
    contextFor: opts.contextFor,
    deliverResult: opts.deliverResult,
    afterFinalizationCommitted: opts.afterFinalizationCommitted,
    defaultTz: opts.defaultTz,
    maxParallel: opts.maxParallel,
    maxRunMs: 480000
  });
  return {
    driver, clock, events, runs,
    getJob: (id) => cronStore.getJob(store, id), getStore: () => store.slice(),
    setStore: (fn) => { store = fn(store); },
    setFailPersist: (v) => { failPersist = v; }
  };
}
const firstOf = (events, name) => (events.find(e => e.name === name) || {}).payload;
const lastOf = (events, name) => { const m = events.filter(e => e.name === name); return m.length ? m[m.length - 1].payload : undefined; };

function intervalJob(id, everyStr) {
  const schedule = cron.parseSchedule(everyStr, T0);
  return cronStore.makeJob({ id, prompt: 'do ' + id, agentId: 'cron_' + id, schedule }, { id, now: T0 });
}

(async function () {

  // ---- 1. TRANSACTIONAL DISPATCH: a failed advance persist launches NOTHING; the job stays due; the
  //         next tick with a healthy disk fires exactly once. ----
  {
    const j = intervalJob('t1', 'every 1m');                 // armed nextRunAt = T0 + 60000
    const s = setup([j]);
    s.setFailPersist(true);
    s.clock.set(T0 + 60000);
    const r1 = s.driver.applyTick(s.clock.now());
    A.eq(r1.fired, 0, 'failed advance persist -> nothing fires');
    A.eq(r1.unpersisted, true, 'the tick reports the unpersisted advance');
    A.eq(r1.deferred, ['t1'], 'the due job is deferred, not dropped');
    A.eq(s.runs.length, 0, 'runOnce was never called over an unpersisted advance');
    A.eq(s.getJob('t1').nextRunAt, cron._internals.iso(T0 + 60000), 'nextRunAt unchanged — the job stays DUE');

    // disk recovers -> the SAME occurrence fires exactly once on the next tick.
    s.setFailPersist(false);
    const r2 = s.driver.applyTick(s.clock.now());
    A.eq(r2.fired, 1, 'healthy disk on the next tick -> the deferred job fires');
    A.eq(s.runs.length, 1, 'exactly one launch total (no double-fire, no loss)');
    A.ok(Date.parse(s.getJob('t1').nextRunAt) > s.clock.now(), 'the advance persisted before the launch');
    s.runs[0].resolve(); await flush();
  }

  // ---- 2. GENERATION FENCE: a reclaimed run settling late does NOT overwrite the replacement's record. ----
  {
    const j = intervalJob('f1', 'every 60m');                // armed nextRunAt = T0 + 3600000
    const s = setup([j]);
    s.clock.set(T0 + 3600000);
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, 'run-1 launched');

    // run-1 goes silent past the heartbeat-stale ceiling -> the sweep reclaims its lease.
    s.clock.set(T0 + 3600000 + 480001);
    s.driver.applyTick(s.clock.now());
    A.eq(firstOf(s.events, 'cron.skipped').reason, 'stale-lock-reclaimed', 'the zombie lease was reclaimed');
    A.eq(s.driver.leases.size, 0, 'the reclaimed lease is gone');

    // a REPLACEMENT fires (make the job due now) and settles cleanly -> it owns the record.
    s.setStore(jobs => jobs.map(x => x.id === 'f1' ? Object.assign({}, x, { nextRunAt: cron._internals.iso(s.clock.now()) }) : x));
    s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 2, 'replacement run-2 launched');
    s.runs[1].resolve(); await flush();
    A.eq(s.getJob('f1').lastRunId, 'run-2', 'the replacement settled and owns lastRunId');
    const advancedNext = s.getJob('f1').nextRunAt;

    // NOW the zombie run-1 finally settles. FENCE: it must not touch the store — run-2's record stands.
    s.runs[0].resolve(); await flush();
    A.eq(s.getJob('f1').lastRunId, 'run-2', 'the stale run did NOT overwrite the replacement (generation fence)');
    A.eq(s.getJob('f1').nextRunAt, advancedNext, 'the stale run did not disturb the advanced nextRunAt');
    // ONE RUN, ONE cron.result (2026-09-24): the sweep's reclaim already settled run-1 (and reported it); the
    // zombie's late unowned settle must not emit a second outcome for the same runId
    const run1Results = s.events.filter(e => e.name === 'cron.result' && e.payload.runId === 'run-1');
    A.eq(run1Results.length, 1, 'the reclaimed run reports exactly ONE cron.result (no duplicate stale-lease emit)');
    A.eq(run1Results[0].payload.reason, 'stale-lock-reclaimed', '…and it is the reclaim, the outcome on the record');
    A.eq(lastOf(s.events, 'cron.result').runId, 'run-2', 'the last outcome on the bus is still the replacement\'s');
  }

  // ---- 2b. an unowned settle for a run that NEVER reported (no reclaim settled it) still emits stale-lease ----
  {
    const j = intervalJob('f2', 'every 60m');
    const s = setup([j]);
    s.clock.set(T0 + 3600000);
    s.driver.applyTick(s.clock.now());
    // simulate a lease replaced out from under run-1 without a settlement (a successor owns the job)
    s.driver.leases.set('f2', { runId: 'someone-else', startedAt: s.clock.now(), heartbeatAt: s.clock.now(), ac: new AbortController() });
    s.runs[0].resolve(); await flush();
    const r = s.events.filter(e => e.name === 'cron.result' && e.payload.runId === 'run-1');
    A.eq(r.length, 1, 'an unowned settle with no prior report still emits its one honest result');
    A.ok(/stale-lease/.test(r[0].payload.reason), '…labeled stale-lease');
    s.driver.leases.delete('f2');
  }

  // ---- 3. FENCE + ABORT: the sweep aborts the zombie; its rejected settle is fenced the same way. ----
  {
    const j = intervalJob('a1', 'every 60m');
    const s = setup([j]);
    s.clock.set(T0 + 3600000);
    s.driver.applyTick(s.clock.now());
    const run1 = s.runs[0];
    A.eq(run1.opts.signal.aborted, false, 'run-1 not aborted while live');
    s.clock.set(T0 + 3600000 + 480001);
    s.driver.applyTick(s.clock.now());
    A.eq(run1.opts.signal.aborted, true, 'the sweep aborted the zombie run');
    // bug-sweep 2026-08-28: the SWEEP now records the reclaim as a transient failure (the hang is durable
    // on the record — before this a reclaimed one-shot re-executed forever and a hanging recurring routine
    // never advanced toward auto-disable). The FENCE property this block guards is unchanged: the reclaimed
    // run's OWN late settle writes nothing beyond the sweep's record.
    const afterSweep = s.getJob('a1');
    A.eq(afterSweep.lastRunId, 'run-1', 'the sweep records the reclaim against the zombie run id');
    A.eq(afterSweep.lastStatus, 'error', 'the reclaim is durable as a failed (transient) run');
    run1.reject(new Error('aborted')); await flush();
    A.eq(s.getJob('a1'), afterSweep, 'the reclaimed run\'s rejection writes NOTHING further (generation fence holds)');
  }

  // ---- 4. DATA PLANE: upstream context reaches the model and completion gets the final reply once. ----
  {
    const delivered = [];
    const j = intervalJob('d1', 'every 1m');
    j.contextFrom = ['source']; j.skills = ['Research']; j.workdir = 'C:\\approved-project'; j.enabledToolsets = ['web'];
    const s = setup([j], { contextFor: () => '<untrusted_routine_context>prior result</untrusted_routine_context>', deliverResult: (job, result) => delivered.push({ job, result }) });
    s.clock.set(T0 + 60000); s.driver.applyTick(s.clock.now());
    A.ok(s.runs[0].opts.messages[0].content.includes('prior result'), 'assembled upstream context reaches the scheduled run');
    A.eq(s.runs[0].opts.preloadSkills, ['Research'], 'scheduled skills reach the guarded runtime preload seam');
    A.eq(s.runs[0].opts.workdir, 'C:\\approved-project', 'scheduled project cwd reaches the run host');
    A.eq(s.runs[0].opts.enabledToolsets, ['web'], 'per-job toolset intersection reaches the run host');
    A.eq(s.runs[0].opts.initialTaint, true, 'upstream context structurally taints the unattended run');
    A.eq(s.runs[0].opts.cronJobId, 'd1', 'scheduled run carries its host-minted routine id into recovery metadata');
    A.eq(s.runs[0].opts.cronJobName, j.name, 'scheduled run carries its routine name into recovery metadata');
    s.runs[0].opts.emit('agent.token', { delta: 'final answer' });
    s.runs[0].resolve(); await flush(); await flush();
    A.eq(s.getJob('d1').lastOutput, 'final answer', 'final reply is persisted for downstream context');
    A.eq(delivered.length, 1, 'completion delivery hook runs exactly once');
    A.eq(delivered[0].result.text, 'final answer', 'delivery receives the actual final result text');
  }

  // ---- 5. FINALIZATION RESTART: receipt commits before delivery and replays without rerunning work. ----
  {
    const j = intervalJob('r1', 'every 1m');
    j.deliver = 'origin'; j.origin = { target: 'telegram:original', channel: 'telegram', chatId: 'original' };
    const first = setup([j], { afterFinalizationCommitted: () => false, deliverResult: () => { throw new Error('must not deliver before crash'); } });
    first.clock.set(T0 + 60000); first.driver.applyTick(first.clock.now());
    first.runs[0].opts.emit('agent.token', { delta: 'restart-safe answer' });
    first.runs[0].opts.emit('agent.run.end', { reason: 'done', usd: 0.41 });
    first.runs[0].resolve(); await flush(); await flush();
    const pending = first.getJob('r1');
    A.eq(pending.finalization.state, 'pending', 'result receipt is durable before destination delivery');
    const delivered = [];
    const second = setup(first.getStore(), { deliverResult: (job, result) => { delivered.push({ job, result }); return { ok: true }; } });
    const recovered = await second.driver.recoverFinalizations();
    A.eq(recovered, 1, 'restart reconciles one pending routine receipt');
    A.eq(second.runs.length, 0, 'recovery does not rerun the paid routine');
    A.eq(delivered.length, 1, 'recovery delivers one logical result');
    A.eq({ text: delivered[0].result.text, usd: second.getJob('r1').lastUsd, destination: delivered[0].job.origin.target },
      { text: 'restart-safe answer', usd: 0.41, destination: 'telegram:original' }, 'result, one cost record, and original destination survive together');
    A.eq(second.getJob('r1').finalization.state, 'delivered', 'successful recovery durably closes the receipt');
  }

  // A stale run's failure is a settlement too: disk failure must retain its fence.
  {
    const j = cronStore.makeJob({ id: 'stale-disk', prompt: 'work', schedule: cron.parseSchedule('in 1m', T0) }, { now: T0 });
    const s = setup([j]);
    s.clock.set(T0 + 60000); s.driver.applyTick(s.clock.now());
    s.setFailPersist(true);
    s.clock.set(T0 + 60000 + 480001); s.driver.applyTick(s.clock.now());
    A.ok(s.driver.leases.get(j.id)?.settlement, 'failed stale-run settlement retains a retryable fence');
    s.runs[0].resolve(); await flush();
    s.setFailPersist(false); s.driver.applyTick(s.clock.now());
    A.eq(s.runs.length, 1, 'disk recovery records failure before any replacement dispatch');
    A.eq(s.getJob(j.id).lastReason, 'stale-lock-reclaimed', 'late success cannot overwrite reclaimed outcome');
    A.eq(s.getJob(j.id).retryCount, 1, 'reclaim consumes exactly one bounded retry');
  }

  // Terminal errors must re-arm on the same host timezone used by creation and planning.
  {
    const at = Date.parse('2026-09-21T13:00:00Z');
    const j = cronStore.makeJob({ id: 'tz-error', prompt: 'work', schedule: cron.parseSchedule('0 9 * * *', at - 60000) }, { now: at - 60000, defaultTz: 'America/New_York' });
    const s = setup([j], { defaultTz: 'America/New_York' });
    s.clock.set(at); s.driver.applyTick(at);
    s.runs[0].reject(new Error('terminal failure')); await flush();
    A.eq(s.getJob(j.id).nextRunAt, '2026-09-22T13:00:00.000Z', 'failed daily run stays at 09:00 New York');
  }

  // Delivery recovery is live, throttled, single-flight, and independent of paid work.
  {
    let sends = 0, release;
    const j = intervalJob('delivery', 'every 1m');
    const s = setup([j], { deliverResult: () => { sends++; return new Promise(r => { release = r; }); } });
    s.clock.set(T0 + 60000); s.driver.applyTick(s.clock.now());
    s.runs[0].resolve(); await flush();
    await Promise.all(Array.from({ length: 30 }, () => s.driver.recoverFinalizations()));
    A.eq(sends, 1, 'overlapping recovery passes cannot duplicate an in-flight notification');
    release({ ok: false, error: 'offline' }); await flush();
    A.eq(s.getJob(j.id).finalization.attempts, 1, 'failed delivery attempt recorded once');
    await s.driver.recoverFinalizations();
    A.eq(sends, 1, 'backoff prevents tight-loop delivery retries');
    // Another occurrence completes while the first delivery is still pending.
    s.clock.set(T0 + 120000); s.driver.applyTick(s.clock.now());
    await flush();
    A.eq(sends, 2, 'a later tick retries the notification without restarting');
    const releaseOld = release;
    s.runs[1].resolve(); await flush();
    A.eq(s.getJob(j.id).deliveryBacklog.length, 1, 'new completion retains the old pending receipt');
    releaseOld({ ok: true }); await flush();
    A.eq(s.getJob(j.id).deliveryBacklog.length, 0, 'older delivery acknowledgement removes only its receipt');
    A.eq(s.getJob(j.id).finalization.runId, 'run-2', 'old completion cannot overwrite the newer receipt');
    release({ ok: true }); await flush();
    A.eq(s.runs.length, 2, 'delivery retries never re-execute paid work');
  }
  {
    let sends = 0;
    const s = setup([intervalJob('ack-disk', 'every 1m')], { deliverResult: () => { sends++; s.setFailPersist(true); return { ok: true }; } });
    s.clock.set(T0 + 60000); s.driver.applyTick(s.clock.now());
    s.runs[0].resolve(); await flush();
    await s.driver.recoverFinalizations();
    A.eq(sends, 1, 'failed acknowledgement persistence does not resend within the process');
    s.setFailPersist(false); await s.driver.recoverFinalizations();
    A.eq(s.getJob('ack-disk').finalization.state, 'delivered', 'acknowledgement retries after disk recovery');
    A.eq(sends, 1, 'durable acknowledgement recovery still sends only once');
  }

  {
    const jobs = Array.from({ length: 200 }, (_, i) => intervalJob('burst-' + i, 'every 1m'));
    const s = setup(jobs, { maxParallel: 4 });
    s.clock.set(T0 + 60000);
    let peak = 0;
    for (let batch = 0; batch < 50; batch++) {
      const before = s.runs.length;
      s.driver.applyTick(s.clock.now());
      peak = Math.max(peak, s.driver.leases.size);
      for (const r of s.runs.slice(before)) r.resolve();
      await flush();
    }
    A.eq(peak, 4, '200 simultaneous jobs never exceed the configured concurrency limit');
    A.eq(s.runs.length, 200, 'all 200 due jobs drain without starvation');
    A.eq(new Set(s.runs.map(r => r.opts.agentId)).size, 200, 'burst executes each job once');
    A.eq(s.getStore().filter(j => j.repeat.completed === 1).length, 200, 'every burst completion is durably accounted once');
  }
  {
    const j = intervalJob('backlog', 'every 1m');
    const waiting = i => ({ runId: 'old-' + i, state: 'pending', result: 'result-' + i, nextAttemptAt: cron._internals.iso(T0 + 999999) });
    j.deliveryBacklog = Array.from({ length: 99 }, (_, i) => waiting(i)); j.finalization = waiting(99);
    const s = setup([j]); s.clock.set(T0 + 60000);
    const tick = s.driver.applyTick(s.clock.now());
    A.eq(tick.deferred, [j.id], 'a full outbox applies backpressure instead of dropping results');
    A.eq(s.getJob(j.id).nextRunAt, j.nextRunAt, 'backpressure preserves the due occurrence');
    A.eq(s.runs.length, 0, 'a full outbox starts no additional paid work');
    const restarted = cronStore.loadEnvelope(JSON.stringify(cronStore.toEnvelope(s.getStore()))).jobs;
    A.eq(cronStore.pendingDeliveries(restarted[0]).length, 100, 'every pending result survives a serialized restart');
  }

  A.report('cron.dispatch');
})().catch(e => { console.error(e); process.exit(1); });
