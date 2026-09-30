/* test/workflow-line.test.js — the docked WORKFLOW PANEL's truth layer, headless (2026-09-22).

   The panel (frontend/app/workflowpanel.js) paints a line's run order, a "how it runs" sentence, a
   readiness pill and a cost estimate. Each is a CLAIM about what the harness will do, so each is computed
   by frontend/app/workflowline.js from the compiled plan alone — and held here to that law:
     1. lineFlow orders docks by the COMPILED chain (Pipeline.chainStep), loop gates become back-arcs;
     2. howItRuns names only triggers that run the WHOLE line, and says honestly when nothing does;
     3. readiness blocks on what the harness would fail on; costEstimate adds ONLY tested steps;
     4. HANDS OFF is functional: composed into the brief the agent receives, outside the plan hash;
     5. insertBayBetween (the strip's "+") is one undo slot, compiler-verified, and refuses honestly. */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const W = require('../frontend/app/workflowline.js');

function stamp(bp, bind) {
  const s = WM.create(); const z = s.rooms()[0].rects[0];
  s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } });
  let ok = null;
  for (let y = z.y1; y < z.y1 + 25 && !ok; y++) for (let x = z.x1; x < z.x2 + 30 && !ok; x++) { const r = s.stampBlueprint(bp, x, y); if (r.ok) ok = r; }
  A.ok(!!ok, 'fixture: ' + bp + ' stamps');
  let n = 0;
  if (bind) for (const p of s.props()) if (p.t === 'bay') s.assignPropAgent(p.id, 'a' + (++n));
  return s;
}
function read(s) {
  const geo = s.projectGeometry(), plan = P.compileRoutingPlan(geo), comp = P.lineComponents(geo)[0];
  return { geo, plan, comp, flow: W.lineFlow(plan, comp, P, geo.props) };
}
const agents = f => f.order.map(pid => f.docks[pid].agentId);
const nameOf = a => String(a).toUpperCase();

/* ---------- 1. ORDER comes from the compiled chain ---------- */
{
  const { flow } = read(stamp('assembly_line', true));
  A.eq(agents(flow), ['a1', 'a2', 'a3', 'a4'], 'a linear line reads in chain order');
  A.ok(flow.outbox.reached, 'its last dock reaches the OUTBOX (plan.chains.outbox)');
  A.ok(flow.cols.every(c => c.mode === 'single'), 'one dock per column on a linear line');
}
{
  const { flow, plan } = read(stamp('revision_loop', true));
  A.eq(agents(flow), ['a1', 'a2'], 'writer then reviewer');
  const g = flow.gates[0];
  A.ok(g && g.kind === 'loop', 'the LOOP gate is read off chainStep');
  A.eq(flow.docks[g.backTo].agentId, 'a1', 'its back-arc lands on the dock the compiler resolved (backTo)');
  const jk = Object.keys(plan.junctions).find(k => plan.junctions[k].kind === 'loop');
  A.eq(g.max, plan.junctions[jk].max, 'the pass limit is the compiled one');
  A.ok(!!g.propId, 'the gate names its LOOP prop (clickable in the strip)');
}
{
  const { flow } = read(stamp('swarm_synthesis', true));
  A.eq(flow.cols[0].docks.length, 3, 'a fan-out puts its branches in ONE column');
  A.eq(flow.cols[0].mode, 'all', 'a fan-out splitter feeding a JOINER reads as "all branches run"');
  A.eq(flow.cols[0].gate && flow.cols[0].gate.kind, 'join', 'the JOINER gate follows the branches');
  A.eq(flow.cols[1].docks[0].agentId, 'a4', 'the analyst runs after the join');
}
{
  const { flow } = read(stamp('parallel_crew', true));
  A.eq(flow.cols[0].mode, 'turns', 'a plain splitter reads as taking turns, never as parallel');
  const { flow: f2 } = read(stamp('triage_desk', true));
  A.eq(f2.cols[0].mode, 'oneof', 'a FILTER reads as one-of by content');
}
{
  // uncrewed docks: the compiler routes nothing, so they sit where the belt walk meets them, flagged
  const { flow } = read(stamp('research_line', false));
  A.eq(flow.order.map(pid => flow.docks[pid].role), ['RESEARCHER', 'WRITER'], 'an uncrewed line still shows its docks in belt order');
  A.ok(flow.order.every(pid => !flow.docks[pid].routed), 'and flags them not-routed (no agent, no compiled chain)');
  A.ok(!flow.outbox.reached, 'an uncrewed line does not claim to reach the OUTBOX');
}

