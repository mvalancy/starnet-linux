/* test/chain.multibay.test.js — the chain executor keyed by DOCK (multi-bay agents, 2026-09-22).

   Andrew's ruling: "never run an agent twice" becomes "never run a DOCK twice". On the acceptance floor
   INBOX → quill@A → mira@B → quill@C → OUTBOX the entry run (quill@A) is followed by EXACTLY two hops —
   mira@B then quill@C — and the third stage's turn carries bay C's brief, never bay A's. The hop and $
   ceilings still bound the line; the same DOCK coming round again outside a loop pass is still refused. */
'use strict';
const A = require('./_assert.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const F = require('./_multibay-floor.js');

// the runner wired EXACTLY like sidecar/index.js wires it
function wired(router, extra) {
  const events = [], calls = [];
  const runner = makeChainRunner(Object.assign({
    nextAgent: (a, ctx) => router.chainNext(a, ctx),
    stepAgent: (a, ctx) => router.chainStep(a, ctx),
    fanSiblings: (a) => router.fanSiblings(a),
    stepDock: (d, ctx) => router.chainStepDock(d, ctx),
    fanSiblingsDock: (d) => router.fanSiblingsDock(d),
    entryDockOf: (a) => router.entryDockOf(a),
    stageBrief: (a, d) => router.stageBrief(a, d),
    lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d),
    lineLimits: (l) => router.lineLimits(l),
    emit: (n, p) => events.push({ n, p }),
    runAgent: async (h) => { calls.push(h); return { text: 'OUT(' + h.agentId + '@' + (h.dockId || '?') + ')', usd: 0.01 }; }
  }, extra || {}));
  return { runner, events, calls };
}

(async function () {
  const router = makeRouter();
  A.ok(router.setPlan(F.plan()).ok, 'the acceptance floor arms');
  const line = router.lineOfAgent('quill', 'p2');

  /* ---- the acceptance line: 2 hops after the entry, in order, bay C briefed as bay C ---- */
  {
    const { runner, events, calls } = wired(router);
    const out = await runner.advance({ agentId: 'quill', dockId: 'p2', text: 'DRAFT by quill@A', originalText: 'write about otters', lineId: line });
    A.eq(out.stopped, null, 'the line runs to its end — no "loops back to quill" stop');
    A.eq(out.hops.map(h => h.agentId + '@' + h.dockId), ['mira@p3', 'quill@p4'], 'exactly two hops after the entry: mira@B then quill@C');
    A.eq(calls.map(c => c.dockId), ['p3', 'p4'], 'every hop runs AT its bay (runAgent names the dock)');
    A.ok(calls[1].text.indexOf(F.BRIEF.C) >= 0, 'the third stage (quill@C) is handed bay C’s brief');
    A.ok(calls[1].text.indexOf(F.BRIEF.A) < 0, '…and NOT bay A’s');
    A.ok(calls[0].text.indexOf(F.BRIEF.B) >= 0, 'mira@B is handed bay B’s brief');
    A.eq(calls[1].fromDock, 'p3', 'quill@C knows it was handed the crate by bay B');
    A.eq(out.agentId + '@' + out.dockId, 'quill@p4', 'the delivered answer is quill’s, from bay C');
    const placed = events.filter(e => e.n === 'workitem.placed').map(e => e.p);
    A.eq(placed.map(p => p.dockId + '<' + p.fromDock), ['p3<p2', 'p4<p3'], 'each hop crate names its bay and the bay it left (additive fields)');
    A.ok(placed.every(p => p.kind === 'chain' && p.lineId === line), 'hop crates keep kind:chain + the line');
  }
  /* a seed with no dockId starts at the agent's ENTRY dock */
  {
    const { runner } = wired(router);
    const out = await runner.advance({ agentId: 'quill', text: 'x', lineId: line });
    A.eq(out.hops.map(h => h.dockId), ['p3', 'p4'], 'no seed dock -> entry dock (bay A) -> the same two hops');
  }
  /* WITHOUT the dock seams the agent-keyed executor would refuse the same line — the bug the dock key fixes */
  {
    const { runner } = wired(router, { stepDock: undefined, fanSiblingsDock: undefined, entryDockOf: undefined });
    const out = await runner.advance({ agentId: 'quill', text: 'x', lineId: line });
    A.eq(out.hops.map(h => h.agentId), ['mira'], 'agent-keyed: one hop, then…');
    A.eq(out.stopped, 'the line loops back to quill', '…the old "never run an agent twice" stop (why the dock key exists)');
  }
  /* a direct order (no lineId) is still terminal */
  {
    const { runner, calls } = wired(router);
    const out = await runner.advance({ agentId: 'quill', dockId: 'p2', text: 'x' });
    A.eq(calls.length, 0, 'no lineId -> nothing downstream runs');
    A.eq(out.stopped, null, 'terminal, silently');
  }
  /* the SAME dock twice outside a loop is still refused (never run a DOCK twice) */
  {
    const seq = [{ dockId: 'p3', agentId: 'mira' }, { dockId: 'p3', agentId: 'mira' }];
    const { runner } = wired(router, { stepDock: () => seq.shift() || null });
    const out = await runner.advance({ agentId: 'quill', dockId: 'p2', text: 'x', lineId: line });
    A.eq(out.hops.length, 1, 'the dock ran once');
    A.eq(out.stopped, 'the line loops back to mira', 'a re-posted plan that sends work back to the same DOCK is refused');
  }
  /* the hop ceiling still bounds a long multi-dock line */
  {
    const { runner } = wired(router, { maxHops: 1 });
    const out = await runner.advance({ agentId: 'quill', dockId: 'p2', text: 'x', lineId: line });
    A.eq(out.hops.length, 1, 'maxHops 1 -> one hop');
    A.ok(/longer than 1 stages/.test(String(out.stopped)), 'the hop ceiling speaks: ' + out.stopped);
  }
  /* a LOOP gate in dock mode: backTo is a DOCK; passes re-run it, then the done lane continues */
  {
    let n = 0;
    const step = (d) => {
      if (d === 'p2') return { dockId: 'p3', agentId: 'mira' };
      if (d === 'p3') return { loop: '9,0', max: 2, backTo: { dockId: 'p2', agentId: 'quill' }, when: null, esc: null, next: { dockId: 'p4', agentId: 'quill' } };
      if (d === 'p4') return null;
      n++; return null;
    };
    const { runner, calls } = wired(router, { stepDock: step });
    const out = await runner.advance({ agentId: 'quill', dockId: 'p2', text: 'x', lineId: line });
    A.eq(calls.map(c => c.dockId), ['p3', 'p2', 'p3', 'p2', 'p3', 'p4'], 'two passes back to bay A, then out to bay C');
    A.eq(out.stopped, null, 'the loop ends on its done lane');
    A.ok(calls[5].text.indexOf(F.BRIEF.C) >= 0 && calls[1].text.indexOf(F.BRIEF.A) >= 0, 'each pass is briefed as the bay it runs at');
    void n;
  }
  A.report('chain.multibay');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
