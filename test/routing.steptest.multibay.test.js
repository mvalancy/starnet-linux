/* test/routing.steptest.multibay.test.js — the STEP-THROUGH TEST keyed by DOCK (multi-bay agents, 2026-09-22).

   The step test's seams wired exactly like sidecar/index.js (stepDock/peekDock/dockRef + the dock-aware
   brief/line/ship-out readers) over the acceptance floor INBOX → quill@A → mira@B → quill@C → OUTBOX.
   Locks: a full run is EXACTLY three hops in order with bay C's brief in the third turn; startAt may name a
   dockId OR an agentId (agent -> entry dock); a pause edge in dock form "p3>p4" and the old agent form
   "mira>quill" both pause at B→C; every hop and the paused preview carry their dockId. */
'use strict';
const A = require('./_assert.js');
const { makeStepTest } = require('../sidecar/routing/steptest.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const F = require('./_multibay-floor.js');

let T = 5000; const clock = () => (T += 10);
function rig() {
  const router = makeRouter();
  if (!router.setPlan(F.plan()).ok) throw new Error('plan refused');
  const calls = [];
  const runDock = async (h) => { calls.push(h); return { runId: 'run' + calls.length, tools: 0, text: 'OUT' + calls.length + ' ' + h.agentId + '@' + h.dockId, usd: 0.01 }; };
  const st = makeStepTest({
    runDock, now: clock, getTag: () => 'general', label: a => a.toUpperCase(),
    plan: {
      get: () => router.getPlan(),
      step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
      stepDock: (d, ctx) => router.chainStepDock(d, ctx), peekDock: (d, ctx) => router.chainPeekDock(d, ctx),
      dockRef: (ref, line) => router.dockRef(ref, line),
      entryDock: (line, text) => { const r = router.resolveDock({ tag: 'general', text, lineId: line }); return r && router.lineOriginFor(r.agentId, r.dockId) === line ? r : null; },
      lineOf: (a, d) => router.lineOfAgent(a, d), stageBrief: (a, d) => router.stageBrief(a, d),
      loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), lineLimits: l => router.lineLimits(l),
      shipsToOutbox: (a, d) => router.chainShipsToOutbox(a, d)
    }
  });
  return { st, router, calls, line: router.lineOfAgent('quill', 'p2') };
}
const settle = async (R, id) => { for (let i = 0; i < 50; i++) { await R.st.settled(id); const s = R.st.get(id).session; if (s.state !== 'running') return s; } return R.st.get(id).session; };

(async () => {
  /* ---- RUN TO THE END: three hops, in order, each at its bay; bay C's brief in the third turn ---- */
  {
    const R = rig();
    const r0 = R.st.start({ line: R.line, text: 'write about otters', pause: 'none' });
    A.ok(r0.ok, 'start ok: ' + r0.error);
    A.eq(r0.session.running, { agentId: 'quill', dockId: 'p2', since: r0.session.running.since }, 'the entry dock (bay A) is working, named');
    const s = await settle(R, r0.session.id);
    A.eq(s.state, 'done', 'the line runs to the OUTBOX');
    A.eq(s.hops.map(h => h.agentId + '@' + h.dockId), ['quill@p2', 'mira@p3', 'quill@p4'], 'EXACTLY three hops: quill@A, mira@B, quill@C');
    A.eq(R.calls.map(c => c.dockId), ['p2', 'p3', 'p4'], 'runDock is told each hop’s bay');
    A.ok(s.hops[2].turn.indexOf(F.BRIEF.C) >= 0, 'the third hop’s turn carries bay C’s brief');
    A.ok(s.hops[2].turn.indexOf(F.BRIEF.A) < 0, '…not bay A’s');
    A.ok(s.hops[1].turn.indexOf(F.BRIEF.B) >= 0, 'the second hop’s turn carries bay B’s brief');
    A.eq(s.hops.map(h => h.pass), [1, 1, 1], 'quill@C is a FIRST pass at bay C, not a second pass of quill');
    A.eq(s.final, 'OUT3 quill@p4', 'the delivered result is bay C’s');
  }
  /* ---- startAt: a dockId, or an agentId (-> its entry dock on this line) ---- */
  {
    const R = rig();
    const r = R.st.start({ line: R.line, text: 'EDITED DRAFT', startAt: 'p4', single: true });
    A.ok(r.ok, 'startAt a dockId is accepted: ' + r.error);
    const s = await settle(R, r.session.id);
    A.eq(s.hops.map(h => h.agentId + '@' + h.dockId), ['quill@p4'], 'try-this-step at bay C runs quill AT bay C');
    A.ok(s.hops[0].turn.indexOf(F.BRIEF.C) >= 0, 'a mid-line dock is handed its OWN brief in the handoff turn');
    A.ok(s.hops[0].turn.indexOf('The upstream stage (mira)') >= 0, 'its upstream is the dock feeding bay C (mira), not quill');
    A.eq(s.preview.next, { kind: 'outbox' }, 'bay C previews the OUTBOX');
    const R2 = rig();
    const r2 = R2.st.start({ line: R2.line, text: 'job', startAt: 'quill', single: true });
    const s2 = await settle(R2, r2.session.id);
    A.eq(s2.hops[0].dockId, 'p2', 'startAt an agentId resolves to its entry dock (bay A)');
    A.eq(s2.preview.next, { kind: 'agent', agentId: 'mira', back: false, dockId: 'p3' }, 'the preview names the next DOCK');
    const R3 = rig();
    const bad = R3.st.start({ line: 'nope', text: 'x', startAt: 'p4' });
    A.eq(bad.ok, false, 'an unknown line is refused');
  }
  /* ---- pause edges: dock form and the old agent form both pause at B→C ---- */
  for (const edge of ['p3>p4', 'mira>quill']) {
    const R = rig();
    const r = R.st.start({ line: R.line, text: 'job', pause: [edge] });
    const s = await settle(R, r.session.id);
    A.eq(s.state, 'paused', 'pause edge "' + edge + '" pauses');
    A.eq(s.hops.map(h => h.dockId), ['p2', 'p3'], '…after bay B (' + edge + ')');
    A.eq(s.paused.next, { kind: 'agent', agentId: 'quill', back: false, dockId: 'p4' }, '…with bay C next (' + edge + ')');
    R.st.continue(s.id, {});
    const s2 = await settle(R, s.id);
    A.eq(s2.state, 'done', 'continue runs bay C and ships (' + edge + ')');
    A.eq(s2.hops.length, 3, 'three hops total (' + edge + ')');
  }
  A.report('routing.steptest.multibay');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
