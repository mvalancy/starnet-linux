/* node test/dispatch.fair-share.test.js — EVERY WORKER STAYS VISIBLE in an aggregated result.

   team.dispatch returned every worker's full text as ONE JSON array and the registry's per-result cap then cut
   that string head+tail. Probed on 29bb21d80 with 4 workers x 30k characters: worker 3's row — its agentId, its
   status, everything — was simply missing from what the lead saw. The fit now happens inside the tool, row-aware:
   every row keeps its identity/status fields, each text gets a fair (water-filled) share of the budget as head +
   tail, and each shortened text is saved WHOLE to a per-worker file whose path the row names.

   Driven against a fake runOnce (no key, no network) and the REAL host parker (output-artifacts.js) on a temp
   workspace, so "the spill file exists and holds the full text" is checked on disk. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makeOrchestrationTools, fitAggregate } = require('../sidecar/tools/builtin/orchestration.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');
const { makeRegistry, outputBudgetFor } = require('../sidecar/tools/registry.js');
const { makeOutputArtifacts } = require('../sidecar/output-artifacts.js');

const WORKERS = ['researcher', 'analyst', 'scout', 'scribe'];
const headOf = (id) => 'BEGIN-' + id + '-VERDICT:';
const tailOf = (id) => ':FINAL-' + id + '-CONCLUSION';
const textFor = (id, n) => headOf(id) + ('<' + id + '> ').repeat(Math.ceil(n / (id.length + 3))).slice(0, n - headOf(id).length - tailOf(id).length) + tailOf(id);
const counter = () => { let n = 0; return () => 'child_' + (++n); };
const tick = () => new Promise(resolve => setImmediate(resolve));

// the host parker exactly as index.js wires it (capCtx.parkOutput): the lead's own workspace, .output/<stem>.txt
function hostParker(root, agentId) {
  const arts = makeOutputArtifacts({ fsp: fs.promises, fs, pathMod: path, root, crypto });
  let seq = 0;
  const calls = [];
  const parkOutput = async (content, meta) => {
    const safeTool = String((meta && meta.tool) || 'tool').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
    calls.push(meta);
    return arts.park(agentId, safeTool + '-run1-' + (seq++), content);
  };
  return { parkOutput, calls, read: (rel) => fs.readFileSync(path.join(root, agentId, rel), 'utf8') };
}
function crew(ids) { return new Map(ids.map(id => [id, { system: id.toUpperCase() + '-SYS' }])); }
function bigRunOnce(size) {
  return async (o) => ({ reason: 'done', messages: [{ role: 'assistant', content: textFor(o.agentId, typeof size === 'function' ? size(o.agentId) : size) }], usd: 0.1, runId: o.runId });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-fair-share-'));
  try {
    // ---- 1. THE AUDIT PROBE: 4 workers x 30k, default (80k) budget ----
    {
      const park = hostParker(root, 'lead');
      const { dispatchTool } = makeOrchestrationTools({ runOnce: bigRunOnce(30000), roster: () => crew(WORKERS), key: 'k', model: 'm', newId: counter() });
      const out = await dispatchTool.run({ workers: WORKERS.map(id => ({ agentId: id, prompt: 'part of the job: ' + id })) }, { agentId: 'lead', emit: () => {}, parkOutput: park.parkOutput });
      A.ok(out.content.length <= 80000, 'the aggregated result fits the 80k budget ITSELF (' + out.content.length + '), so the registry never head/tail-cuts it');
      const rows = JSON.parse(out.content);
      A.eq(rows.map(r => r.agentId), WORKERS, 'EVERY worker row is present, in order — worker 3 (scout) no longer vanishes');
      A.ok(rows.every(r => r.reason === 'done' && r.runId && typeof r.usd === 'number'), 'every row keeps its status/verdict fields (reason, runId, usd)');
      for (const r of rows) {
        A.ok(r.result.startsWith(headOf(r.agentId)), r.agentId + ': the HEAD of its text is visible');
        A.ok(r.result.endsWith(tailOf(r.agentId)), r.agentId + ': the TAIL (its conclusion) is visible');
        A.eq([r.resultTruncated, r.resultChars], [true, 30000], r.agentId + ': the row says it was shortened and how long the full text is');
        A.ok(typeof r.resultPath === 'string' && r.result.indexOf(r.resultPath) >= 0, r.agentId + ': the marker names the spill file');
        A.eq(park.read(r.resultPath), textFor(r.agentId, 30000), r.agentId + ': the spill file on disk holds the WHOLE text');
        A.ok(r.result.length > 15000, r.agentId + ': a fair share (~1/4 of the budget), not a sliver (' + r.result.length + ')');
      }
      A.eq(new Set(rows.map(r => r.resultPath)).size, 4, 'one spill file PER worker');
      A.ok(park.calls.every(m => /^team\.dispatch-/.test(m.tool)), 'spill files are named for the tool and the worker');
      A.ok(/4 result\(s\) shortened to fit \(4 saved in full/.test(out.summary), 'the summary says what was shortened: ' + out.summary);
    }

    // ---- 2. THROUGH THE REGISTRY on a 32k window: the tool fits the SAME window-scaled budget it is held to ----
    {
      const park = hostParker(root, 'lead2');
      const { dispatchTool } = makeOrchestrationTools({ runOnce: bigRunOnce(30000), roster: () => crew(WORKERS), key: 'k', model: 'm', newId: counter() });
      const reg = makeRegistry();
      reg.register(dispatchTool);
      const cap = outputBudgetFor(32768).resultMax;
      const r = await reg.dispatch({ id: 'd1', name: 'team.dispatch', args: { workers: WORKERS.map(id => ({ agentId: id, prompt: 'p ' + id })) } },
        { agentId: 'lead2', emit: () => {}, canUse: () => ({ ok: true }), outputMax: () => cap, parkOutput: park.parkOutput });
      A.ok(r.ok, 'the dispatch succeeds through the registry');
      A.ok(r.content.length <= cap, 'the result is within the 32k window\'s 15% budget (' + r.content.length + ' <= ' + cap + ')');
      A.eq(r.parkedPath, null, 'the registry had nothing to cut or park — the tool already fit itself');
      const rows = JSON.parse(r.content);
      A.eq(rows.map(x => x.agentId), WORKERS, 'all four workers are visible on a small window too');
      A.ok(rows.every(x => x.result.startsWith(headOf(x.agentId)) && x.result.endsWith(tailOf(x.agentId))), 'each keeps head and tail');
      A.ok(rows.every(x => park.read(x.resultPath) === textFor(x.agentId, 30000)), 'each full text is on disk');
    }

    // ---- 3. WATER-FILL: a short answer keeps ALL of its text; the long ones share the rest ----
    {
      const park = hostParker(root, 'lead3');
      const size = (id) => id === 'analyst' ? 600 : 40000;
      const { dispatchTool } = makeOrchestrationTools({ runOnce: bigRunOnce(size), roster: () => crew(WORKERS), key: 'k', model: 'm', newId: counter() });
      const out = await dispatchTool.run({ workers: WORKERS.map(id => ({ agentId: id, prompt: 'p ' + id })) }, { agentId: 'lead3', emit: () => {}, parkOutput: park.parkOutput });
      const rows = JSON.parse(out.content);
      const analyst = rows.find(r => r.agentId === 'analyst');
      A.eq(analyst.result, textFor('analyst', 600), 'the short result is passed through WHOLE');
      A.ok(!('resultTruncated' in analyst) && !('resultPath' in analyst), 'and carries no truncation fields (additive only where something was cut)');
      A.eq(park.calls.length, 3, 'only the three shortened texts were spilled');
    }

    // ---- 4. NO PARKER: rows are still all there, and the marker says plainly the text was NOT saved ----
    {
      const { dispatchTool } = makeOrchestrationTools({ runOnce: bigRunOnce(30000), roster: () => crew(WORKERS), key: 'k', model: 'm', newId: counter() });
      const out = await dispatchTool.run({ workers: WORKERS.map(id => ({ agentId: id, prompt: 'p ' + id })) }, { agentId: 'lead', emit: () => {} });
      const rows = JSON.parse(out.content);
      A.eq(rows.length, 4, 'all rows present without a parker');
      A.ok(rows.every(r => r.resultPath === null && /could NOT be saved/.test(r.result)), 'each shortened row admits its text was not saved');
      A.ok(/0 saved in full/.test(out.summary), 'and the summary does not claim a save');
    }

    // ---- 5. A RESULT THAT FITS IS BYTE-IDENTICAL to before ----
    {
      const { dispatchTool } = makeOrchestrationTools({ runOnce: bigRunOnce(500), roster: () => crew(WORKERS), key: 'k', model: 'm', newId: counter() });
      const out = await dispatchTool.run({ workers: WORKERS.map(id => ({ agentId: id, prompt: 'p ' + id })) }, { agentId: 'lead', emit: () => {} });
      const rows = JSON.parse(out.content);
      A.ok(rows.every(r => r.result === textFor(r.agentId, 500) && !('resultTruncated' in r)), 'small results pass through untouched');
      A.ok(!/shortened/.test(out.summary), 'and the summary is the old one');
    }

    // ---- 6. team.spawn (foreground) and team.subagents (list) aggregate the same way ----
    {
      const park = hostParker(root, 'lead4');
      const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
      const ro = async (o) => ({ reason: 'done', messages: [{ role: 'assistant', content: textFor(o.agentId.slice(0, 12), 30000) }], usd: 0.1 });
      const { spawnTool, dispatchTool, subagentsTool } = makeOrchestrationTools({ runOnce: ro, roster: () => crew(WORKERS), key: 'k', model: 'm', newId: counter(), subagents });
      const out = await spawnTool.run({ tasks: [0, 1, 2, 3].map(i => ({ prompt: 'slice ' + i, label: 'slice-' + i })) }, { agentId: 'lead4', emit: () => {}, parkOutput: park.parkOutput });
      A.ok(out.content.length <= 80000, 'team.spawn\'s aggregated result fits its budget (' + out.content.length + ')');
      const rows = JSON.parse(out.content);
      A.eq(rows.map(r => r.label), ['slice-0', 'slice-1', 'slice-2', 'slice-3'], 'every spawned subagent row is present');
      A.ok(rows.every(r => r.agentId && r.reason === 'done' && r.resultTruncated && r.resultPath), 'each keeps identity + status and names its spill file');
      A.ok(rows.every(r => r.result.endsWith(tailOf(r.agentId.slice(0, 12)))), 'each keeps its tail');

      // background workers -> the durable list the lead inspects with team.subagents
      await dispatchTool.run({ workers: WORKERS.map(id => ({ agentId: id, prompt: 'bg ' + id })), background: true }, { agentId: 'lead4', emit: () => {} });
      for (let i = 0; i < 6; i++) await tick();
      const listed = await subagentsTool.run({}, { agentId: 'lead4', parkOutput: park.parkOutput });
      A.ok(listed.content.length <= 80000, 'team.subagents fits its budget with 8 large records (' + listed.content.length + ')');
      const recs = JSON.parse(listed.content);
      A.eq(recs.length, 8, 'every background record is listed (4 spawned + 4 dispatched)');
      A.ok(recs.every(r => r.id && r.status && r.agentId), 'each keeps id/status/agentId');
      A.ok(recs.filter(r => r.resultTruncated).every(r => r.resultPath && park.read(r.resultPath).length === r.resultChars), 'each shortened record\'s full text is on disk');

      // POLLING is idempotent: the same unchanged records re-listed write no new park files and name the same paths
      const parkedBefore = park.calls.length;
      const filesBefore = fs.readdirSync(path.join(root, 'lead4', '.output')).length;
      const again = JSON.parse((await subagentsTool.run({}, { agentId: 'lead4', parkOutput: park.parkOutput })).content);
      const third = JSON.parse((await subagentsTool.run({}, { agentId: 'lead4', parkOutput: park.parkOutput })).content);
      A.eq(park.calls.length, parkedBefore, 'two more team.subagents polls parked nothing new');
      A.eq(fs.readdirSync(path.join(root, 'lead4', '.output')).length, filesBefore, 'and wrote no new .output files');
      A.eq(again.map(r => r.resultPath), recs.map(r => r.resultPath), 'the re-listed rows name the files already saved');
      A.eq(third.map(r => r.resultPath), recs.map(r => r.resultPath), 'on every poll');
      // a DIFFERENT run's parker (a new capCtx.parkOutput) does not inherit another run's memo
      const park2 = hostParker(root, 'lead4');
      await subagentsTool.run({}, { agentId: 'lead4', parkOutput: park2.parkOutput });
      A.ok(park2.calls.length > 0, 'a new run parks its own copies');
    }

    // ---- 7. fitAggregate directly: heavy metadata is compacted (and says so) before identity can be crowded out ----
    {
      const rows = WORKERS.map(id => ({ agentId: id, reason: 'done', result: textFor(id, 5000), artifacts: Array.from({ length: 40 }, (_, i) => ({ path: 'out/' + id + '/file-' + i + '.txt', bytes: 1000 + i })), validation: { state: 'valid', attempts: [{ ok: true, errors: Array.from({ length: 20 }, (_, i) => 'e'.repeat(40) + i) }] } }));
      const fit = await fitAggregate(rows, { budget: 8000, what: r => r.agentId });
      const s = JSON.stringify(fit.rows);
      A.ok(s.length <= 8000, 'a tiny budget with heavy metadata still fits (' + s.length + ')');
      A.eq(fit.rows.map(r => r.agentId), WORKERS, 'identity survives compaction');
      A.ok(fit.rows.every(r => r.artifactsOmitted === 32 && r.artifacts.length === 8), 'long artifact lists are trimmed and COUNT what they dropped');
      A.ok(fit.rows.every(r => r.validation && r.validation.state === 'valid' && !r.validation.attempts), 'validation keeps its verdict');
      A.eq(rows[0].artifacts.length, 40, 'the caller\'s rows are never mutated');
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('dispatch.fair-share.test');
})().catch(e => { console.log('FAIL: dispatch.fair-share.test threw -- ' + (e && e.stack || e)); process.exit(1); });
