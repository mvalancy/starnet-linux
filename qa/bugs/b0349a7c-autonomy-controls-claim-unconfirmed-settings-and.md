---
fingerprint: b0349a7c
slug: autonomy-controls-claim-unconfirmed-settings-and
title: Autonomy controls claim unconfirmed settings and overwrite server state on reload
surface: autonomy
severity: P1
status: fixed
found: 2026-09-21
lane: agent/system-polish-0920
fix: 4a2028759
origin: audit
---

# Autonomy controls claim unconfirmed settings and overwrite server state on reload

## Symptom

Autonomy displays BUILD after a refused save while the server remains WAIT. Reload can send stale browser settings back to the server. A backend disk-write failure also changes live posture and reports success despite losing durability.

## Repro

Open Settings > Autonomy in a seeded station; fail POST /api/autonomy/posture with 503 and select BUILD. Compare the highlighted dial and description with GET /api/autonomy/posture. For durability, run test/autonomy-confirmation.http.test.js: replace the isolated posture file with a directory and attempt a new posture while halted.

## Evidence

Before: .dogfood/system-polish/autonomy-before.json records local initiative leash, backend initiative wait, and the affirmative unattended-work description. Regression anchors: test/autonomystore.test.js, test/autonomy-confirmation.http.test.js, test/permissionsstore.test.js and test/truststore.test.js. Live proof: dev/system-polish-proof.mjs covers failure/pending/retry/reload/restart in the real seeded application.

## Verdict

Verified in the running seeded app and covered by the complete 844-step fast gate (HTTP 130/130 also green): server-owned posture, durable publication before acknowledgement, serialized confirmed browser writes, and acknowledgement-aware settings/onboarding/backup/permissions/trust callers. Installed builds and customer recovery are not claimed.
