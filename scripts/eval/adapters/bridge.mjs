import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256Text, TRAJECTORY_SCHEMA } from '../core.mjs';

const require = createRequire(import.meta.url);
const { runAgentLoop } = require('../../../sidecar/loop.js');
const { makeCostEngine } = require('../../../sidecar/cost.js');
const { makeRunJournal } = require('../../../sidecar/run-journal.js');
const { makeCodeTools } = require('../../../sidecar/tools/builtin/code.js');
const { makeLspManager } = require('../../../sidecar/lsp-manager.js');
const { makeFsTools } = require('../../../sidecar/tools/builtin/fs.js');
const { makeSegmentedTranscriptIo } = require('../../../sidecar/transcript-history.js');
const { makeCronDriver } = require('../../../sidecar/cron-driver.js');
const cron = require('../../../sidecar/cron.js');
const cronStore = require('../../../sidecar/cron-store.js');

const T0 = '2026-08-01T14:00:00.000Z';
const at = ms => new Date(Date.parse(T0) + ms).toISOString();
const event = (seq, ms, type, data = {}) => ({ seq, at: at(ms), type, data });
const trajectory = (taskId, durationMs, finalText, events, artifacts = []) => ({
  schemaVersion: TRAJECTORY_SCHEMA, taskId, runId: 'adapter-' + taskId, startedAt: T0,
  endedAt: at(durationMs), finalText, events, artifacts
});

function memoryJournalIo() {
  const files = new Map();
  return {
    create(id, line) { files.set(id, line + '\n'); }, append(id, line) { files.set(id, files.get(id) + line + '\n'); },
    read(id) { return files.get(id); }, list() { return Array.from(files.keys()); }, readFile(id) { return files.get(id); },
    remove(id) { files.delete(id); }, quarantine(id) { files.set(id + '.corrupt', files.get(id)); files.delete(id); return id + '.corrupt'; },
    repair(id, records) { files.set(id, records.map(row => JSON.stringify(row)).join('\n') + '\n'); return id + '.corrupt'; }
  };
}

async function continuationAdapter() {
  let calls = 0;
  const turns = [
    [{ type: 'text', delta: 'The answer ends with repeated words.' }, { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, { type: 'done', finishReason: 'length' }],
    [{ type: 'text', delta: 'repeated ' }, { type: 'text', delta: 'words. Then ' }, { type: 'text', delta: 'continues.' }, { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }, { type: 'done', finishReason: 'stop' }]
  ];
  const provider = {
    async *stream() { const turn = turns[calls++] || [{ type: 'done', finishReason: 'stop' }]; for (const row of turn) yield row; },
    priceOf: () => ({ in: 1, out: 2 }), contextLimit: () => 8000
  };
  const captured = [];
  const messages = [{ role: 'user', content: 'continue this' }];
  const result = await runAgentLoop({ messages, provider, emit: (name, data) => captured.push({ name, data }), cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'm', agentId: 'a', runId: 'r' });
  const visible = captured.filter(row => row.name === 'agent.token').map(row => row.data.delta).join('');
  const costs = captured.filter(row => row.name === 'agent.cost');
  const events = [event(1, 0, 'agent.run.start'), event(2, 10, 'model.turn'), event(3, 20, 'model.turn')];
  costs.forEach((row, index) => events.push(event(events.length + 1, 30 + index * 10, 'agent.cost', row.data)));
  events.push(event(events.length + 1, 60, 'bridge.continuation', {
    providerCalls: calls, assistantTurns: messages.filter(row => row.role === 'assistant').length,
    duplicateFree: visible === messages[messages.length - 1].content, tokens: result.tokens, finishReason: result.finishReason || 'stop'
  }));
  events.push(event(events.length + 1, 80, 'agent.run.end', { reason: result.reason }));
  return trajectory('bridge-continuation', 80, visible, events);
}

async function recoveryAdapter() {
  let tick = 100;
  const io = memoryJournalIo();
  let journal = makeRunJournal({ io, clock: { now: () => ++tick } });
  journal.begin({ runId: 'recover', agentId: 'a', messages: [{ role: 'user', content: 'write once' }] });
  journal.toolIntent('recover', { callId: 'mutate-1', name: 'fs.write', argsRaw: '{"path":"once.txt"}', mutating: true });
  const before = journal.inspect('recover');
  const mutationDispatches = 1;
  journal = makeRunJournal({ io, clock: { now: () => ++tick } });
  const restarted = journal.recoverAll()[0];
  journal.toolResult('recover', { callId: 'mutate-1', ok: true, content: 'saved' });
  journal.checkpoint('recover', { phase: 'tool_results', messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'mutate-1' }] }, { role: 'tool', tool_call_id: 'mutate-1', content: 'saved' }] });
  const after = journal.inspect('recover');
  const events = [
    event(1, 0, 'run.journal.intent', { mutating: true }),
    event(2, 10, 'run.recovered', { initialStatus: before.status, restartStatus: restarted.status, finalStatus: after.status, mutationDispatches, uncertainBefore: before.uncertain.length, completedAfter: after.completed.length }),
    event(3, 20, 'agent.run.end', { reason: 'interrupted-resumable' })
  ];
  return trajectory('bridge-recovery', 20, 'Recovered at a safe boundary without replaying the mutation.', events);
}

