---
fingerprint: eba7e8aa
slug: routine-schedule-preview-races-newer-input-and-s
title: Routine schedule preview races newer input and stalls after failures
surface: autonomy
severity: P2
status: fixed
found: 2026-09-21
lane: agent/system-polish-0920
fix: 4a2028759
origin: audit
---

# Routine schedule preview races newer input and stalls after failures

## Symptom

An older schedule response replaces the next-run time for the current input. An offline request leaves Checking next run indefinitely.

## Repro

Open Automation > Create Routine, enter every 10m and hold its preview response. Enter every 20m, allow that response, then release the first response. The old code changes the displayed next run back to 10m. Reject another request to observe the stuck checking message. The reschedule editor uses the same handler.

## Evidence

Live before: .dogfood/system-polish/routine-before.json records the displayed 20m becoming 10m and the failure remaining Checking next run. test/routine-preview-race.test.js executes the production preview closure for stale, cleared, failed, malformed and recovered responses. scripts/qa/work-console-journey.mjs verifies create/readback/arm/delete and recipe launch.

## Verdict

Verified in the running seeded app and covered by the complete 844-step fast gate (HTTP 130/130 also green): selection/revision guards, cancellation, bounded requests and explicit failure recovery in the shared create/reschedule preview path. The standalone workflow runner also had obsolete expectations for the removed checkmark and former recipe launch button; its behavior assertions now follow the current controls.
