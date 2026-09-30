/* node test/web.ssrf.test.js — the web_fetch SSRF guard: literal-address blocking (IPv4 + IPv6 +
   encodings + bare names), public addresses allowed, DNS-rebinding refusal, and redirect re-validation
   (a public page cannot bounce the fetch to an internal address). Zero real network — fetch + DNS are
   injected. Pairs with the hardening in sidecar/tools/builtin/web.js. */
'use strict';
const A = require('./_assert.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');

// a noop fetch so makeWebTools constructs; lookup:null disables real DNS for the static-guard checks.
const W = makeWebTools({ fetchImpl: async () => ({ status: 200, text: async () => '', headers: { get: () => '' } }), lookup: null });
const { assertSafeUrl, assertResolvedSafe, isPrivateV4, isPrivateV6 } = W._internals;

function rejects(fn, msg) { try { fn(); A.ok(false, msg + ' — did NOT reject'); } catch (e) { A.ok(true, msg); } }
async function rejectsAsync(p, msg) { try { await p; A.ok(false, msg + ' — did NOT reject'); } catch (e) { A.ok(true, msg); } }

(async () => {
  // ---- A. literal hosts that MUST be refused ----
  const blocked = [
    'http://localhost/', 'http://127.0.0.1/', 'http://127.9.9.9/', 'http://0.0.0.0/',
    'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://172.16.0.1/', 'http://172.31.255.255/', 'http://100.64.0.1/',                 // CGNAT
    'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', // IPv6 loopback/ULA/link-local/mapped
    'http://2130706433/', 'http://0x7f000001/',                                            // integer / hex 127.0.0.1
    'http://internal-api/', 'http://db/', 'http://router.local/', 'http://svc.internal/',  // intranet names
    'http://metadata.goog/computeMetadata/v1/', 'http://metadata.google.internal/',        // GCP cloud-metadata hostnames
    'ftp://example.com/', 'file:///etc/passwd', 'gopher://x/'                              // non-http(s)
  ];
  for (const url of blocked) rejects(() => assertSafeUrl(url), 'blocks ' + url);

  // ---- B. public hosts that MUST be allowed ----
  const allowed = ['https://example.com/', 'http://8.8.8.8/', 'https://[2606:4700:4700::1111]/', 'http://news.ycombinator.com/'];
  for (const url of allowed) { try { assertSafeUrl(url); A.ok(true, 'allows ' + url); } catch (e) { A.ok(false, 'allows ' + url + ' — wrongly blocked: ' + e.message); } }

  // ---- C. range helpers ----
  A.ok(isPrivateV4('127.0.0.1') && isPrivateV4('10.1.2.3') && isPrivateV4('100.100.0.1'), 'isPrivateV4 ranges');
  A.ok(!isPrivateV4('8.8.8.8') && !isPrivateV4('100.200.0.1'), 'isPrivateV4 passes public');
  A.ok(isPrivateV6('::1') && isPrivateV6('fd00::1') && isPrivateV6('fe80::1') && isPrivateV6('::ffff:7f00:1'), 'isPrivateV6 ranges');
  A.ok(!isPrivateV6('2606:4700:4700::1111'), 'isPrivateV6 passes public');

  // ---- D. DNS rebinding: a public NAME resolving to a private address is refused ----
  const privLookup = async () => [{ address: '169.254.169.254', family: 4 }];
  const pubLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  await rejectsAsync(assertResolvedSafe(new URL('http://totally-public.example/'), privLookup), 'refuses name that resolves to a private addr');
  try { await assertResolvedSafe(new URL('http://totally-public.example/'), pubLookup); A.ok(true, 'allows name resolving to a public addr'); }
  catch (e) { A.ok(false, 'public-resolving name wrongly blocked: ' + e.message); }

  // ---- E. redirect re-validation: a public page that 302s to an internal address is refused ----
  function resp(status, opts) { opts = opts || {}; return { status, text: async () => opts.body || '', headers: { get: k => (k.toLowerCase() === 'location' ? (opts.loc || '') : (k.toLowerCase() === 'content-type' ? (opts.ct || 'text/html') : '')) } }; }
  // jina returns 402 (forces the direct fallback); the target then 302s to the cloud-metadata endpoint
  const evilFetch = async (url) => {
    if (String(url).indexOf('r.jina.ai') >= 0) return resp(402);
    if (String(url).indexOf('169.254') >= 0) return resp(200, { body: 'SECRET METADATA' });
    return resp(302, { loc: 'http://169.254.169.254/latest/meta-data/' });
  };
  const evil = makeWebTools({ fetchImpl: evilFetch, lookup: null });
  await rejectsAsync(evil.webFetch('http://totally-public.example/page'), 'web_fetch refuses a redirect to an internal address');

  // ---- F. the happy direct path still works (jina down -> direct fetch of a public page) ----
  const okFetch = async (url) => {
    if (String(url).indexOf('r.jina.ai') >= 0) return resp(402);
    return resp(200, { body: '<h1>Hello</h1><p>real content here</p>', ct: 'text/html' });
  };
  const good = makeWebTools({ fetchImpl: okFetch, lookup: null });
  const got = await good.webFetch('http://example.com/article');
  A.ok(/real content here/.test(got.text) && got.source === 'direct', 'direct fallback returns cleaned text for a public page');

  // The socket receives the validated address, not the original hostname for
  // another independent DNS lookup. A third DNS answer would be loopback.
  {
    let lookups = 0, connectedTo = '', sentHost = '', closed = false;
    const pinned = makeWebTools({
      lookup: async () => [{ address: ++lookups < 3 ? '93.184.216.34' : '127.0.0.1', family: 4 }],
      agentFactory: options => ({
        async close() { closed = true; },
        connect: options.connect
      }),
      fetchImpl: async (url, opts) => {
        sentHost = new URL(url).hostname;
        opts.dispatcher.connect.lookup(sentHost, {}, (error, address) => { if (error) throw error; connectedTo = address; });
        return resp(200, { body: 'ok', ct: 'text/plain' });
      }
    });
    await pinned.requestTool.run({ url: 'http://rebind.audit.test/proof' }, { agentId: 'agent' });
    A.eq(lookups, 2, 'validation and connection share the selected DNS result; no third lookup occurs');
    A.eq(connectedTo, '93.184.216.34', 'connection callback supplies the validated public IP');
    A.eq(sentHost, 'rebind.audit.test', 'original hostname remains for Host and TLS identity');
    A.ok(closed, 'per-hop dispatcher is closed after consuming the response');
  }
  await rejectsAsync(assertResolvedSafe(new URL('https://public.example/'), async () => { throw new Error('resolver unavailable'); }), 'DNS errors fail closed');
  await rejectsAsync(assertResolvedSafe(new URL('https://public.example/'), async () => []), 'empty DNS answers fail closed');

  // ---- the FQDN root label is not an escape hatch ----
  // WHATWG strips a trailing dot for IP literals but NOT for names, so `localhost.` kept its dot and slipped
  // past every name rule. The DNS guard usually catches it downstream, but it is best-effort (a failed lookup
  // returns silently, deps.lookup:null disables it), so the static rule has to be right on its own.
  for (const u of ['http://localhost./', 'http://svc.internal./', 'http://router.lan./', 'http://wiki./', 'http://myapp.local./'])
    rejects(() => assertSafeUrl(u), 'trailing-dot FQDN refused: ' + u);
  A.eq(assertSafeUrl('https://example.com./').protocol, 'https:', 'a PUBLIC name with a root label is still allowed');

  A.report('web.ssrf.test');
})();
