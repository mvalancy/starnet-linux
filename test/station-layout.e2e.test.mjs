/* node test/station-layout.e2e.test.mjs — station.layout END TO END, in real Chromium (2026-09-28).

   The unit suites prove the page verb and the sidecar tool in a vm. Only this proves the whole chain the lead
   actually uses: a MOCK model asks for station_layout → the REAL sidecar tool → the REAL station bridge (SSE) →
   the REAL page (stationcommands.js over the live WorldModel, WorkflowLine, World.planStatus) → the ack → the
   sidecar completes it against the REAL router → the tool result the model receives. And it holds that answer to
   the one promise the tool makes: it says what the Workflow panel shows — the panel is opened in the same page and
   its pill + sentence must match the tool's, character for character.

   Isolated: a fresh seeded workspace, APPDATA / LOCALAPPDATA / USERPROFILE / HOME / HERMES_HOME pointed at scratch
   (a test sidecar must never touch a real station), a fresh Chrome profile, OS-picked ports, and the model is a
   local mock (a mock that is never hit fails the test — traffic that reached a real provider is not a pass).
   Skips LOUDLY when no Chromium is installed. In test:http (a child-process boot + browser is not a fast step). */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { findChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { bootToken } = require('./_httpToken.js');

let chromePath = null;
try { chromePath = findChrome(); } catch (_) { chromePath = null; }
if (!chromePath) { console.log('station-layout.e2e: SKIPPED — no Chromium installed (this box cannot run the live bridge)'); process.exit(0); }

const failures = [];
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); if (!ok) failures.push(name); };
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const a = server.address(); server.close(e => e ? reject(e) : resolve(a.port)); });
});
const stopChild = (child, graceful = false) => new Promise(resolve => {
  if (!child || child.exitCode != null) { resolve(); return; }
  let killTimer;
  const timer = setTimeout(resolve, 6000);
  child.once('exit', () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); });
  const kill = () => {
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
      } else child.kill('SIGKILL');
    } catch (_) { clearTimeout(timer); resolve(); }
  };
  if (graceful) killTimer = setTimeout(kill, 3000); else kill();
});

// the mock model: the lead calls station_layout once per run (args = mock.nextArgs), then answers
function startMock() {
  const mock = { requests: [], results: [], nextArgs: {} };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      let p = {}; try { p = JSON.parse(body); } catch (_) {}
      mock.requests.push(p);
      const offered = (p.tools || []).some(t => t && t.function && t.function.name === 'station_layout');
      const answered = (p.messages || []).filter(m => m && m.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (offered && !answered.length) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_layout_' + mock.requests.length, type: 'function', function: { name: 'station_layout', arguments: JSON.stringify(mock.nextArgs) } }] } }] });
        send({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      } else {
        for (const m of answered) mock.results.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        send({ choices: [{ delta: { content: 'I read the floor.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      }
      res.write('data: [DONE]\n\n'); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => { mock.server = server; mock.base = 'http://127.0.0.1:' + server.address().port + '/api/v1'; r(mock); }));
}
async function leadRun(base, token, prompt) {
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base },
    body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: prompt }] }) });
  const text = await res.text();
  return { status: res.status, events: text.split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) };
}

const root = mkdtempSync(join(tmpdir(), 'starnet-layout-e2e-'));
const iso = {};
for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['USERPROFILE', 'home'], ['HOME', 'home'], ['HERMES_HOME', 'hermes']]) { iso[k] = join(root, 'iso', d); mkdirSync(iso[k], { recursive: true }); }
const workspace = join(root, 'workspace'), profile = join(root, 'profile');
const mock = await startMock();
const appPort = await freePort(), cdpPort = await freePort();
const base = 'http://127.0.0.1:' + appPort;
materializeSeedWorkspace(workspace, 'test/model');
const sidecar = bootSeededSidecar({ port: appPort, scratchDir: workspace, model: 'test/model', key: 'sk-or-v1-fake', env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base }, iso) });
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
  '--remote-debugging-port=' + cdpPort, '--window-size=1440,900', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

