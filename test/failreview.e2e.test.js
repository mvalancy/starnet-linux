/* node test/failreview.e2e.test.js — TRUE end-to-end proof of the FAILURE-REVIEW aux pass (failure-learn lane).

   THE GAP THIS CLOSES: all six post-run learning passes gate on reason 'done', so a FAILED run (error /
   max_iters / budget / refusal) taught the station nothing. The failure-review pass reads the failed run's
   persisted evidence (failureStage/failureCode, tool trace, recovery attempts) + transcript tail and writes at
   most 3 durable LESSONS to notebook memory with origin 'failure-review'. Against the REAL sidecar + a mock
   OpenRouter that records every model call, one fixture proves:

     ARM 1 — a run ending 'error' (a real tool turn, then a fatal provider 400) fires EXACTLY ONE
             failure-review pass, on the configured aux model with effort 'low'; a lesson record with origin
             'failure-review' lands in /api/memory/records (the notebook recall reads from); and NO
             done-gated pass (reflection et al.) fires on the failed run.
     ARM 2 — a second failed run for the SAME agent inside the cooldown window fires NOTHING (per-agent
             cooldown, armed only because arm 1's lesson survived).
     ARM 3 — failureReviewEnabled=false (POST /api/memory/config, the reflectEnabled pattern) suppresses the
             pass LIVE for a fresh agent; the config API round-trips the flag.
     ARM 4 — the personalization PAUSE (POST /api/personalization {enabled:false}) suppresses the pass — a
             paused station learns nothing new, same server authority as the scout.
     ARM 5 — REGRESSION: a run ending 'done' fires reflection exactly as before and NEVER fires
             failure-review (the done-gated and fail-gated families are mutually exclusive per run).
     ARM 6 — a CANCELLED run (client abort via POST /api/cancel) fires NO failure-review pass.
     ARM 7 — PROJECT TIER (memory-compound lane): a lesson learned inside blessed project A is scoped to A —
             it is injected back inside A and NEVER into project B or an unscoped run.
     ARM 8 — HYBRID RECALL (memory-compound lane): with no embedding model the lane makes NO provider call and
             a lexically-unrelated task does NOT recall the lesson (BM25 only); once `embedModel` is configured
             the SAME task recalls it through the mock /embeddings wire, the vectors persist (a repeat costs no
             new call), and the personalization PAUSE silences the lane (no embedding call while paused).

   ZERO network, zero real key (the fake key routes to the mock). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RUN_MODEL = 'run/model';
const AUX_MODEL = 'aux/cheap';

// markers route the mock's MAIN-call behavior per run (the marker rides the user text, so it is in the raw body)
const FAIL_MARK = 'FAILRUN';
const GOOD_MARK = 'GOODRUN';
const SLOW_MARK = 'SLOWRUN';

const LESSON_REPLY = 'LESSON: Registry pushes rate-limit after repeated attempts; batch retries with exponential backoff before the next push';
// ~6 KB reply for the 'done' arm: clears reflectSalient (>=200 chars) on a fresh workspace.
const LONG_REPLY = ('I dug through the deploy pipeline and rebuilt the staging rollback path end to end. ' +
  'Here is the substantive write-up with the reasoning, the tradeoffs, and the follow-ups worth remembering. ').repeat(40);

function sse(res, deltas, usage, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const delta of deltas) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

/* mock OpenRouter. Catalog: run/model tool-capable; aux/cheap reasoning-capable (no tools). Records
   {model, sys, main, failReview, reflection, reasoning} per /chat/completions call.
   MAIN-call routing by marker: FAILRUN -> one real tool turn, then a fatal 400 (run ends 'error' at
   provider_stream/format_error); SLOWRUN -> stall until the client aborts; GOODRUN -> the long clean reply. */