/* ---------- 2. the sentence ---------- */
{
  const s = stamp('revision_loop', true), { flow } = read(s);
  const hands = { [flow.order[0]]: 'a 200-word draft' };
  const txt = W.howItRuns(flow, { nameOf, handsOf: pid => hands[pid] || null,
    triggers: { schedules: ['every Sunday at 9:00 AM'], channels: ['Telegram'] } }).map(x => x.s).join('');
  A.ok(/^Every Sunday at 9:00 AM or when a Telegram message arrives, A1 writes it up, handing off a 200-word draft/.test(txt), 'triggers lead, then the first dock with its hand-off: ' + txt);
  A.ok(/A2 reviews it and sends it back to A1 until it is approved \(3 tries max\)/.test(txt), 'the loop gate is said in its compiled words');
  A.ok(/the result goes to the OUTBOX\.$/.test(txt), 'and it ends at the OUTBOX');
  const none = W.howItRuns(flow, { nameOf, triggers: { schedules: [], channels: [] } }).map(x => x.s).join('');
  A.ok(/^Nothing starts it on its own yet/.test(none), 'no trigger is said plainly, never invented');
  // LINE TRIGGERS (2026-09-23): only server-armed folder/webhook triggers of THIS line join the sentence
  const L = 'line-x';
  const ev = W.lineEventTriggers([
    { id: 'trg_a1', lineId: L, kind: 'folder', enabled: true, blockedBy: null, config: { path: 'C:\\Drops\\invoices' } },
    { id: 'trg_a2', lineId: L, kind: 'webhook', enabled: true, blockedBy: null, name: 'Orders', config: {} },
    { id: 'trg_a3', lineId: L, kind: 'folder', enabled: false, blockedBy: null, config: { path: 'C:\\Paused' } },
    { id: 'trg_a4', lineId: L, kind: 'folder', enabled: true, blockedBy: 'no work line is armed', config: { path: 'C:\\Blocked' } },
    { id: 'trg_a5', lineId: 'other', kind: 'folder', enabled: true, blockedBy: null, config: { path: 'C:\\Elsewhere' } }
  ], L);
  A.eq(ev.mine.length, 4, 'lineEventTriggers keeps only this line\'s triggers');
  A.eq(ev.sentences, ['when a file lands in C:\\Drops\\invoices', 'when its webhook "Orders" is called'], 'only enabled, unblocked triggers start the line: ' + JSON.stringify(ev.sentences));
  const withEv = W.howItRuns(flow, { nameOf, triggers: { schedules: [], channels: ['Telegram'], events: ev.sentences } }).map(x => x.s).join('');
  A.ok(/^When a Telegram message arrives, when a file lands in C:\\Drops\\invoices or when its webhook "Orders" is called, A1/.test(withEv), 'the sentence names the folder and the webhook: ' + withEv);
  const onlyEv = W.readiness(flow, { props: [] }, { triggers: { schedules: [], channels: [], events: ev.sentences } });
  A.ok(!onlyEv.hints.some(h => /nothing starts it/.test(h.what)), 'an armed folder/webhook trigger satisfies the "nothing starts it" hint');
  const un =read(stamp('research_line', false)).flow;
  const segs = W.howItRuns(un, { nameOf });
  A.ok(segs.some(x => x.t === 'miss' && /pick a researcher/.test(x.s)), 'an uncrewed dock is a clickable gap, not a name');
}

