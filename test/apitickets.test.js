/* node test/apitickets.test.js — scoped short-lived URL tickets (sidecar/apitickets.js verifier + the page's
   synchronous minter frontend/app/apiticket.js). Pure; no server boot. Proves:
     - the page's pure-JS SHA-256/HMAC is byte-identical to Node crypto, so page-minted tickets verify;
     - a ticket opens ONLY the resource it was minted for, expires, cannot be minted long-lived, and the
       once-only kinds refuse a replay;
     - every URL the page builds carries a ticket and NEVER the master token. */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const T = require('../sidecar/apitickets.js');

const KEY = 'launch-token-' + 'x'.repeat(40);
const NOW = 1.9e12;

// ---- the page minter, loaded against a fake window (sync mint, real CSPRNG, fixed clock) ----
global.window = { __STARNET_API_TOKEN__: KEY, __STARNET_API__: '', crypto: crypto.webcrypto };
const realNow = Date.now;
Date.now = () => NOW;
delete require.cache[require.resolve('../frontend/app/apiticket.js')];
const P = require('../frontend/app/apiticket.js');

// ---- crypto parity (the reason a sync pure-JS HMAC is safe to ship) ----
let shaBad = 0;
for (let n = 0; n < 200; n++) {
  const b = crypto.randomBytes(n);
  if (Buffer.from(P._test.sha256(new Uint8Array(b))).toString('hex') !== crypto.createHash('sha256').update(b).digest('hex')) shaBad++;
}
A.eq(shaBad, 0, 'page SHA-256 == node sha256 for lengths 0..199 (every padding boundary)');
let hmacBad = 0;
for (const kl of [0, 1, 36, 63, 64, 65, 300]) {
  const k = crypto.randomBytes(kl), m = crypto.randomBytes(91);
  if (Buffer.from(P._test.hmacSha256(new Uint8Array(k), new Uint8Array(m))).toString('hex') !== crypto.createHmac('sha256', k).update(m).digest('hex')) hmacBad++;
}
A.eq(hmacBad, 0, 'page HMAC-SHA256 == node HMAC incl. keys longer than a block');
const nonce = 'c0ffee'.repeat(5) + '00';
A.eq(P._test.mintWith(KEY, 'file', T.scopeFile('ag', 'dir/ä b+c&d.md'), NOW, nonce),
  T.mint(KEY, 'file', T.scopeFile('ag', 'dir/ä b+c&d.md'), { now: NOW, nonce }), 'page and sidecar mint byte-identical tickets (unicode + URL-special path)');
A.eq(P._test.KINDS.file.ttl, T.KINDS.file.maxTtlMs, 'page file lifetime == server cap');
A.eq(P._test.KINDS.run.ttl, T.KINDS.run.maxTtlMs, 'page run lifetime == server cap');
A.eq(P._test.KINDS.sse.ttl, T.KINDS.sse.maxTtlMs, 'page sse lifetime == server cap');
A.eq(P._test.KINDS.save.ttl, T.KINDS.save.maxTtlMs, 'page save lifetime == server cap');