function startMock() {
  const state = { calls: [] };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [
          { id: RUN_MODEL, context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
          { id: AUX_MODEL, context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning'] }
        ] }));
        return;
      }
      if (req.url.indexOf('/embeddings') >= 0) {
        // the embedding wire (ARM 8): a deterministic 3-d "semantic" space — anything about registry pushes /
        // throttled uploads lands on axis 0, everything else on axis 1 — so a zero-lexical-overlap paraphrase
        // still scores cosine 1.0 against the lesson.
        let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
          const body = JSON.parse(raw);
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          state.calls.push({ model: body.model, embed: true, inputs: inputs.slice(), main: false, failReview: false, reflection: false, recall: '' });
          const vec = t => (/registry|rate-limit|throttl|package index|uploads/i.test(String(t)) ? [1, 0, 0] : [0, 1, 0]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: vec(t) })), usage: { prompt_tokens: 5 * inputs.length, total_tokens: 5 * inputs.length } }));
        });
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
          const body = JSON.parse(raw);
          const messages = body.messages || [];
          const sysMsg = messages.find(m => m && m.role === 'system');
          const sys = sysMsg ? (typeof sysMsg.content === 'string' ? sysMsg.content : JSON.stringify(sysMsg.content)) : '';
          const rec = {
            model: body.model, sys: sys.slice(0, 240),
            main: raw.indexOf('[RUNTIME]') >= 0,   // only the MAIN task run carries the full runtime system prompt
            failReview: sys.indexOf('reviewing a task run of yours that FAILED') >= 0,
            reflection: sys.indexOf('reflecting right after finishing a task') >= 0,
            reasoning: body.reasoning || null,
            // the recalled-memory fence (if any) the MAIN run received — the proof that a stored lesson SURFACED
            recall: messages.filter(m => m && m.role === 'system' && typeof m.content === 'string' && m.content.indexOf('<recalled-memory>') >= 0).map(m => m.content).join('\n')
          };
          state.calls.push(rec);
          if (rec.failReview) { sse(res, [{ content: LESSON_REPLY }], { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }, 'stop'); return; }
          if (rec.reflection) { sse(res, [{ content: 'FACT: the commander maintains the staging deploy rollback path' }], { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }, 'stop'); return; }
          if (rec.main && raw.indexOf(FAIL_MARK) >= 0) {
            if (!messages.some(m => m && m.role === 'tool')) {
              // one REAL tool turn first, so the failed run has a tool trace (the salience floor) …
              sse(res, [{ tool_calls: [{ index: 0, id: 'inspect_once', type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] }],
                { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }, 'tool_calls');
              return;
            }
            // … then a fatal 400: classify400 -> format_error (retryable:false, no fallback) -> reason 'error'.
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'main stream rejected (test fault injection)', code: 400 } }));
            return;
          }
          if (rec.main && raw.indexOf(SLOW_MARK) >= 0) {
            // stall: headers + one delta, then hold the stream open until the client aborts (safety cap 12s).
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'working…' } }] }) + '\n\n');
            const t = setTimeout(() => { try { res.end(); } catch (_) {} }, 12000);
            req.on('close', () => clearTimeout(t));
            return;
          }
          if (rec.main) { sse(res, [{ content: LONG_REPLY }], { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }, 'stop'); return; }
          sse(res, [{ content: 'ok, done.' }], { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, 'stop');
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

async function driveRun(fixture, agentId, text, extra) {
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ key: 'sk-or-v1-failreview-fake', model: RUN_MODEL, agentId, isTask: true, messages: [{ role: 'user', content: text }] }, extra || {}))
  });
  A.eq(r.status, 200, 'the real /api/run stream opened for ' + agentId);
  const raw = await r.text();
  return raw.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// drive a run, then CANCEL it as soon as its runId shows on the event stream (the client-side stop button path).
async function driveCancelledRun(fixture, agentId, text) {
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-or-v1-failreview-fake', model: RUN_MODEL, agentId, isTask: true, messages: [{ role: 'user', content: text }] })
  });
  A.eq(r.status, 200, 'the cancellable /api/run stream opened');
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let raw = '', cancelled = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (!cancelled) {
      const m = raw.match(/"runId"\s*:\s*"([^"]+)"/);
      if (m) {
        cancelled = true;
        await fixture.request('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m[1] }) });
      }
    }
  }
  return raw.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function endReason(events) {
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  return end && end.payload && end.payload.reason;
}

// wait for the fire-and-forget aux passes to settle: poll the recorded-call counter until stable.
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 12000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    if (state.calls.length !== last) { last = state.calls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 1500)) break;
    await sleep(200);
  }
}

