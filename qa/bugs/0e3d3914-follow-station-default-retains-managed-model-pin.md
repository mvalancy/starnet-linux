---
fingerprint: 0e3d3914
slug: follow-station-default-retains-managed-model-pin
title: Follow station default retains managed model pin and blocks BYOK delegation
surface: providers
severity: P1
status: fixed
found: 2026-09-20
lane: openrouter-delegation-0920
fix: 13a83534b
origin: customer
report: User-supplied sanitized v0.12.4 report, 2026-09-20
affected: StarNet desktop 0.12.4, Windows x64, source f00aa04df
family: execution-configuration
installer: unverified
recovery: unconfirmed
---

# Follow station default retains managed model pin and blocks BYOK delegation

## Symptom

A Windows v0.12.4 station with working OpenRouter BYOK and zero managed balance can run direct COMMS requests but delegated specialists immediately fail with the managed-credit error after selecting Follow station default in the dossier dropdown and saving.

## Repro

1. Use a BYOK lead, a specialist pinned to a managed model, and a linked zero-balance wallet.
2. Open the specialist's CONFIG model card, select Follow station default in the dropdown, and click SAVE MODEL.
3. Dispatch a trivial task to that specialist. Its retained managed pin causes a zero-turn billing refusal.
4. Run `node scripts/qa/openrouter-delegation-live.cjs before` on the affected source with Playwright available for the local, synthetic-provider reproduction.

## Evidence

Live seeded app at f00aa04df reproduced the dropdown save retaining `{model: "fixture/managed", provider: "starnet"}`. Real delegated worker emitted `agent.run.error` with `reason: billing`, the reported credit message, and `agent.run.end` with `turns: 0`. Direct BYOK request reached the local OpenRouter wire fixture. Evidence: `scripts/qa/openrouter-delegation-live.cjs`, local `delegation-before.log`. The defective fallback is `const model = pick.model || advModel;` in `frontend/app/stationui.js`; the collapsed advanced fields still contained the prior pin.

## Verdict

Source fix synchronizes advanced model/provider fields on a deliberate picker change, including the empty inheritance selection. A second reproduced failure in `rehydrateRoster` replaced cleared pins with fixed copies of the hero's configuration on reload; the fix retains empty model/provider/effort instead. No billing bypass or provider routing changes. Installed artifact and reporter recovery remain unverified. The report does not establish whether the reporter used the dropdown or the separate clear button; this reproduction establishes a matching failure path, not direct inspection of their saved station.

## Regression

`test/agent-model-select.test.js` passes 91 assertions, including actual dossier change/save and roster restoration handlers for both frontend copies: clear a stale managed pin, save an explicit OpenRouter pin, type an advanced custom model, use the dedicated clear button, and restore inherited versus pinned identities. Live patched source clears both fields and emits `agent.run.end` for the worker with `reason: done`, using the BYOK wire and zero managed balance. Renderer reload plus sidecar restart retain the cleared pins and successful delegation. Baseline campaign independently proves the dedicated clear button works before restart and that reload incorrectly recreates a pin. Local receipts: `delegation-before.log`, `delegation-after.log`; reproducible script has explicit before/after modes. Customer journeys pass 38/38; full final fast gate recorded in the investigation digest.

## Sibling coverage

{
  "adapters": [{"target":"OpenRouter BYOK and managed relay admission","state":"blocked","reason":"Live local wire fixture proves the matching billing path; no real funded OpenRouter account or rebuilt installer exercised."}],
  "entrypoints": [{"target":"Dossier dropdown save, explicit pin, advanced custom entry and dedicated clear button","state":"covered","test":"test/agent-model-select.test.js","scenario":"actual dossier handlers preserve deliberate clears and explicit selections","gate":"fast"}],
  "displays": [{"target":"Desktop frontend source and website mirror","state":"covered","test":"test/agent-model-select.test.js","scenario":"both shipped source copies execute the same clear and pin behavior","gate":"fast"},{"target":"Installed Windows v0.12.4","state":"blocked","reason":"Installed customer station was not modified or inspected; no rebuilt installer acceptance."}],
  "lifecycle": [{"target":"Roster restoration of inherited and explicit pins","state":"covered","test":"test/agent-model-select.test.js","scenario":"both actual rehydrateRoster handlers retain empty model/provider/effort and explicit OpenRouter pins","gate":"fast"},{"target":"Installed restart recovery","state":"blocked","reason":"Seeded source restart passed, but no rebuilt installed artifact or reporter retest was performed."}]
}
