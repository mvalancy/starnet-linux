---
fingerprint: b1da69a1
slug: late-deliverable-preview-replaces-the-current-fi
title: Late deliverable preview replaces the current file selection
surface: sessions
severity: P2
status: fixed
found: 2026-09-21
lane: agent/system-polish-0920
fix: 4a2028759
origin: audit
---

# Late deliverable preview replaces the current file selection

## Symptom

Selecting a second file can display the first file again when its slower response finishes.

## Repro

Open a Markdown preview with a delayed response, select another file, then release the first response. The original handler overwrites the second selection. Repeat with a delayed response body or a delayed failure.

## Evidence

Live before: .dogfood/system-polish/preview-before.json shows fast.md/Newest file replaced by slow.md/Older file. test/deliverables-open.test.js exercises header/body/error ordering; dev/system-polish-proof.mjs drives the production handler against live DOM nodes.

## Verdict

Verified in the running seeded app and covered by the complete 844-step fast gate (HTTP 130/130 also green): cancel obsolete fetches, guard every async completion by selection identity, and keep image URL/timer cleanup scoped to its owning preview. Covers another selection and panel cleanup; installed renderer acceptance remains separate.