(async () => {
  const mock = await startMock();
  // aux tier ON (routes the pass to the cheap model, per-request effort low) and governor UNLIMITED (budget 0)
  // so what fires — and what does NOT — is decided ONLY by the failure-review gate under test.
  const fixture = SidecarFixture.create({
    prefix: 'sk-failreview-',
    env: { SKYNET_OPENROUTER_BASE: mock.base, STARNET_AUX_MODEL: AUX_MODEL, SKYNET_AUX_BUDGET: '0', SKYNET_QUEST_REFRESH: '0', SKYNET_FULL_ACCESS: '1' }
  });
  // PROJECT TIER (arm 7): two blessed project roots, granted the way the projects rail grants them (the same
  // files project-root.e2e writes) so /api/run's projectRoot passes isBlessedRoot and rides into the run.
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-frproj-a-'));
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-frproj-b-'));
  {
    const gA = 'path:' + path.resolve(projA), gB = 'path:' + path.resolve(projB);
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: [gA, gB], meta: { [gA]: { grantedAt: 1 }, [gB]: { grantedAt: 1 } } }), 'utf8');
    fs.writeFileSync(path.join(fixture.workspace, 'projects.json'), JSON.stringify({ version: 1, projects: [
      { root: path.resolve(projA), displayPath: projA, grantedAt: 1, lastTouchedAt: 1, isGitRepo: false },
      { root: path.resolve(projB), displayPath: projB, grantedAt: 1, lastTouchedAt: 1, isGitRepo: false }
    ] }), 'utf8');
  }
  await fixture.start();
  try {
    const frCalls = () => mock.state.calls.filter(c => c.failReview);
    const reflCalls = () => mock.state.calls.filter(c => c.reflection);

    // ---- ARM 1 — a run ending 'error' fires EXACTLY ONE failure-review pass on the aux model ----------------
    {
      const ev = await driveRun(fixture, 'fr-hot', FAIL_MARK + ' inspect the station then push the registry update');
      A.eq(endReason(ev), 'error', 'the driven run really ended with reason error');
      await settle(mock.state);
      const fr = frCalls();
      A.eq(fr.length, 1, 'exactly ONE failure-review pass fired for the failed run');
      A.eq(fr[0].model, AUX_MODEL, 'failure-review rode the configured aux model');
      A.eq(fr[0].reasoning && fr[0].reasoning.effort, 'low', 'failure-review carried per-request reasoning effort low (aux tier)');
      A.eq(reflCalls().length, 0, 'NO done-gated pass (reflection) fired on the FAILED run');
      // the lesson landed as a real notebook record, origin-tagged, on the surface recall reads from
      const rec = await fixture.json('GET', '/api/memory/records?agent=fr-hot');
      A.eq(rec.status, 200, 'memory records served');
      const lessons = (rec.body.records || []).filter(r => r && r.origin === 'failure-review');
      A.eq(lessons.length, 1, 'ONE lesson record carries origin failure-review');
      A.ok(String(lessons[0].body || '').indexOf('Registry pushes rate-limit') === 0, 'the record holds the parsed lesson content');
      A.eq(lessons[0].kind, 'fact', 'the lesson is a notebook fact (never a skill — skillreview owns procedures)');
    }

    // ---- ARM 2 — a second failed run for the SAME agent inside the cooldown fires NOTHING -------------------
    //      …and — the compounding proof (memory-compound lane) — the lesson arm 1 wrote SURFACES in this next
    //      run's prompt: the MAIN call carries a <recalled-memory> fence holding the lesson text. Until this
    //      assertion existed the emitter→store→prompt seam was never proven end to end.
    {
      const before = frCalls().length, mainBefore = mock.state.calls.filter(c => c.main).length;
      const ev = await driveRun(fixture, 'fr-hot', FAIL_MARK + ' inspect the station then push the registry update again');
      A.eq(endReason(ev), 'error', 'the second run also ended error');
      await sleep(2500);
      A.eq(frCalls().length, before, 'the per-agent cooldown suppressed a second failure-review pass');
      const mains = mock.state.calls.filter(c => c.main).slice(mainBefore);
      A.ok(mains.length >= 1, 'the second run made at least one MAIN model call');
      A.ok(mains.every(c => c.recall.indexOf('Registry pushes rate-limit') >= 0), 'the lesson learned by run 1 was injected into the NEXT run prompt as a recalled-memory fence (' + JSON.stringify(mains[0].recall.slice(0, 200)) + ')');
    }

    // ---- ARM 3 — failureReviewEnabled=false suppresses the pass LIVE (the reflectEnabled pattern) -----------
    {
      const cfg0 = await fixture.json('GET', '/api/memory/config');
      A.eq(cfg0.body.failureReviewEnabled, true, 'failureReviewEnabled defaults ON');
      const set = await fixture.json('POST', '/api/memory/config', { failureReviewEnabled: false });
      A.eq(set.status, 200, 'config POST accepted');
      A.eq(set.body.failureReviewEnabled, false, 'the flag round-trips OFF through the config API');
      const before = frCalls().length;
      const ev = await driveRun(fixture, 'fr-off', FAIL_MARK + ' inspect the station then push the registry update');
      A.eq(endReason(ev), 'error', 'the disabled-arm run ended error');
      await sleep(2500);
      A.eq(frCalls().length, before, 'failureReviewEnabled=false fired NO failure-review pass');
      await fixture.json('POST', '/api/memory/config', { failureReviewEnabled: true });   // restore for the next arms
    }

    // ---- ARM 4 — the personalization PAUSE suppresses the pass (same server authority as the scout) ---------
    {
      const paused = await fixture.json('POST', '/api/personalization', { enabled: false });
      A.eq(paused.status, 200, 'personalization pause accepted');
      A.eq(paused.body.enabled, false, 'personalization reports paused');
      const before = frCalls().length;
      const ev = await driveRun(fixture, 'fr-paused', FAIL_MARK + ' inspect the station then push the registry update');
      A.eq(endReason(ev), 'error', 'the paused-arm run ended error');
      await sleep(2500);
      A.eq(frCalls().length, before, 'the personalization pause fired NO failure-review pass');
      // …and REFLECTION honours the same pause (memory-compound lane): a paused station learns nothing from a
      // 'done' run either — no aux call, no memory written.
      const beforeRefl = reflCalls().length;
      const evDone = await driveRun(fixture, 'fr-paused-done', GOOD_MARK + ' rebuild the staging deploy rollback path and write up what changed and why');
      A.eq(endReason(evDone), 'done', 'the paused-arm done run ended done');
      await sleep(2500);
      A.eq(reflCalls().length, beforeRefl, 'the personalization pause fired NO reflection pass on a done run');
      const recPaused = await fixture.json('GET', '/api/memory/records?agent=fr-paused-done');
      A.eq((recPaused.body.records || []).length, 0, 'a paused station wrote NO memory for the done run');
      await fixture.json('POST', '/api/personalization', { enabled: true });   // resume
    }

    // ---- ARM 5 — REGRESSION: a 'done' run reflects exactly as before and NEVER fires failure-review ---------
    {
      const beforeFr = frCalls().length, beforeRefl = reflCalls().length;
      const ev = await driveRun(fixture, 'fr-done', GOOD_MARK + ' rebuild the staging deploy rollback path and write up what changed and why');
      A.eq(endReason(ev), 'done', 'the clean run ended done');
      await settle(mock.state);
      A.eq(reflCalls().length - beforeRefl, 1, 'reflection still fires exactly once on a done run (no regression to the done-gated passes)');
      A.eq(reflCalls().slice(beforeRefl)[0].model, AUX_MODEL, 'reflection still rides the aux model');
      A.eq(frCalls().length, beforeFr, 'failure-review NEVER fires on reason done (mutually exclusive families)');
    }

    // ---- ARM 6 — a CANCELLED run fires NO failure-review pass -----------------------------------------------
    {
      const before = frCalls().length;
      const ev = await driveCancelledRun(fixture, 'fr-cancel', SLOW_MARK + ' inspect the station slowly');
      A.eq(endReason(ev), 'cancelled', 'the aborted run really ended cancelled');
      await sleep(2500);
      A.eq(frCalls().length, before, 'a cancelled run fired NO failure-review pass');
    }

    // ---- ARM 7 — PROJECT TIER: a lesson learned inside project A never reaches project B (or an unscoped run) --
    {
      const mainsSince = (n) => mock.state.calls.filter(c => c.main).slice(n);
      const before = frCalls().length;
      const evA = await driveRun(fixture, 'fr-proj', FAIL_MARK + ' inspect the station then push the registry update', { projectRoot: projA });
      A.eq(endReason(evA), 'error', 'the project-A run ended error');
      await settle(mock.state);
      A.eq(frCalls().length - before, 1, 'the project-A failure fired one failure-review pass');
      const rec = await fixture.json('GET', '/api/memory/records?agent=fr-proj');
      const lesson = (rec.body.records || []).find(r => r && r.origin === 'failure-review');
      A.ok(lesson, 'the lesson record landed');
      A.eq(lesson && lesson.scope, 'project', 'a lesson learned inside a blessed root is PROJECT-scoped');
      A.eq(lesson && path.resolve(String(lesson.projectRoot || '')).toLowerCase(), path.resolve(projA).toLowerCase(), 'the record is keyed to the project-A root');
      // project B: same agent, same lexical overlap — the lesson must NOT be injected
      let n = mock.state.calls.filter(c => c.main).length;
      const evB = await driveRun(fixture, 'fr-proj', FAIL_MARK + ' inspect the station then push the registry update again', { projectRoot: projB });
      A.eq(endReason(evB), 'error', 'the project-B probe run ended error (cooldown: no new lesson)');
      A.ok(mainsSince(n).length >= 1 && mainsSince(n).every(c => c.recall.indexOf('Registry pushes rate-limit') < 0), 'the project-B prompt carries NO project-A lesson');
      // unscoped run: the project tier stays inside its project
      n = mock.state.calls.filter(c => c.main).length;
      const evU = await driveRun(fixture, 'fr-proj', FAIL_MARK + ' inspect the station then push the registry update once more');
      A.eq(endReason(evU), 'error', 'the unscoped probe run ended error');
      A.ok(mainsSince(n).length >= 1 && mainsSince(n).every(c => c.recall.indexOf('Registry pushes rate-limit') < 0), 'an UNSCOPED run prompt carries NO project-A lesson');
      // back inside project A: the lesson surfaces
      n = mock.state.calls.filter(c => c.main).length;
      const evA2 = await driveRun(fixture, 'fr-proj', FAIL_MARK + ' inspect the station then push the registry update yet again', { projectRoot: projA });
      A.eq(endReason(evA2), 'error', 'the second project-A run ended error');
      A.ok(mainsSince(n).length >= 1 && mainsSince(n).every(c => c.recall.indexOf('Registry pushes rate-limit') >= 0), 'back in project A the lesson IS injected into the prompt');
      A.eq(frCalls().length - before, 1, 'still exactly one failure-review pass for fr-proj (cooldown held across the probes)');
    }

    // ---- ARM 8 — HYBRID RECALL: the embedding lane surfaces a lesson BM25 alone cannot -------------------------
    {
      const embedCalls = () => mock.state.calls.filter(c => c.embed);
      const mainsSince = (n) => mock.state.calls.filter(c => c.main).slice(n);
      // a task with ZERO lexical overlap with the lesson ("Registry pushes rate-limit after repeated attempts; batch
      // retries with exponential backoff before the next push") — no shared significant token.
      const PARAPHRASE = FAIL_MARK + ' inspect the station; our uploads to the package index keep getting throttled';
      const before = frCalls().length;
      const ev0 = await driveRun(fixture, 'fr-sem', FAIL_MARK + ' inspect the station then push the registry update');
      A.eq(endReason(ev0), 'error', 'the semantic-arm seed run ended error');
      await settle(mock.state);
      A.eq(frCalls().length - before, 1, 'the seed failure fired one failure-review pass (the lesson exists)');
      A.eq(embedCalls().length, 0, 'no embedding model configured -> NO embedding call was ever made (BM25 only, zero spend)');
      // probe 1 — lane OFF: BM25 finds nothing for the paraphrase
      let n = mock.state.calls.filter(c => c.main).length;
      const ev1 = await driveRun(fixture, 'fr-sem', PARAPHRASE);
      A.eq(endReason(ev1), 'error', 'probe 1 ended error (cooldown: no new lesson)');
      A.ok(mainsSince(n).length >= 1 && mainsSince(n).every(c => c.recall.indexOf('Registry pushes rate-limit') < 0), 'BM25 alone: the paraphrased task does NOT recall the lesson (the gap)');
      A.eq(embedCalls().length, 0, 'still no embedding call with the lane off');
      // turn the lane on through the persisted memory config (the same live-config seam as reflectEnabled)
      const cfg = await fixture.json('POST', '/api/memory/config', { embedModel: 'openai/text-embedding-3-small' });
      A.eq(cfg.status, 200, 'embedModel accepted');
      A.eq(cfg.body.embedModel, 'openai/text-embedding-3-small', 'embedModel round-trips');
      A.eq(cfg.body.embedEnabled, true, 'the config reports the lane as live (model named + personalization on)');
      const bad = await fixture.json('POST', '/api/memory/config', { embedProvider: 'not-a-provider' });
      A.eq(bad.status, 400, 'an unknown embedProvider is refused');
      // probe 2 — lane ON: the same paraphrase now recalls the lesson via the mock /embeddings wire
      n = mock.state.calls.filter(c => c.main).length;
      const ev2 = await driveRun(fixture, 'fr-sem', PARAPHRASE);
      A.eq(endReason(ev2), 'error', 'probe 2 ended error');
      A.ok(mainsSince(n).length >= 1 && mainsSince(n).every(c => c.recall.indexOf('Registry pushes rate-limit') >= 0), 'HYBRID: the paraphrased task DOES recall the lesson through the embedding lane (' + JSON.stringify((mainsSince(n)[0] || {}).recall || '').slice(0, 160) + ')');
      const ec = embedCalls();
      A.ok(ec.length >= 1 && ec.length <= 2, 'the lane made 1–2 bounded embedding calls (record backfill + query), got ' + ec.length);
      A.ok(ec.some(c => c.inputs.some(t => /Registry pushes rate-limit/.test(t))), 'the lesson text was embedded (record backfill)');
      A.ok(ec.some(c => c.inputs.some(t => /throttled/.test(t))), 'the query text was embedded');
      A.ok(ec.every(c => c.model === 'openai/text-embedding-3-small'), 'every embedding call rode the configured embed model');
      A.ok(fs.existsSync(path.join(fixture.workspace, 'fr-sem.embed.json')), 'the vectors persisted to the durable embed:<agent> sibling store');
      // probe 3 — vectors persisted + query cached: the SAME task recalls again with NO new embedding call
      const ecBefore = embedCalls().length;
      n = mock.state.calls.filter(c => c.main).length;
      const ev3 = await driveRun(fixture, 'fr-sem', PARAPHRASE);
      A.eq(endReason(ev3), 'error', 'probe 3 ended error');
      A.ok(mainsSince(n).length >= 1 && mainsSince(n).every(c => c.recall.indexOf('Registry pushes rate-limit') >= 0), 'the lesson still surfaces on a repeat');
      A.eq(embedCalls().length, ecBefore, 'a repeat made NO new embedding call (vectors on disk, query cached) — zero repeat spend');
      // the personalization PAUSE silences the lane: no embedding call at all while paused
      await fixture.json('POST', '/api/personalization', { enabled: false });
      const cfgPaused = await fixture.json('GET', '/api/memory/config');
      A.eq(cfgPaused.body.embedEnabled, false, 'while paused the config honestly reports the lane OFF');
      n = mock.state.calls.filter(c => c.main).length;
      const ev4 = await driveRun(fixture, 'fr-sem', FAIL_MARK + ' inspect the station; a brand new wording about the package index being slow');
      A.eq(endReason(ev4), 'error', 'the paused probe ended error');
      A.eq(embedCalls().length, ecBefore, 'PAUSED: no embedding call was made (the pause is server authority for the lane too)');
      await fixture.json('POST', '/api/personalization', { enabled: true });
      await fixture.json('POST', '/api/memory/config', { embedModel: '' });   // lane off again
      A.eq((await fixture.json('GET', '/api/memory/config')).body.embedEnabled, false, 'clearing embedModel turns the lane off');
    }
  } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} try { fs.rmSync(projA, { recursive: true, force: true }); fs.rmSync(projB, { recursive: true, force: true }); } catch (_) {} }

  A.report('failreview.e2e.test');
})().catch(e => { console.log('FAIL: failreview.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
