'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { makeSaveStore } = require('../sidecar/savestore.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-cas-'));
const deps = { fs, pathMod: path, root, clock: { now: () => 1000 } };
try {
  let store = makeSaveStore(deps);
  const save = doc => store.save('agent', doc, { compareRevision: true });
  const baseline = { agent: { id: 'agent' }, updatedAt: 1, workstreams: [] };
  assert.equal(save(baseline).revision, 1);
  const a = structuredClone(store.load('agent')), b = structuredClone(a);
  a.updatedAt = 2; a.workstreams.push({ id: 'a', history: ['A'] });
  assert.equal(save(a).revision, 2);
  assert.equal(save(a).revision, 2, 'lost response retry is idempotent');
  b.updatedAt = 9000; b.workstreams.push({ id: 'b', history: ['B'] });
  const conflict = save(b);
  assert.equal(conflict.conflict, true, 'a fresh timestamp cannot disguise a stale read');
  assert.deepEqual(store.load('agent').workstreams, a.workstreams, 'current station remains unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, conflict.recovery))).workstreams, b.workstreams, 'conflicting work is durably recoverable');
  assert.equal(save({ ...baseline, updatedAt: 9999 }).conflict, true, 'unversioned old clients cannot bypass CAS');
  store = makeSaveStore(deps);
  assert.equal(store.load('agent')._saveRevision, 2, 'revision survives restart');
  const current = store.load('agent'); current.updatedAt = -10; current.workstreams.push({ id: 'c' });
  assert.equal(save(current).revision, 3, 'reload permits a new edit');
  assert.equal(save(current).revision, 3, 'a replay remains idempotent after server clock correction');
  // conflict snapshots are bounded (audit 2026-09-25 #18): the newest N per agent survive, the rest are pruned
  const small = makeSaveStore({ ...deps, conflictKeep: 3 });
  const conflictsFor = id => fs.readdirSync(root).filter(n => n.indexOf(id + '.save-conflict-') === 0);
  fs.writeFileSync(path.join(root, 'other.save-conflict-keep.json'), '{}');
  const stale = small.load('agent');
  let last;
  for (let i = 0; i < 12; i++) {
    const doc = { ...stale, _saveRevision: 1, _saveClient: 'client' + String(i).padStart(2, '0'), workstreams: [{ id: 'w' + i }] };
    last = small.save('agent', doc, { compareRevision: true });
    assert.equal(last.conflict, true, 'each stale save is still refused and recorded');
    const when = new Date(Date.now() + (i + 1) * 60000);   // strictly increasing mtimes, newer than the earlier conflicts
    fs.utimesSync(path.join(root, last.recovery), when, when);
  }
  const kept = conflictsFor('agent').sort();
  assert.equal(kept.length, 3, 'only the newest 3 conflict snapshots are kept (got ' + kept.length + ')');
  assert.ok(kept.indexOf(last.recovery) >= 0, 'the snapshot just written is always kept');
  assert.deepEqual(kept, ['agent.save-conflict-client09.json', 'agent.save-conflict-client10.json', 'agent.save-conflict-client11.json'], 'the newest ones are the ones kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, last.recovery))).workstreams, [{ id: 'w11' }], 'the kept snapshot is intact');
  assert.equal(conflictsFor('other').length, 1, 'another agent\'s conflict snapshots are never touched');
  console.log('save-concurrency: stale edits, durable recovery, replay, old clients, restart and bounded conflicts PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
