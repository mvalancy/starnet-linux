# Linux validation — 2026-09-29

Upstream: `fbddbf992f8e7082196f07c3024781fcf1c276fc` on
`androoAGI/starnet:feat/harness-backend` (v0.12.5 plus post-release fixes).
Validated application/package revision: `61ea448f3fceae0159c4e60310ca5c915471e5d3`.
Later documentation-only commits do not change the tested application code.

## Builds and hardware

Both architectures built `.deb` and AppImage packages using the locked Rust dependencies.
All hosts ran Ubuntu 24.04.4 LTS.

| Host | Architecture | Debian payload | AppImage | Dedicated server |
| --- | --- | --- | --- | --- |
| RTX 4090 workstation | x86_64 | Pass | Pass | Pass |
| DGX Spark | ARM64 | Pass | Pass | Pass |
| Jetson AGX Thor Developer Kit | ARM64 | Pass | Pass | Not tested |

Desktop checks used freshly extracted Debian payloads and extracted AppImages, private
XDG profiles, Xvfb, and a private D-Bus session. They verified a loaded WebKit document,
visible window, healthy sidecar, bundled Node, Sharp/PTY and both ONNX CPU ABIs, shell timeout,
idle close, crash cleanup, and data persistence after relaunch. Package-manager installation
and FUSE mounting were not exercised in this update.

Real systemd installations verified the service account's filesystem restrictions, private
permissions, Git clone/commit/push, HTTP health/UI access, and restart persistence. The x86_64
host used a root-owned Node 22 override; ARM64 used `/usr/bin/node`. Temporary service accounts,
units, and station data were removed after testing. Existing personal installations were preserved.

## Regression results

- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 69 passed, one ignored on each architecture.
- `npm run test:fast`, followed by isolated continuations: **952/954 entries passed**.
- `npm run test:http`, followed by isolated continuations: **154/156 entries passed**.
- All 15 focused fast shell suites passed. The process-tree test also verifies fallback and
  diagnostics for denied process-group signals without targeting unrelated processes.
- The empty-catch guard passed after fixing the Linux fallback; its baseline was not relaxed.
- Clean dependency installations and the production npm audit reported zero advisories after
  updating the transitive `fast-uri` dependency from 3.1.7 to 3.1.8.
- Gitleaks was unavailable, so `security:secrets` was not run.

The full gates are **not green**. These failures also reproduced on the unchanged upstream
revision with the same test environment:

| Gate | Test | Result |
| --- | --- | --- |
| Fast | `crt-context-loss.e2e.test.mjs` | CDP `Page.navigate` timeout |
| Fast | `session-reliability.e2e.test.js` | CDP `Page.navigate` timeout |
| HTTP | `station-layout.e2e.test.mjs` | CDP `Page.navigate` timeout |
| HTTP | `browser.gauntlet.e2e.test.js` | Did not finish within a 180-second bound |

Browser tests used a temporary headless Chrome launcher. The successful native desktop
checks above use WebKit and are separate from these Chrome-based test journeys.
