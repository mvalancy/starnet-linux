---
fingerprint: d0904df1
slug: website-preview-applies-retired-rendering-effect
title: Website preview applies retired rendering effects and implies live work
surface: world
severity: P2
status: fixed
found: 2026-09-22
lane: agent/website-demo-0921
fix: 8be5cf230
origin: owner
report: Owner screenshot and website request, 2026-09-21
affected: starnetos.com production on 2026-09-21
family: website-preview
installer: not-applicable
installerEvidence: Website-only preview and generation changes; desktop binaries are unchanged.
recovery: unconfirmed
---

# Website preview applies retired rendering effects and implies live work

## Symptom

Owner reports an ugly, inaccurate website demo. The deployed starter room appears muddy and colour-fringed, with a live-preview caption although no backend executes tasks. It also contains one desk instead of the current starter factory's eight props and uses obsolete floor/wall/hull materials.

## Repro

1. Open https://starnetos.com/#station before deployment of this lane.
2. Observe the embedded station and its live-preview caption.
3. Compare website/app/demo-boot.js overrides to frontend/app/worldrenderer.js PHOSPHOR settings.

## Evidence

Owner screenshot 2026-09-21; live browser reproduction on production and local staged source. test/website-live-preview.test.js verifies the versioned save refresh and current geometry; test/website-deploy-staging.test.js verifies the exact upload. Live local camera DOM measured 960x660; desktop and 390px mobile document widths stayed within the viewport.

## Verdict

Source changes culminate in 8be5cf230. Generate the real starter layout from WorldModel.starterDoc() and derive its saved-preview revision from the layout hash. Removed retired CRT overrides and duplicate page glass, framed the complete hull with the actual renderer camera, and labeled the offline starter layout. Local desktop/mobile rendering verified; Cloudflare preview is https://723f4bea.starnet-site.pages.dev. Production deployment and final gate receipt are recorded separately in this lane's digest. Owner visual acceptance remains unconfirmed.

## Regression

Before: executing the trunk demo fixture produces one prop and null floor/wall/hull materials. The current WorldModel.starterDoc() produces eight props with resin/panelled/bone materials. test/website-live-preview.test.js now compares the entire generated station to that actual factory, including prop placement and workstation ownership. The same test covers one-time revision upgrades and preservation after the upgrade.



## Sibling coverage

{
  "adapters": [{"target":"static website frontend mirror","state":"covered","test":"test/website-app-sync.test.js","scenario":"generated preview matches the app and retains the versioned demo boot and styling","gate":"fast"}],
  "entrypoints": [{"target":"homepage embed and direct app document","state":"covered","test":"test/website-deploy-staging.test.js","scenario":"unique embed entry matches the generated app and required runtime artwork ships","gate":"fast"}],
  "displays": [{"target":"desktop and mobile visual appearance","state":"blocked","reason":"1440px desktop and 390px phone browser screenshots and overflow checks passed manually. Visual aesthetics and owner acceptance are not established by an automated fast/http scenario."}],
  "lifecycle": [{"target":"returning visitor saved station","state":"covered","test":"test/website-live-preview.test.js","scenario":"layout hash refreshes obsolete saved demos once; current revisions retain their saved state; generated layout equals the real starter factory","gate":"fast"}]
}
