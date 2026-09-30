'use strict';

async function bootToken(base, origin) {
  const headers = origin ? { Origin: origin } : undefined;
  const r = await fetch(base + '/', headers ? { headers } : undefined);
  const html = await r.text();
  const m = html.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
  if (!m) return '';
  try { return String(JSON.parse(m[1]) || ''); } catch (_) { return ''; }
}

// The master token is refused in any URL (2026-09-25). Header-less surfaces present a scoped ticket instead;
// these mint the same tickets the page does (sidecar/apitickets.js). SSE tickets are single-use: mint per connect.
const apitickets = require('../sidecar/apitickets.js');
function sseQuery(token) { return 'ticket=' + encodeURIComponent(apitickets.mint(token, 'sse', apitickets.SCOPE_SSE, { now: Date.now() })); }
function fileQuery(token, agent, relPath) { return 'ticket=' + encodeURIComponent(apitickets.mint(token, 'file', apitickets.scopeFile(agent, relPath), { now: Date.now() })); }
function runPrefix(token, agent, runId) { return '/workshop-run/~t/' + apitickets.mint(token, 'run', apitickets.scopeRun(agent, runId), { now: Date.now() }) + '/'; }

module.exports = { bootToken, sseQuery, fileQuery, runPrefix };
