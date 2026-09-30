/* node test/mcp.oauth-fetch.test.js — connector-OAuth fetches connect ONLY to the address that passed the check.

   Security audit 2026-09-25: the OAuth wrapper validated a hostname's DNS answer and then let fetch resolve it
   AGAIN, so a rebinding authorization server could pass the check publicly and connect privately. The pinned
   dispatcher's lookup must return the validated address no matter what DNS says at connect time. */
'use strict';
const A = require('./_assert.js');
const net = require('net');
const undici = require('undici');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
const { makeConnectorOauthFetch } = require('../sidecar/mcp/oauth-fetch.js');

const W = makeWebTools({})._internals;

(async () => {
  // A rebinding resolver: the first (validation) answer is public, every later answer is loopback.
  let calls = 0;
  const rebinding = async () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  let madeWith = null, closed = 0, seen = null;
  const f = makeConnectorOauthFetch({
    assertSafeUrl: W.assertSafeUrl, assertResolvedSafe: W.assertResolvedSafe, lookup: rebinding,
    agentFactory: opts => { madeWith = opts; return { close: async () => { closed++; } }; },
    fetchImpl: async (url, init) => { seen = { url, init }; return { status: 200, ok: true }; }
  });
  const r = await f.connectorOauthFetch('https://as.rebind.example/register', { method: 'POST' });
  A.eq(r.status, 200, 'the leg completes');
  A.ok(seen && seen.init.dispatcher && seen.init.redirect === 'manual', 'fetch received the pinned dispatcher and manual redirects');
  A.eq(calls, 1, 'DNS was consulted exactly once (for the check)');
  // what the socket layer would get at connect time, both callback shapes:
  let single = null, all = null;
  madeWith.connect.lookup('as.rebind.example', {}, (err, addr, fam) => { single = { addr, fam }; });
  madeWith.connect.lookup('as.rebind.example', { all: true }, (err, list) => { all = list; });
  A.eq(single, { addr: '93.184.216.34', fam: 4 }, 'connect-time lookup returns the VALIDATED address, not a fresh (rebound) answer');
  A.eq(all, [{ address: '93.184.216.34', family: 4 }], 'the all:true connect shape is pinned too');
  await new Promise(res => setImmediate(res));
  A.eq(closed, 1, 'the per-leg dispatcher is closed (no pinned connection outlives its hop)');

  // private destinations are refused before any connect
  const refuse = async (url, lookup, msg) => {
    const g = makeConnectorOauthFetch({ assertSafeUrl: W.assertSafeUrl, assertResolvedSafe: W.assertResolvedSafe, lookup,
      agentFactory: () => { throw new Error('must not build a dispatcher'); }, fetchImpl: async () => { throw new Error('must not fetch'); } });
    try { await g.connectorOauthFetch(url); A.ok(false, msg + ' — was NOT refused'); } catch (e) { A.ok(!/must not/.test(e.message), msg + ' (' + e.message + ')'); }
  };
  await refuse('https://evil.example/token', async () => [{ address: '10.0.0.5', family: 4 }], 'a host resolving to 10.x is refused');
  await refuse('https://evil.example/token', async () => [{ address: '169.254.169.254', family: 4 }], 'a host resolving to cloud metadata is refused');
  await refuse('https://evil.example/token', async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], 'a mixed public+loopback answer is refused');
  await refuse('http://public.example/token', async () => [{ address: '93.184.216.34', family: 4 }], 'plain http is refused');
  await refuse('https://user:pw@public.example/token', async () => [{ address: '93.184.216.34', family: 4 }], 'embedded credentials are refused');
  await refuse('https://127.0.0.1/token', async () => [], 'a loopback literal is refused');

  // REAL socket proof: a real undici Agent pinned to a local listener's address. A hostname that the OS would
  // resolve elsewhere still connects to the pinned address — the pin, not DNS, decides where bytes go.
  const hits = [];
  const srv = net.createServer(sock => { hits.push(1); sock.destroy(); });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const pinnedLocal = makeConnectorOauthFetch({
    assertSafeUrl: u => new URL(u), assertResolvedSafe: async () => ({ address: '127.0.0.1', family: 4 }), lookup: null,
    agentFactory: opts => new undici.Agent(opts), fetchImpl: undici.fetch
  });
  try { await pinnedLocal.connectorOauthFetch('https://pinned-target.invalid:' + port + '/x'); } catch (_) { /* TLS to a raw socket fails — the connect is what we measure */ }
  srv.close();
  A.eq(hits.length, 1, 'the real connection went to the pinned address (a name that does not even resolve)');

  A.report('mcp.oauth-fetch.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
