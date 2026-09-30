# GL warp probe false-positive — the post-texture "lag"

`agent/texture-perf` → trunk merge `927826169` (fix `8389cb6da`). Snapshot tag
`archive/pre-texture-perf-202609240022`, post tag `archive/post-texture-perf-202609240023`.

## Cause

`probeMeans` (world.js, the one-time WebGL barrel-warp output check) reduced the full frame to
16×16 in one `drawImage`, which point-samples. Scanlines, grain and fine industrial texture aliased
a healthy warp to +27% brighter (true full-resolution mean +3%, CPU warp identical), tripped the
"implausible magnitude" check and pinned the session to `drawCurveCPU` + `sharpenSample`.
Intermittent (about 3 of 4 boots, also with `?textures=classic`); the new textures made it likelier.

## Fix

The probe reduces through exact 2:1 bilinear halvings (true box averages on every backend).
`test/crt-glprobe.test.js` locks it (fails on the old sampler).

## Evidence

- `dev/world-performance-probe.mjs --gpu --settled`, RTX 5060 Ti, seeded station:
  25.8 fps / 32.2 ms median callback / 66.7 ms p95 interval → 60 fps / 1.6 ms / 16.7 ms.
- Probe latched trusted (3 clean readings) on 3/3 boots; an injected 1.8× GL brightening is still
  caught on its first reading.
- Gate: `test:fast` 907/907 green on the exact merged tree, no retries. Claims PASS.
- Also mirrored `frontend/app/windows/routines.js` into `website/app` — trunk `fc12b6d29` had left
  `website-app-sync.test` red.

Not verified: the installed desktop app (same Chromium engine; measured in headless GPU Chrome).
