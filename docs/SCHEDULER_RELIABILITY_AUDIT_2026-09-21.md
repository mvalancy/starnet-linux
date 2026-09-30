# Scheduler reliability audit — 2026-09-21

StarNet baseline: `a934cb61c` (`feat/harness-backend`). Implementation lane:
`agent/cron-reliability-0921`. Hermes reference: NousResearch/hermes-agent
`8e806ae1b219ebe538bdfacd86756479c3c10a40`, downloaded from upstream on September 21.
The comparison below distinguishes StarNet tests/live observations from Hermes source inspection.
Hermes was not installed or exercised against providers; this is not a comparative uptime benchmark.

## Findings and repairs

| Area | StarNet baseline and evidence | Hermes reference | This pass / remaining limit |
| --- | --- | --- | --- |
| Missed runs | `cron.js` supports `fire_once`/`skip`, persisted next-fire times and bounded catch-up; slow schedules normally catch up once, not once per missed slot. | `jobs.py` evaluates lateness, configurable recurring catch-up and pending-slot restoration. | Existing policy retained. Neither local process executes while the host is off. A recurring advance committed immediately before a crash can still lose that occurrence before launch. |
| Duplicate runs / ownership | Advance-before-run, one-shot claims, heartbeat leases and run-generation fences already exist. Stale reclamation deleted its lease before checking the failure write; a disk fault let a one-shot launch again. | File-locked admission, durable fire claims, execution ownership and process-liveness checks. | Reclamation now retains a settlement fence until persistence succeeds; late host completion cannot replace it. Manual runs and synchronous dispatch exceptions use the same settlement path. |
| Lock contention | CRUD and driver persistence both bypassed a held lock through an unlocked “merge by id” fallback. Live HTTP repro returned 200 and changed disk under a foreign live PID lock. | Separate tick/jobs OS advisory locks; jobs lock waits are bounded. | Removed both unlocked fallbacks. CRUD returns an explicit error; driver outcomes wait for storage. Single sidecar per workspace remains a required invariant; the portable lock is not a distributed scheduler. |
| Execution retries | Transient errors have bounded retries (default three, 90-second delay); terminal failure streaks can pause a job. | `unreachable_retry.py` retries recurring jobs at 5/15/30 minutes only when the model was unreachable and no API call completed. | Kept existing execution policy. Hermes is more conservative about retrying potentially effectful work. StarNet's general transient/zombie retries can repeat a tool effect; this pass does not claim otherwise. |
| Persistence / restart | Verified fsync/rename writes and protected backups; pending finalization stored with each job. A later completion overwrote its predecessor's undelivered result. | Separate SQLite execution and delivery ledgers with bounded terminal history. | Added a durable per-job delivery backlog. New work is deferred at 100 pending results instead of silently evicting results. All metadata is additive; existing jobs load unchanged. |
| Timezones | IANA validation, host-default timezone, schedule preview and DST tests already exist. Normal driver error settlement omitted the host zone. | Timezone-aware schedules plus repair of persisted instants after offset/configuration changes. | Fixed settlement and preflight-error re-arming. Regression: New York 09:00 now remains `13:00Z` after a September failure; baseline incorrectly stored `09:00Z`. Host-zone changes on old zone-less schedules remain a separate migration concern. |
| Concurrency | In-process tick guard, one lease per job, configurable global cap and oldest-due fairness; cap defaults off. Manual command runs lacked a lease. | Persistent worker pool, configurable parallelism and running-job claims; resolver defaults to the executor's default when no explicit bound is supplied. | Manual command runs now take a lease. Stress test drains 200 simultaneous jobs exactly once at a configured peak of four. No new default user-work quota introduced. |
| Delivery recovery | Boot-only recovery; no send single-flight; partial fanout did not remember successful targets; send acknowledgements could be retried by resending. | Delivery queue claims pending rows and fences abandoned sends as `unknown`, deliberately avoiding automatic replay of uncertain sends. | Recovery now also runs on ticks. Durable 1/2/4/8/15-minute backoff, four recovered sends per pass, run-specific acknowledgements, successful-target suppression, and in-process acknowledgement-write retries without resending. |
| Monitoring / visibility | Tick health, last run/error, failed delivery and session history already exist. “Armed” alone is not proof of successful dispatch. | Durable execution history and explicit unknown outcomes; ticker diagnostics in scheduler modules. | ROUTINES shows pending-result count and next retry separately from execution success; full backlogs explain deferred runs. Dispatch persistence failure marks ticker error. Pending deliveries count as background work for tray lifecycle. |

## Source references

All upstream links are pinned, rather than floating `main`:

- [Hermes due-job planning and store locking](https://github.com/NousResearch/hermes-agent/blob/8e806ae1b219ebe538bdfacd86756479c3c10a40/cron/jobs.py)
- [Hermes tick admission and dispatch](https://github.com/NousResearch/hermes-agent/blob/8e806ae1b219ebe538bdfacd86756479c3c10a40/cron/scheduler_tick.py)
- [Hermes runtime execution and parallelism](https://github.com/NousResearch/hermes-agent/blob/8e806ae1b219ebe538bdfacd86756479c3c10a40/cron/scheduler.py)
- [Hermes execution ledger](https://github.com/NousResearch/hermes-agent/blob/8e806ae1b219ebe538bdfacd86756479c3c10a40/cron/executions.py)
- [Hermes delivery queue and ambiguous-send policy](https://github.com/NousResearch/hermes-agent/blob/8e806ae1b219ebe538bdfacd86756479c3c10a40/cron/delivery_queue.py)
- [Hermes narrowly scoped execution retries](https://github.com/NousResearch/hermes-agent/blob/8e806ae1b219ebe538bdfacd86756479c3c10a40/cron/unreachable_retry.py)

## Reproducible evidence

- `node test/cron.dispatch.test.js`: 62 assertions, including 200 simultaneous jobs,
  30 overlapping recovery calls, refused persistence, stale completion, timezone re-arm,
  retained delivery backlog, bounded backpressure and serialized restart.
- `node test/cron-store.test.js`: 154 assertions, including run-specific acknowledgements,
  retry deadlines and partial-fanout receipts surviving serialization.
- `node test/cron.api.test.js`: 96 assertions, including real sidecar restart, script-only
  delivery and foreign-lock CRUD refusal. The new lock test failed against the baseline.
- `node test/cron.run-now.e2e.test.js`: 35 assertions through the real sidecar.
- Existing cron tick, chain, DST, durability, one-shot, guard and lock suites remain part of
  the registered fast gate. Before repair, the added stale/timezone regressions produced
  five failures; after repair they pass.

Seeded live proof used `node dev/seed.js --keep --workspace dev/.scratch-cron-reliability`
on isolated port 18921, with sandboxed credential roots and local script/dev-channel output:

1. Created a script routine that increments a local execution counter and prints its count.
2. Ran it twice with two fixture targets: a working dev target and a disconnected target.
3. API showed two completed runs, two pending result receipts, and one successful target
   recorded on each receipt. Browser AUTOMATION showed **“2 results awaiting delivery”**
   and **“delivery failed — telegram is not connected”**, alongside **“last ✓ ok”**.
4. Triggered the dev-only process-fault endpoint, changed only the isolated failed target
   fixture to the local dev channel, and restarted with `--keep`.
5. Both retained results were delivered to the recovered target. The already-successful
   target received zero repeats after restart; execution counter remained **2**. The
   final receipt was `delivered`, backlog empty, and both warnings disappeared in the UI.
6. Restarted again on source commit `0f881f44a`: both dev reply buffers remained empty,
   the receipt remained delivered, and the execution counter was still **2**.

No actual Telegram/Discord recipient, paid provider, OS suspend/resume, installed binary,
or long-running multi-day soak was exercised. The injected process fault deliberately logs
an uncaught exception; it is the restart stimulus, not a claim of a clean shutdown.

## Remaining priorities

1. **Ambiguous outcomes:** StarNet still replays pending external notifications after a
   crash between remote acceptance and durable acknowledgement. That is at-least-once
   recovery, not exactly once. Add per-target sending/unknown receipts and explicit
   reconciliation, following the distinction in Hermes's delivery ledger; do not hide
   uncertainty behind a green “delivered” badge.
2. **Dispatch intent and safe retries:** persist occurrence IDs before advancing recurring
   schedules, bind them to the run journal, and distinguish “never launched” from
   “launched with unknown effects.” Automatic replay should require proof of no effects
   or an idempotency contract. Do not blindly replay every interrupted job.
3. **Operator history:** unify routine execution, delivery attempts and run-journal recovery
   in one navigable history. The current final record plus pending backlog is not a full
   scheduler execution ledger; removing a routine also removes its pending receipts.
4. **Lifecycle:** tray continuation already exists, but full quit, shutdown and sleep stop
   execution. Supervised service/wake or an external scheduler is still needed for an
   always-on promise. This audit does not silently install a service or change login behavior.
   Runtime delivery retries use the armed scheduler's ticker; disarming pauses those retries
   too. Pending receipts survive until scheduling is resumed or startup reconciliation runs.

These repairs address reproduced failures, not a universal reliability or release-readiness
certification. Gate results and source commit are recorded in the accompanying lane digest.