/* ---------- 3. readiness + cost ---------- */
{
  const s = stamp('research_line', false), { flow, comp, plan } = read(s);
  const r = W.readiness(flow, comp, { hasCompute: () => true, errors: plan.errors, briefOf: () => '' });
  A.ok(!r.ready, 'an uncrewed line is not ready');
  A.ok(/needs an agent/.test(r.blocking[0].what), 'the pill names the first missing thing: ' + r.blocking[0].what);
  A.ok(/^\d+ TO FIX · BAY 1/.test(W.pillText(r)), 'pill text: ' + W.pillText(r));
  const s2 = stamp('research_line', true), x = read(s2);
  const r2 = W.readiness(x.flow, x.comp, { hasCompute: () => true, errors: x.plan.errors, briefOf: () => 'x', triggers: { schedules: ['daily'] } });
  A.ok(r2.ready && W.pillText(r2) === 'READY TO RUN', 'crewed + computed + routed = READY TO RUN');
  const r3 = W.readiness(x.flow, x.comp, { hasCompute: a => a !== 'a2', errors: [], briefOf: () => 'x' });
  A.ok(!r3.ready && r3.blocking.some(b => /BAY 2 \(WRITER\) needs a workstation/.test(b.what)), 'a dock with no workstation blocks (the compute gate stays shut)');
  const c0 = W.costEstimate(x.flow, {});
  A.eq(c0.tested, 0, 'no tests, no estimate');
  A.ok(/Test a step/.test(c0.text), 'and it says so');
  const c1 = W.costEstimate(x.flow, { [x.flow.order[0]]: { usd: 0.0112 } });
  A.eq([c1.tested, c1.untested], [1, 1], 'only tested steps count; untested ones are counted, not guessed');
  A.ok(/≈ \$0\.011 a run · from 1 tested step, 1 untested/.test(c1.text), c1.text);
}

/* ---------- channels + routines ---------- */
{
  const status = { telegram: { configured: true, connected: true, agentName: 'Nova', bots: [{ botId: 'b1', configured: true, connected: true, enabled: true, agentId: 'quill', agentName: 'Quill', username: 'q_bot' }] },
    discord: { configured: false }, slack: { configured: true, connected: false, agentName: '' } };
  const rows = W.channelFeeds(status, ['nova'], [{ id: 'nova', name: 'NOVA' }, { id: 'quill', name: 'QUILL' }]);
  A.eq(rows.map(r => [r.label, r.feeds]), [['Telegram', true], ['Telegram @q_bot', false], ['Slack', null]],
    'a channel feeds the line only when it answers as an ENTRY dock; unknown stays unknown');
  const jobs = [{ id: 'j1', agentId: 'nova', runsLine: true, enabled: true }, { id: 'j2', agentId: 'nova', enabled: true },
    { id: 'j3', agentId: 'quill', runsLine: true, enabled: true }, { id: 'j4', agentId: 'zed', runsLine: true }];
  const rt = W.lineRoutines(jobs, ['nova', 'quill'], ['nova']);
  A.eq(rt.map(r => [r.id, r.startsLine]), [['j1', true], ['j2', false], ['j3', false]], 'only a runsLine routine at an ENTRY dock starts the whole line');
}

/* ---------- test inputs flow left to right ---------- */
{
  const x = read(stamp('research_line', true)), [d1, d2] = x.flow.order;
  A.eq(W.testInputFor(x.flow, d1, {}, 'the job').text, 'the job', 'the first dock tries the INBOX test job');
  A.eq(W.testInputFor(x.flow, d2, {}, 'the job'), null, 'the next dock has nothing honest until the previous one is tested');
  A.eq(W.testInputFor(x.flow, d2, { [d1]: { output: 'notes', usd: 0.01 } }, 'the job').text, 'notes', "the previous dock's real output becomes its input");
  const nb = W.neighbours(x.flow, d2);
  A.ok(nb.prev[0] === d1 && nb.last, 'neighbours: GETS from the dock before, TO the end');
}

