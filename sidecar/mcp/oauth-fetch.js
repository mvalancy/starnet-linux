/* sidecar/mcp/oauth-fetch.js — the ONE fetch every connector-OAuth leg uses (probe, protected-resource + AS
   metadata, dynamic client registration, code exchange, refresh, Google userinfo, GitHub device flow).

   Those URLs come from an untrusted MCP server's metadata. The old wrapper validated the host (public, https, no
   userinfo) and RESOLVED it once, then called a plain fetch — which resolved the name AGAIN at connect time. A
   DNS-rebinding authorization server could answer the check with a public address and the connect with
   127.0.0.1 / 10.x / 169.254.169.254, turning DCR and token POSTs into requests against the Commander's own
   network. web.js closed exactly this gap with a per-request pinned dispatcher; this is the same guard here:
   the socket is opened to the address that was validated, never to a second answer.

   makeConnectorOauthFetch({ assertSafeUrl, assertResolvedSafe, lookup, fetchImpl?, agentFactory, onCloseError? })
     -> async (url, init) => Response
     assertSafeUrl(raw) -> URL                 literal-host checks (web.js)
     assertResolvedSafe(u, lookup) -> {address, family} | undefined   (undefined only for an IP literal host)
     fetchImpl : defaults to globalThis.fetch looked up PER CALL (test preloads replace it after boot)
     agentFactory(options) -> dispatcher       an undici Agent; its connect.lookup is pinned to the checked address */
'use strict';

function makeConnectorOauthFetch(deps) {
  deps = deps || {};
  const assertSafeUrl = deps.assertSafeUrl;
  const assertResolvedSafe = deps.assertResolvedSafe;
  const lookup = deps.lookup;
  const agentFactory = deps.agentFactory;
  const onCloseError = typeof deps.onCloseError === 'function' ? deps.onCloseError : null;
  if (typeof assertSafeUrl !== 'function' || typeof assertResolvedSafe !== 'function' || typeof agentFactory !== 'function')
    throw new Error('makeConnectorOauthFetch requires { assertSafeUrl, assertResolvedSafe, agentFactory }');
  const fetchNow = (url, init) => (typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch)(url, init);

  async function publicUrl(raw) {
    const u = assertSafeUrl(raw);
    if (u.protocol !== 'https:') throw new Error('connector OAuth endpoints must use https');
    if (u.username || u.password) throw new Error('connector OAuth endpoints cannot contain embedded credentials');
    return u;
  }

  async function connectorOauthFetch(raw, init) {
    const u = await publicUrl(raw);
    const address = await assertResolvedSafe(u, lookup);
    const dispatcher = address && address.address ? agentFactory({ connect: {
      lookup(hostname, options, callback) {
        if (options && options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      }
    } }) : null;
    const opts = Object.assign({}, init || {}, { redirect: 'manual' });
    if (dispatcher) opts.dispatcher = dispatcher;
    try {
      return await fetchNow(u.href, opts);
    } finally {
      // Graceful close: undici waits for the in-flight request (including its body) before closing the socket,
      // so the caller can still read the response; a later request can never reuse this pinned connection.
      if (dispatcher && typeof dispatcher.close === 'function') {
        Promise.resolve().then(() => dispatcher.close()).catch(e => { if (onCloseError) onCloseError(e); });
      }
    }
  }

  return { connectorOauthFetch, publicUrl };
}

module.exports = { makeConnectorOauthFetch };
