'use strict';
/* dev/google-review-release.cjs — REVIEW-ONLY preload that opens every Google Workspace service so the
   Google data-access verification demo can be recorded against real Google endpoints.

   Why it is safe: dev/ is never bundled (src-tauri/tauri.conf.json ships only ../sidecar), this module is
   only reachable through the developer review launcher (src-tauri/examples/google-review.rs), and it
   refuses to load unless that launcher set STARNET_GOOGLE_REVIEW=1. Product code has no environment or UI
   switch around the release deferral — this is the same module-injection seam the tests use
   (test/fixtures/google-future-release.cjs). See docs/GOOGLE_REVIEW_BUILD.md. */
if (process.env.STARNET_GOOGLE_REVIEW !== '1') {
  throw new Error('google-review-release.cjs is for the Google verification review launcher only');
}
const google = require('../sidecar/mcp/google-client.js');
google.RELEASE_DEFERRED = false;
if (!process.env.STARNET_GOOGLE_REVIEW_BANNER) {
  process.env.STARNET_GOOGLE_REVIEW_BANNER = '1';   // print once, not again in the sidecar child
  console.error('[google-review] ALL Google Workspace services opened for an UNVERIFIED review preview.'
    + ' Use a dedicated test Google account and test data only.');
}
