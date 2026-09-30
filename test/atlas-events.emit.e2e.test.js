/* node test/atlas-events.emit.e2e.test.js — emit-seam gate for two bus events the Atlas events-area audit
   found EMITTED + CONSUMED but with NO test asserting the emit/payload BY NAME:

     · workitem.superseded (finding 40203e5e; shared/events.js:197, emit sidecar/index.js:~4172) — a newer
       message for the same chat ABORTS the prior in-flight work-item's run (hub one-run-per-chat), so its
       box drops off the belt. Driven the house way: a fake Telegram + fake OpenRouter, the LLM gate HOLDS
       run #1 in-flight, a SECOND task message on the SAME chat supersedes it, and the event rides the SSE bus.
     · workshop.decided (finding cf61a8e9; shared/events.js:140, emit sidecar/index.js:~6749) — emit-only
       telemetry when the Commander decides a pending deliverable. Driven deterministically via the 'later'
       decision (no manifest/disk needed): POST /api/workshop/decide {decision:'later'} emits it on the bus.

   Zero model spend: the mocked provider returns a canned stream (pricing 0); no real key is ever sent. Run
   via test:http (a child-process boot test shouldn't gate other agents' merges). */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJsonBody(req) { return new Promise(resolve => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } }); }); }

// fake OpenRouter with a GATE: when armed, the first completion emits its first delta (run is provably
// in-flight), then AWAITS release() before the finishing chunk — so we can hold run #1 while a second
// message supersedes it. (Mirrors the gate in channels.telegram.e2e.test.js.)
function startMockOpenRouter() {
  const requests = [];
  const gate = { armed: false, _release: null, _startedResolve: null, started: null };
  gate.arm = () => { gate.armed = true; gate.started = new Promise(r => { gate._startedResolve = r; }); };
  gate.release = () => { const r = gate._release; gate._release = null; if (r) r(); };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', async () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }) + '\n\n');
          if (gate.armed) { gate.armed = false; await new Promise(r => { gate._release = r; if (gate._startedResolve) gate._startedResolve(); }); }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, gate, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function startMockTelegram() {
  const calls = []; const sends = []; const queued = []; const waiters = [];
  let updateId = 1000, messageId = 2000;
  const respond = (res, obj) => { try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch (_) {} };
  const flush = () => { while (queued.length && waiters.length) respond(waiters.shift().res, { ok: true, result: [queued.shift()] }); };
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const method = String(req.url || '').split('/').pop();
      const body = await readJsonBody(req);
      calls.push({ method, body });
      if (method === 'deleteWebhook') return respond(res, { ok: true, result: true });
      if (method === 'getUpdates') {
        if (body.offset === -1) return respond(res, { ok: true, result: [] });
        if (queued.length) return respond(res, { ok: true, result: [queued.shift()] });
        const waiter = { res }; waiters.push(waiter);
        req.on('close', () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      if (method === 'sendMessage') { sends.push(body); return respond(res, { ok: true, result: { message_id: ++messageId } }); }
      respond(res, { ok: false, error_code: 404, description: 'unknown method' });
    });
    server.listen(0, HOST, () => resolve({
      calls, sends, base: 'http://' + HOST + ':' + server.address().port,
      pushText(chatId, userId, text) {
        queued.push({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: userId, username: 'commander' }, text } });
        flush();
      },
      close(done) { while (waiters.length) respond(waiters.shift().res, { ok: true, result: [] }); server.close(done || (() => {})); }
    }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function startSseCollector(url) {
  const ac = new AbortController();
  const events = []; const waiters = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'SSE feed opens with token');
  const reader = res.body.getReader();
  const notify = () => { for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; try { if (w.pred(events)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(events); } } catch (e) { waiters.splice(i, 1); clearTimeout(w.timer); w.reject(e); } } };
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try { while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line || line[0] === ':') continue; if (line.indexOf('data:') === 0) { try { events.push(JSON.parse(line.slice(5).trim())); notify(); } catch (_) {} } } } } catch (_) {}
  })();
  return {
    events,
    waitFor(pred, ms, label) { if (pred(events)) return Promise.resolve(events); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms); waiters.push({ pred, resolve, reject, timer }); }); },
    close() { try { ac.abort(); } catch (_) {} }
  };
}

async function waitUntil(fn, ms, label) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await fn()) return; await sleep(25); } throw new Error('timed out waiting for ' + label); }

