/* node test/prompt-on-demand.e2e.test.js — the prompt diet at the WIRE (2026-09-23).

   Boots a private sidecar against a scripted fake model (custom OpenAI-compatible provider) and asserts on the
   bytes the model actually receives:
     1. default new-install floor (notebook placed -> skill.view on the wire): the system prompt carries the
        INSTALLED SKILLS index line per offered recipe and NO recipe body, and the manual's TOC form (rules
        inline, reference bodies absent);
     2. the model calls skill_view {"name":"library:plan"} and manual_read {"section":"navigation"} and the
        NEXT request carries the exact recipe body and the exact manual section in its tool results;
     3. a computer-only floor (no notebook -> no skill.view): the recipe bodies stay INLINE and no library:
        index line appears — the index never points at a tool the run cannot call.
   Zero real network, zero spend. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const WM = require('../frontend/app/worldmodel.js');
const C = require('../sidecar/skills/catalog.js');
const M = require('../sidecar/manual.js');

const MARK = 'PROMPT_ON_DEMAND_PROBE';
const HOST = '127.0.0.1';
const LIB = C.loadDir(path.join(__dirname, '..', 'sidecar', 'skills', 'library'), fs, path);
const PLAN = LIB.filter(s => s.slug === 'plan')[0];
const DEFAULTS = C.live(LIB, { overrides: {}, placedTypes: [] });

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
  res.write('data: [DONE]\n\n'); res.end();
}
const USAGE = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
const textText = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && (p.text || p.content)) || '').join('') : JSON.stringify(c || ''));

(async () => {
  const mains = [];
  let callScripted = false;
  const llm = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const system = (body.messages || []).filter(m => m.role === 'system').map(m => textText(m.content)).join('\n');
    const isMain = system.indexOf(MARK) >= 0 && Array.isArray(body.tools) && body.tools.length > 0;
    if (isMain) mains.push(body);
    const hasToolResults = (body.messages || []).some(m => m.role === 'tool');
    if (isMain && callScripted && !hasToolResults) {
      return sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_skill', type: 'function', function: { name: 'skill_view', arguments: JSON.stringify({ name: 'library:plan' }) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_manual', type: 'function', function: { name: 'manual_read', arguments: JSON.stringify({ section: 'navigation' }) } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: USAGE }
      ]);
    }
    return sse(res, [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE }]);
  });
  await new Promise(r => llm.listen(0, HOST, r));
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0' });
  const fixture = SidecarFixture.create({ prefix: 'starnet-prompt-on-demand-', timeoutMs: 20000, env });
  const starter = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
  async function run(placed, scripted) {
    mains.length = 0; callScripted = !!scripted;
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'custom', baseUrl: 'http://' + HOST + ':' + llm.address().port + '/v1', key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: true,
      placed: placed.map(objectType => ({ objectType })), stationPlaced: placed.map(objectType => ({ objectType })),
      system: MARK + ': on-demand probe.', messages: [{ role: 'user', content: 'Plan the work, then tell me where ROUTINES live.' }] }) });
    A.eq(r.status, 200, 'run accepted');
    const events = (await r.text()).trim().split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    return { events, requests: mains.slice() };
  }
  const sysOf = body => (body.messages || []).filter(m => m.role === 'system').map(m => textText(m.content)).join('\n');
  const toolNames = body => (body.tools || []).map(t => (t.function && t.function.name) || t.name);
  try {
    await fixture.start();

    /* ---- 1 + 2: the default new-install floor ---- */
    const a = await run(starter, true);
    A.eq(a.requests.length, 2, 'two main-loop calls: the tool-calling turn and the turn that reads the results');
    const first = a.requests[0] || { messages: [] };
    const sys = sysOf(first);
    A.ok(toolNames(first).indexOf('skill_view') >= 0 && toolNames(first).indexOf('manual_read') >= 0, 'skill_view and manual_read are on the wire');
    A.ok(sys.indexOf('\n\n## INSTALLED SKILLS\n') >= 0, 'the INSTALLED SKILLS section reaches the model');
    for (const s of DEFAULTS) {
      A.ok(sys.indexOf('- ' + s.name + ' [library:' + s.slug + '] -- ' + s.description) >= 0, s.slug + ': indexed');
      A.ok(sys.indexOf(s.body) < 0, s.slug + ': body NOT in the system prompt');
    }
    A.ok(sys.indexOf(M.starnetManualIndex()) >= 0, 'the manual rides in its TOC form (rules inline)');
    A.ok(sys.indexOf(M.manualSection('navigation')) < 0 && sys.indexOf(M.manualSection('troubleshooting')) < 0 && sys.indexOf(M.manualSection('props')) < 0,
      'no manual reference section body is in the system prompt');
    A.ok(sys.indexOf('<capabilities_ground_truth>') >= 0, 'the capability ground truth stays');
    A.ok(sys.lastIndexOf('Run id:') > sys.indexOf('## INSTALLED SKILLS') && sys.lastIndexOf('Run id:') > sys.indexOf('</starnet_operator_manual>'),
      'the per-run id still rides after the byte-stable blocks (prefix cache)');
    console.log('[on-demand] default-floor system prompt: ' + sys.length + ' chars');

    const second = a.requests[1] || { messages: [] };
    const results = (second.messages || []).filter(m => m.role === 'tool');
    const byId = {}; for (const m of results) byId[m.tool_call_id] = textText(m.content);
    A.ok(byId.call_skill && byId.call_skill.indexOf(PLAN.body) >= 0, 'skill_view library:plan put the EXACT recipe body in front of the model');
    A.ok(byId.call_manual && byId.call_manual.indexOf(M.manualSection('navigation')) >= 0, 'manual_read navigation put the EXACT section in front of the model');
    const ends = a.events.filter(e => e.name === 'agent.run.end').map(e => e.payload && e.payload.reason);
    A.eq(ends[ends.length - 1], 'done', 'the run finished normally');

    /* ---- 3: a floor with no notebook -> no skill.view -> bodies stay inline ---- */
    const b = await run([], false);
    A.eq(b.requests.length, 1, 'one main-loop call');
    const bsys = sysOf(b.requests[0] || { messages: [] });
    A.ok(toolNames(b.requests[0] || {}).indexOf('skill_view') < 0, 'precondition: skill_view is NOT on this run\'s wire');
    A.ok(bsys.indexOf('[library:') < 0, 'no library: index line where skill.view cannot be called');
    A.ok(bsys.indexOf('### ' + PLAN.name + ' -- ' + PLAN.description + '\n' + PLAN.body) >= 0, 'the recipe body stays INLINE on that run');
    A.ok(toolNames(b.requests[0] || {}).indexOf('manual_read') >= 0 && bsys.indexOf(M.starnetManualIndex()) >= 0, 'manual_read rides the computer, so the manual TOC form holds there too');
  } finally {
    await fixture.dispose();
    await new Promise(r => llm.close(r));
  }
  A.report('prompt-on-demand.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
