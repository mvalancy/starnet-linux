'use strict';
/* Real sidecar proof that RESTRICTED Google data never reaches StarNet Managed (the credits relay):
   a live Gmail connector (synthetic Google) is offered to an own-key run and returns mail content; on a
   StarNet Managed run the same agent is NOT offered Gmail tools, and the replayed Gmail result arrives at
   the relay as the withheld notice — never the mail body. No real Google account, cloud or model is used. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { ENDPOINTS } = require('../sidecar/mcp/transport.google.js');
const { WITHHELD } = require('../sidecar/mcp/google-relay-guard.js');

const MAIL = 'Synthetic message for acceptance testing.';   // what the synthetic Gmail returns (google-signin-preload.cjs)
const GMAIL_READ = 'mcp__gmail__read_message';

(async () => {
  const relay = [], custom = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/balance')) return res.end(JSON.stringify({ balanceUsd: 100 }));
    if (req.url.includes('/history')) return res.end(JSON.stringify({ entries: [] }));
    if (/\/(debit|credit)$/.test(req.url)) return res.end(JSON.stringify({ ok: true, balanceUsd: 100 }));
    if (req.url.includes('/models')) return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    let body = {}; try { body = JSON.parse(raw); } catch (_) {}
    const isCustom = req.url.startsWith('/custom/');
    (isCustom ? custom : relay).push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    const toolNames = (body.tools || []).map(t => t.function && t.function.name);
    const answered = (body.messages || []).some(m => m.role === 'tool');
    const delta = isCustom && toolNames.includes(GMAIL_READ) && !answered
      ? { tool_calls: [{ index: 0, id: 'mail1', type: 'function', function: { name: GMAIL_READ, arguments: JSON.stringify({ messageId: 'message-1' }) } }] }
      : { content: 'Done.' };
    const finish = delta.tool_calls ? 'tool_calls' : 'stop';
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cloud = 'http://127.0.0.1:' + server.address().port;
  const fixture = new SidecarFixture({ prefix: 'google-relay-guard-', timeoutMs: 30000, env: {
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: '', SKYNET_CREDITS_TOKEN: '',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_CLOUD_URL: cloud, STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    OPENROUTER_API_KEY: '', OPENROUTER_KEY: '', SKYNET_AUX_BUDGET: '0', SKYNET_FULL_ACCESS: '1',
    STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify({ installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } }),
    NODE_OPTIONS: '--require=' + path.join(__dirname, 'fixtures/google-signin-preload.cjs').replace(/\\/g, '/')
  } });
  const secrets = path.join(fixture.workspace, '.secrets/credits.json');
  fs.mkdirSync(path.dirname(secrets), { recursive: true });
  fs.writeFileSync(secrets, JSON.stringify({ url: cloud, deviceToken: 'fixture-linked-token', accountId: 'fixture-account', linkedAt: Date.now() }));
  const state = path.join(fixture.workspace, 'connectors/state.json');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, JSON.stringify({ version: 2,
    configs: [{ id: 'gmail', label: 'Gmail', url: ENDPOINTS.gmail, transport: 'http', oauth: true, enabled: true, googleApi: true }],
    oauth: { clients: {}, byId: { gmail: { accessToken: 'GOOGLE_ACCESS_TEST', refreshToken: 'GOOGLE_REFRESH_TEST', expiresAt: Date.now() + 3600e3,
      tokenEndpoint: 'https://oauth2.googleapis.com/token', clientId: '123456-starnettest.apps.googleusercontent.com',
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' } } } }));
  const run = async (provider, messages, extra) => {
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({
      provider, model: 'test/model', agentId: 'mailer', isTask: true, placed: [{ objectType: 'connector', connectorId: 'gmail' }], messages }, extra || {})) });
    assert.equal(r.status, 200);
    return (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  };
  const names = b => (b.tools || []).map(t => t.function && t.function.name);
  try {
    await fixture.start();
    let row;
    for (let i = 0; i < 50; i++) {
      row = (await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'gmail');
      if (row && row.state === 'up') break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(row && row.state, 'up', 'the Gmail connector is live: ' + JSON.stringify(row && { state: row.state, detail: row.detail }));

    // 1. own-key run: Gmail is offered and returns mail content into the conversation
    const own = await run('custom', [{ role: 'user', content: 'Read my latest mail' }], { baseUrl: cloud + '/custom/v1', key: 'fixture-custom-key' });
    assert.ok(custom.some(b => names(b).includes(GMAIL_READ)), 'an own-key run is offered Gmail');
    const result = own.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'mail1');
    assert.ok(result && result.payload.ok, 'Gmail read_message ran: ' + JSON.stringify(result && result.payload).slice(0, 200));
    assert.ok(custom.some(b => JSON.stringify(b.messages).includes(MAIL)), 'the own-key provider received the mail (the user chose it)');

    // 2. StarNet Managed run carrying that history: no Gmail tools, and the mail body is withheld
    const history = [
      { role: 'user', content: 'Read my latest mail' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'mail1', type: 'function', function: { name: GMAIL_READ, arguments: '{"messageId":"message-1"}' } }] },
      { role: 'tool', tool_call_id: 'mail1', content: MAIL },
      { role: 'user', content: 'Now summarize it' }
    ];
    const before = relay.length;
    const managed = await run('starnet', history);
    assert.equal(managed.filter(e => e.name === 'agent.run.end').at(-1)?.payload.reason, 'done', JSON.stringify(managed.filter(e => /error/.test(e.name))));
    const sent = relay.slice(before).filter(b => Array.isArray(b.messages));
    assert.ok(sent.length > 0, 'the managed run reached the relay');
    for (const b of sent) {
      assert.ok(!names(b).some(n => /^mcp__gmail__/.test(n)), 'StarNet Managed is never offered Gmail tools');
      assert.ok(!JSON.stringify(b).includes(MAIL), 'the mail body never reaches the StarNet relay');
    }
    assert.ok(sent.some(b => JSON.stringify(b.messages).includes('never sent to StarNet Managed')), 'the relay sees the withheld notice in its place');
    console.log('google-relay-guard.e2e: PASS (own-key run reads Gmail; StarNet Managed gets no Gmail tools and only the withheld notice)');
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
