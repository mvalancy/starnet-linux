/* node test/e2e.dispatch-session.test.js — TRUE end-to-end of session-targeted delegation.

   Boots the REAL sidecar with a MOCK OpenRouter that makes the lead call team.dispatch with a `session`, then
   ACTS AS THE BROWSER: it holds the real SSE hub open, answers station.sessions with a live session list and
   station.deliver with an ack, exactly as stationcommands.js does in the page. Nothing is stubbed inside the
   sidecar — the bridge, the routes, the run host and the stores are all the shipped ones.

   THE BUG THIS PROVES CLOSED. team.dispatch was agent-addressed only, so a run the Commander asked to happen
   in "research" was filed under whatever session the LEAD was in: the work happened, the lead reported success,
   and the Commander could not find it. Unit tests can show the tool passes a streamId; only this shows the run
   host actually FILES it there. So the load-bearing assertions are the two that read the sidecar's own durable
   state afterwards — /api/runs and /api/transcript — not the tool's own account of itself.

   Also proves the refusal, which matters more than the happy path: a session name that does not exist must
   leave the worker unrun rather than picking a plausible one.

   NOT in test:fast (a child-process boot test shouldn't gate other agents' merges); run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { bootToken } = require('./_httpToken.js');
const { spawn } = require('child_process');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

const WORKER_TEXT = 'Phobos and Deimos, both captured asteroids.';

/* The mock model. The LEAD's first call delegates; the WORKER's own agent loop then hits this same server and
   answers as itself; the lead's follow-up wraps up. Keyed on the agent the request is for rather than a call
   counter, because the worker's run is interleaved with the lead's and a counter would be order-fragile. */
function startMockOpenRouter(dispatchArgs) {
  const requests = [];
  const leadSeen = () => requests.filter(r => r.__lead).length;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch (_) {}
          // the WORKER is the run whose tools do NOT include team_dispatch (a worker can never re-delegate)
          const isLead = JSON.stringify(parsed.tools || []).indexOf('team_dispatch') >= 0;
          parsed.__lead = isLead;
          requests.push(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (isLead && leadSeen() === 1) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_dispatch', type: 'function', function: { name: 'team_dispatch', arguments: JSON.stringify(dispatchArgs) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
          } else {
            const text = isLead ? 'Handed off.' : WORKER_TEXT;
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

/* BE THE PAGE. Hold the real SSE hub open and answer station.command exactly as stationcommands.js would —
   the same verbs, the same /api/station/ack route. `sessions` is the live list a name is resolved against. */
function attachStationPage(B, token, sessions) {
  const seen = [];
  const ctrl = new AbortController();
  const ready = fetch(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token), { signal: ctrl.signal }).then(async res => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (!ev || ev.name !== 'station.command') continue;
            const p = ev.payload || {};
            seen.push(p);
            const out = p.verb === 'station.sessions' ? { ok: true, result: { sessions: sessions } }
              : p.verb === 'station.deliver' ? { ok: true, result: { folded: true, session: 'research' } }
                : (p.verb === 'station.dispatch_start' || p.verb === 'station.dispatch_end')
                  ? { ok: true, result: { session: 'research' } }
                  : { ok: false, error: 'unknown station verb: ' + p.verb };
            await fetch(B + '/api/station/ack', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
              body: JSON.stringify(Object.assign({ id: p.id }, out))
            }).catch(() => {});
          }
        }
      } catch (_) { /* aborted at teardown */ }
    })();
    return true;
  });
  return { seen, ready, close: () => { try { ctrl.abort(); } catch (_) {} } };
}

async function drive(B, token, prompt) {
  const res = await fetch(B + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
    body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: prompt }] })
  });
  A.eq(res.status, 200, 'POST /api/run streams (200)');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch (_) {}
    }
  }
  return events;
}

async function run(label, dispatchArgs, sessions, body) {
  const mock = await startMockOpenRouter(dispatchArgs);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-dispatch-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_FULL_ACCESS: '1' };
  const { child, port } = await boot(8940 + (process.pid % 40), env, 20);
  const B = 'http://' + HOST + ':' + port;
  const page = { close: () => {} };
  try {
    const token = await bootToken(B, B);
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    // the crew the lead can address — pushed exactly as the browser's pushRoster() does
    const roster = await fetch(B + '/api/roster', { method: 'POST', headers: H, body: JSON.stringify({ agents: [
      { agentId: 'agent', system: 'LEAD', name: 'OVERSEER', model: 'test/model' },
      { agentId: 'researcher', system: 'You research things.', name: 'RESEARCHER', model: 'test/model' }
    ] }) });
    A.eq(roster.status, 200, label + ': the researcher is on the roster');
    const attached = attachStationPage(B, token, sessions);
    Object.assign(page, attached);
    await attached.ready;
    await new Promise(r => setTimeout(r, 250));   // let the hub register this client before the run emits
    const events = await drive(B, token, 'have the researcher summarise the moons of Mars in the research session');
    await body({ B, H, token, events, station: attached.seen, mock, label });
  } finally {
    page.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }
}

