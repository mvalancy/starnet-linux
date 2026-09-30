/* The owned Chromium uses this loopback proxy for every public connection.
   Validation and TCP dial share one DNS answer, including redirects and page
   subresources. CONNECT tunnels preserve the browser's original TLS SNI. */
'use strict';

const http = require('node:http');
const net = require('node:net');

async function startPinnedProxy({ validate, resolve }) {
  const localOrigins = new Set();
  async function destination(url) {
    const requested = new URL(url);
    if (localOrigins.has(requested.origin) && ['127.0.0.1', 'localhost', '[::1]'].includes(requested.hostname)) {
      return { u: requested, address: requested.hostname.replace(/^\[|\]$/g, '') };
    }
    const u = validate(url);
    const selected = await resolve(u);
    const address = selected ? selected.address : u.hostname.replace(/^\[|\]$/g, '');
    if (!net.isIP(address)) throw new Error('no verified IP address for ' + u.hostname);
    return { u, address };
  }
  const server = http.createServer((req, res) => {
    (async () => {
      const { u, address } = await destination(req.url);
      if (u.protocol !== 'http:') throw new Error('HTTPS requires CONNECT');
      const upstream = http.request({ hostname: address, port: Number(u.port) || 80,
        path: u.pathname + u.search, method: req.method,
        headers: Object.assign({}, req.headers, { host: u.host }) }, incoming => {
        res.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('error', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => { if (!res.headersSent) res.writeHead(403); res.end(); });
  });
  server.on('connect', (req, client, head) => {
    (async () => {
      if (!/^[^@/]+:\d+$/.test(req.url)) throw new Error('invalid CONNECT authority');
      const { u, address } = await destination('https://' + req.url + '/');
      const port = Number(u.port) || 443;
      const upstream = net.connect({ host: address, port });
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    })().catch(() => { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
  });
  server.on('upgrade', (req, client, head) => {
    (async () => {
      const { u, address } = await destination(req.url.replace(/^ws:/i, 'http:'));
      if (u.protocol !== 'http:') throw new Error('unsupported upgrade target');
      const upstream = net.connect({ host: address, port: Number(u.port) || 80 });
      upstream.once('connect', () => {
        const headers = req.rawHeaders.slice();
        for (let i = 0; i < headers.length; i += 2) {
          if (headers[i].toLowerCase() === 'host') headers[i + 1] = u.host;
        }
        let wire = req.method + ' ' + u.pathname + u.search + ' HTTP/' + req.httpVersion + '\r\n';
        for (let i = 0; i < headers.length; i += 2) wire += headers[i] + ': ' + headers[i + 1] + '\r\n';
        upstream.write(wire + '\r\n');
        if (head && head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    })().catch(() => { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  return {
    port: server.address().port,
    allowLocal(url) { localOrigins.add(new URL(url).origin); },
    close: () => new Promise(resolveClose => server.close(resolveClose))
  };
}

module.exports = { startPinnedProxy };
