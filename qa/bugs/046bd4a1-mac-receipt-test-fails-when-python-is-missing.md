---
fingerprint: 046bd4a1
slug: mac-receipt-test-fails-when-python-is-missing
title: Mac receipt test fails when Python is missing
surface: release
severity: P2
status: fixed
found: 2026-09-24
lane: issue-40-investigation
fix: 4847acd6751b5719f87dc3ef4e1d3683b2c62782
origin: customer
report: https://github.com/androoAGI/starnet/issues/40
affected: v0.12.4; Linux Node 22 container without Python
family: test-portability
installer: not-applicable
installerEvidence: Test harness portability repair; no installed application code changed.
recovery: unconfirmed
---

# Mac receipt test fails when Python is missing

## Symptom

The fast gate fails with "expected 0, got null" and an undefined diagnostic when the plist receipt test runs on a host without Python.

## Repro

Run `node test/desktop-build-macos-notarization.test.js` with Node available but Python absent from PATH. On Windows the executable is `python`; on Linux/macOS it is `python3`.

## Evidence

At base 8041acbf8, a real Windows child process with PATH restricted to the Node directory exited 1: `FAIL: receipt uses actual installed XML/binary plist and rejects missing version: undefined — expected 0, got null`, followed by `1 problem(s), 26 ok`. The spawn result had `error.code=ENOENT` and `status=null`. The unchanged test passed 27 assertions with Python available.

## Verdict

Source fixed by skipping only ENOENT, printing an explicit SKIP line, and retaining all static checks without counting the skipped probe as passed. Other spawn errors and nonzero Python exits still fail with diagnostics. Reporter recovery remains unconfirmed.

## Regression

After the fix, the real Python-present test passes 27 assertions; the real restricted-PATH run prints `SKIP: python not on PATH` and passes 26 assertions. `test/desktop-build-macos-python-host.test.js` passes 12 assertions covering both interpreter names, an actual ENOENT subprocess result, EACCES, a Python failure, and preservation of earlier workflow failures. Linux behavior is covered through the interpreter boundary; the reported Linux container was not run locally.

## Initial validation limits (historical)

The canonical filtered fast runner passed both affected suites (`run-fast-tests: OK — 2 step(s) green`). JavaScript syntax checks and bug-register validation passed. The full `npm run test:fast` run exited 124 after its configured 1,200,000 ms timeout, with `chat-prompt-diet.test: OK (7 assertions)` as the last completed suite; there was no full-gate success receipt. `npm run qa:customer-journeys` stopped at step 3/38 because the unchanged `test/sidecar.http.test.js` hit a sidecar boot timeout. Local logs are `issue-40-fast.log` and `issue-40-journeys.log` in the lane worktree. The source repair is committed on the isolated branch; these incomplete/red broad gates do not authorize integration into trunk.

## Merge follow-up

On 2026-09-24, candidate e5bb40b7a passed the complete fast gate (923/923) and customer journeys (38/38), including the previously timed-out sidecar HTTP suite. Merge 70c9236c2 exactly matched that candidate tree. The next independent integration, 726fdb2c7, preserved the issue fix.

The post-merge gate on 726fdb2c7 stopped at step 599/923: `stationbake.connections.test.mjs` passed all 408 Canvas assertions but profile deletion failed with EBUSY on Chrome's debug log. The test passed unchanged when retried. To honor the merge gate without discarding the independent integration, f8faa548d reverted only merge 70c9236c2 on trunk; 34f820e40 reapplied it in the owned lane for revalidation.

The separate test-cleanup repair e23a88609 waits for graceful Chrome exit before a Windows process-tree fallback, requires parent exit, and bounds retries of transient profile-deletion errors. Rendering assertions are unchanged. The real Canvas test passed 408 assertions after the repair; a forced-shutdown probe executed the actual stop helper against a live browser and proved process exit plus profile deletion (4,107 ms). Full combined gates remain required before reintegration.

The next full retry stopped at step 288/923 in the unchanged reconciliation smoke test, whose real CLI subprocess returned a null status under its two-minute limit; the isolated original test reproduced that result. A direct diagnostic invocation subsequently completed with status 0 in 95,602 ms and 128,098 stdout bytes. Test-only repair fd30781e6 gives this repository-wide Git metadata audit a bounded five-minute window and includes spawn errors in its diagnostic. The complete isolated reconciliation test then passed all 82 assertions. No reconciliation logic or exit/JSON assertion was removed.

## Final integration evidence

Candidate d0324708b merged the independent test-gate repairs from trunk 762cb07c4 and passed the full unfiltered fast manifest (923/923) plus customer journeys (38/38). Fast verification used the same canonical runner with an explicit 2,400,000 ms outer watchdog, rather than the package script's 1,200,000 ms watchdog; no steps were filtered or assertions suppressed. The prior candidate 275da0d6b also passed all 923 steps under this extended watchdog.

Merge 056553417aa2f5e185b59f10efd8982e7d90da71 has exactly the tested Git tree 51fb2dcd64e81d1827a03bd8db7c4cfe7b2da535. Existing shared operational notes were byte-preserved. The final gate includes ledger reconciliation (82 assertions), the independent parallel-tools regression (15), real Canvas rendering and cleanup (408), Python-present receipt validation (27), and the missing/error interpreter regression (12).

On the pinned merge, the two affected suites passed again (2/2); a real process with PATH restricted to Node printed the explicit missing-Python SKIP and passed 26 static assertions. The complete suite was run on the identical pre-merge tree; it was not repeated a third time after this final merge. Logs are retained in C:/Users/andro/gen-trees/_evidence/issue-40-2026-09-24-SDGlqI, including issue-40-combined-fast.log, issue-40-combined-journeys.log, and issue-40-final-postmerge-*.log. This closes the source/integration work; the original Linux reporter's recovery remains unconfirmed.

## Sibling coverage

{
  "adapters": [{"target":"Windows python and Unix python3","state":"covered","test":"test/desktop-build-macos-python-host.test.js","scenario":"missing interpreter prints SKIP without adding a passing assertion","gate":"fast"}],
  "entrypoints": [{"target":"fast gate notarization suite","state":"covered","test":"test/desktop-build-macos-notarization.test.js","scenario":"static workflow checks and real Python XML/binary plist receipt validation","gate":"fast"}],
  "displays": [{"target":"CLI diagnostics","state":"covered","test":"test/desktop-build-macos-python-host.test.js","scenario":"visible skip, spawn error, and Python stderr","gate":"fast"}],
  "lifecycle": [{"target":"subprocess completion","state":"covered","test":"test/desktop-build-macos-python-host.test.js","scenario":"non-ENOENT and nonzero exit fail; preceding failures survive a skipped probe","gate":"fast"},{"target":"installed Mac lifecycle","state":"not-applicable","reason":"Only the portable test wrapper changes; the installed acceptance script and application lifecycle are unchanged."}]
}