(async () => {
  const llm = await startMockOpenRouter();
  const tg = await startMockTelegram();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-events-emit-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-events-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-events-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_TELEGRAM_TOKEN: 'TESTTOKEN', STARNET_TELEGRAM_TOKEN: 'TESTTOKEN',
    SKYNET_TELEGRAM_API_BASE: tg.base, STARNET_TELEGRAM_API_BASE: tg.base
  };
  const { child, port } = await boot(8975 + (process.pid % 40), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token));

    // ================= workitem.superseded =================
    // wait for the adapter's drop-pending poll so the hub is live, then HOLD run #1 in-flight.
    await waitUntil(() => tg.calls.some(c => c.method === 'getUpdates' && c.body && c.body.offset === -1), 6000, 'telegram drop-pending poll');
    // First DM never claims a remote-control bot. Pair this test's owner via the authenticated local route.
    const pair = await (await fetch(B + '/api/channels/telegram/owner/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: '{}'
    })).json();
    A.ok(/^[-A-Z0-9]{11}$/.test(String(pair.code || '')), 'owner pairing issued a code');
    tg.pushText(5555, 77, '/pair ' + pair.code);
    await waitUntil(() => tg.sends.some(s => String(s.chat_id) === '5555' && /Owner paired/i.test(String(s.text || ''))), 8000, 'owner pairing acknowledgement');
    llm.gate.arm();
    const CHAT = 5555;
    tg.pushText(CHAT, 77, 'research the launch checklist now');   // task-phrased → rides the belt as a crate

    // run #1's work-item is placed on the belt; capture its id (superseded must carry the SAME id).
    await sse.waitFor(ev => ev.some(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'tg_' + CHAT), 8000, 'workitem.placed for run #1');
    const placed = sse.events.find(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'tg_' + CHAT);
    const wi1 = placed.payload.workitemId;
    A.ok(wi1 && typeof wi1 === 'string', 'run #1 got a workitemId on the belt');
    // run #1 is provably in-flight now (the held completion emitted its first delta).
    await llm.gate.started;

    // a SECOND task message on the SAME chat aborts run #1 (one-run-per-chat) → its box is superseded.
    tg.pushText(CHAT, 77, 'actually research the release notes instead');
    await sse.waitFor(ev => ev.some(e => e.name === 'workitem.superseded' && e.payload && e.payload.workitemId === wi1), 8000, 'workitem.superseded for run #1');
    const sup = sse.events.find(e => e.name === 'workitem.superseded' && e.payload && e.payload.workitemId === wi1);
    A.ok(sup, 'workitem.superseded fired BY NAME for the aborted in-flight box');
    A.eq(sup.payload.workitemId, wi1, 'superseded carries the SUPERSEDED work-item id (the prior box, not the new one)');
    A.eq(sup.payload.agentId, 'tg_' + CHAT, 'superseded carries the aborted run\'s agentId');
    A.ok(typeof sup.payload.ts === 'number', 'superseded carries a numeric ts');

    // let the held completions drain so the child exits cleanly.
    llm.gate.release();

    // ================= workshop.decided =================
    // the 'later' decision is emit-only telemetry — no manifest/disk needed. POST decide {later} → event on the bus.
    const decide = await fetch(B + '/api/workshop/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ agentId: 'agent', runId: 'run-coverage', decision: 'later' })
    });
    const decideBody = await decide.json();
    A.eq(decide.status, 200, 'POST /api/workshop/decide {later} -> 200');
    A.eq(decideBody.decision, 'later', 'decide echoes the later decision');
    await sse.waitFor(ev => ev.some(e => e.name === 'workshop.decided' && e.payload && e.payload.runId === 'run-coverage'), 5000, 'workshop.decided on the bus');
    const dec = sse.events.find(e => e.name === 'workshop.decided' && e.payload && e.payload.runId === 'run-coverage');
    A.ok(dec, 'workshop.decided fired BY NAME');
    A.eq(dec.payload.decision, 'later', 'workshop.decided carries the decision');
    A.eq(dec.payload.agentId, 'agent', 'workshop.decided carries the agentId');
    A.eq(dec.payload.runId, 'run-coverage', 'workshop.decided carries the runId');

  } finally {
    try { llm.gate.release(); } catch (_) {}
    try { if (sse) sse.close(); } catch (_) {}
    try { tg.close(); } catch (_) {}
    try { llm.server.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(200);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('atlas-events.emit.e2e');
})().catch(e => { console.log('FAIL: atlas-events.emit.e2e threw — ' + (e && e.stack || e)); process.exit(1); });
