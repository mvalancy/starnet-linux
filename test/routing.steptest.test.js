/* node test/routing.steptest.test.js — the conveyor STEP-THROUGH TEST engine (sidecar/routing/steptest.js),
   driven through the REAL compiler + REAL router (the same reads the executor takes) with a fake runDock,
   a fake clock and an in-memory store. No provider, no wall-clock, no sockets.

   Locks: pause every / none / an edge list; the paused handoff text; an owner edit stamped edited:true (and
   told to the receiving run); rerun (appends, same input, CURRENT brief); rewind (drops later hops, their
   money stays spent); a verdict LOOP revise -> back -> approved with pass counting; the LINE BUDGET over the
   whole session (re-runs included) ending in 'stopped'; single (try-this-step) with a preview; the next dock
   resolved at CONTINUE time from the current plan; the restart round-trip (paused stays paused, running comes
   back failed and can be re-run); one active session per station. */
'use strict';
const A = require('./_assert.js');
const { makeStepTest, normPause } = require('../sidecar/routing/steptest.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');

const belt = (x, y, dir) => ({ x, y, dir });
let T = 1000; const clock = () => (T += 10);

// INBOX -> research -> writer -> OUTBOX (the sample e2e's two-stage floor)
function twoDock(briefs) {
  const b = briefs || {};
  return {
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research', brief: b.research },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer', brief: b.writer },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  };
}
// INBOX -> research -> editor -> writer -> OUTBOX (a bay ADDED between research and writer)
function threeDock() {
  return {
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research' },
            { id: 'b3', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'editor' },
            { id: 'b2', t: 'bay', x: 10, y: 0, w: 1, h: 1, agentId: 'writer' },
            { id: 'o', t: 'outbox', x: 13, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E'), belt(11, 0, 'E'), belt(12, 0, 'E')]
  };
}
// INBOX -> drafter -> reviewer -> LOOP gate -> (done E -> publisher -> OUTBOX | back N -> drafter)  (chain.join-loop's floor + an OUTBOX)
function loopFloor(gateCfg) {
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W'), belt(17, 4, 'E'), belt(18, 4, 'E')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  return {
    props: [{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
            { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
            { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
            Object.assign({ id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E' }, gateCfg || {}),
            { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' },
            { id: 'p7', t: 'outbox', x: 19, y: 4, w: 1, h: 1 }],
    belts
  };
}

function memStore() { let v = null; return { load: () => (v ? JSON.parse(v) : null), save: x => { v = JSON.stringify(x); }, raw: () => v }; }

function rig(floor, script, opts) {
  opts = opts || {};
  const router = opts.router || makeRouter();
  const plan = P.compileRoutingPlan(floor);
  if (opts.limits) plan.lineLimits = Object.fromEntries((plan.lines || []).map(l => [l.lineId, opts.limits]));
  const set = router.setPlan(plan);
  if (!set.ok) throw new Error('plan refused: ' + JSON.stringify(plan.errors));
  const calls = [];
  const runDock = async (h) => {
    calls.push(h);
    if (opts.gate) await opts.gate(h);
    const r = script[h.agentId];
    return Object.assign({ runId: 'run' + calls.length, tools: 1 }, typeof r === 'function' ? r(h, calls) : (r || { text: h.agentId + ' output', usd: 0.01 }));
  };
  const store = opts.store || memStore();
  const mk = () => makeStepTest({
    runDock, store, now: clock, getTag: () => 'general', label: a => a.toUpperCase(),
    plan: {
      get: () => router.getPlan(),
      step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
      entryDock: (line, text) => { const a = router.resolveTarget({ tag: 'general', text, lineId: line }); return a && router.lineOriginFor(a) === line ? a : null; },
      lineOf: a => router.lineOfAgent(a), stageBrief: a => router.stageBrief(a),
      loopGateAfter: (a, l) => router.loopGateAfter(a, l), lineLimits: l => router.lineLimits(l),
      shipsToOutbox: a => router.chainShipsToOutbox(a)
    }
  });
  const st = mk();
  const lineId = P.lineOf(plan, plan.bays[0].agentId);
  return { st, mk, router, plan, calls, store, lineId };
}
const settle = async (R, id) => { for (let i = 0; i < 50; i++) { await R.st.settled(id); const s = R.st.get(id).session; if (s.state !== 'running') return s; } return R.st.get(id).session; };

(async () => {
  /* ---- pause rule normalization ---- */
  A.eq(normPause(undefined), 'every', 'default pause rule is every');
  A.eq(normPause(['a>b', 'a>b', 'b>outbox']), ['a>b', 'b>outbox'], 'an edge list is deduped');
  A.eq(normPause('sometimes'), null, 'an unknown word is refused');
  A.eq(normPause(['a-b']), null, 'a malformed edge is refused');

  /* ---- PAUSE EVERY: start -> paused after research, with the exact handoff text and a PREVIEW of the next dock ---- */
  {
    const R = rig(twoDock({ writer: 'Press style.' }), { research: { text: 'findings A', usd: 0.1 }, writer: (h) => ({ text: 'final from: ' + h.text.slice(0, 20), usd: 0.2 }) });
    const r0 = R.st.start({ line: R.lineId, text: 'research sleep' });
    A.ok(r0.ok, 'start answers ok: ' + r0.error);
    A.eq(r0.session.state, 'running', 'the session starts running (the route answers at once; the panel polls)');
    A.eq(r0.session.running.agentId, 'research', 'the ENTRY dock (router.resolveTarget scoped to the line) is working');
    const again = R.st.start({ line: R.lineId, text: 'second' });
    A.eq(again.ok, false, 'ONE active session per station: a second start is refused');
    A.ok(/already running/.test(again.error), 'the refusal says why: ' + again.error);
    let s = await settle(R, r0.session.id);
    A.eq(s.state, 'paused', 'pause:every pauses after the first dock');
    A.eq(R.calls[0].entry, true, 'the entry dock runs as stage one (its brief rides its SYSTEM context in runDock)');
    A.eq(R.calls[0].text, 'research sleep', 'the entry dock is handed the job itself');
    A.eq(s.hops.length, 1);
    A.eq(s.hops[0].output, 'findings A', 'the hop records exactly what the agent replied');
    A.eq(s.hops[0].pass, 1); A.eq(s.hops[0].agentLabel, 'RESEARCH'); A.eq(s.hops[0].sent, null, 'nothing has been sent onward yet');
    A.eq(s.paused.afterHop, 0);
    A.eq(s.paused.text, 'findings A', 'the paused text is the exact handoff the executor would send');
    A.eq(s.paused.next, { kind: 'agent', agentId: 'writer', back: false }, 'the preview names the next dock from the current plan');
    A.eq(s.totalUsd, 0.1); A.eq(s.limits.maxUsdPerMessage, 2, 'the default line budget applies'); A.eq(s.limits.spent, 0.1);
    A.ok(!('_w' in s) && !('_job' in s.hops[0]), 'internals never leave the engine');
    A.eq(R.st.get().session.id, s.id, 'GET with no id answers the active session');

    /* ---- CONTINUE WITH AN EDIT: edited:true on the hop, the receiver is told, the handoff turn carries the owner's words ---- */
    const c1 = R.st.continue(s.id, { text: 'findings A — plus my note' });
    A.ok(c1.ok, 'continue answers ok');
    s = await settle(R, s.id);
    A.eq(s.hops[0].edited, true, 'the owner-edited handoff is stamped edited:true');
    A.eq(s.hops[0].sent, 'findings A — plus my note', 'sent is the text actually handed on');
    A.eq(R.calls[1].edited, true, 'the receiving run is told its input was edited (run-row stamp)');
    A.eq(R.calls[1].entry, false);
    A.ok(/PIPELINE HANDOFF/.test(R.calls[1].text) && R.calls[1].text.indexOf('findings A — plus my note') >= 0, 'the handoff turn (Pipeline.handoffPrompt) carries the edited text');
    A.ok(R.calls[1].text.indexOf('The original request was:\nresearch sleep') >= 0, 'and the original request');
    A.ok(R.calls[1].text.indexOf('YOUR STANDING BRIEF FOR THIS STATION:\nPress style.') >= 0, 'and the RECEIVING dock\'s standing brief');
    A.eq(s.hops[1].input, 'findings A — plus my note', 'the next hop\'s input is the post-edit text');
    A.eq(s.state, 'paused', 'paused again after the writer');
    A.eq(s.paused.next, { kind: 'outbox' }, 'the writer ships to the OUTBOX');

    /* ---- RERUN: same input, CURRENT brief, appended with rerun:true; its cost counts ---- */
    R.plan.dockBays.find(b => b.agentId === 'writer').brief = 'Tabloid style.';
    R.router.setPlan(R.plan);
    A.ok(R.st.rerun(s.id).ok, 'rerun answers ok');
    s = await settle(R, s.id);
    A.eq(s.hops.length, 3, 'the re-run appends a hop');
    A.eq(s.hops[2].rerun, true); A.eq(s.hops[2].pass, 1, 'a re-run keeps the pass number');
    A.eq(s.hops[2].input, s.hops[1].input, 'on the SAME input');
    A.ok(R.calls[2].text.indexOf('Tabloid style.') >= 0 && R.calls[2].text.indexOf('Press style.') < 0, 'with the dock\'s CURRENT brief');
    A.eq(R.calls[2].edited, true, 'a re-run of an edited handoff still says so');
    A.eq(s.totalUsd, 0.5, 'every run counts: 0.1 + 0.2 + 0.2');

    /* ---- REWIND to hop 1: drops hops >= 1, re-runs writer on its original input; the dropped money stays spent ---- */
    const rw = R.st.rewind(s.id, { hop: 1 });
    A.ok(rw.ok, 'rewind answers ok');
    A.eq(rw.session.hops.length, 1, 'hops >= 1 dropped');
    A.eq(rw.session.droppedUsd, 0.4, 'the dropped hops\' cost is recorded');
    s = await settle(R, s.id);
    A.eq(s.hops.length, 2); A.eq(s.hops[1].agentId, 'writer'); A.eq(s.hops[1].rerun, false);
    A.eq(s.hops[1].input, 'findings A — plus my note', 'the rewound hop re-runs on that hop\'s original input');
    A.eq(s.hops[0].usd, 0.1, 'earlier hops and their cost stay');
    A.eq(s.totalUsd, 0.7, 'dropped hops stay counted in the session spend (0.1 + 0.2 + 0.2 dropped + 0.2 new)');
    A.eq(R.st.rewind(s.id, { hop: 9 }).ok, false, 'rewind to a hop that never ran is refused');

    /* ---- continue to the OUTBOX: done, final = what shipped ---- */
    R.st.continue(s.id, {});
    s = await settle(R, s.id);
    A.eq(s.state, 'done', 'continuing past the last dock finishes the test');
    A.eq(s.final, s.hops[1].output, 'final is what reached the OUTBOX');
    A.eq(s.hops[1].edited, false, 'an unedited continue is not stamped edited');
    A.eq(R.st.continue(s.id, {}).ok, false, 'continue on a finished test is refused');
    A.eq(R.st.stop(s.id).ok, false, 'stop on a finished test is refused');
  }

  /* ---- PAUSE NONE: runs to the end without stopping ---- */
  {
    const R = rig(twoDock(), {});
    const r = R.st.start({ line: R.lineId, text: 'go', pause: 'none' });
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'done', 'pause:none runs to the OUTBOX');
    A.eq(s.hops.map(h => h.agentId), ['research', 'writer']);
    A.eq(s.final, 'writer output'); A.eq(s.hops[0].sent, 'research output');
  }

  /* ---- PAUSE ON AN EDGE LIST: only the listed edge stops ---- */
  {
    const R = rig(twoDock(), {});
    const r = R.st.start({ line: R.lineId, text: 'go', pause: ['writer>outbox'] });
    let s = await settle(R, r.session.id);
    A.eq(s.state, 'paused', 'pauses on the listed edge');
    A.eq(s.hops.length, 2, 'research>writer was not listed, so it ran straight through');
    A.eq(s.paused.next, { kind: 'outbox' });
    A.ok(R.st.pause(s.id, { pause: 'every' }).ok, 'the pause rule can change mid-test');
    A.eq(R.st.pause(s.id, { pause: 'bogus' }).ok, false, 'a bad rule is refused');
    A.ok(R.st.stop(s.id).ok, 'stop while paused');
    s = R.st.get(s.id).session;
    A.eq(s.state, 'stopped'); A.eq(s.error, null, 'an owner stop is not an error'); A.eq(s.paused, null);
    A.ok(R.st.start({ line: R.lineId, text: 'next' }).ok, 'a stopped test frees the station for a new one');
  }

  /* ---- THE NEXT DOCK IS RESOLVED AT CONTINUE TIME: a bay added while paused receives the crate ---- */
  {
    const R = rig(twoDock(), {});
    const r = R.st.start({ line: R.lineId, text: 'go' });
    let s = await settle(R, r.session.id);
    A.eq(s.paused.next.agentId, 'writer', 'preview before the edit: writer');
    const p3 = P.compileRoutingPlan(threeDock());
    A.ok(R.router.setPlan(p3).ok, 'the floor re-posts with an editor bay added');
    A.eq(P.lineOf(p3, 'research'), R.lineId, 'fixture: the line keeps its id (its oldest machine is unchanged)');
    // (sweep 2026-09-25) the paused VIEW re-previews on read: it names the new bay before CONTINUE, not the old next dock
    const fresh = R.st.get(s.id).session;
    A.eq(fresh.paused.next.agentId, 'editor', 'a GET while paused previews the NEW next dock from the current plan');
    A.eq(fresh.paused.text, s.paused.text, 'the paused handoff text itself is untouched');
    A.eq(fresh.updatedAt, s.updatedAt, 'a preview refresh is not an edit (updatedAt unchanged, so the panel keeps the owner\'s draft)');
    R.st.continue(s.id, {});
    s = await settle(R, s.id);
    A.eq(s.hops[1].agentId, 'editor', 'the crate rode into the NEW bay (resolved from the current plan)');
    A.eq(s.paused.next.agentId, 'writer');
  }

  /* ---- VERDICT LOOP: reviewer says revise -> back to drafter (pass 2) -> reviewer approves -> publisher ---- */
  {
    let reviews = 0;
    const R = rig(loopFloor({ maxIter: 3, when: 'approved' }), {
      drafter: (h) => ({ text: 'draft ' + (/LOOP — pass/.test(h.text) ? 'v2' : 'v1'), usd: 0.01 }),
      reviewer: () => ({ text: 'notes\nVERDICT: ' + (++reviews === 1 ? 'revise' : 'approved'), usd: 0.01 }),
      publisher: { text: 'published', usd: 0.01 }
    });
    const r = R.st.start({ line: R.lineId, text: 'write a post' });
    A.ok(r.ok, 'loop floor starts: ' + r.error);
    let s = await settle(R, r.session.id);
    A.eq(s.hops[0].agentId, 'drafter');
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.hops[1].agentId, 'reviewer');
    A.ok(/VERDICT: approved/.test(R.calls[1].text), 'the reviewer is told to end with the VERDICT line (verdict brief via hopTurn)');
    A.eq(s.hops[1].verdict, 'revise', 'the hop records the parsed verdict');
    A.eq(s.paused.next, { kind: 'agent', agentId: 'drafter', back: true }, 'the preview says the crate goes BACK round the gate');
    A.ok(/^\[LOOP — pass 1 of 3 round the gate at /.test(s.paused.text), 'the paused text carries the executor\'s loop marker: ' + s.paused.text.slice(0, 60));
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.hops[2].agentId, 'drafter'); A.eq(s.hops[2].pass, 2, 'the drafter is on pass 2');
    A.eq(s.hops[2].output, 'draft v2');
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.hops[3].agentId, 'reviewer'); A.eq(s.hops[3].pass, 2); A.eq(s.hops[3].verdict, 'approved');
    A.eq(s.paused.next, { kind: 'agent', agentId: 'publisher', back: false }, 'approved -> the done lane');
    R.st.pause(s.id, { pause: 'none' });
    R.st.continue(s.id, {}); s = await settle(R, s.id);
    A.eq(s.state, 'done'); A.eq(s.final, 'published', 'the publisher shipped to the OUTBOX');
    A.eq(s.hops.map(h => h.agentId + ':' + h.pass), ['drafter:1', 'reviewer:1', 'drafter:2', 'reviewer:2', 'publisher:1']);
  }

  /* ---- LINE BUDGET over the WHOLE session: re-runs count; the refusal ends in 'stopped' with an honest error ---- */
  {
    const R = rig(twoDock(), { research: { text: 'r', usd: 0.4 }, writer: { text: 'w', usd: 0.4 } }, { limits: { maxUsdPerMessage: 1 } });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    let s = await settle(R, r.session.id);
    A.eq(s.limits.maxUsdPerMessage, 1, 'the line\'s own LINE BUDGET applies');
    R.st.rerun(s.id); s = await settle(R, s.id);
    R.st.rerun(s.id); s = await settle(R, s.id);
    A.eq(s.totalUsd, 1.2, 'three runs spent $1.20 (the cap is enforced pre-run, within one run\'s spend)');
    const rr = R.st.rerun(s.id);
    A.ok(rr.ok, 'the verb is accepted — the executor refuses honestly');
    s = await settle(R, s.id);
    A.eq(s.state, 'stopped', 'over budget -> stopped');
    A.ok(/reached its \$1\.00 limit/.test(s.error) && /re-runs included/.test(s.error), 'an honest error: ' + s.error);
    A.eq(s.hops.length, 3, 'nothing ran past the cap');
  }

  /* ---- a failing dock -> failed with an honest error; RE-RUN recovers ---- */
  {
    let n = 0;
    const R = rig(twoDock(), { research: () => (++n === 1 ? { text: '', error: 'provider 500' } : { text: 'ok now', usd: 0.01 }) });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    let s = await settle(R, r.session.id);
    A.eq(s.state, 'failed'); A.ok(/RESEARCH failed: provider 500/.test(s.error), 'failed says why: ' + s.error);
    A.eq(s.hops[0].error, s.error, 'the failed hop carries its error');
    A.ok(R.st.rerun(s.id).ok, 'a failed step can be re-run');
    s = await settle(R, s.id);
    A.eq(s.state, 'paused'); A.eq(s.hops[1].output, 'ok now'); A.eq(s.error, null);
  }

  /* ---- SINGLE (try this step): one dock, then done, with the next dock only previewed ---- */
  {
    const R = rig(twoDock({ writer: 'Press style.' }), { writer: { text: 'polished', usd: 0.05 } });
    const r = R.st.start({ line: R.lineId, text: 'raw findings', startAt: 'writer', single: true, original: 'research sleep' });
    A.ok(r.ok, 'try-this-step starts at a later dock: ' + r.error);
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'done'); A.eq(s.hops.length, 1); A.eq(s.hops[0].agentId, 'writer');
    A.eq(R.calls[0].entry, false, 'a later dock is handed the text as a handoff');
    A.ok(R.calls[0].text.indexOf('The upstream stage (research) produced:\nraw findings') >= 0, 'from its real upstream dock');
    A.ok(R.calls[0].text.indexOf('The original request was:\nresearch sleep') >= 0, 'with the (additive) original request');
    A.eq(s.paused, null); A.eq(s.final, null, 'nothing reached the OUTBOX');
    A.eq(s.preview, { afterHop: 0, text: 'polished', next: { kind: 'outbox' } }, 'the next step is PREVIEWED only');
    A.eq(R.st.start({ line: R.lineId, text: 'x', startAt: 'nobody' }).ok, false, 'startAt must crew a dock on the line');
    A.eq(R.st.start({ line: 'nope', text: 'x' }).ok, false, 'an unknown line is refused');
    A.eq(R.st.start({ line: R.lineId, text: '' }).ok, false, 'an empty job is refused');
    A.eq(R.st.start({ line: R.lineId, text: 'x'.repeat(4001) }).ok, false, 'a job over 4000 chars is refused');
  }

  /* ---- RESTART ROUND-TRIP: paused stays paused and continues; running comes back failed and re-runs ---- */
  {
    const store = memStore();
    const R = rig(twoDock(), {}, { store });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    let s = await settle(R, r.session.id);
    A.eq(s.state, 'paused');
    const st2 = R.mk();   // a fresh engine over the same store = a sidecar restart
    const back = st2.get(s.id).session;
    A.eq(back.state, 'paused', 'a paused session comes back paused');
    A.eq(back.paused, s.paused, 'with the same handoff and preview');
    st2.continue(s.id, { text: 'edited after restart' });
    await st2.settled(s.id);
    const s2 = st2.get(s.id).session;
    A.eq(s2.hops[1].agentId, 'writer', 'and continues after the restart');
    A.eq(s2.hops[0].edited, true);

    // a session caught RUNNING when the process died
    // the first writer run never returns: that process "died" — only the restarted engine's re-run completes
    let writers = 0; const never = new Promise(() => {});
    const store3 = memStore();
    const R3 = rig(twoDock(), {}, { store: store3, gate: (h) => (h.agentId === 'writer' && ++writers === 1 ? never : null) });
    const r3 = R3.st.start({ line: R3.lineId, text: 'go' });
    let s3 = await settle(R3, r3.session.id);
    R3.st.continue(s3.id, {});
    A.eq(R3.st.get(s3.id).session.state, 'running', 'the writer is mid-run');
    const st4 = R3.mk();   // restart while running
    const dead = st4.get(s3.id).session;
    A.eq(dead.state, 'failed', 'a session that was RUNNING comes back failed');
    A.ok(/restarted while WRITER was working/.test(dead.error), 'with an honest error: ' + dead.error);
    A.eq(dead.running, null);
    A.ok(st4.rerun(s3.id).ok, 'the lost step can be re-run');
    await st4.settled(s3.id);
    const again = st4.get(s3.id).session;
    A.eq(again.hops[again.hops.length - 1].agentId, 'writer', 'the re-run runs the dock that was lost');
    A.eq(again.state, 'paused');
  }

  /* ---- STOP while running: aborts the run, the hop's spend is still recorded ---- */
  {
    let release; const hold = new Promise(res => { release = res; });
    const R = rig(twoDock(), { research: (h) => ({ text: h.signal.aborted ? 'partial' : 'full', usd: 0.03 }) }, { gate: () => hold });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    const st = R.st.stop(r.session.id);
    A.eq(st.session.state, 'stopped', 'stop answers stopped at once');
    A.eq(R.calls[0].signal.aborted, true, 'the in-flight run was aborted');
    A.eq(R.st.rerun(r.session.id).ok, false, 'a stopped step still winding down cannot be re-run yet');
    release();
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'stopped'); A.eq(s.hops.length, 1); A.eq(s.totalUsd, 0.03, 'the aborted run\'s spend is recorded');
    A.ok(/stopped by you/.test(s.hops[0].error), 'the hop says it was stopped');
  }

  /* ---- E-STOP: the engine's inflight map is halt.js-shaped ---- */
  {
    let release; const hold = new Promise(res => { release = res; });
    const R = rig(twoDock(), {}, { gate: () => hold });
    const r = R.st.start({ line: R.lineId, text: 'go' });
    const { killAll } = require('../sidecar/halt.js');
    A.eq(killAll(null, R.st.inflight), 1, 'E-STOP reaches the step-test run');
    release();
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'stopped'); A.ok(/E-STOP/.test(s.error), 'says E-STOP: ' + s.error);
  }

  /* ---- (sweep 2026-09-25) the owner reads display names, never raw agent ids ---- */
  {
    const noOut = twoDock();
    noOut.props = noOut.props.filter(p => p.t !== 'outbox');
    noOut.belts = noOut.belts.filter(b => b.x < 8);
    const R = rig(noOut, {}, { });
    const r = R.st.start({ line: R.lineId, text: 'go', pause: 'none' });
    A.ok(r.ok, 'a line with no OUTBOX still starts: ' + r.error);
    const s = await settle(R, r.session.id);
    A.ok(/the belt from WRITER does not reach the OUTBOX/.test(s.ended || ''), 'the dead end names the agent by its label, not its id: ' + s.ended);
    A.ok(!/the belt from writer /.test(s.ended || ''), 'the raw id is not what the owner reads');
  }

  A.report('routing.steptest');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
