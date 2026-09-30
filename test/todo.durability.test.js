/* node test/todo.durability.test.js - durable todo storage regression.

   Guards the StarNet goal 5-6 bug: todo:<agent> keys must not be treated as unsupported notebook keys
   and swallowed by the host store. The todo tool writes through the same injected memory store as notebook,
   but persists to its own sibling file so task plans survive restart and compaction. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const { makeMemoryStore, memoryFileFor, resetAgentMemory, restoreDeclined, appendPending, takePending, listPending, findPending, PENDING_CAP } = require('../sidecar/memory-store.js');
const { makeTodoTool, formatForInjection } = require('../sidecar/tools/builtin/todo.js');

function memFs() {
  const files = new Map();
  const fds = new Map();
  let nextFd = 10;
  const stats = { fsync: 0, rename: 0 };
  return {
    files, stats,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); stats.rename++; },
    mkdirSync() {},
    openSync(p, flags) {
      const fd = nextFd++;
      if (flags === 'r') {
        if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
        fds.set(fd, { path: p, buf: files.get(p), read: true });
      } else {
        fds.set(fd, { path: p, buf: '' });
        files.set(p, '');
      }
      return fd;
    },
    writeSync(fd, data) { const h = fds.get(fd); h.buf += String(data); files.set(h.path, h.buf); },
    fsyncSync() { stats.fsync++; },
    closeSync(fd) { fds.delete(fd); }
  };
}

(async () => {
  const ROOT = '/ws';

  A.eq(memoryFileFor(ROOT, path, 'notebook:hero'), path.join(ROOT, 'hero.notebook.json'), 'notebook keys map to notebook sibling files');
  A.eq(memoryFileFor(ROOT, path, 'todo:hero'), path.join(ROOT, 'hero.todo.json'), 'todo keys map to todo sibling files');
  A.eq(memoryFileFor(ROOT, path, 'declined:hero'), path.join(ROOT, 'hero.declined.json'), 'declined keys map to declined sibling files');
  A.eq(memoryFileFor(ROOT, path, 'minted:hero'), path.join(ROOT, 'hero.minted.json'), 'minted keys map to minted sibling files (W6 mint ledger)');
  A.eq(memoryFileFor(ROOT, path, 'embed:hero'), path.join(ROOT, 'hero.embed.json'), 'embed keys map to embed sibling files (hybrid recall vectors)');
  A.throws(() => memoryFileFor(ROOT, path, 'embed:../bad'), 'invalid embed agent ids are rejected');
  A.throws(() => memoryFileFor(ROOT, path, 'todo:../bad'), 'invalid todo agent ids are rejected');
  A.throws(() => memoryFileFor(ROOT, path, 'declined:../bad'), 'invalid declined agent ids are rejected');
  A.throws(() => memoryFileFor(ROOT, path, 'minted:../bad'), 'invalid minted agent ids are rejected');
  A.throws(() => memoryFileFor(ROOT, path, 'other:hero'), 'unknown memory keys are rejected');

  const fs = memFs();
  const store = makeMemoryStore({ fs, path, workspaces: ROOT });
  const { todoTool } = makeTodoTool({ store });

  const write = await todoTool.run({ todos: [
    { id: 'a', content: 'audit current todo behavior', status: 'completed' },
    { id: 'b', content: 'persist todo list durably', status: 'in_progress' },
    { id: 'c', content: 'run regression tests', status: 'pending' }
  ] }, { agentId: 'hero' });
  A.ok(/3 tasks/.test(write.summary), 'todo write succeeds through the durable host store');

  const todoFile = path.join(ROOT, 'hero.todo.json');
  const notebookFile = path.join(ROOT, 'hero.notebook.json');
  A.ok(fs.files.has(todoFile), 'todo:<agent> persisted to a real .todo.json file');
  A.ok(!fs.files.has(notebookFile), 'todo writes do not create or clobber the notebook file');
  A.ok(fs.stats.fsync > 0, 'todo write used the durable fsync-before-rename path');

  await todoTool.run({ merge: true, todos: [{ id: 'b', status: 'completed' }] }, { agentId: 'hero' });
  A.ok(fs.files.has(todoFile + '.bak'), 'second todo write snapshotted the prior plan to .bak');

  const afterRestart = makeMemoryStore({ fs, path, workspaces: ROOT });
  const { todoTool: restartedTodo } = makeTodoTool({ store: afterRestart });
  const read = await restartedTodo.run({}, { agentId: 'hero' });
  A.ok(/\[x\] b\. persist todo list durably/.test(read.content), 'fresh store reads the persisted todo list after restart');

  const inj = formatForInjection(afterRestart, 'hero');
  A.ok(/preserved across context compaction/.test(inj), 'active todo list is available for compaction reinjection');
  A.ok(inj.indexOf('run regression tests') >= 0 && inj.indexOf('audit current todo behavior') < 0, 'injection keeps pending items and omits completed ones');

  /* ---------- resetAgentMemory: the new-hero clean slate (no prior Commander's state bleeds into a fresh agent) ---------- */
  const rstore = makeMemoryStore({ fs: memFs(), path, workspaces: ROOT });
  await rstore.update('notebook:hero', () => [{ content: 'a kept belief' }]);
  await rstore.update('declined:hero', () => ['a permanently-rejected belief']);
  await rstore.update('todo:hero', () => [{ id: 'x', content: 'a plan item', status: 'pending' }]);
  await rstore.update('minted:hero', () => [{ fp: 'ultron daily operating loop', title: 'ULTRON daily operating loop', status: 'created', at: 1 }]);
  await rstore.update('notebook:other', () => [{ content: 'a DIFFERENT hero belief' }]);
  await resetAgentMemory(rstore, 'hero');
  A.eq(rstore.get('notebook:hero'), [], 'reset wipes the kept notebook (no inherited memories)');
  A.eq(rstore.get('declined:hero'), [], 'reset wipes the declined reject-list (no inherited suppression)');
  A.eq(rstore.get('todo:hero'), [], 'reset wipes the active todo plan');
  A.eq(rstore.get('minted:hero'), [], 'reset wipes the mint ledger (a fresh hero re-earns its own routines)');
  A.eq(rstore.get('notebook:other'), [{ content: 'a DIFFERENT hero belief' }], 'reset is scoped to ONE agent — a different agent is untouched');

  /* ---------- restoreDeclined: the undo-a-discard escape hatch removes ONE entry from the reject-list ---------- */
  const dstore = makeMemoryStore({ fs: memFs(), path, workspaces: ROOT });
  await dstore.update('declined:hero', () => ['keep this one', 'restore me', 'and keep this']);
  A.eq(await restoreDeclined(dstore, 'hero', 'restore me'), true, 'restoreDeclined reports it removed the matched entry');
  A.eq(dstore.get('declined:hero'), ['keep this one', 'and keep this'], 'only the matched belief is lifted off the reject-list');
  A.eq(await restoreDeclined(dstore, 'hero', 'not present'), false, 'restoring a belief that was never declined is a no-op (removed=false)');
  A.eq(await restoreDeclined(dstore, 'hero', '   '), false, 'a blank text restores nothing');
  A.eq(dstore.get('declined:hero'), ['keep this one', 'and keep this'], 'the reject-list is unchanged by no-op restores');

  /* ---- every lookup here is keyed by a MODEL-SUPPLIED string, so none may be a bare object literal ----
     `byId['constructor']` resolved to the global Object function: the merge branch wrote the todo's content
     and status onto Object ITSELF, then dropped the item — the model asked for a task and got global
     mutation, no task and no error. ---- */
  {
    const T = require('../sidecar/tools/builtin/todo.js')._internals;
    A.eq(Object.content, undefined, 'precondition: Object carries no stray content property');
    const merged = T.buildList([{ id: 't1', content: 'real', status: 'pending' }],
      [{ id: 'constructor', content: 'PWNED', status: 'completed' }], true);
    A.eq(Object.content, undefined, 'a prototype-named todo id does NOT mutate the global Object');
    A.eq(Object.status, undefined, 'nor its status');
    A.eq(merged.length, 2, 'and the requested todo is actually stored instead of silently dropped');
    A.eq(merged[1].id, 'constructor', 'kept under the id the model asked for');
    A.eq(merged[1].status, 'completed', 'with the status it asked for');
    // the status enum is a real enum
    A.eq(T.buildList([], [{ id: 'x', content: 'c', status: 'constructor' }], false)[0].status, 'pending',
      'a prototype-named STATUS clamps to pending rather than being accepted');
    A.eq(T.buildList([], [{ id: 'y', content: 'c', status: 'in_progress' }], false)[0].status, 'in_progress',
      'a real status still round-trips');
    A.ok(T.render([{ id: 'z', content: 'c', status: 'toString' }]).indexOf('[?]') === 0,
      'an unknown status renders as [?] rather than reaching for a prototype value');
  }

  /* ---------- the DURABLE pending queue: a high-stakes deck raised with nobody watching stays answerable ----------
     Unattended runs reflect now, so a credential/PII/standing-instruction proposal can be raised at 3am. The old
     in-memory Map lost it on restart and could only be reached by exact runId — i.e. the Commander was never given
     the chance to rule on it. This queue is the durable half. ---------- */
  {
    const pstore = makeMemoryStore({ fs: memFs(), path, workspaces: ROOT });
    const props = [{ id: 'prop_1', kind: 'fact', content: 'the api key rotates monthly', scope: 'global', origin: 'schedule' }];
    A.eq(await appendPending(pstore, 'hero', 'run-a', props, 5000), 1, 'a high-stakes proposal is queued');
    const q = listPending(pstore, 'hero');
    A.eq(q.length, 1, 'and is listed');
    A.eq(q[0].runId, 'run-a', 'carrying the run that raised it, so a verdict can be routed back');
    A.eq(q[0].origin, 'schedule', 'and the surface that formed it');
    A.eq(q[0].createdAt, 5000, 'stamped with the INJECTED clock (memory-store is inside the determinism scan)');

    // idempotent: a retried run / double-fired beat must not double the deck
    A.eq(await appendPending(pstore, 'hero', 'run-a', props, 6000), 0, 're-stashing the same batch adds nothing');
    A.eq(listPending(pstore, 'hero').length, 1, 'the deck is not doubled');

    // proposal ids are per-batch (every batch mints a prop_1) — the composite key must keep runs apart
    await appendPending(pstore, 'hero', 'run-b', [{ id: 'prop_1', kind: 'fact', content: 'a different belief' }], 7000);
    A.eq(listPending(pstore, 'hero').length, 2, 'the same prop id from a DIFFERENT run is its own entry');

    const peeked = findPending(pstore, 'hero', 'run-a', 'prop_1');
    A.eq(peeked.content, 'the api key rotates monthly', 'two-phase turn-in can inspect the exact proposal before committing it');
    A.eq(listPending(pstore, 'hero').length, 2, 'non-consuming lookup leaves the proposal retryable when the destination write fails');

    // resolving returns the real proposal body — this is what lets a post-restart verdict commit the right text
    const taken = await takePending(pstore, 'hero', 'run-a', 'prop_1');
    A.eq(taken.content, 'the api key rotates monthly', 'taking a proposal returns its body, not just an id');
    A.eq(listPending(pstore, 'hero').length, 1, 'and removes exactly that one');
    A.eq(listPending(pstore, 'hero')[0].runId, 'run-b', 'the other run\'s proposal is untouched');
    A.eq(await takePending(pstore, 'hero', 'run-a', 'prop_1'), null, 'taking it twice is a null no-op, never an error');
    A.eq(await takePending(pstore, 'nobody', 'run-z', 'prop_9'), null, 'taking from an empty queue is a no-op');

    // FIFO bound: a backlog nobody answers must never grow without limit
    const many = [];
    for (let i = 0; i < PENDING_CAP + 10; i++) many.push({ id: 'p' + i, content: 'belief ' + i });
    await appendPending(pstore, 'flood', 'run-c', many, 8000);
    const flooded = listPending(pstore, 'flood');
    A.eq(flooded.length, PENDING_CAP, 'the queue is capped');
    A.eq(flooded[flooded.length - 1].id, 'p' + (PENDING_CAP + 9), 'and keeps the NEWEST (oldest fall off the front)');

    // a re-commissioned hero must not inherit the prior Commander's un-answered deck
    pstore.set('notebook:hero', [{ id: 'note_1' }]);
    await resetAgentMemory(pstore, 'hero');
    A.eq(listPending(pstore, 'hero'), [], 'new-hero reset wipes the pending deck too');
    A.eq(listPending(pstore, 'flood').length, PENDING_CAP, 'and is scoped to the one agent');
  }

  A.report('todo.durability.test');
})();