/* ---------- step-test readings ---------- */
{
  const sess = { state: 'paused', paused: { afterHop: 0, text: 'x', next: { kind: 'agent', agentId: 'quill', back: true } } };
  A.eq(W.pausedNext(sess, nameOf).label, 'QUILL (sent back)', 'paused next names the dock (and a loop re-entry)');
  A.eq(W.pausedNext({ paused: { next: { kind: 'outbox' } } }).kind, 'outbox', 'or the OUTBOX');
  A.ok(W.isLive({ state: 'paused' }) && !W.isLive({ state: 'done' }), 'paused is live; done is terminal');
  A.eq(W.hopLabel({ agentId: 'vex', pass: 2, rerun: true, usd: 0.003, edited: true }, nameOf), 'VEX ×2 ↻ $0.003 ✎', 'hop label');
}

/* ---------- 4. HANDS OFF is functional ---------- */
{
  const s = stamp('research_line', true), bay = s.props().find(p => p.t === 'bay');
  s.setPropBrief(bay.id, 'Find sources.');
  const before = P.compileRoutingPlan(s.projectGeometry()).hash;
  A.eq(s.setPropHands(bay.id, '  bullet   notes ').hands, 'bullet notes', 'setPropHands trims and collapses');
  A.ok(!s.setPropHands(s.props().find(p => p.t === 'intake').id, 'x').ok, 'only a BAY hands off');
  const s2 = WM.deserialize(s.serialize());
  A.eq(s2.propById(bay.id).hands, 'bullet notes', 'hands survives serialize -> migrate -> deserialize');
  const plan = P.compileRoutingPlan(s2.projectGeometry());
  A.eq(plan.dockBays.find(d => d.propId === bay.id).brief, 'Find sources.\n\n' + P.HANDS_LEAD + 'bullet notes', 'the agent is TOLD the hand-off (composed into the dock brief)');
  A.eq(plan.hash, before, 'a hand-off edit never moves the dispatch hash');
  A.eq(P.composeStageBrief('', 'a draft'), P.HANDS_LEAD + 'a draft', 'hands alone still briefs');
  A.eq(P.composeStageBrief('  ', ''), null, 'nothing composes nothing');
}

/* ---------- 5. insertBayBetween ---------- */
{
  const s = stamp('research_line', true), x = read(s), [d1, d2] = x.flow.order;
  const doc0 = JSON.stringify(s.serialize());
  const r = s.insertBayBetween(d1, d2, { role: 'REVIEWER' });
  A.ok(r.ok, 'a BAY inserts between two directly-belted docks: ' + (r.msg || ''));
  A.eq(s.propById(r.id).role, 'REVIEWER', 'it carries the picked role');
  s.assignPropAgent(r.id, 'zz');
  const y = read(s);
  A.eq(agents(y.flow), ['a1', 'zz', 'a2'], 'the compiled chain now runs through the new dock');
  A.eq(y.plan.errors.filter(e => !e.warn).length, 0, 'with no blocking error');
  s.undo();   // the assign
  s.undo();   // the insert — ONE slot for lift + place + two belts
  A.eq(JSON.stringify(s.serialize()), doc0, 'one UNDO restores the whole insert');
}
{
  const s = stamp('revision_loop', true), x = read(s);
  const doc0 = JSON.stringify(s.serialize()), undo0 = s.canUndo();
  const r = s.insertBayBetween(x.flow.trigger.propId, x.flow.order[0], {});
  A.ok(!r.ok && r.error === 'LANE_SHARED', 'a lane another belt merges into is refused honestly');
  A.eq(JSON.stringify(s.serialize()), doc0, 'a refusal changes nothing');
  A.eq(s.canUndo(), undo0, 'and burns no undo slot');
}
{
  // transact: all-or-nothing
  const s = stamp('front_desk', true), doc0 = JSON.stringify(s.serialize());
  const r = s.transact(() => { s.setBelt(0, 0, 'E'); return { ok: false, error: 'NOPE' }; });
  A.ok(!r.ok && JSON.stringify(s.serialize()) === doc0, 'a failed transaction restores the pre-batch doc');
}

