'use strict';
// Local provider and empty-wallet fixture; no real credentials or vendor charges.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('../../test/helpers/sidecar-fixture.js');
const { chromium } = require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
(async () => {
  const calls = [], receipt = { phase: process.argv[2] || 'before', checks: [] };
  const vendor = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/balance')) return res.end(JSON.stringify({ balanceUsd: 0 }));
    if (req.url.includes('/history')) return res.end(JSON.stringify({ entries: [] }));
    if (!raw) return res.end(JSON.stringify({ data: ['fixture/byok', 'fixture/managed'].map(id => ({ id, name: id, context_length: 128000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } })) }));
    const body = JSON.parse(raw); calls.push({ model: body.model, auth: req.headers.authorization, path: req.url });
    const delegated = body.messages?.some(m => m.role === 'tool');
    const lead = body.messages?.some(m => m.role === 'system' && String(m.content).includes('DISPATCH_PROBE'));
    const delta = lead && !delegated ? { tool_calls: [{ index: 0, id: 'dispatch_probe', type: 'function', function: { name: 'team.dispatch', arguments: JSON.stringify({ workers: [{ agentId: 'worker', prompt: 'Reply with OK.' }] }) } }] } : { content: 'OK' };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => vendor.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + vendor.address().port;
  const fixture = new SidecarFixture({ prefix: 'byok-delegation-', entry: path.join(root, 'dev/seed.js'), timeoutMs: 30000, env: {
    SKYNET_DEFAULT_MODEL: 'fixture/byok', SKYNET_OPENROUTER_KEY: 'fixture-byok-key', STARNET_OPENROUTER_KEY: 'fixture-byok-key',
    STARNET_OPENROUTER_BASE: url + '/v1', SKYNET_OPENROUTER_BASE: url + '/v1',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: '', SKYNET_CREDITS_TOKEN: '',
    STARNET_CLOUD_URL: url, SKYNET_AUX_BUDGET: '0'
  } });
  fixture.args = ['--keep', '--workspace', fixture.workspace];
  fs.cpSync(path.join(root, 'dev/fixtures/seed-workspace'), fixture.workspace, { recursive: true });
  const savePath = path.join(fixture.workspace, 'agent.save.json');
  const save = JSON.parse(fs.readFileSync(savePath));
  save.doc.agent.model = 'fixture/byok'; save.doc.agent.provider = 'openrouter';
  save.doc.agents = [{ ...save.doc.agent, id: 'worker', name: 'WORKER', model: 'fixture/managed', provider: 'starnet', role: 'specialist' }];
  fs.writeFileSync(savePath, JSON.stringify(save));
  fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(fixture.workspace, '.secrets/credits.json'), JSON.stringify({ url, deviceToken: 'fixture-managed-token', accountId: 'fixture-account' }));
  let browser;
  try {
    await fixture.start();
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    if (receipt.phase === 'before') {
      const original = require('node:child_process').execFileSync('git', ['show', 'f00aa04df:frontend/app/stationui.js'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      await page.route('**/app/stationui.js*', route => route.fulfill({ contentType: 'application/javascript', body: original }));
      const originalApp = require('node:child_process').execFileSync('git', ['show', 'f00aa04df:frontend/app/app.js'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      await page.route('**/app/app.js*', route => route.fulfill({ contentType: 'application/javascript', body: originalApp }));
    }
    await page.goto(fixture.baseUrl);
    await page.waitForFunction(() => typeof App !== 'undefined' && App.agents().some(a => a.id === 'worker'));
    await page.evaluate(() => StationUI.openAgent(App.agents().findIndex(a => a.id === 'worker')));
    await page.locator('[data-goconfig="ag-model-card"]').first().click();
    await page.waitForFunction(() => document.querySelector('#ag-model-pick-model')?.value.includes('fixture/managed'));
    await page.locator('#ag-model-pick-model').selectOption('');
    await page.locator('#ag-model-save').click();
    const saved = await page.evaluate(() => App.agents().find(a => a.id === 'worker'));
    receipt.saved = { model: saved.model, provider: saved.provider };
    const before = receipt.phase === 'before';
    assert.equal(saved.model, before ? 'fixture/managed' : null);
    assert.equal(saved.provider, before ? 'starnet' : null);
    receipt.checks.push(before ? 'Dropdown default + SAVE silently retains managed pin' : 'Dropdown default + SAVE clears model and provider');
    await page.evaluate(() => App.pushRoster());
    const run = async system => {
      const out = await fixture.json('POST', '/api/run', { provider: 'openrouter', model: 'fixture/byok', key: 'fixture-byok-key', agentId: 'agent', system, isTask: system === 'DISPATCH_PROBE', placed: ['orchestrator'], messages: [{ role: 'user', content: system === 'DISPATCH_PROBE' ? 'Delegate to worker now.' : 'Hello' }] });
      return out.text;
    };
    receipt.direct = await run('DIRECT_PROBE');
    assert.ok(receipt.direct.includes('agent.token'));
    receipt.delegated = await run('DISPATCH_PROBE');
    const events = receipt.delegated.trim().split('\n').map(JSON.parse);
    const workers = events.filter(e => e.payload?.agentId === 'worker');
    if (before) {
      assert.ok(workers.some(e => e.name === 'agent.run.error' && e.payload.message.includes('Out of managed credit')));
      assert.ok(workers.some(e => e.name === 'agent.run.end' && e.payload.turns === 0));
      receipt.checks.push('Retained managed pin reproduces zero-turn credit refusal');
      // Separate explicit button is a usable workaround on the affected build.
      await page.locator('#ag-model-clear').click();
      await page.evaluate(() => App.pushRoster());
      const workaround = await run('DISPATCH_PROBE');
      assert.ok(workaround.split('\n').filter(Boolean).map(JSON.parse).some(e => e.name === 'agent.run.end' && e.payload.agentId === 'worker' && e.payload.reason === 'done'));
      receipt.checks.push('Dedicated FOLLOW STATION DEFAULT button restores BYOK delegation');
    } else {
      assert.ok(workers.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'));
      assert.ok(!workers.some(e => e.name === 'agent.run.error'));
      receipt.checks.push('Worker completes against BYOK with zero managed balance');
    }
    assert.ok(calls.every(c => c.auth === 'Bearer fixture-byok-key'));
    assert.ok(calls.every(c => c.model === 'fixture/byok'));
    await page.evaluate(async () => { App.persist(); await App.pushRoster(); await CloudSave.flush({ force: true }); });
    await fixture.restart();
    await page.goto(fixture.baseUrl);
    await page.waitForFunction(() => typeof App !== 'undefined' && App.agents().some(a => a.id === 'worker'));
    const restored = await page.evaluate(() => App.agents().find(a => a.id === 'worker'));
    assert.equal(restored.model, before ? 'fixture/byok' : null);
    assert.equal(restored.provider, before ? 'openrouter' : null);
    await page.evaluate(() => App.pushRoster());
    const restarted = await run('DISPATCH_PROBE');
    assert.ok(restarted.split('\n').filter(Boolean).map(JSON.parse).some(e => e.name === 'agent.run.end' && e.payload.agentId === 'worker' && e.payload.reason === 'done'));
    receipt.checks.push(before ? 'Reload incorrectly re-pins the cleared worker to the current lead model' : 'Clear survives renderer reload and sidecar restart; delegated worker still completes');
    receipt.calls = calls;
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    if (browser) await browser.close();
    await fixture.dispose(); vendor.closeAllConnections(); await new Promise(resolve => vendor.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
