# OpenRouter delegation investigation — 2026-09-20

Reported build: desktop v0.12.4, Windows x64, source f00aa04df. The sanitized report describes direct OpenRouter BYOK succeeding while delegated specialists fail immediately against an empty StarNet managed wallet.

Source repair: `13a83534b`. Verified candidate: `379b013f3`. Isolated branch: `agent/openrouter-delegation-0920`. Owner-requested integration: `09100d151f1fda3b0851b86650849968e05d5236`. No installer rebuild, publication, or customer-station mutation.

## Cause and matching reproduction

The dossier dropdown returns an empty model/provider for Follow station default. SAVE MODEL then falls back to advanced input fields, which are prefilled with the specialist's old pin even while collapsed. Selecting inheritance therefore silently saves the old managed model/provider. Delegation resolves that persisted identity and correctly reaches managed admission, where the zero wallet rejects it before a provider call. Direct COMMS keeps using the selected BYOK provider.

An independent lifecycle defect was reproduced: after the dedicated clear button successfully removed a pin, `rehydrateRoster` replaced empty values with the lead's current model/provider on restart. Inheritance became a fixed pin again.

The reporter's saved roster was not inspected. These are live-reproduced defects matching the supplied symptoms; the report alone does not establish which clear control the reporter used.

## Repair

- Synchronize the advanced fallback fields on a deliberate picker change, including an empty choice.
- Preserve empty specialist model/provider/effort fields during roster restoration.
- Apply the same changes to the desktop frontend and website mirror.
- Keep intentional explicit model pins and billing admission unchanged.

Existing pins are not automatically deleted. The user must select inheritance again on the corrected build. On the affected source, the separate FOLLOW STATION DEFAULT button successfully restored BYOK delegation for the current session; baseline restart then reproduced the unwanted fixed pin.

## Evidence

`scripts/qa/openrouter-delegation-live.cjs before` serves the affected f00aa04df UI source into a real dev-seeded app. A local OpenRouter-compatible endpoint and linked zero-balance wallet provide deterministic evidence without real credentials or provider charges:

- Direct request reaches the BYOK endpoint.
- Dropdown plus SAVE retains the managed pin.
- Worker emits the exact managed-credit message and terminates at zero turns.
- Dedicated clear button permits the worker to complete.
- Reload plus sidecar restart incorrectly re-pins the worker.

The same script in `after` mode proves both pins clear, delegated worker ends with `reason: done`, all observed provider requests use the BYOK fixture model/credential, and inheritance plus successful delegation survive renderer reload and sidecar restart.

Local detailed receipts: `delegation-before.log`, `delegation-after.log`.

Final candidate verification:

- `npm run test:fast`: **841/841 steps PASS** (`delegation-fast-final.log`).
- `npm run qa:customer-journeys`: **38/38 steps PASS** (`delegation-journeys-final.log`).
- `test/agent-model-select.test.js`: **91 assertions PASS**, including executed save/change/rehydration handlers for both frontend copies.
- `test/orchestration.test.js`: **263 assertions PASS** within the full fast gate.
- Syntax checks for all changed JavaScript and diff whitespace checks PASS.

Earlier development gate attempts were stopped while incorporating the newly reproduced restart repair and refreshing the source-fingerprint record. The final full run above supersedes them. Claims fingerprint updates change source hashes only, not verdicts or release-readiness claims.

Actual OpenRouter service billing, a rebuilt installed Windows artifact, and reporter recovery remain unverified. Source-fixed does not mean shipped or customer-recovered. Durable bug: `qa/bugs/0e3d3914-follow-station-default-retains-managed-model-pin.md`.

## Integration receipt

Owner requested merge after reviewing the investigation. Trunk remained at the tested base `f00aa04df`; merge-into-lane synchronization was already up to date. The conflict-free integration at `09100d151` has the exact accepted candidate tree. Pre-existing integration edits in `docs/NEXT.md` and `qa/STATUS.md` were byte-preserved during the merge.

The full post-merge `npm run test:fast` passed **841/841 steps** on the integration commit in the owned worktree (`delegation-postmerge-fast.log`). The live dev-seeded campaign also passed at that commit (`delegation-postmerge-live.log`): cleared pins, successful worker with zero managed balance, and persisted inheritance plus successful delegation after renderer reload and sidecar restart. Frontend syntax checks passed; no sidecar/route/ship implementation changed, so the prior **38/38 customer journeys** and the post-merge live wire campaign cover the relevant backend interaction without requiring an additional full HTTP gate.

Integration reservation released after green verification. No push, installer rebuild, publication, or installed/customer recovery claim.
