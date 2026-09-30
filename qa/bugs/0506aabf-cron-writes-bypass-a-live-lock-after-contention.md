---
fingerprint: 0506aabf
slug: cron-writes-bypass-a-live-lock-after-contention
title: Cron writes bypass a live lock after contention
surface: autonomy
severity: P1
status: fixed
found: 2026-09-21
lane: agent/cron-reliability-0921
fix: 0f881f44afde73e79de13f0117cf0dd9f2771ff9
origin: audit
---

# Cron writes bypass a live lock after contention

## Symptom

A routine edit reports success and changes disk state while another live writer owns the cron lock.

## Repro

Boot the sidecar, stamp cron.lock with the test parent PID, then POST /api/cron/update. Compare cron.jobs.json before and after.

## Evidence

test/cron.api.test.js failed before the fix: HTTP 200 instead of 500 and changed durable bytes. After repair: 96 assertions pass, including refusal and unchanged disk content.

## Verdict

Removed the unlocked fallback in CRUD and driver persistence. CRUD fails visibly; driver settlement retains its receipt for retry. Source implementation is in this lane; installed-build verification and external channel testing are not claimed.