// ---- LINE TRIGGERS repaint plan (2026-09-24): the 5 s re-read patches only what changed ----
{
  const t1 = { id: 'a', enabled: true, fires: 1 }, t2 = { id: 'b', enabled: true, fires: 0 };
  const sig = W.triggerSig;
  A.eq(sig(t1), sig({ id: 'a', enabled: true, fires: 1 }), 'the same data has the same fingerprint');
  A.ok(sig(t1) !== sig({ id: 'a', enabled: true, fires: 2 }), 'a changed field changes it');
  A.ok(sig(t1) !== sig(t1, 'reveal'), 'the once-only key box is part of the row');
  const rows = ts => ts.map(t => [t.id, sig(t)]);
  A.eq(W.rowPatch(rows([t1, t2]), rows([t1, t2])), { all: false, changed: [] }, 'nothing changed -> touch nothing (an ARMED delete stays armed)');
  A.eq(W.rowPatch(rows([t1, t2]), rows([t1, { id: 'b', enabled: true, fires: 1 }])), { all: false, changed: ['b'] }, 'one row changed -> only that row repaints');
  A.eq(W.rowPatch(rows([t1]), rows([t1, t2])).all, true, 'a row added -> the list repaints');
  A.eq(W.rowPatch(rows([t1, t2]), rows([t2, t1])).all, true, 'reordered -> the list repaints');
  A.eq(W.rowPatch([], []), { all: false, changed: [] }, 'empty stays empty');
  A.eq(W.rowPatch(null, rows([t1])).all, true, 'no previous rows ("reading triggers…") -> the list paints');
}

/* ---------- (sweep 2026-09-25) CONNECTED BUT UNCREWED is not "not connected" ---------- */
{
  // the stranded-user repro: INBOX → BAY → BAY → OUTBOX all belted, no agent yet. The panel said "[the last step is
  // not connected to the OUTBOX]" + "connect the last step to the OUTBOX" — telling a newcomer to lay belts that exist.
  const s = stamp('assembly_line', false);
  const { flow, comp } = read(s);
  A.eq(flow.outbox.reached, false, 'nothing reaches the OUTBOX TODAY (no crew — the real claim is unchanged)');
  A.eq(flow.outbox.reachedOnceCrewed, true, 'but the belts do reach it once every bay is crewed');
  const r = W.readiness(flow, comp, {});
  A.ok(!r.blocking.some(b => /connect the last step/.test(b.what)), 'no "connect the last step" blocker for a belt that exists: ' + JSON.stringify(r.blocking.map(b => b.what)));
  A.ok(r.blocking.some(b => /needs an agent/.test(b.what)), 'the real missing piece (an agent) is what blocks');
  A.eq(r.ready, false, 'and the line is still not ready');
  const txt = W.howItRuns(flow, { nameOf, triggers: {} }).map(x => x.s).join('');
  A.ok(/\[the result reaches the OUTBOX once every step has an agent\]/.test(txt) && !/not connected to the OUTBOX/.test(txt), 'the sentence says what is missing: ' + txt);
  // crew only the FIRST bay: its onward belt leads to an uncrewed bay — probeNext names it (never "connect a belt")
  const first = flow.order[0];
  s.assignPropAgent(first, 'a1');
  const f2 = read(s).flow;
  A.ok(f2.probeNext[first] && f2.probeNext[first].length === 1 && f2.probeNext[first][0] === f2.order[1], 'the crewed bay\'s belt leads to the next (uncrewed) bay: ' + JSON.stringify(f2.probeNext));
  A.eq((f2.edges[first] || []).length, 0, '(the REAL plan still hands off to nothing today)');
  // a line whose last bay is NOT belted to the OUTBOX still says so
  const s3 = stamp('assembly_line', true);
  const g3 = s3.projectGeometry();
  const outbox = g3.props.find(p => p.t === 'outbox');
  s3.removeProp(outbox.id);
  const r3 = read(s3);
  const rb = W.readiness(r3.flow, r3.comp, {});
  A.ok(rb.blocking.some(b => /add an OUTBOX|connect the last step/.test(b.what)), 'a line that really does not reach an OUTBOX still blocks on it: ' + JSON.stringify(rb.blocking.map(b => b.what)));
}
A.report('workflow-line');
