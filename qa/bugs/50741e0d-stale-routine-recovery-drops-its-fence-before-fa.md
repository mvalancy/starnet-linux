---
fingerprint: 50741e0d
slug: stale-routine-recovery-drops-its-fence-before-fa
title: Stale routine recovery drops its fence before failure persistence
surface: autonomy
severity: P1
status: fixed
found: 2026-09-21
lane: agent/cron-reliability-0921
fix: 0f881f44afde73e79de13f0117cf0dd9f2771ff9
origin: audit
---

# Stale routine recovery drops its fence before failure persistence

## Symptom

A hung one-shot can execute again immediately after storage recovers, without recording the reclaimed attempt.

## Repro

Launch a one-shot in the injected-clock driver. Refuse persistence, advance beyond the heartbeat ceiling, settle the aborted host late, restore storage, and tick again.

## Evidence

test/cron.dispatch.test.js reproduced four failures before repair, including 2 launches instead of 1 and retryCount 0 instead of 1. The updated test proves one launch, a retained settlement, and the reclaimed failure winning over late success.

## Verdict

Stale-run recovery now uses the common durable settlement path. Manual runs and synchronous dispatch failures also retain settlement ownership until saved. Source implementation is in this lane; installed-build verification and external channel testing are not claimed.