(async () => {

// ---- THE HAPPY PATH: a named session resolves, and the run is really FILED there ----
await run('targeted',
  { workers: [{ agentId: 'researcher', prompt: 'summarise the moons of Mars', session: 'research' }] },
  [{ id: 'ws_r1', title: 'research', agentId: 'researcher' }, { id: 'ws_gen', title: 'General', agentId: 'agent' }],
  async ({ B, H, events, station, label }) => {
    // 1) the sidecar really asked the page to resolve the name (the bridge is live, not simulated)
    const asked = station.filter(c => c.verb === 'station.sessions');
    A.eq(asked.length, 1, label + ': the tool asked the live page for its session list, once');

    // 2) the run completed and the worker really ran
    const ends = events.filter(e => e.name === 'agent.run.end');
    A.ok(ends.length >= 1, label + ': the lead run ended');
    A.eq(ends[ends.length - 1].payload.reason, 'done', label + ': the lead completed cleanly');

    // 3) the finished answer was delivered to the page, into the RESOLVED session
    const delivered = station.filter(c => c.verb === 'station.deliver');
    A.eq(delivered.length, 1, label + ': the answer was delivered to the page exactly once');
    A.eq(delivered[0].args.streamId, 'ws_r1', label + ': delivered into the session the Commander named');
    A.eq(delivered[0].args.sessionTitle, 'research', label + ': delivery carries the stable title that heals page-local id drift');
    A.eq(delivered[0].args.agentId, 'researcher', label + ': attributed to the worker that did it');
    A.ok(delivered[0].args.text.indexOf('Phobos') >= 0, label + ": the delivered text is the worker's real output");
    A.eq(station.filter(c => c.verb === 'station.dispatch_start').length, 1, label + ': target-session activity starts from a real worker run');

    /* 4) ⛔ THE LOAD-BEARING PROOF. Everything above is the tool describing its own behaviour. THIS reads the
          sidecar's own durable ledger: the worker's run must be recorded under the named stream. Before this
          fix that field was empty and the run belonged to no session at all. */
    const runs = await (await fetch(B + '/api/runs?agent=researcher&limit=20', { headers: H })).json();
    const workerRun = (runs.runs || []).find(r => r && r.agentId === 'researcher');
    A.ok(workerRun, label + ": the worker's run is in the run ledger");
    A.eq(workerRun.streamId, 'ws_r1', label + ': and the ledger files it under the named session — not the lead\'s');
    A.eq(workerRun.runId, delivered[0].args.runId, label + ': the delivered runId is the SAME run the ledger recorded');
    A.eq(workerRun.sessionTitle, 'research', label + ': the stable target title is durable for cross-page recovery');
    A.eq(workerRun.deliveryPrompt, 'summarise the moons of Mars', label + ': the delegated instruction is durable');
    A.eq(workerRun.deliveryText, WORKER_TEXT, label + ': the finished answer is durable when no page can receive it');

    // The lead lookup now returns its durable child runs, so COMMS can show the work hierarchy instead of
    // presenting the lead's one dispatch call as if it were the whole job.
    const leadEnd = ends.find(e => e.payload && e.payload.agentId === 'agent');
    const leadRuns = await (await fetch(B + '/api/runs?agent=agent&runId=' + encodeURIComponent(leadEnd.payload.runId), { headers: H })).json();
    const leadRun = (leadRuns.runs || [])[0];
    A.ok(leadRun && Array.isArray(leadRun.children), label + ': lead run API carries a child-run hierarchy');
    A.ok(leadRun.children.some(r => r.runId === workerRun.runId && r.parentRunId === leadRun.runId), label + ': the worker is joined to the exact lead that dispatched it');
    A.ok(leadRun.children.some(r => r.model === 'test/model' && typeof r.durationMs === 'number'), label + ': child hierarchy carries worker model and elapsed time');

    // 5) and its dialogue persisted under that stream, so a reload still finds the work there
    const tr = await (await fetch(B + '/api/transcript?agent=researcher&stream=ws_r1&limit=50', { headers: H })).json();
    const turns = tr.turns || [];
    A.ok(turns.some(t => t.role === 'assistant' && String(t.content).indexOf('Phobos') >= 0),
      label + ": the worker's answer persisted in that session's transcript");
    A.ok(turns.some(t => t.role === 'user' && /moons of Mars/.test(String(t.content))),
      label + ': along with the instruction it was given');

    // 6) the lead was told where it landed, so its spoken/typed report can be accurate
    const toolResults = events.filter(e => e.name === 'agent.tool_result');
    A.ok(toolResults.length >= 1, label + ': the dispatch returned a tool result');
  });

/* ---- ⛔ THE REFUSAL, WHICH MATTERS MORE. A name that matches nothing must leave the worker UNRUN. The
   original bug was not "the wrong session got picked at random" — it was that picking anything at all lets the
   lead truthfully report a success the Commander cannot find. ---- */
await run('unknown-session',
  { workers: [{ agentId: 'researcher', prompt: 'summarise the moons of Mars', session: 'marketing' }] },
  [{ id: 'ws_r1', title: 'research', agentId: 'researcher' }, { id: 'ws_gen', title: 'General', agentId: 'agent' }],
  async ({ B, H, station, mock, label }) => {
    A.eq(station.filter(c => c.verb === 'station.deliver').length, 0, label + ': nothing was delivered anywhere');
    A.eq(mock.requests.filter(r => !r.__lead).length, 0, label + ': the WORKER never ran — no work happened in the wrong place');
    const runs = await (await fetch(B + '/api/runs?agent=researcher&limit=20', { headers: H })).json();
    A.eq((runs.runs || []).filter(r => r && r.agentId === 'researcher').length, 0, label + ': and no worker run was recorded at all');
    // the lead is TOLD, in terms it can act on
    const followUp = mock.requests.filter(r => r.__lead).pop();
    const seen = JSON.stringify(followUp && followUp.messages || []);
    // matched loosely on purpose: `seen` is JSON, so the quotes around the name are backslash-escaped in it
    A.ok(/no session called/.test(seen) && /marketing/.test(seen), label + ': the model is told the session does not exist, by name');
    A.ok(seen.indexOf('research') >= 0, label + ': and is shown the sessions that DO exist, so it can correct itself');
    A.ok(/did NOT run/.test(seen), label + ': and told plainly that no work happened');
  });

A.report('e2e.dispatch-session.test');

})().catch(e => { console.error(e); process.exit(1); });
