# System polish audit — 2026-09-20

Base: `719382f50`. Isolated implementation: `agent/system-polish-0920`.
Source candidate: `4a2028759`. Integrated at `21e267c7c` on `feat/harness-backend`; candidate and integrated Git trees match (`bddc698b950707576c41a3794e942eb640c8f6b4`).

Done for each repair means the original failing interaction produces the correct
observable result in the running seeded app, its adjacent lifecycle paths pass,
and the full fast gate is green. This report does not assert exhaustive perfection.

## Reproduced and repaired

| Area | Root cause and resulting behavior | Regression |
| --- | --- | --- |
| Autonomy | Browser writes previously committed locally and ignored acknowledgements; reload pushed stale cache; backend published state before a best-effort disk write. Backend persistence now precedes publication. Browser writes serialize, retain confirmed state, reconcile lost acknowledgements, and expose pending/error states. Boot only reads authority. | `test/autonomystore.test.js`, `test/autonomy-confirmation.http.test.js`, live `dev/system-polish-proof.mjs` |
| Adjacent autonomy flows | Settings, onboarding, permissions presets, earned recommendations, backup import and new-Commander reset now wait for confirmed writes. Neither import nor reset resumes an emergency stop. Both portable backup namespaces are supported. | `test/permissionsstore.test.js`, `test/truststore.test.js`, `test/backup-autonomy.test.js`, `test/newhero-reset.test.js`; live backup/reset refusal and retry |
| Deliverable previews | Older header/body/error completions could overwrite the newest selection. Requests now cancel and completion checks retain the current selection; image URL and timeout cleanup belongs to the originating preview. | `test/deliverables-open.test.js`, live slow/fast response reversal |
| Workshop decisions | `ok !== false` accepted an empty acknowledgement as saved. Keep/Discard now require explicit `ok === true`; existing failure controls remain usable. | `test/workshop-visibility.test.js`, live empty-receipt refusal |
| Routine previews | A revision counter was incremented but never checked; errors were swallowed. Create and reschedule share guarded, bounded previews with cancellation and actionable failure text. | `test/routine-preview-race.test.js`, live late-response/offline proof |
| Workflow audit | The standalone runner required a removed checkmark and an obsolete intermediate recipe-launch button. Assertions now follow the current controls, preserving real schedule/readback and task-dispatch checks. | `scripts/qa/work-console-journey.mjs`: 26/26 PASS |

The four durable audit records are `b0349a7c`, `b1da69a1`, `9bc0b751`, `eba7e8aa`.
Frontend mirror regenerated with the repository generator; shared contracts untouched. The audited source lock was refreshed using the repository relock tool; claim verdicts were not promoted. The onboarding quick-setup fixture now returns the actual confirmed-writer contract and checks rejection/retry before tutorial handoff.

## Coverage and receipts

All retained logs below are under `.dogfood/system-polish/` in the owned worktree.

| Campaign | Result / evidence |
| --- | --- |
| Full fast gate | **844/844 PASS** against candidate `9f39da7e1`; `candidate-fast-complete.log` |
| Post-merge fast gate | **844/844 PASS** on exact merge commit; `post-merge-fast.log` |
| Post-merge live proof | **PASS**: repair failure/retry/reload/restart plus 32 panel states and 20 Settings sections; `post-merge-live.log` |
| Post-merge HTTP gate | **130/130 PASS** on exact merge commit; `post-merge-http.log` |
| Full HTTP gate | **130/130 PASS**; `http.log` |
| Customer reliability campaign | **38/38 PASS**; `customer-journeys.log` (controlled provider endpoints, not customer accounts) |
| Live task journeys | **139/139 assertions PASS**; `live-journeys.log` |
| Live behavior audit | **49/49 assertions PASS**; `behavior-audit.log` |
| Primary panels | **32 states PASS**: 16 primary surfaces at 1440px and 800px; no page overflow, native-painted controls or uncaught exceptions; `live-proof.json` |
| Settings sections | **20 tab visits PASS** across those widths; same receipt |
| Repair lifecycle | Failed/pending/retried writes, stale-cache reload and backend restart; preview ordering; missing decision receipts; `live-proof.json`, `backup-live.json`, `routine-after.json` |
| Workflows | **26/26 PASS**; routine create/readback/arm/delete, outbox and recipe launch; `work-console-verified.log` |
| Reload authority | **31/31 PASS** across ten reloads; no pre-authority online claim, coherent bridge/online state and no uncaught exceptions; `boot-truth-owned.log` |
| Session tools | Search across 50 sessions, exact hit navigation, Projects/Session switching and row-specific Markdown/JSON export PASS; `session-tools.log` |
| Storage/performance | 3,000 conversations, all established budgets PASS; `longhaul.log`. Startup 821ms, RSS 110MiB, UI search 1.65ms, serialization 14.62ms, deliverables query 22.36ms, corruption recovery 60.67ms. Disposable synthetic data; not a production hardware benchmark. |

Panel sweep: station, agents, recruitment, Commander, tasks, deliverables, recipes, automation, quests, refit, connectors, messaging, manual, settings, updates and notifications. Settings sweep: providers, autonomy, night shift, permissions, budget, models, live voice, appearance, notifications and system. These are panel reachability/style/overflow checks, not full functional acceptance of every control or external integration.

Before-fix receipts: `autonomy-before.json`, `preview-before.json`,
`workshop-before.json`, `routine-before.json`. The new live proof waits for a
completed page navigation before evaluating reload/restart state.

## Boundaries and remaining work

- No exact installed Windows/Mac build acceptance, real OAuth/account login,
  physical microphone/speaker, OS keychain, sleep/wake or external messaging-service
  acceptance was performed. Local provider simulators establish harness behavior,
  not external account health or model quality.
- The ten pre-existing customer/environment investigations remain open. Their
  unavailable affected-machine diagnostics cannot be replaced by nearby passing tests.
- The full W0–W7 product-perfection campaign has not passed; no zero-defect,
  release-readiness, customer-recovery or exhaustive-perfection claim is made.
- Native rendering was not accepted. Headless Chromium logged its existing WebGL
  fallback warning and used the CPU path; no uncaught application errors occurred.
- An initial fast attempt hit an evidence-scanner EBUSY on the audit's live browser
  profile. Subsequent browsers use isolated temporary profiles outside evidence.
  Intermediate fast attempts were stopped or invalidated as fixes expanded; only
  the final complete gate is acceptance evidence.

No installer rebuild, public release, push, external message or deployment.
