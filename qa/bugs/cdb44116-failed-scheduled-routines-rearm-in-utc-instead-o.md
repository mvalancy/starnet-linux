---
fingerprint: cdb44116
slug: failed-scheduled-routines-rearm-in-utc-instead-o
title: Failed scheduled routines rearm in UTC instead of host timezone
surface: autonomy
severity: P1
status: fixed
found: 2026-09-21
lane: agent/cron-reliability-0921
fix: 0f881f44afde73e79de13f0117cf0dd9f2771ff9
origin: audit
---

# Failed scheduled routines rearm in UTC instead of host timezone

## Symptom

A routine scheduled for 9 a.m. local time can move four hours early after a terminal failure.

## Repro

Create a timezone-less 0 9 * * * routine with America/New_York as host timezone. Fail the September 21, 2026 occurrence and inspect nextRunAt.

## Evidence

test/cron.dispatch.test.js reproduced 2026-09-22T09:00:00.000Z before repair, instead of the required 2026-09-22T13:00:00.000Z. The regression passes after repair.

## Verdict

Pass the same host timezone to settlement that creation and planning already use; preserve explicit schedule timezone precedence. Source implementation is in this lane; installed-build verification and external channel testing are not claimed.
