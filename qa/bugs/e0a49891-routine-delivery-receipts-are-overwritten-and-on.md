---
fingerprint: e0a49891
slug: routine-delivery-receipts-are-overwritten-and-on
title: Routine delivery receipts are overwritten and only recovered at boot
surface: autonomy
severity: P1
status: fixed
found: 2026-09-21
lane: agent/cron-reliability-0921
fix: 0f881f44afde73e79de13f0117cf0dd9f2771ff9
origin: audit
---

# Routine delivery receipts are overwritten and only recovered at boot

## Symptom

A successful routine can lose its notification when the destination is unavailable and another occurrence finishes.

## Repro

Run two script-only occurrences with one connected dev target and one disconnected target. Inspect both receipts, restart, reconnect the fixture target, and inspect delivered messages and the script execution counter.

## Evidence

test/cron.dispatch.test.js covers overlapping recovery, backoff, retention, restart serialization and acknowledgement write failure. Seeded live proof: two pending results became delivered after restart; execution counter remained 2; previously successful target received zero repeats.

## Verdict

Delivery now retains up to 100 pending results per job with backpressure, retries with durable exponential backoff, fences concurrent sends and remembers successful fanout targets. Source implementation is in this lane; installed-build verification and external channel testing are not claimed.
