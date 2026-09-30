'use strict';
// Test-only: synthetic Google (the sign-in preload) with ONE service released through the per-service map,
// exactly as a future source change would ship it. Never loaded by product code.
require('./google-signin-preload.cjs');
const google = require('../../sidecar/mcp/google-client.js');
google.RELEASE_DEFERRED = true;
google.EARLY_ACCESS = false;   // exercise the post-verification per-service map, not the early-access build
google.RELEASED['google-calendar'] = true;
