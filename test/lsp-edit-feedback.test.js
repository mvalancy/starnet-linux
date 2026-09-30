/* Deterministic end-to-end contract for the lazy LSP edit seam: a real stdio child speaks JSON-RPC,
   fs.edit captures baseline-before-write, and only the newly introduced diagnostic reaches the model/event. */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const A = require('./_assert.js');
const { makeLspManager } = require('../sidecar/lsp-manager.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-lsp-edit-'));
  const workspace = path.join(root, 'a1');
  fs.mkdirSync(workspace, { recursive: true });
  const fixture = path.join(__dirname, 'fixtures', 'fake-lsp-server.js');
  const env = Object.assign({}, process.env, { STARNET_TEST_SECRET: 'must-not-reach-child' });
  const ledgerRows = [], ledgerReleases = [];
  const ledger = { record: row => ledgerRows.push(row), pinIdentity: async () => 1, release: pid => ledgerReleases.push(pid) };
  const manager = makeLspManager({
    spawn, fs, fsp, pathMod: path, env, ledger,
    servers: [{ id: 'fake', command: process.execPath, args: [fixture], extensions: ['.fake'], languageIds: { '.fake': 'fake' } }],
    limits: { requestTimeoutMs: 2000, diagnosticTimeoutMs: 1000, idleMs: 500 }
  });
  const tools = makeFsTools({ fsp, pathMod: path, root, editDiagnostics: manager });
  const events = [];
  const ctx = { agentId: 'a1', runId: 'r1', emit: (name, payload) => events.push({ name, payload }) };

  try {
    const Client = manager._internals.Client;
    const probe = new Client({ id: 'probe', args: [] }, 'probe', workspace);
    const uri = 'file:///versioned.fake';
    let staleResolved = false;
    const versioned = probe.waitForDiagnostics(uri, null, () => {}, 2).then(value => { staleResolved = true; return value; });
    probe.onMessage({ method: 'textDocument/publishDiagnostics', params: { uri, version: 1, diagnostics: [{ message: 'stale v1' }] } });
    await Promise.resolve();
    A.eq(staleResolved, false, 'a stale diagnostic version does not confirm the current edit');
    probe.onMessage({ method: 'textDocument/publishDiagnostics', params: { uri, version: 2, diagnostics: [{ message: 'current v2' }] } });
    A.eq((await versioned).diagnostics[0].message, 'current v2', 'the matching diagnostic version confirms the edit');
    const versionless = probe.waitForDiagnostics(uri, null, () => {}, 3);
    probe.onMessage({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ message: 'versionless' }] } });
    A.eq((await versionless).confirmed, true, 'a genuinely versionless server remains supported');

    const delayedUri = 'file:///delayed.fake';
    const delayed = probe.waitForDiagnostics(delayedUri, null, () => {}, 1);
    probe.touch();
    await new Promise(resolve => setTimeout(resolve, 650));
    A.eq(probe.dead, false, 'idle reaping cannot close a server while diagnostics are in flight');
    probe.onMessage({ method: 'textDocument/publishDiagnostics', params: { uri: delayedUri, version: 1, diagnostics: [] } });
    A.eq((await delayed).confirmed, true, 'a delayed diagnostic still confirms before its own timeout');

    const source = path.join(workspace, 'main.fake');
    fs.writeFileSync(source, 'OLD\nclean\n', 'utf8');
    await tools.readTool.run({ path: 'main.fake' }, ctx);   // fs.edit requires the file to have been observed this session
    const first = await tools.editTool.run({ path: 'main.fake', find: 'clean', replace: 'BROKEN' }, ctx);
    A.ok(first.diagnostics && first.diagnostics.status === 'available', 'a detected server confirms the edit delta');
    A.eq(first.diagnostics.addedCount, 1, 'only one newly introduced diagnostic is counted');
    A.eq(first.diagnostics.added[0].code, 'BROKEN', 'the new diagnostic is identified');
    A.ok(!first.content.includes('pre-existing problem'), 'pre-existing diagnostics do not reach the model result');
    A.ok(first.content.includes('newly introduced problem'), 'the newly introduced diagnostic reaches the model result');
    A.ok(!first.content.includes('SECRET_LEAK'), 'the language-server child receives no StarNet secret environment');
    const ev = events.find(e => e.name === 'verify.result');
    A.ok(ev && ev.payload.passed === false && ev.payload.added === 1, 'existing verify.result semantics carry the failed edit check');

    events.length = 0;
    const second = await tools.editTool.run({ path: 'main.fake', find: 'BROKEN', replace: 'clean again' }, ctx);
    A.eq(second.diagnostics.addedCount, 0, 'fixing the new problem introduces nothing');
    A.eq(second.diagnostics.removedCount, 1, 'the fixed diagnostic is counted separately');
    A.ok(second.content.includes('no new diagnostics'), 'the model sees a truthful clean delta, not a whole-project clean claim');
    A.ok(events.some(e => e.name === 'verify.result' && e.payload.passed === true), 'a confirmed zero-new delta emits passed:true');

    events.length = 0;
    const plain = await tools.writeTool.run({ path: 'notes.txt', content: 'plain text' }, ctx);
    A.eq(plain.diagnostics.status, 'unsupported', 'unsupported files report an honest unavailable state');
    A.ok(plain.content.includes('LSP unavailable'), 'the fallback tells the model to use project verification');
    A.ok(!events.some(e => e.name === 'verify.result'), 'unavailable diagnostics never emit a success-shaped verification event');

    const missing = makeLspManager({
      spawn, fs, fsp, pathMod: path, env,
      servers: [{ id: 'missing', command: 'definitely-not-a-real-starnet-lsp', args: [], extensions: ['.miss'], languageIds: { '.miss': 'missing' } }],
      limits: { diagnosticTimeoutMs: 200 }
    });
    const absent = await missing.beginEdit({ files: [{ abs: path.join(workspace, 'x.miss'), base: workspace, rel: 'x.miss', text: '' }] });
    const absentResult = await missing.finishEdit(absent);
    A.eq(absentResult.status, 'unavailable', 'an absent executable is not started or treated as a pass');
    A.ok(absentResult.reason.includes('not installed on PATH'), 'the unavailable reason names detection truth');
    await missing.closeAll();

    const retrySource = path.join(workspace, 'retry.fake');
    fs.writeFileSync(retrySource, 'clean\n', 'utf8');
    let spawnAttempts = 0;
    const retrying = makeLspManager({
      spawn: (...args) => {
        spawnAttempts++;
        if (spawnAttempts === 1) throw new Error('transient spawn failure');
        return spawn(...args);
      },
      fs, fsp, pathMod: path, env,
      servers: [{ id: 'fake-retry', command: process.execPath, args: [fixture], extensions: ['.fake'], languageIds: { '.fake': 'fake' } }],
      limits: { requestTimeoutMs: 2000, diagnosticTimeoutMs: 1000, idleMs: 500 }
    });
    const retryInput = { files: [{ abs: retrySource, base: workspace, rel: 'retry.fake', text: 'clean\n' }] };
    const failedStart = await retrying.beginEdit(retryInput);
    A.eq((await retrying.finishEdit(failedStart)).status, 'unavailable', 'a transient LSP spawn failure is reported honestly');
    const recoveredStart = await retrying.beginEdit(retryInput);
    A.eq(spawnAttempts, 2, 'the next edit retries a client whose first spawn threw');
    A.eq(recoveredStart.items.length, 1, 'the retried LSP client confirms a diagnostic baseline');
    await retrying.closeAll();

    // Make cancellation exercise a cold server, even on a fast host where idle reaping
    // has not fired while the unrelated retry checks above run.
    await new Promise(resolve => setTimeout(resolve, 1200));
    A.eq(manager.status().length, 0, 'an idle language server is reaped');
    const recordedBeforeCancel = ledgerRows.length;
    const cancelFile = path.join(workspace, 'cancel.fake');
    fs.writeFileSync(cancelFile, 'clean before cancel\n', 'utf8');
    await tools.readTool.run({ path: 'cancel.fake' }, ctx);
    const ac = new AbortController(); ac.abort();
    let cancelled = false;
    try {
      await tools.editTool.run({ path: 'cancel.fake', find: 'clean', replace: 'BROKEN' }, Object.assign({}, ctx, { signal: ac.signal }));
    } catch (e) { cancelled = !!(e && e.name === 'AbortError'); }
    A.ok(cancelled, 'cancellation during the diagnostic baseline aborts the file tool');
    A.eq(ledgerRows.length, recordedBeforeCancel, 'an already-cancelled edit never starts a replacement language server');
    A.eq(fs.readFileSync(cancelFile, 'utf8'), 'clean before cancel\n', 'a cancelled baseline never permits a late mutation');

    A.eq(manager.status().length, 0, 'an already-cancelled edit leaves no cached replacement client');
    A.eq(ledgerRows.length, 1, 'the long-lived language-server child is recorded for crash recovery');
    A.ok(ledgerRows[0].kind === 'lsp:fake' && ledgerReleases.includes(ledgerRows[0].pid), 'normal idle exit releases the durable process-ledger row');
  } finally {
    await manager.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
  A.report('lsp-edit-feedback.test');
})().catch(e => { console.log('FAIL: lsp-edit-feedback.test threw — ' + (e && e.stack || e)); process.exit(1); });
