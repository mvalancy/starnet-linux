# Scheduler reliability — isolated lane receipt

- Lane: `agent/cron-reliability-0921`, based on trunk `a934cb61c`.
- Source repair: `0f881f44afde73e79de13f0117cf0dd9f2771ff9`.
- Diagnostic follow-up: `13377ab19` reports delivery-deferral errors and lowers the
  silent-catch baseline to match the repaired source.
- Source-manifest refresh: `cc4cf4df2` (source reference plus the ROUTINES file size/hash only;
  all claim assessments and live-proof statuses preserved).
- [Audit and pinned Hermes comparison](../../docs/SCHEDULER_RELIABILITY_AUDIT_2026-09-21.md).

## Behavior changed

Stale-run, synchronous-dispatch and manual-run settlements retain their lease until saved;
late completion cannot replace the chosen recovery outcome. Failed routines re-arm in the
host timezone. Contention never falls through to an unlocked cron write.

Undelivered results now survive subsequent occurrences, with bounded backlog backpressure,
durable exponential retry timing and per-run send exclusion. Partial fanout remembers
successful targets. A completed send whose acknowledgement write fails is not resent in
the same process. Manual and scheduled work share settlement. Script delivery recovery
does not append a second copy of an existing transcript. Pending deliveries remain visible
in AUTOMATION and count as background work when the scheduler is armed.

## Evidence

- Syntax checks and `git diff --check`: pass.
- Full HTTP gate: **130/130 steps green**.
- Full fast gate: **844/844 steps green** on frozen source revision `13377ab19`
  (`.scratch-cron-audit/fast-complete.log`, exit 0).
- Final scheduler/lifecycle HTTP subset: **7/7 steps green**; additional pending-delivery
  lifecycle regression **83 assertions green** (`7a0c96d35`).
- Focused driver/store tests: **62 / 154 assertions**. The driver test includes a
  **200-job burst, peak concurrency 4, 200 unique executions**, 30 overlapping recovery
  calls, failed writes, late settlement and a 100-result backlog surviving serialization.
- Real sidecar CRUD lock test: baseline returned HTTP 200 and changed disk while a live
  foreign PID held `cron.lock`; repaired route returns an error and preserves disk bytes.
- Seeded app, local script and dev transport: two completed executions, two retained
  partial-fanout results; restart delivered both to the recovered fixture destination,
  zero repeated sends to the already-successful destination, execution counter still 2.
  A second restart preserved delivered state with zero sends and counter still 2.
- Browser AUTOMATION: pending count and failure text matched API state; after recovery,
  the warnings disappeared and the two-run history remained.

The first fast attempt caught the required website mirror update. A subsequent committed
run caught the required source-manifest refresh. Both were addressed through the normal
repository workflows, without weakening the gate or changing claim assessments. One
subsequent run observed a moving Git HEAD when the extra lifecycle regression was committed
mid-inspection. A later run caught the silent-catch ratchet; its diagnostic and downward
baseline adjustment were committed before the final uninterrupted, frozen-revision run
passed all 844 steps. The final receipt itself is documentation only.

## Owner-authorized integration

- User authorized merge after reviewing the isolated-lane result.
- `agent/cron-reliability-0921` merged into `feat/harness-backend` at
  `3296f8be2905e7b78b9417ceae55e92063f94b6f`, from rollback point `a934cb61c`.
- The merged tree exactly matches candidate `ac409bc70`:
  `42ab2f03ce4515e860ea9ce6a4a25dc72bb3bfeb`.
- Fresh post-merge gates on the frozen merge revision in the owned worktree:
  **fast 844/844 PASS**, **HTTP 130/130 PASS**, both exit 0. Logs:
  `.scratch-cron-audit/post-merge-fast.log` and `post-merge-http.log`.
- Pre-existing integration edits in `docs/NEXT.md` and `qa/STATUS.md` were
  byte-preserved at merge. The lane appended its own integration-status notes only.
- The owned worktree remains because it contains untracked audit/live-test evidence.
  Integration reservation released after green gates; no installer or publication.

## Scope limits

No installer build, deployment, real channel
message, paid model call, suspend/resume exercise, multi-host claim, multi-day soak,
release-readiness claim or Hermes runtime benchmark is included. External sends still
have an ambiguous crash window between acceptance and acknowledgement; the audit describes
the remaining reconciliation/occurrence-ledger work explicitly. Source fixes are not an
installed-build or customer-recovery claim.
