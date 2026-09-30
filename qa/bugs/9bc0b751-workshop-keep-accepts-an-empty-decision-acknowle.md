---
fingerprint: 9bc0b751
slug: workshop-keep-accepts-an-empty-decision-acknowle
title: Workshop Keep accepts an empty decision acknowledgement
surface: sessions
severity: P2
status: fixed
found: 2026-09-21
lane: agent/system-polish-0920
fix: 4a2028759
origin: audit
---

# Workshop Keep accepts an empty decision acknowledgement

## Symptom

A missing decision receipt can be reported as successfully saved by the Workshop Keep/Implement action.

## Repro

Return HTTP 200 with an empty object from /api/workshop/decide, then invoke Keep through WorkshopStore.decide. The original `j.ok !== false` check returns success without affirmative evidence.

## Evidence

Live before: .dogfood/system-polish/workshop-before.json records ok:true for an empty response. test/workshop-visibility.test.js covers missing, negative, null and valid receipts. dev/system-polish-proof.mjs checks the real browser store with the same fault.

## Verdict

Verified in the running seeded app and covered by the complete 844-step fast gate (HTTP 130/130 also green): require `j.ok === true`. Keep and Discard already retain their controls and show a failure when the store refuses success. Later remains a local deferral, not a file-save claim.