// ---- verify: scope, expiry, cap, signature, format ----
const ok = (t, kind, scope, now, guard) => T.verify(KEY, t, kind, scope, { now: now == null ? NOW : now, guard }).ok;
const fileT = T.mint(KEY, 'file', T.scopeFile('ag', 'a.md'), { now: NOW });
A.ok(ok(fileT, 'file', T.scopeFile('ag', 'a.md')), 'file ticket verifies for its own file');
A.ok(!ok(fileT, 'file', T.scopeFile('ag', 'b.md')), 'file ticket refused for another file');
A.ok(!ok(fileT, 'file', T.scopeFile('other', 'a.md')), 'file ticket refused for another agent');
A.ok(!ok(fileT, 'run', T.scopeRun('ag', 'a.md')), 'file ticket refused as a run ticket (method/scope domain)');
A.ok(ok(fileT, 'file', T.scopeFile('ag', 'a.md'), NOW + T.KINDS.file.maxTtlMs - 1), 'still valid 1 ms before expiry');
A.ok(!ok(fileT, 'file', T.scopeFile('ag', 'a.md'), NOW + T.KINDS.file.maxTtlMs), 'EXPIRED at its expiry');
A.ok(!ok(fileT.slice(0, -2) + (fileT.slice(-2) === 'AA' ? 'AB' : 'AA'), 'file', T.scopeFile('ag', 'a.md')), 'tampered MAC refused');
A.ok(!ok(fileT.replace(/^st1\.[0-9a-z]+\./, 'st1.' + (NOW + 60000).toString(36) + '.'), 'file', T.scopeFile('ag', 'a.md')), 'edited expiry breaks the MAC');
A.eq(T.verify('other-launch', fileT, 'file', T.scopeFile('ag', 'a.md'), { now: NOW }).reason, 'bad signature', 'another launch key refuses it');
A.eq(T.verify(KEY, KEY, 'file', T.scopeFile('ag', 'a.md'), { now: NOW }).reason, 'malformed', 'the MASTER token is not a ticket');
A.eq(T.verify(KEY, '', 'file', T.scopeFile('ag', 'a.md'), { now: NOW }).reason, 'malformed', 'empty ticket refused');
// a minter asking for a long life gets the cap; a hand-forged long-lived ticket (valid MAC) is refused by the verifier
const capped = T.mint(KEY, 'file', T.scopeFile('ag', 'a.md'), { now: NOW, ttlMs: 24 * 3600e3 });
A.eq(T.parse(capped).exp, NOW + T.KINDS.file.maxTtlMs, 'mint caps a requested day-long life to 5 min');
const n2 = 'ab'.repeat(16), longExp = NOW + 3600e3;
const forged = 'st1.' + longExp.toString(36) + '.' + n2 + '.' + crypto.createHmac('sha256', KEY).update(T.message('GET', T.scopeFile('ag', 'a.md'), longExp, n2)).digest('base64url');
A.eq(T.verify(KEY, forged, 'file', T.scopeFile('ag', 'a.md'), { now: NOW }).reason, 'lifetime over cap', 'a validly-signed 1-hour ticket is refused (server cap)');

// ---- single-use kinds ----
const g = T.replayGuard();
const sseT = T.mint(KEY, 'sse', T.SCOPE_SSE, { now: NOW });
A.ok(ok(sseT, 'sse', T.SCOPE_SSE, NOW, g), 'sse ticket: first connect ok');
A.ok(!ok(sseT, 'sse', T.SCOPE_SSE, NOW, g), 'sse ticket: replay refused');
A.eq(T.verify(KEY, T.mint(KEY, 'sse', T.SCOPE_SSE, { now: NOW }), 'sse', T.SCOPE_SSE, { now: NOW }).reason, 'no replay guard', 'once-only kind fails CLOSED without a guard');
const small = T.replayGuard(3);
for (let i = 0; i < 10; i++) small.take('n' + i, NOW + 1000, NOW);
A.eq(small.size(), 3, 'replay registry is bounded');
const pr = T.replayGuard();
pr.take('old', NOW + 10, NOW); pr.take('new', NOW + 5000, NOW);
pr.take('newer', NOW + 6000, NOW + 100);
A.eq(pr.size(), 2, 'expired nonces are pruned');

// ---- request → claim (the verifier derives scope from the REQUEST) ----
const c1 = T.apiTicketClaim({ method: 'GET', url: '/api/file?agent=ag&path=' + encodeURIComponent('x/y z.md') + '&ticket=abc' });
A.eq(c1 && c1.kind, 'file', 'GET /api/file claims a file ticket');
A.eq(c1 && c1.scope, T.scopeFile('ag', 'x/y z.md'), 'scope = the decoded agent + path of the request');
A.eq(T.apiTicketClaim({ method: 'GET', url: '/api/file?path=p&ticket=abc' }).scope, T.scopeFile('agent', 'p'), 'agent defaults like the route (agent)');
A.eq(T.apiTicketClaim({ method: 'POST', url: '/api/run?ticket=x' }), null, 'POST /api/run can never claim a ticket');
A.eq(T.apiTicketClaim({ method: 'GET', url: '/api/transcript?ticket=x' }), null, 'data routes can never claim a ticket');
A.eq(T.apiTicketClaim({ method: 'DELETE', url: '/api/file?ticket=x' }), null, 'DELETE /api/file cannot claim a ticket');
A.eq(JSON.stringify(T.splitRunTicket('/workshop-run/~t/TK/ag/run1/index.html')), JSON.stringify({ ticket: 'TK', rest: 'ag/run1/index.html' }), 'run ticket rides the path');
A.eq(T.splitRunTicket('/workshop-run/ag/run1/index.html'), null, 'an un-ticketed run path has no ticket');
A.eq(T.splitRunTicket('/workshop-run/~t/'), null, 'an empty ticket segment is no ticket');