let cdp = null;
try {
  check('isolated seeded sidecar starts', await waitUp(base + '/'));
  const token = await bootToken(base, base);
  cdp = await connectCDP(cdpPort);
  cdp.timeoutMs = 45000;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const diagnostics = collectDiagnostics(cdp);
  // a throttled frame pump: the world still recompiles + posts, without a software canvas starving every evaluate
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 60); window.cancelAnimationFrame = id => clearTimeout(id);' });
  await cdp.send('Page.navigate', { url: base + '/' });
  check('the real page reaches the live floor', await waitDevReady(cdp, evalJS, { url: base + '/', tries: 60 }));

  // a REAL line through the live WorldModel mutation API: INBOX -> RESEARCHER -> WRITER -> OUTBOX, the hero on BOTH Bays
  const setup = await evalJS(cdp, `(() => {
    const st = App.station(), hero = App.heroId(), z = st.rooms()[0].rects[0];
    st.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } });
    let ok = null;
    for (let y = z.y1; y < z.y1 + 25 && !ok; y++) for (let x = z.x1; x < z.x2 + 30 && !ok; x++) { const r = st.stampBlueprint('research_line', x, y); if (r && r.ok) ok = r; }
    if (!ok) return null;
    const bays = st.props().filter(p => p.t === 'bay').map(p => p.id);
    for (const b of bays) st.assignPropAgent(b, hero);
    const intake = st.props().find(p => p.t === 'intake');
    st.setPropLabel(intake.id, 'RESEARCH DESK');
    return { hero, bays, intake: intake.id };
  })()`);
  check('laid a research line with the hero on both Bays', !!setup && setup.bays.length === 2, JSON.stringify(setup));
  let sync = null;
  for (let i = 0; i < 40; i++) { sync = await evalJS(cdp, 'World.planStatus()'); if (sync && !sync.pending && sync.lastHash && !sync.inflight && !sync.stale) break; await sleep(500); }
  check('the world posted the floor and the router answered', !!sync && !sync.pending && !!sync.lastHash && !sync.stale, JSON.stringify(sync && { pending: sync.pending, stale: sync.stale }));

  // 1. the lead reads the floor over the real bridge
  const run1 = await leadRun(base, token, 'what does my research line do?');
  const end1 = run1.events.filter(e => e.name === 'agent.run.end').pop();
  check('the lead run completes', run1.status === 200 && !!end1 && end1.payload.reason === 'done', JSON.stringify(end1 && end1.payload && end1.payload.reason));
  check('the lead is offered station_layout', JSON.stringify((mock.requests[0] || {}).tools || []).indexOf('station_layout') >= 0);
  let R = null; try { R = JSON.parse(mock.results[0] || ''); } catch (_) { R = null; }
  check('the model received the layout (not a refusal)', !!R, (mock.results[0] || '').slice(0, 160));
  const L = R && (R.lines || []).find(l => l.name === 'RESEARCH DESK');
  check('routing is live AND confirmed against the real router', !!R && R.routing.state === 'live' && R.routing.confirmed === true, JSON.stringify(R && R.routing));
  check('two steps, the hero on both, in compiled order', !!L && L.steps.length === 2 && L.steps.every(s => s.propId && setup.bays.indexOf(s.propId) >= 0), JSON.stringify(L && L.steps));
  check('the line carries the runner\'s effective budget', !!L && !!L.budget && typeof L.budget.maxHops === 'number', JSON.stringify(L && L.budget));

  // 2. the same line in full: per-Bay hand-offs off the compiled dock layer
  mock.nextArgs = { line: 'research desk' };
  await leadRun(base, token, 'show me that line in full');
  let D = null; try { D = JSON.parse(mock.results[1] || '').line; } catch (_) { D = null; }
  const [a, b] = (D && D.steps) || [];
  check('`line` returns that one line in full', !!D && D.name === 'RESEARCH DESK' && !!a && typeof a.brief === 'string' && Array.isArray(a.tools));
  check('step 1 is fed by the Inbox and hands to step 2; step 2 ships to the OUTBOX', !!a && !!b && a.fedByInbox === true && b.fedByInbox === false
    && a.sendsTo.length === 1 && a.sendsTo[0].step === 2 && b.sendsTo.length === 1 && b.sendsTo[0] === 'OUTBOX', JSON.stringify(a && [a.sendsTo, b.sendsTo]));

  // 3. PARITY: the REAL Workflow panel on the same line shows the same pill and the same sentence
  await evalJS(cdp, `(() => { Build.openAssign(${JSON.stringify(setup.intake)}); return true; })()`);
  let panel = null;
  for (let i = 0; i < 20; i++) {
    panel = await evalJS(cdp, `(() => { try { WorkflowPanel.refresh && WorkflowPanel.refresh(); } catch (e) {}
      const p = document.getElementById('wf-pill'), s = document.getElementById('wf-sentence');
      return { open: WorkflowPanel.isOpen(), pill: p && p.textContent, sentence: s && s.textContent }; })()`);
    if (panel && panel.open && panel.pill === (L && L.status) && panel.sentence === (L && L.howItRuns)) break;
    await sleep(500);
  }
  check('panel pill == tool status', !!panel && !!L && panel.pill === L.status, JSON.stringify([panel && panel.pill, L && L.status]));
  check('panel sentence == tool sentence', !!panel && !!L && panel.sentence === L.howItRuns, '\n  panel: ' + (panel && panel.sentence) + '\n  tool : ' + (L && L.howItRuns));

  // 4. Build mode holds the world: an unsent edit reads as pending, and the answer never says the router runs it
  await evalJS(cdp, `(() => { App.station().assignPropAgent(${JSON.stringify(setup.bays[1])}, ''); return true; })()`);
  await sleep(1000);
  mock.nextArgs = {};
  await leadRun(base, token, 'why is step 2 not running?');
  let P = null; try { P = JSON.parse(mock.results[2] || ''); } catch (_) { P = null; }
  check('an edit held by Build mode reads as pending', !!P && P.routing.pendingEdits === true && /running the floor as last sent/.test(P.routing.note), JSON.stringify(P && P.routing));
  const PL = P && (P.lines || []).find(l => l.name === 'RESEARCH DESK');
  check('and the drawn floor says what is missing', !!PL && /NEEDS AN AGENT/.test(PL.status), PL && PL.status);
  check('the mock carried every model call (no real provider)', mock.requests.length >= 6, String(mock.requests.length));
  check('no page exceptions', diagnostics.exceptions.length === 0, JSON.stringify(diagnostics.exceptions.slice(0, 3)));
} catch (error) {
  console.log('FAIL harness :: ' + (error && error.stack || error));
  failures.push('harness');
} finally {
  try { if (cdp) await Promise.race([cdp.send('Browser.close'), sleep(2000)]); } catch {}
  try { cdp?.ws.close(); } catch {}
  await Promise.all([stopChild(chrome, true), stopChild(sidecar)]);
  try { mock.server.close(); } catch {}
  const resolvedRoot = root.replace(/\\/g, '/');
  if (resolvedRoot.startsWith(tmpdir().replace(/\\/g, '/') + '/') && /starnet-layout-e2e-/.test(resolvedRoot)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9) console.log('(could not remove ' + root + ': ' + error.message + ')'); await sleep(300); }
    }
  }
}

console.log('\n=== ' + (failures.length ? 'FAILURES: ' + failures.join(', ') : 'station-layout.e2e: ALL CHECKS PASSED') + ' ===');
process.exit(failures.length ? 1 : 0);
