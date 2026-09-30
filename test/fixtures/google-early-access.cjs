'use strict';
// Test-only: synthetic Google + an EARLY ACCESS build (the flag a staged registration would carry), with the
// per-service release map left exactly as source ships it. Never loaded by product code.
require('./google-signin-preload.cjs');
const google = require('../../sidecar/mcp/google-client.js');
google.RELEASE_DEFERRED = true;
google.EARLY_ACCESS = true;