// ---- page URL builders: a ticket, never the master token ----
const fu = P.fileUrl('ag', 'dir/a b.md');
A.ok(fu.indexOf(KEY) < 0 && !/[?&]token=/.test(fu), 'fileUrl carries no master token: ' + fu.slice(0, 60));
const fq = new URL(fu, 'http://127.0.0.1').searchParams;
A.ok(ok(fq.get('ticket'), 'file', T.scopeFile(fq.get('agent'), fq.get('path'))), 'fileUrl ticket verifies against the request it builds');
const ru = P.runUrl('ag', 'run-1', 'sub/index.html');
const rs = T.splitRunTicket(ru);
A.ok(rs && rs.rest === 'ag/run-1/sub/index.html', 'runUrl = /workshop-run/~t/<ticket>/<agent>/<run>/<file>');
A.ok(ok(rs.ticket, 'run', T.scopeRun('ag', 'run-1')), 'runUrl ticket verifies for its run');
A.ok(!ok(rs.ticket, 'run', T.scopeRun('ag', 'run-2')), 'runUrl ticket refused for a sibling run');
A.ok(ru.indexOf(KEY) < 0, 'runUrl carries no master token');
const su = P.sseUrl('cursor=a%3A1');
A.ok(/^\/api\/channels\/events\?cursor=a%3A1&ticket=st1\./.test(su) && su.indexOf(KEY) < 0, 'sseUrl = cursor + a ticket, no master token');
const bu = P.saveBeaconUrl();
A.ok(/^\/api\/save\?ticket=st1\./.test(bu) && bu.indexOf(KEY) < 0, 'saveBeaconUrl = a save ticket, no master token');
A.ok(P.sseUrl('') !== P.sseUrl(''), 'every SSE connect mints a fresh (single-use) ticket');
// sign(): server-built openUrls
const sf = P.sign('/api/file?agent=ag&path=workshop%2Fr1%2Fa.md&token=LEGACY');
A.ok(!/token=/.test(sf) && /ticket=st1\./.test(sf), 'sign() drops a legacy ?token= and adds a file ticket');
const sfq = new URL(sf, 'http://127.0.0.1').searchParams;
A.ok(ok(sfq.get('ticket'), 'file', T.scopeFile('ag', 'workshop/r1/a.md')), 'sign() file ticket verifies');
const sr = P.sign('/workshop-run/ag/r%201/dir/index.html');
A.ok(ok(T.splitRunTicket(sr).ticket, 'run', T.scopeRun('ag', 'r 1')), 'sign() run ticket binds the DECODED run id');
A.eq(T.splitRunTicket(sr).rest, 'ag/r%201/dir/index.html', 'sign() keeps the path encoding');
A.eq(P.sign('https://example.com/x'), 'https://example.com/x', 'sign() never touches a foreign URL');
// desktop: absolute loopback base
window.__STARNET_API__ = 'http://127.0.0.1:4321';
A.ok(P.fileUrl('ag', 'a').indexOf('http://127.0.0.1:4321/api/file?') === 0, 'desktop fileUrl is absolute (Tauri origin)');
A.ok(P.runUrl('ag', 'r', 'i.html').indexOf('http://127.0.0.1:4321/workshop-run/~t/') === 0, 'desktop runUrl is absolute');
// no token loaded: no URL credential at all (never a guess)
window.__STARNET_API_TOKEN__ = '';
A.ok(!/ticket=/.test(P.fileUrl('ag', 'a')), 'no launch token → no ticket (the request is refused, nothing leaks)');
A.eq(P.runUrl('ag', 'r', 'i.html'), '', 'no launch token → no run URL');

Date.now = realNow;
delete global.window;
A.report('apitickets.test');
