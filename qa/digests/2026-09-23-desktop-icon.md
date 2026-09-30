# Approved desktop icon — owner-authorized integration

Owner approved the borderless circular CRT icon with the original hollow amber
four-point star. Artwork commit: `f4e12ca5f`. The lane was synced with integration
commit `fc12b6d29` through `816956bfa`; no application logic changed in this lane.

## Assets

- The approved imagegen PNG was copied byte-for-byte to `src-tauri/icon-source.png`.
- SHA-256: `4ea401f76fde4cc918935c65b0167a750544a53654a0ce6d86e3ac1ec40a93c6`.
- `npm run desktop:icon` succeeded and regenerated the existing platform assets.
- Tauri's existing bundle, NSIS installer, and default-window/tray references use
  these assets. The in-app wordmark and website artwork are separate.

## Direct verification

- Master is byte-identical to the owner-approved image.
- PNG exports are square at 32, 64, 128, 256 and 512 pixels, with alpha and fully
  transparent corners. The circular screen remains filled at its center.
- ICO directory is valid and includes 16, 24, 32, 48, 64 and 256 pixel entries.
- Windows System.Drawing decoded and rendered the 16, 32 and 48 pixel icons.
- ICNS structure/length verified, including its 1024 pixel `ic10` representation.
- Packaging icon paths resolve; 32 and 128 pixel PNGs and Windows' native 32 pixel
  rendering were visually inspected. `git diff --check` passed.
- No installer was rebuilt, installed, or published. Installed-app appearance and
  macOS runtime rendering remain unverified.

## Full-gate attempts

All attempts used the unchanged `npm run test:fast` command and assertions.

1. Stopped at 74/907: `agent-eval.test.js`, default seed CLI returned failure.
   The CLI then passed directly (13/13, quality 100), and the isolated gate rerun
   passed all 43 assertions. Both later full attempts passed this test.
2. Stopped at 164/907: `shell-machine-state.test.js`, host PowerShell single-quote
   probe failed (265 assertions passed). The exact harmless probe then passed
   directly in 3128 ms. The third full attempt passed all 266 assertions.
3. Stopped at 208/907: `workshop-implement.e2e.test.js`, sidecar boot timeout at
   line 118. Earlier packaging and Tauri hardening checks passed.

Local logs and the asset verification receipt are retained under
`.tmp/icon-verification/` in the owned `official-icon-0923` worktree. No tests were
weakened or skipped. After these failures were explained, the owner explicitly
instructed "merge", authorizing this icon-only integration despite the red full
gate. The exception does not turn those results green or authorize a release.
The subsequent sync includes trunk `d2defe68e`; its only additional tracked change
relative to the previously synced trunk is an operational QA status note.
