'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { startPinnedProxy } = require('../sidecar/tools/builtin/browser-proxy.js');
const { _internals } = require('../sidecar/tools/builtin/browser.js');

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function request(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path: url }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}
function connect(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  let hits = 0;
  const sentinel = http.createServer((req, res) => { hits++; res.end('LOCAL_SENTINEL'); });
  const port = await listen(sentinel);
  const proxy = await startPinnedProxy({ validate: _internals.assertSafeUrl,
    resolve: u => _internals.assertResolvedSafe(u, async () => [{ address: '127.0.0.1', family: 4 }]) });
  try {
    const url = 'http://127.0.0.1:' + port + '/proof';
    const blocked = await request(proxy.port, url);
    A.eq(blocked.status, 403, 'ordinary browser traffic cannot reach loopback through the proxy');
    A.eq(hits, 0, 'blocked request never reaches the local sentinel');
    A.eq(await connect(proxy.port, '127.0.0.1:' + port), 403, 'HTTPS CONNECT to loopback is refused');
    const rebound = await request(proxy.port, 'http://rebind.audit.test:' + port + '/proof');
    A.eq(rebound.status, 403, 'a public hostname resolving to loopback is refused');
    A.eq(hits, 0, 'neither DNS rebinding nor CONNECT reached the sentinel');
    proxy.allowLocal(url);
    const allowed = await request(proxy.port, url);
    A.eq(allowed.status, 200, 'explicit browser.test_navigate origin can reach its local server');
    A.eq(allowed.body, 'LOCAL_SENTINEL', 'local test request reaches only the authorized origin');
  } finally {
    await proxy.close();
    await new Promise(resolve => sentinel.close(resolve));
  }
  A.report('browser-proxy.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