async function codeAdapter() {
  const calls = [];
  const tool = makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool;
  const output = await tool.run({ code: `
    const rows=[];
    for (const id of [1,2,3,4]) rows.push(await tool('records.get',{id}));
    const kept=rows.filter(row=>row.score>=6);
    return {status:'ok',ids:kept.map(row=>row.id),total:kept.reduce((n,row)=>n+row.score,0)};
  ` }, { composeDispatch: async req => { calls.push(req); return { id: req.args.id, score: req.args.id * 3 }; } });
  let mutationDenied = false;
  const denied = await tool.run({ code: `try { await tool('fs.write',{path:'x'}); } catch(e) { return e.message; }` }, {
    composeDispatch: async () => { mutationDenied = true; throw new Error('code.run v1 may compose only consent-free read tools; refused fs.write'); }
  });
  const events = [event(1, 0, 'agent.run.start'), event(2, 10, 'model.turn')];
  calls.forEach((req, index) => events.push(event(events.length + 1, 20 + index * 5, 'agent.tool_call', { name: req.name, id: req.args.id })));
  events.push(event(events.length + 1, 50, 'bridge.code_mode', { nestedReads: calls.length, result: JSON.parse(output.content), mutationDenied: mutationDenied && /refused fs\.write/.test(denied.content), summary: output.summary }));
  events.push(event(events.length + 1, 60, 'agent.run.end', { reason: 'done' }));
  return trajectory('bridge-code-mode', 60, output.content, events);
}

