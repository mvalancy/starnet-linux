/* node test/journey-store.test.js — durable, verified, non-gating Commander journey progression. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeJourneyStore, normalize, tierFor, evolutionFor } = require('../sidecar/journey-store.js');

function memFs() {
  const files = new Map();
  return {
    _files: files,
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); },
    renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
}
const writeDurable = ({ fs }, file, data) => fs.writeFileSync(file, data);
const fresh = fs => makeJourneyStore({ fs: fs || memFs(), path, workspaces: '/ws', writeDurable });

(async () => {
  A.eq(normalize(null), { goals: [], achievements: [], achievementKeys: [], commanderPoints: 0, v: 1, seq: 0, commanderEpoch: 0, startedAt: 0, metrics: [], outcomes: [], outcomeKeys: [], mastery: [], receipts: [], goalsReached: [], suppressed: {} }, 'missing journey state hydrates safely');
  A.eq([tierFor(0), tierFor(1), tierFor(3), tierFor(7)], ['unproven', 'tested', 'practiced', 'proven'], 'mastery tiers cross only on verified outcome counts');
  A.eq(evolutionFor(['a', 'b']).name, 'ORBIT', 'station evolution is derived from distinct goals reached');
  A.eq(evolutionFor(Array.from({ length: 9 }, (_, i) => String(i))).stage, 9, 'station evolution remains uncapped across a long Commander journey');

  const fs = memFs();
  const s = fresh(fs);
  await s.registerGoal({ id: 'goal:saas', text: 'Grow the SaaS', successCondition: 'Ten customers renew for a second month' }, 1);
  const made = await s.createMetric({ goalId: 'goal:saas', label: 'Monthly recurring revenue', unit: 'USD', baseline: 100, target: 1000 }, 10);
  A.ok(made.ok && made.metric.current === 100, 'a Commander metric starts at its explicit baseline');
  A.eq(s.snapshot({ id: 'goal:saas', text: 'Grow the SaaS', done: 1, total: 4, next: 'Find ten users' }).activeGoal.next, 'Find ten users', 'active goal context is projected without being inferred');
  A.ok((await s.updateMetric({ id: made.metric.id, current: 700, note: 'billing dashboard' }, 20)).ok, 'a current value can advance without claiming the target');
  A.eq(s.snapshot().evolution.goalsReached, 0, 'station does not evolve before the real target is reached');
  const reached = await s.updateMetric({ id: made.metric.id, current: 1000, note: 'verified in billing dashboard' }, 30);
  A.ok(reached.ok && reached.outcome && reached.outcome.verifiedBy === 'commander-client', 'reaching an explicit metric writes a provenance-bearing outcome');
  A.eq(s.snapshot().evolution.goalsReached, 0, 'a reached metric proves itself but cannot claim the whole goal complete');
  await s.updateMetric({ id: made.metric.id, current: 1200, note: 'later month' }, 40);
  A.eq(s.snapshot().outcomes.filter(o => o.kind === 'metric').length, 1, 'later updates cannot re-award the same metric target');

  const quest = n => ({ id: 'q:' + n, status: 'done', title: 'Ship build ' + n, domain: 'building', completedBy: 'builder',
    goalId: 'goal:game', contract: { type: 'artifact', key: 'game-' + n + '.zip' }, completedAt: 100 + n });
  const first = await s.recordQuest(quest(1), null, 101);
  A.ok(first.ok && first.receipt && first.receipt.tier === 'tested', 'first verified domain outcome creates a visible tested receipt');
  A.eq(first.outcome.verifiedBy, 'harness-contract', 'mechanical quest completion names harness authority');
  const duplicate = await s.recordQuest(quest(1), null, 102);
  A.ok(duplicate.duplicate, 'replayed quest completion is idempotent');
  for (let n = 2; n <= 7; n++) await s.recordQuest(quest(n), null, 100 + n);
  const mastery = s.snapshot().mastery.find(m => m.agentId === 'builder' && m.domain === 'building');
  A.eq([mastery.count, mastery.tier], [7, 'proven'], 'seven distinct verified outcomes reach proven mastery exactly once');
  A.eq(s.snapshot().receipts.filter(r => r.agentId === 'builder').map(r => r.tier), ['tested', 'practiced', 'proven'], 'receipts explain each actual adaptation threshold');

  const attest = { id: 'q:attest', status: 'done', title: 'Interview five users', domain: 'research', agentId: 'scout',
    contract: { type: 'attest', key: '' }, attest: { agentId: 'scout', evidence: 'Commander confirmed five interview notes', confirmed: true } };
  const attested = await s.recordQuest(attest, null, 200);
  A.eq(attested.outcome.verifiedBy, 'commander-confirmed', 'real-world attest mastery cannot claim harness authority');
  A.ok((await s.recordQuest({ id: 'q:bare-claim', status: 'done', title: 'Bare claim', contract: { type: 'attest', key: '' } }, null, 201)).ok === false, 'an attest without Commander-confirmed evidence cannot enter the journey ledger');

  A.ok(/building: 7 verified outcomes/.test(s.adaptationBlock('builder')), 'prompt adaptation names only verified mastery evidence');
  await s.setSuppressed('builder', 'building', true, 300);
  A.eq(s.adaptationBlock('builder'), '', 'Commander correction immediately removes that planning prior');
  A.ok(s.snapshot().receipts.filter(r => r.agentId === 'builder').every(r => r.dismissedAt === 300), 'suppression is visible on its receipts');
  await s.setSuppressed('builder', 'building', false, 301);
  A.ok(/building: 7 verified outcomes/.test(s.adaptationBlock('builder')), 'Commander can resume the corrected track');
  // PROTOTYPE POLLUTION (security audit 2026-09-25): '__proto__' passes the agent-id regex, and
  // rec.suppressed['__proto__'] is Object.prototype — one /api/journey call used to set Object.prototype.building.
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    const r = await s.setSuppressed(bad, 'building', true, 310);
    A.ok(r.ok === false, 'setSuppressed refuses object-model key ' + bad + ' as an agent id');
  }
  A.ok(!Object.prototype.hasOwnProperty('building') && ({}).building === undefined, 'Object.prototype was not polluted');
  A.ok(typeof Object.building === 'undefined', 'the Object constructor was not written to');
  A.eq(Object.keys(normalize({ suppressed: JSON.parse('{"__proto__":{"building":1},"builder":{"research":2}}') }).suppressed), ['builder'], 'a __proto__ row on disk is dropped on load');

  const milestone = { goalId: 'goal:game', milestoneId: 'm:launch', milestoneText: 'Launch the playable game', evidence: 'Release build linked in the task', agentId: 'builder', domain: 'building', goalDone: true };
  A.ok((await s.recordMilestone(milestone, 400)).ok, 'a final work milestone records the completed action');
  A.ok((await s.recordMilestone(milestone, 401)).duplicate, 'milestone replay cannot evolve the station twice');
  A.eq(s.snapshot().evolution.goalsReached, 0, 'finishing every planned milestone cannot claim a life goal');
  await s.registerGoal({ id: 'goal:game', text: 'Launch a game', successCondition: 'Five people play the release' }, 402);
  await s.confirmGoal({ id: 'goal:game', evidence: 'Five people played the release at the meetup' }, 403);

  const saasDone = { goalId: 'goal:saas', milestoneId: 'm:finish', milestoneText: 'Reach the SaaS goal', evidence: 'Final goal arc milestone verified', agentId: 'builder', domain: 'growth', goalDone: true };
  await s.recordMilestone(saasDone, 410);
  A.eq(s.snapshot().evolution.goalsReached, 1, 'second final work milestone cannot infer goal achievement');
  await s.confirmGoal({ id: 'goal:saas', evidence: 'Ten renewal receipts recorded' }, 411);
  A.eq(s.snapshot().evolution.goalsReached, 2, 'explicit confirmations produce evolution beacons');

  const restarted = fresh(fs);
  A.eq(restarted.snapshot().evolution.goalsReached, 2, 'metrics, mastery, receipts, and evolution survive process restart');
  A.eq(restarted.snapshot().mastery.find(m => m.agentId === 'builder').count, 8, 'restart preserves the exact verified mastery count');
  A.eq(Object.keys(restarted.snapshot()).includes('capabilities'), false, 'journey state has no capability/unlock field by construction');

  // Long-horizon invariants: visible history may be bounded, but idempotency, active user metrics, and the
  // distinct-goal evolution count must never silently fall out of their authority windows.
  const longFs = memFs(), long = fresh(longFs);
  for (let n = 1; n <= 305; n++) await long.recordQuest({ id: 'q:long-' + n, status: 'done', title: 'Long outcome ' + n,
    domain: 'support', completedBy: 'keeper', contract: { type: 'artifact', key: 'proof-' + n } }, null, 1000 + n);
  A.eq(long.read().outcomes.length, 300, 'stored outcome history remains bounded');
  A.eq(long.snapshot().mastery.find(m => m.agentId === 'keeper' && m.domain === 'support').count, 305, 'mastery keeps the full verified lifetime count');
  A.ok((await long.recordQuest({ id: 'q:long-1', status: 'done', title: 'Long outcome 1', domain: 'support', completedBy: 'keeper',
    contract: { type: 'artifact', key: 'proof-1' } }, null, 2000)).duplicate, 'an outcome remains idempotent after its visible row ages out');
  A.eq(long.snapshot().mastery.find(m => m.agentId === 'keeper' && m.domain === 'support').count, 305, 'aged-out replay cannot inflate mastery');
  for (let n = 1; n <= 45; n++) await long.recordMilestone({ goalId: 'goal:long-' + n, milestoneId: 'finish', milestoneText: 'Finish goal ' + n,
    evidence: 'final evidence ' + n, agentId: 'keeper', domain: 'planning', goalDone: true }, 3000 + n);
  A.eq(long.snapshot().evolution.goalsReached, 0, 'even many final work milestones never infer life goal achievement');
  for (let n = 1; n <= 45; n++) {
    await long.registerGoal({ id: 'goal:long-' + n, text: 'Goal ' + n, successCondition: 'Explicit success ' + n }, 3100 + n);
    await long.confirmGoal({ id: 'goal:long-' + n, evidence: 'Commander report ' + n }, 3200 + n);
  }
  A.eq(long.snapshot().evolution.goalsReached, 45, 'station evolution counts all explicitly confirmed goals');

  const metricFs = memFs(), metricStore = fresh(metricFs), createdMetrics = [];
  for (let n = 0; n < 40; n++) createdMetrics.push(await metricStore.createMetric({ label: 'Active metric ' + n, baseline: 0, target: 1 }, 4000 + n));
  A.ok(createdMetrics.every(r => r.ok), 'forty active Commander metrics are retained');
  const overflowMetric = await metricStore.createMetric({ label: 'Overflow metric', baseline: 0, target: 1 }, 5000);
  A.ok(!overflowMetric.ok, 'the active metric ceiling refuses overflow instead of deleting user data');
  A.ok(metricStore.snapshot().metrics.some(m => m.id === createdMetrics[0].metric.id), 'the oldest active metric survives an overflow attempt');
  A.ok(!(await metricStore.createMetric({ label: 'Null baseline', baseline: null, target: 10 }, 5001)).ok, 'null is not silently coerced into a numeric metric baseline');

  const lifeFs = memFs(), life = fresh(lifeFs);
  A.ok(!(await life.registerGoal({ id: 'life', text: 'Get stronger', successCondition: '   ' }, 1)).ok, 'blank success conditions cannot establish a goal');
  A.ok(!(await life.confirmGoal({ id: 'life', evidence: 'I did it' }, 1)).ok, 'confirmation requires stored criteria');
  await life.registerGoal({ id: 'life', text: 'Get stronger', successCondition: 'Complete ten full pull-ups' }, 1);
  A.ok(!(await life.confirmGoal({ id: 'life', evidence: '   ' }, 2)).ok, 'blank reports cannot confirm a goal');
  const lm = await life.createMetric({ goalId: 'life', label: 'Pull-ups', baseline: 0, target: 10 }, 2);
  await life.updateMetric({ id: lm.metric.id, current: 6 }, 3);
  A.eq(life.snapshot().progression.points, 20, 'reported metric improvement crosses two bounded checkpoints');
  await life.updateMetric({ id: lm.metric.id, current: 1 }, 4);
  await life.updateMetric({ id: lm.metric.id, current: 6 }, 5);
  A.eq(life.snapshot().progression.points, 20, 'regression and replay cannot farm progress');
  await life.retireMetric(lm.metric.id, 6);
  const replacement = await life.createMetric({ goalId: 'life', label: 'Replacement', baseline: 0, target: 10 }, 7);
  await life.updateMetric({ id: replacement.metric.id, current: 10 }, 8);
  A.eq(life.snapshot().progression.points, 40, 'replacement metrics cannot repeat the same goal checkpoints');
  A.eq(life.snapshot().evolution.goalsReached, 0, 'full metric progress still awaits goal confirmation');
  const reported = await life.recordMilestone({ goalId: 'life', milestoneId: 'first-class', milestoneText: 'Attend class', evidence: 'Attended the first class today', source: 'commander', goalDone: true }, 9);
  A.eq(reported.outcome.verifiedBy, 'commander-confirmed', 'real-world action reports preserve user authority');
  A.eq(life.snapshot().progression.points, 50, 'one reported milestone awards a fixed intermediate achievement');
  const confirmed = await life.confirmGoal({ id: 'life', evidence: 'Completed ten full pull-ups at class' }, 10);
  A.eq(confirmed.goal.successCondition, 'Complete ten full pull-ups', 'confirmed evidence stays attached to stored criteria');
  A.eq(life.snapshot().progression.level, 2, 'Commander level follows achievements independently of agent mastery');
  A.eq(life.snapshot().mastery, [], 'Commander reports without agent attribution never invent agent mastery');
  const lifeRestart = fresh(lifeFs);
  A.ok((await lifeRestart.confirmGoal({ id: 'life', evidence: 'Repeated report' }, 11)).duplicate, 'goal confirmation remains idempotent after restart');
  A.eq(lifeRestart.snapshot().progression.points, 150, 'restart preserves earned Commander points');
  A.eq(lifeRestart.snapshot().goals[0].evidence, 'Completed ten full pull-ups at class', 'duplicate confirmation preserves original evidence');
  A.ok(!(await lifeRestart.registerGoal({ id: 'life', text: 'Other goal', successCondition: 'Different criteria' }, 12)).ok, 'achieved goals cannot be redefined to farm another outcome');
  for (let n = 0; n < 305; n++) await lifeRestart.recordMilestone({ goalId: 'life', milestoneId: 'session-' + n,
    milestoneText: 'Completed planned session ' + n, evidence: 'Commander reported session ' + n, source: 'commander' }, 100 + n);
  const afterHistory = fresh(lifeFs);
  const lifetimePoints = afterHistory.snapshot().progression.points;
  A.eq(afterHistory.read().achievements.length, 300, 'visible achievement history stays bounded');
  A.ok((await afterHistory.recordMilestone({ goalId: 'life', milestoneId: 'first-class', evidence: 'Replay original reported action', source: 'commander' }, 500)).duplicate, 'aged-out milestone cannot award points again');
  A.eq(afterHistory.snapshot().progression.points, lifetimePoints, 'lifetime points and dedupe survive display compaction and restart');
  const realWorld = fresh();
  await realWorld.registerGoal({ id: 'practice', text: 'Learn piano', successCondition: 'Play one piece from memory' }, 1);
  const realQuest = { id: 'practice-q', status: 'done', goalId: 'practice', milestoneId: 'first-lesson',
    title: 'Attend the first lesson', domain: 'creative', contract: { type: 'attest' },
    attest: { confirmed: true, evidence: 'I attended my first piano lesson' } };
  await realWorld.recordQuest(realQuest, null, 2);
  A.eq(realWorld.snapshot().progression.points, 10, 'a goal-linked Commander-confirmed quest advances Commander progression');
  A.eq(realWorld.snapshot().mastery, [], 'a self-reported quest without an agent never awards agent mastery');
  await realWorld.recordQuest(Object.assign({}, realQuest, { id: 'assigned-user-action', agentId: 'builder', attest: { source: 'commander', confirmed: true, evidence: 'I attended the lesson myself' } }), null, 2);
  A.eq(realWorld.snapshot().mastery, [], 'a direct user report never credits the assigned agent with doing the action');
  await realWorld.recordQuest(realQuest, null, 3);
  await realWorld.recordMilestone({ goalId: 'practice', milestoneId: 'first-lesson', milestoneText: 'Attend the first lesson', evidence: 'I attended my first piano lesson', source: 'commander' }, 4);
  A.eq(realWorld.snapshot().progression.points, 10, 'quest replay and the corresponding milestone share one achievement');
  await realWorld.recordMilestone({ goalId: 'practice', milestoneId: 'second-lesson', evidence: 'Attended the second lesson', source: 'commander' }, 5);
  await realWorld.recordQuest(Object.assign({}, realQuest, { id: 'practice-q2', milestoneId: 'second-lesson' }), null, 6);
  A.eq(realWorld.snapshot().progression.points, 20, 'milestone before quest also shares one achievement');
  await realWorld.recordQuest({ id: 'mechanical', status: 'done', goalId: 'practice', title: 'Create lesson notes', contract: { type: 'artifact', key: 'notes.txt' } }, null, 7);
  A.eq(realWorld.snapshot().progression.points, 20, 'mechanical artifact completion alone never earns Commander points');
  await realWorld.recordQuest(Object.assign({}, realQuest, { id: 'unregistered', goalId: 'missing', milestoneId: null }), null, 8);
  A.eq(realWorld.snapshot().progression.points, 20, 'Commander quests require a registered goal to earn points');
  await realWorld.confirmGoal({ id: 'practice', evidence: 'Played the piece from memory' }, 9);
  await realWorld.recordQuest(Object.assign({}, realQuest, { id: 'after-achievement', milestoneId: null }), null, 10);
  A.eq(realWorld.snapshot().progression.points, 120, 'quests for already achieved goals do not award additional points');
  const legacy = normalize({ goalsReached: ['old-goal'], outcomes: [] });
  A.eq(legacy.goalsReached, ['old-goal'], 'legacy recorded achievements remain intact');
  A.eq(legacy.commanderPoints, 0, 'legacy history is not retroactively represented as Commander-confirmed points');
  A.eq(fresh(longFs).snapshot().progression.points, 4500, 'lifetime Commander points survive long outcome history and restart');

  const unreadableFs = memFs();
  unreadableFs.readFileSync = () => { const e = new Error('locked'); e.code = 'EBUSY'; throw e; };
  const unreadable = fresh(unreadableFs);
  let unreadableThrew = false;
  try { unreadable.snapshot(); } catch (_) { unreadableThrew = true; }
  A.ok(unreadableThrew, 'an unreadable journey ledger fails loudly instead of presenting an empty life history');
  await restarted.reset(5000, 77);
  A.eq(restarted.currentEpoch(1), 77, 'reset atomically advances the Commander generation authority');
  A.eq(restarted.snapshot().evolution.goalsReached, 0, 'a new Commander can start with a truly clean journey');
  const priorQuest = quest(99); priorQuest.completedAt = 4999;
  A.ok((await restarted.recordQuest(priorQuest, null, 5001)).skipped, 'completed quests from before the reset epoch cannot bleed into a new Commander journey');
  A.eq(restarted.snapshot().mastery.length, 0, 'prior-Commander quest reconciliation cannot restore old mastery after reset');

  A.report('journey-store.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