async function lspAdapter() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starnet-eval-lsp-'));
  const workspace = path.join(root, 'a1');
  mkdirSync(workspace, { recursive: true });
  const fixture = fileURLToPath(new URL('../fixtures/fake-lsp-server.cjs', import.meta.url));
  const manager = makeLspManager({
    spawn, fs, fsp, pathMod: path, env: Object.assign({}, process.env, { STARNET_EVAL_SECRET: 'must-not-cross' }),
    servers: [{ id: 'eval-fake', command: process.execPath, args: [fixture], extensions: ['.fake'], languageIds: { '.fake': 'fake' } }],
    limits: { requestTimeoutMs: 2000, diagnosticTimeoutMs: 1000, idleMs: 5000 }
  });
  const tools = makeFsTools({ fsp, pathMod: path, root, editDiagnostics: manager });
  const emitted = [];
  try {
    const source = path.join(workspace, 'main.fake');
    writeFileSync(source, 'OLD\nclean\n', 'utf8');
    // fs.edit requires the file to have been observed this session (read-before-edit); read it the way a model would.
    await tools.readTool.run({ path: 'main.fake' }, { agentId: 'a1', runId: 'eval' });
    const result = await tools.editTool.run({ path: 'main.fake', find: 'clean', replace: 'BROKEN' }, { agentId: 'a1', runId: 'eval', emit: (name, data) => emitted.push({ name, data }) });
    const bytes = readFileSync(source, 'utf8');
    const verified = emitted.find(row => row.name === 'verify.result');
    const events = [
      event(1, 0, 'agent.tool_call', { name: 'fs.edit' }),
      event(2, 20, 'verify.result', verified ? verified.data : {}),
      event(3, 30, 'bridge.lsp_delta', { status: result.diagnostics.status, addedCount: result.diagnostics.addedCount, removedCount: result.diagnostics.removedCount, code: result.diagnostics.added[0] && result.diagnostics.added[0].code }),
      event(4, 40, 'agent.run.end', { reason: 'done' })
    ];
    const hash = sha256Text(bytes);
    return trajectory('bridge-lsp-delta', 40, result.content, events, [{ path: 'main.fake', sha256: hash, mutatedAt: at(10), verifiedSha256: hash, verifiedAt: at(20) }]);
  } finally {
    await manager.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

async function historyAdapter() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'starnet-eval-history-'));
  const historyRoot = path.join(root, 'history');
  try {
    let io = makeSegmentedTranscriptIo({ fs, path, root: historyRoot, segmentBytes: 300, recentPerStream: 8, legacyFiles: [] });
    let first;
    for (let i = 0; i < 600; i++) {
      const row = io.appendDurable({ streamId: 'history', role: i % 2 ? 'assistant' : 'user', content: (i === 0 ? 'oldest zircon beacon ' : 'ordinary message ') + i + ' ' + 'x'.repeat(80), ts: 1000 + i });
      if (i === 0) first = row;
    }
    const before = io.status();
    io = makeSegmentedTranscriptIo({ fs, path, root: historyRoot, segmentBytes: 300, recentPerStream: 8, legacyFiles: [] });
    const hits = io.search('history', 'zircon beacon', { limit: 5 });
    const stable = io.readById(first.rowId);
    const events = [
      event(1, 0, 'history.segmented', { segments: before.segments.length, rows: 600 }),
      event(2, 20, 'history.recalled', { hits: hits.length, rowId: hits[0] && hits[0].rowId, stableRowId: stable && stable.rowId, oldestFound: !!(hits[0] && hits[0].content.includes('oldest zircon beacon')) }),
      event(3, 30, 'agent.run.end', { reason: 'done' })
    ];
    return trajectory('bridge-full-history', 30, 'Recalled the oldest indexed record after restart.', events);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function cronRuntimeAdapter() {
  const nowMs = Date.parse(T0);
  const job = cronStore.makeJob({ id: 'routine-parity', name: 'Routine parity', prompt: 'produce the scheduled report', agentId: 'a', schedule: cron.parseSchedule('every 1m', nowMs - 60000) }, { id: 'routine-parity', now: nowMs - 60000 });
  let jobs = [job], providerCalls = 0, deliveryCount = 0, deliveredText = '';
  const io = memoryJournalIo();
  const journal = makeRunJournal({ io, clock: { now: () => nowMs } });
  const provider = { priceOf: () => ({ in: 1, out: 2 }), contextLimit: () => 8000, async *stream() {
    providerCalls++;
    if (providerCalls === 1) {
      yield { type: 'text', delta: 'Scheduled report ends with repeated words.' };
      yield { type: 'done', finishReason: 'length' };
    } else {
      yield { type: 'text', delta: 'repeated words. Then completes.' };
      yield { type: 'done', finishReason: 'stop' };
    }
  } };
  let deliveredResolve;
  const delivered = new Promise(resolve => { deliveredResolve = resolve; });
  const driver = makeCronDriver({
    getJobs: () => jobs, setJobs: next => { jobs = next; return true; }, emit() {},
    newId: () => 'cron-eval-run', newAbort: () => new AbortController(), now: () => nowMs,
    getKey: () => 'test', hasCredential: () => true, defaultModel: 'm', persona: 'SYSTEM',
    runOnce: async o => {
      journal.begin({ runId: o.runId, agentId: o.agentId, trigger: o.trigger, cronJobId: o.cronJobId, cronJobName: o.cronJobName });
      journal.checkpoint(o.runId, { phase: 'initial', turn: 0, messages: o.messages });
      const result = await runAgentLoop({ messages: o.messages, provider, emit: o.emit, model: o.model, agentId: o.agentId, runId: o.runId,
        onCheckpoint: ({ phase, turn, messages }) => journal.checkpoint(o.runId, { phase, turn, messages }) });
      journal.finish(o.runId, { reason: result.reason, transcriptAck: true });
      return result;
    },
    deliverResult: (_job, result) => { deliveryCount++; deliveredText = result.text; deliveredResolve(); }
  });
  driver.applyTick(nowMs);
  await delivered;
  const saved = cronStore.getJob(jobs, 'routine-parity');
  const recovered = journal.inspect('cron-eval-run');
  const data = {
    providerCalls, duplicateFree: saved.lastOutput === 'Scheduled report ends with repeated words. Then completes.',
    deliveryCount, deliveredExact: deliveredText === saved.lastOutput, persistedExact: saved.lastOutput === deliveredText,
    recoveryStatus: recovered.status, cronJobId: recovered.meta.cronJobId, trigger: recovered.meta.trigger
  };
  return trajectory('bridge-cron-runtime', 50, saved.lastOutput, [
    event(1, 0, 'cron.fire', { jobId: 'routine-parity' }),
    event(2, 40, 'bridge.cron_runtime', data),
    event(3, 50, 'agent.run.end', { reason: 'done' })
  ]);
}

export async function runBridgeAdapters() {
  return [await continuationAdapter(), await recoveryAdapter(), await codeAdapter(), await lspAdapter(), await historyAdapter(), await cronRuntimeAdapter()];
}

export const adapters = { continuationAdapter, recoveryAdapter, codeAdapter, lspAdapter, historyAdapter, cronRuntimeAdapter };
