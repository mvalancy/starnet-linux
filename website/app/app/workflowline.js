/* frontend/app/workflowline.js — the WORKFLOW PANEL's pure readings of one conveyor line (2026-09-22).

   The docked Workflow panel in REFIT (build.js mounts it, workflowpanel.js draws it) says four things
   about a line: the ORDER its docks run in, a plain-English "how it runs" sentence, a readiness pill
   naming what is missing, and a cost estimate. Every one of those is a claim about what the harness
   will do, so every one is computed HERE, from the SAME compiled plan the sidecar routes by
   (Pipeline.compileRoutingPlan -> plan.reach / plan.chains / Pipeline.chainStep), and nothing else.

   PURE, zero-dep, UMD (the pipeline.js idiom): params in, plain data out, no DOM, no clock, no module
   state — so test/workflow-line.test.js can hold every sentence to the truthful-telemetry law.

   ORDER AND HAND-OFFS ARE COMPILED, NEVER INFERRED (2026-09-23 playtest). A crewed dock's position and every
   hand-off it claims come from the real plan's dock maps (reachDock / dockChains / chainStepDock). An UNCREWED
   bay is not a dock of the real plan, so the floor is compiled once more with probe agents on the uncrewed bays
   (probePlan) to place it — it still says "not routed until it has an agent" and hands off to nothing. A dock no
   INBOX reaches even then is listed as NOT CONNECTED (one 'apart' group), never chained in bay order, and
   neighbours() reads prev/next off compiled edges only — two parallel bays are siblings, never a sequence. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.WorkflowLine = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- role copy: the verb a dock "does" in the sentence + its starter chips ----------
     Keys are WorldModel.BAY_ROLES (the dock's stamped role). A starter fills DOES (the standing brief)
     and HANDS OFF (the phrase composed into the brief the agent receives — Pipeline.composeStageBrief).
     A REVIEWER's starters end with the VERDICT line the loop gate parses (routing/verdict.js). */
  const ROLE = {
    RESEARCHER: { verb: 'researches it', starters: [
      ['Find sources', 'Find three credible, recent sources on the task. Only include claims you can back with a link.', 'bullet notes with links'],
      ['Compare options', 'Compare the main options for the task in a short table: cost, pros, cons.', 'a comparison table'],
      ['Pull key numbers', 'Pull the 5 most important numbers on the topic, each with its source.', '5 numbers with sources']] },
    WRITER: { verb: 'writes it up', starters: [
      ['Newsletter blurb', 'Turn the notes into a 200-word newsletter blurb. Warm, plain English, no jargon. Keep every link.', 'a 200-word draft'],
      ['Bullet summary', 'Summarize the notes as 5 punchy bullets a busy reader can skim in 20 seconds.', '5 bullets'],
      ['Email draft', 'Write a short email sharing the findings with my team. Friendly, under 150 words.', 'an email draft']] },
    REVIEWER: { verb: 'reviews it', starters: [
      ['Fact-check + verdict', 'Check every claim in the draft against the notes. End with VERDICT: approved, or VERDICT: revise and exactly what to fix.', 'the approved draft'],
      ['Tone & clarity', 'Check the draft reads clearly for a non-expert. End with VERDICT: approved, or VERDICT: revise with the fixes.', 'the approved draft']] },
    ENGINEER: { verb: 'builds it', starters: [
      ['Implement it', 'Make the change the task asks for. Keep it small, run the tests, and list the files you touched.', 'a summary of the change and files touched'],
      ['Review code', 'Read the change for bugs and risky edge cases. List each problem with its file and line.', 'a list of issues']] },
    GENERALIST: { verb: 'handles it', starters: [
      ['Do the task', 'Do what the task asks, then summarize what you did in plain words.', 'the finished result'],
      ['Plan it', 'Break the task into 3 to 5 concrete steps and say what each one needs.', 'a short plan']] },
    CREW: { verb: 'works its share', starters: [
      ['Work your share', 'Handle your share of the incoming work and report the result plainly.', 'your part of the result']] },
    SHIPPER: { verb: 'finishes and ships it', starters: [
      ['Polish & ship', 'Turn the input into the final deliverable: clean formatting, a clear title, nothing missing.', 'the final deliverable']] },
    ANALYST: { verb: 'analyzes it', starters: [
      ['Combine branches', 'Combine the parts you receive into one answer. Note anywhere they disagree.', 'one combined answer']] },
    FIXER: { verb: 'fixes what the loop could not', starters: [
      ['Take over', 'The review loop gave up on this. Read the history, fix what is still wrong, and say what you changed.', 'the fixed result']] },
  };
  const GENERIC = { verb: 'works on it', starters: [
    ['Do the task', 'Do what the task asks, then summarize what you did in plain words.', 'the finished result'],
    ['Summarize', 'Summarize what you receive in 5 short bullets.', '5 bullets']] };
  const roleInfo = role => ROLE[role] || GENERIC;
  const starters = role => roleInfo(role).starters.map(s => ({ label: s[0], does: s[1], hands: s[2] }));

  const key = (x, y) => x + ',' + y;

  /* ---------- lineFlow(plan, comp, P, props) -> the line's run order ----------
     plan  = the compiled RoutingPlan (LOCAL frame), comp = one Pipeline.lineComponents entry (same frame),
     P     = Pipeline (chainStep + _internals), props = the geometry's props (same frame; junction prop ids).
     Returns {
       cols:  [ { docks:[dock…], mode:'single'|'all'|'turns'|'oneof', gate?:gateNode } ]  in run order
              ('all' = a fan-out: every dock runs · 'turns' = a plain splitter · 'oneof' = a FILTER by content)
       docks: { propId -> dock }   dock = { propId, agentId, role, bound, routed, col, deadEnd, reachedBy }
       gates: [ { kind:'loop'|'join', key, propId, after:[propId…], backTo:propId|null, backAgent, max, when,
                  next:propId|null, timeoutMin } ]
       order: [propId…] every dock in strip order (the contract's previous/next)
       outbox: { propId|null, reached:bool }, trigger: { propId|null } }
     Order law: a BOUND dock's column is the compiled chain's (chainStep from the entry docks, loop back
     edges excluded). An UNCREWED dock sits where the physical belt walk meets it, flagged routed:false.
     KEYED BY DOCK (multi-bay agents, 2026-09-22): one agent may crew several bays, so the walk reads the plan's
     DOCK layer (reachDock / dockChains / Pipeline.chainStepDock) — writer@A → editor@B → writer@C is three
     columns with the writer in two of them. A plan without the dock layer derives it (Pipeline.dockLayer). */
  function lineFlow(plan, comp, P, props) {
    const out = { cols: [], docks: {}, gates: [], order: [], edges: {}, probeIn: {}, probeNext: {}, outbox: { propId: null, reached: false, reachedOnceCrewed: false }, trigger: { propId: null } };
    if (!comp) return out;
    out.trigger.propId = (comp.intakes && comp.intakes[0]) || null;
    out.outbox.propId = (comp.outboxes && comp.outboxes[0]) || null;
    const bays = comp.bays || [];
    for (const b of bays) {
      out.docks[b.propId] = { propId: b.propId, agentId: b.agentId || null, role: b.role || null,
        bound: !!b.agentId, routed: false, col: null, deadEnd: false, reachedBy: null, detached: false };
    }
    const mine = pid => !!out.docks[pid];
    const layerOf = pl => (P && P.dockLayer && pl) ? P.dockLayer(pl) : { dockChains: {}, reachDock: {} };
    const real = layerOf(plan);

    // 1. THE REAL PLAN decides what is ROUTED today, whether the line reaches the OUTBOX, and every hand-off a
    //    CREWED dock makes (edges). Nothing here comes from belt order or bay order.
    const R = walkCompiled(plan, comp, P, props, bays.filter(b => b.agentId && real.reachDock[b.propId]).map(b => b.propId));
    for (const pid in R.col) if (out.docks[pid] && out.docks[pid].bound) out.docks[pid].routed = true;
    if (R.outboxReached) out.outbox.reached = true;
    for (const b of bays) {
      if (!b.agentId) continue;
      const ch = real.dockChains[b.propId];
      out.edges[b.propId] = ch ? (ch.next || []).filter(mine) : [];
      if (ch && !ch.outbox && ch.deadEnd && !(ch.next || []).length && !ch.gated) out.docks[b.propId].deadEnd = true;
    }
    // no INBOX-fed run at all: the OUTBOX claim is still the compiled one — a crewed dock whose own chain ships out
    if (!R.outboxReached && !Object.keys(R.col).length) for (const b of bays) { const ch = b.agentId && real.dockChains[b.propId]; if (ch && ch.outbox) out.outbox.reached = true; }

    // 2. THE LAYOUT (where each dock sits in the strip) comes from the compiler too. An UNCREWED bay is not a
    //    dock of the real plan, so the floor is compiled once more with a probe agent on every uncrewed bay of
    //    this line: the columns are then the compiler's own answer for "once every bay is crewed". An uncrewed
    //    dock stays routed:false and hands off to nothing (its contract says "decided once it has an agent");
    //    a crewed dock's hand-offs are still read ONLY off the real plan (step 1).
    const probe = probePlan(plan, comp, P, props);
    const pl = probe ? layerOf(probe) : real;
    const L = walkCompiled(probe || plan, comp, P, props, bays.filter(b => (probe || b.agentId) && pl.reachDock[b.propId]).map(b => b.propId));
    for (const pid in L.col) if (out.docks[pid]) { out.docks[pid].col = L.col[pid]; out.docks[pid].reachedBy = L.reachedBy[pid] || null; }
    out.gates = L.gates;
    // an uncrewed dock's upstream (its GETS) is the probe compile's — the only compiled answer for a dock with no agent
    if (probe) for (const b of bays) {
      if (b.agentId) continue;
      for (const x of bays) { const ch = pl.dockChains[x.propId]; if (x.propId !== b.propId && ch && (ch.next || []).indexOf(b.propId) >= 0) (out.probeIn[b.propId] = out.probeIn[b.propId] || []).push(x.propId); }
    }
    /* CONNECTED, JUST NOT CREWED (sweep 2026-09-25). The real plan routes nothing through an uncrewed bay, so a line
       whose belts DO run INBOX → bays → OUTBOX read "the last step is not connected to the OUTBOX" and a crewed bay
       before an uncrewed one read "nowhere — connect a belt" — telling a newcomer to lay belts that are already there.
       The probe compile (every uncrewed bay given a stand-in agent) is the compiler's answer for "once every bay is
       crewed": reachedOnceCrewed + probeNext carry it, so the copy can say what is really missing (an agent). The
       REAL claims (reached, edges, routed) are unchanged — nothing here says work flows today. */
    out.outbox.reachedOnceCrewed = !!(out.outbox.reached || (probe && L.outboxReached));
    if (probe) for (const b of bays) {
      if (!b.agentId || (out.edges[b.propId] || []).length) continue;
      const ch = pl.dockChains[b.propId];
      const nx = ch ? (ch.next || []).filter(pid => mine(pid) && !out.docks[pid].agentId) : [];
      if (nx.length) out.probeNext[b.propId] = nx;
    }

    // 3. NOT CONNECTED: a dock no INBOX reaches even once crewed has no place in the run order. It is never
    //    chained in bay order: every such dock is listed together in ONE trailing 'apart' group.
    const placed = Object.values(out.docks).filter(d => d.col != null);
    const loose = bays.map(b => out.docks[b.propId]).filter(d => d.col == null);
    const colKeys = [...new Set(placed.map(d => d.col))].sort((a, b) => a - b);
    const bayOrder = {}; bays.forEach((b, i) => { bayOrder[b.propId] = i; });
    for (const ck of colKeys) {
      const docks = placed.filter(d => d.col === ck).sort((a, b) => bayOrder[a.propId] - bayOrder[b.propId]);
      const mode = docks.length < 2 ? 'single' : docks.some(d => d.reachedBy === 'all') ? 'all' : docks.some(d => d.reachedBy === 'turns') ? 'turns' : 'oneof';
      const c = { docks, mode, gate: null };
      const g = out.gates.find(gg => gg.col === ck && gg.after.some(pid => docks.some(d => d.propId === pid)));
      if (g) c.gate = g;
      out.cols.push(c);
      for (const d of docks) out.order.push(d.propId);
    }
    if (loose.length) {
      const top = colKeys.length ? Math.floor(colKeys[colKeys.length - 1]) + 1 : 0;
      for (const d of loose) { d.col = top; d.detached = true; d.routed = false; }
      out.cols.push({ docks: loose, mode: loose.length > 1 ? 'apart' : 'single', gate: null, detached: true });
      for (const d of loose) out.order.push(d.propId);
    }
    return out;
  }

  /* the compiled walk: columns by longest forward path from `entries` along Pipeline.chainStepDock (loop back
     edges excluded), plus the loop/join gates it meets. Pure over one plan. */
  function walkCompiled(plan, comp, P, props, entries) {
    const res = { col: {}, reachedBy: {}, gates: [], outboxReached: false };
    if (!plan || !comp) return res;
    const lineId = comp.key;
    const L = (P && P.dockLayer) ? P.dockLayer(plan) : { dockChains: {}, reachDock: {} };
    const chains = L.dockChains || {};
    const isDock = {}; for (const b of (comp.bays || [])) isDock[b.propId] = true;
    const pidOf = n => (n && typeof n === 'object') ? (n.dockId || null) : (n && isDock[n] ? n : null);
    const step = pid => { try { return (P && P.chainStepDock) ? P.chainStepDock(plan, pid, { lineId }) : null; } catch (e) { return null; } };
    const I = (P && P._internals) || {};
    // the junction prop at a plan junction key (the compiler's attach rule: own tile if on a belt, else the ring)
    const jprop = (jk) => {
      const map = plan.belts || {};
      for (const p of (props || [])) {
        if (!(p.t === 'loop' || p.t === 'joiner') || (comp.props || []).indexOf(p.id) < 0) continue;
        const t = map[key(p.x, p.y)] ? { x: p.x, y: p.y } : (I.beltTileNear ? I.beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1) : null);
        if (t && key(t.x, t.y) === jk) return p.id;
      }
      return null;
    };
    const col = res.col, gateByKey = {};
    const srcStarts = [];
    for (const s of (plan.sources || [])) if ((comp.intakes || []).indexOf(s.propId) >= 0) for (const t of ((s.tiles && s.tiles.length) ? s.tiles : (s.tile ? [s.tile] : []))) srcStarts.push(t);
    const entryBy = entries.length > 1 ? (forkKind(plan, srcStarts, I) || 'oneof') : 'entry';
    const q = entries.map(a => ({ a, c: 0, by: entryBy }));
    let guard = 0;
    while (q.length && guard++ < 4096) {
      const { a, c, by } = q.shift();
      const pid = pidOf(a); if (!pid) continue;
      if (col[pid] != null && col[pid] >= c) continue;
      col[pid] = c;
      if (!res.reachedBy[pid] || by === 'all' || by === 'turns') res.reachedBy[pid] = by;
      const s = step(pid), ch = chains[pid];
      const statics = (ch && ch.next) || [];
      if (!s) {
        if (ch && ch.outbox) res.outboxReached = true;
        for (const n of statics) q.push({ a: n, c: c + 1, by: 'oneof' });   // a static fork chainStep's default tag didn't take
        continue;
      }
      if (s.dockId) {
        const fk = statics.length > 1 ? (forkKind(plan, ch && ch.tile ? [ch.tile] : [], I) || 'oneof') : 'single';
        q.push({ a: s.dockId, c: c + 1, by: fk });
        for (const n of statics) if (n !== s.dockId) q.push({ a: n, c: c + 1, by: fk });
      } else if (s.branches) {
        for (const n of s.branches) q.push({ a: n, c: c + 1, by: 'all' });
      } else if (s.loop || s.join) {
        const k = s.loop || s.join;
        let g = gateByKey[k];
        if (!g) {
          g = gateByKey[k] = { kind: s.loop ? 'loop' : 'join', key: k, propId: jprop(k), after: [], backTo: null, backAgent: null,
            max: s.max || null, when: s.when || null, next: null, nextAgent: (s.next && s.next.agentId) || null, nextDock: pidOf(s.next), timeoutMin: s.timeoutMin || null, col: c };
          res.gates.push(g);
        }
        if (g.after.indexOf(pid) < 0) g.after.push(pid);
        if (c > g.col) g.col = c;
        if (s.loop) { g.backAgent = (s.backTo && s.backTo.agentId) || null; g.backTo = pidOf(s.backTo); }
        const nd = pidOf(s.next), bd = pidOf(s.backTo);
        if (nd) q.push({ a: nd, c: c + 1, by: 'single' });
        else if (ch && ch.outbox) res.outboxReached = true;
        // a loop's back lane re-enters UPSTREAM: never a forward edge (it is drawn as the back-arc)
        for (const n of statics) if (n !== nd && n !== bd) q.push({ a: n, c: c + 1, by: 'oneof' });
      }
      if (ch && ch.outbox && !s.dockId && !s.branches) res.outboxReached = true;
    }
    for (const g of res.gates) g.next = g.nextDock || null;
    return res;
  }

  /* the floor compiled once more with a probe agent on every UNCREWED bay of this line (null when the line has
     none — the real plan already answers everything). Memoized per compiled plan object. */
  const probeMemo = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function probePlan(plan, comp, P, props) {
    if (!plan || !P || !P.compileRoutingPlan || !props || !props.length) return null;
    const unbound = (comp.bays || []).filter(b => !b.agentId).map(b => b.propId);
    if (!unbound.length) return null;
    const sig = comp.key + '|' + unbound.join(',');
    const m = probeMemo && probeMemo.get(plan);
    if (m && m.sig === sig && m.props === props) return m.probe;
    const set = {}; for (const id of unbound) set[id] = true;
    const belts = [];
    for (const k in (plan.belts || {})) { const p = k.split(','); belts.push({ x: +p[0], y: +p[1], dir: plan.belts[k] }); }
    let probe = null;
    try { probe = P.compileRoutingPlan({ props: props.map(p => set[p.id] ? Object.assign({}, p, { agentId: '__probe_' + p.id }) : p), belts }); } catch (e) { probe = null; }
    if (probeMemo) probeMemo.set(plan, { sig, props, probe });
    return probe;
  }

  /* what kind of FORK sits on a lane: walk forward from `starts` to the first junction that has more than
     one way out. 'all' = a fan-out splitter (every branch runs — it feeds a JOINER), 'turns' = a plain
     splitter (round-robin), 'oneof' = a FILTER (by content). null = no fork before the docks. */
  function forkKind(plan, starts, I) {
    if (!plan || !plan.belts) return null;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToDock || plan.bayTileToAgent || {};
    const q = (starts || []).slice(), seen = {};
    let guard = 0;
    while (q.length && guard++ < 4096) {
      const t = q.shift(), k = key(t.x, t.y);
      if (seen[k]) continue; seen[k] = true;
      const j = junctions[k];
      if (j && j.kind === 'split') return j.fanout ? 'all' : 'turns';
      if (j && j.kind === 'filter') return 'oneof';
      if (bayAt[k] && guard > 1) continue;
      const nts = I.nextTiles ? I.nextTiles(map, junctions, t) : [];
      if (nts.length) q.push(nts[0]);
    }
    return null;
  }

  // the physical walk (see lineFlow step 2): dock propIds in the order the belts meet them
  function physicalOrder(plan, comp, I) {
    const res = [];
    if (!plan || !plan.belts || !comp) return res;
    const map = plan.belts, junctions = plan.junctions || {};
    const ring = {};   // belt key -> dock propId (every belt tile in a dock's 1-tile ring)
    const ringOf = {};
    for (const b of (comp.bays || [])) {
      ringOf[b.propId] = [];
      for (let y = b.y - 1; y <= b.y + (b.h || 1); y++)
        for (let x = b.x - 1; x <= b.x + (b.w || 1); x++)
          if (map[key(x, y)] && !ring[key(x, y)]) { ring[key(x, y)] = b.propId; ringOf[b.propId].push({ x, y }); }
    }
    const intakeIds = {}; for (const id of (comp.intakes || [])) intakeIds[id] = true;
    const q = [], seen = {}, met = {};
    for (const s of (plan.sources || [])) {
      if (!intakeIds[s.propId]) continue;
      const ts = (s.tiles && s.tiles.length) ? s.tiles : (s.tile ? [s.tile] : []);
      for (const t of ts) if (!seen[key(t.x, t.y)]) { seen[key(t.x, t.y)] = true; q.push(t); }
    }
    let guard = 0;
    while (q.length && guard++ < 20000) {
      const t = q.shift(), k = key(t.x, t.y), pid = ring[k];
      if (pid && !met[pid]) {
        met[pid] = true; res.push(pid);
        for (const rt of ringOf[pid]) { const rk = key(rt.x, rt.y); if (!seen[rk]) { seen[rk] = true; q.push(rt); } }
      }
      const nts = I.nextTiles ? I.nextTiles(map, junctions, t) : [];
      for (const nt of nts) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
    }
    return res;
  }

  /* ---------- the neighbours a dock's contract names (GETS / TO) ---------- */
  function neighbours(flow, propId) {
    const d = flow && flow.docks[propId];
    if (!d) return { prev: [], next: [], gate: null, first: false, last: false };
    const i = flow.cols.findIndex(c => c.docks.some(x => x.propId === propId));
    const colHere = flow.cols[i];
    const gate = colHere && colHere.gate && colHere.gate.after.indexOf(propId) >= 0 ? colHere.gate : null;
    // loop re-entry: the gate that sends work BACK to this dock
    const backFrom = flow.gates.filter(g => g.kind === 'loop' && g.backTo === propId);
    /* HAND-OFFS ARE COMPILED EDGES, NEVER COLUMN ADJACENCY (2026-09-23): two parallel bays under a splitter, or
       docks no INBOX reaches, used to read as a chain because they sat in neighbouring columns. next = the real
       plan's dockChains for a crewed dock (an uncrewed dock hands off to nothing yet); prev = the crewed docks
       whose compiled next is this one (+ the probe compile's answer for an uncrewed dock). */
    const E = flow.edges || {}, order = flow.order || [];
    const next = (E[propId] || []).slice();
    const prev = Object.keys(E).filter(x => x !== propId && (E[x] || []).indexOf(propId) >= 0);
    for (const x of ((flow.probeIn || {})[propId] || [])) if (prev.indexOf(x) < 0) prev.push(x);
    const byOrder = (a, b) => order.indexOf(a) - order.indexOf(b);
    prev.sort(byOrder); next.sort(byOrder);
    const lastRun = flow.cols.reduce((n, c, k) => (c.detached ? n : k), -1);
    return { prev, next, gate, backFrom, first: i === 0 && !d.detached, last: !d.detached && i === lastRun, index: i, detached: !!d.detached };
  }

  /* ---------- "how it runs": the sentence, as segments the panel paints ----------
     seg = { t:'text', s } | { t:'agent', s, propId } | { t:'miss', s, propId } | { t:'loop', s } | { t:'end', s }
     triggers = { schedules:[sentence…], channels:[label…], events:[sentence…] } — ONLY triggers that run the WHOLE
     line (a runsLine routine at an entry dock, a channel answering as an entry dock, an armed LINE TRIGGER —
     'when a file lands in C:\Drops' / 'when its webhook is called', see lineEventTriggers). */
  function howItRuns(flow, opt) {
    const o = opt || {}, nameOf = o.nameOf || (a => String(a || '').toUpperCase()), segs = [];
    const T = s => segs.push({ t: 'text', s });
    const trig = o.triggers || { schedules: [], channels: [] };
    const starts = [].concat((trig.schedules || []), (trig.channels || []).map(c => 'when a ' + c + ' message arrives'), (trig.events || []));
    if (!flow || !flow.trigger.propId) T('This line has no INBOX yet, so nothing can start it. ');
    else if (!starts.length) T('Nothing starts it on its own yet (no schedule, channel, folder or webhook runs this line); it runs when you test it. ');
    else T(cap(joinOr(starts)) + ', ');
    if (!flow || !flow.cols.length) { T('there is no BAY on it yet.'); return segs; }
    const run = flow.cols.filter(c => !c.detached), apart = flow.cols.filter(c => c.detached);
    run.forEach((c, i) => {
      if (i > 0) T(i === run.length - 1 && !c.gate ? ' then ' : '; ');
      c.docks.forEach((d, j) => {
        if (j > 0) T(c.mode === 'all' ? ' and ' : ' or ');
        if (d.agentId) segs.push({ t: 'agent', s: nameOf(d.agentId), propId: d.propId });
        else segs.push({ t: 'miss', s: '[pick ' + (d.role ? 'a ' + d.role.toLowerCase() : 'an agent') + ']', propId: d.propId });
        const hands = o.handsOf ? o.handsOf(d.propId) : null;
        T(' ' + roleInfo(d.role).verb + (hands ? ', handing off ' + hands : ''));
      });
      if (c.docks.length > 1) T(c.mode === 'all' ? ' (in parallel)' : c.mode === 'turns' ? ' (taking turns)' : ' (whichever the content routes to)');
      const g = c.gate;
      if (g && g.kind === 'loop') {
        const back = g.backTo && flow.docks[g.backTo];
        const who = back ? (back.agentId ? nameOf(back.agentId) : (back.role || 'the earlier bay')) : 'an earlier bay';
        const until = g.when === 'approved' ? 'until it is approved' : g.when === 'revise' ? 'until the verdict says revise'
          : g.when ? 'while it reads as ' + g.when + ' work' : 'every pass';
        segs.push({ t: 'loop', s: ' and sends it back to ' + who + ' ' + until + ' (' + (g.max || 5) + ' tries max)' });
      } else if (g && g.kind === 'join') T(' and the parts wait at the JOINER, then continue as one');
    });
    /* NOT CONNECTED (2026-09-23): a dock no INBOX reaches is named, never sequenced — the old walk chained such
       docks in bay order ("WRITER then RESEARCHER") though the plan held no hand-off between them. */
    for (const c of apart) {
      T(run.length ? '; not connected to ' + (flow.trigger.propId ? 'the INBOX' : 'an INBOX') + ': ' : 'Not connected to ' + (flow.trigger.propId ? 'the INBOX' : 'an INBOX') + ': ');
      c.docks.forEach((d, j) => {
        if (j > 0) T(', ');
        if (d.agentId) segs.push({ t: 'agent', s: nameOf(d.agentId), propId: d.propId });
        else segs.push({ t: 'miss', s: '[pick ' + (d.role ? 'a ' + d.role.toLowerCase() : 'an agent') + ']', propId: d.propId });
      });
    }
    T('; ');
    if (flow.outbox.reached) segs.push({ t: 'end', s: 'the result goes to the OUTBOX.' });
    else if (flow.outbox.propId && flow.outbox.reachedOnceCrewed) segs.push({ t: 'miss', s: '[the result reaches the OUTBOX once every step has an agent]', propId: flow.outbox.propId });
    else if (flow.outbox.propId) segs.push({ t: 'miss', s: '[the last step is not connected to the OUTBOX]', propId: flow.outbox.propId });
    else segs.push({ t: 'miss', s: '[there is no OUTBOX, so the result goes nowhere]', propId: null });
    return segs;
  }
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  function joinOr(list) {
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1];
  }

  /* ---------- readiness: what is missing, blocking first ----------
     facts = { hasCompute(agentId)->bool, errors:[{code, propId, warn}], labelOf(code)->string, briefOf(propId), triggers }
     A BLOCKING item is one the harness would fail on: no INBOX, an uncrewed dock, a dock with no workstation
     (the compute gate stays shut), no route to an OUTBOX, a compiler error on this line. A HINT is advice. */
  function readiness(flow, comp, facts) {
    const f = facts || {}, blocking = [], hints = [];
    if (!comp) return { ready: false, blocking: [{ what: 'Connect this BAY to a line with the BELT tool', propId: null }], hints };
    if (!flow.trigger.propId) blocking.push({ what: 'add an INBOX', propId: null });
    let n = 0;
    for (const pid of flow.order) {
      n++;
      const d = flow.docks[pid], label = 'BAY ' + n + (d.role ? ' (' + d.role + ')' : '');
      if (!d.agentId) { blocking.push({ what: label + ' needs an agent', propId: pid }); continue; }
      if (f.hasCompute && !f.hasCompute(d.agentId)) blocking.push({ what: label + ' needs a workstation', propId: pid });
      if (f.briefOf && !f.briefOf(pid)) hints.push({ what: label + ' has no instructions', propId: pid });
    }
    if (flow.trigger.propId) { let k = 0; for (const pid of flow.order) { k++; const d = flow.docks[pid]; if (d.detached && d.agentId) blocking.push({ what: 'BAY ' + k + ' is not connected to the INBOX', propId: pid }); } }
    if (!flow.order.length) blocking.push({ what: 'add a BAY', propId: null });
    // belts that already reach the OUTBOX once every bay is crewed are not a belt problem: the uncrewed bays' own
    // "needs an agent" items above are what is missing (sweep 2026-09-25)
    else if (!flow.outbox.reached && !(flow.outbox.reachedOnceCrewed && flow.order.some(pid => !flow.docks[pid].agentId))) blocking.push({ what: flow.outbox.propId ? 'connect the last step to the OUTBOX' : 'add an OUTBOX', propId: flow.outbox.propId });
    const mine = {}; for (const id of (comp.props || [])) mine[id] = true;
    const seenCodes = {};
    for (const e of (f.errors || [])) {
      if (e.warn || !e.propId || !mine[e.propId] || seenCodes[e.code]) continue;
      seenCodes[e.code] = true;
      blocking.push({ what: 'fix: ' + (f.labelOf ? f.labelOf(e.code) : e.code), propId: e.propId });
    }
    const t = f.triggers || {};
    if (flow.trigger.propId && !((t.schedules || []).length || (t.channels || []).length || (t.events || []).length)) hints.push({ what: 'nothing starts it yet (no schedule, channel, folder or webhook)', propId: flow.trigger.propId });
    return { ready: !blocking.length, blocking, hints };
  }
  function pillText(r) {
    if (r.ready) return 'READY TO RUN';
    const n = r.blocking.length;
    return n + ' TO FIX · ' + String(r.blocking[0].what).toUpperCase();
  }

  /* ---------- cost estimate: ONLY from steps the Commander actually tested ----------
     tests = { propId -> { usd } } (real server answers). Never guesses an untested step. */
  function costEstimate(flow, tests) {
    let usd = 0, tested = 0, untested = 0;
    for (const pid of (flow ? flow.order : [])) {
      const t = tests && tests[pid];
      if (t && typeof t.usd === 'number' && isFinite(t.usd)) { usd += t.usd; tested++; } else untested++;
    }
    const loops = !!(flow && flow.gates.some(g => g.kind === 'loop'));
    return { usd, tested, untested, loops,
      text: !tested ? 'Test a step to see its real cost'
        : '≈ $' + usd.toFixed(3) + ' a run · from ' + tested + ' tested step' + (tested === 1 ? '' : 's')
          + (untested ? ', ' + untested + ' untested' : '') + (loops ? ' · a loop can repeat steps' : '') };
  }

  /* ---------- channels: which connected channels start THIS line ----------
     status = GET /api/channels/status (id -> payload). A channel runs a line only when the agent it answers as
     crews one of the line's ENTRY docks (Pipeline.lineOriginOf: reach, never the chat binding). Proven by id
     for per-agent Telegram bots; by display name for the station channels (the payload names, never ids). */
  const CHAN_LABEL = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', matrix: 'Matrix', signal: 'Signal' };
  // (a channel addresses an AGENT; on a multi-bay line it enters at that agent's ENTRY dock — the plan's
  //  entryDock — so "feeds this line" = the agent's entry dock is one of this line's entry docks)
  function channelFeeds(status, entryAgentIds, agents) {
    const rows = [];
    if (!status || typeof status !== 'object') return rows;
    const entry = {}; for (const a of (entryAgentIds || [])) entry[a] = true;
    const byName = {}; for (const a of (agents || [])) if (a && a.name) byName[String(a.name).toLowerCase()] = a.id;
    for (const id of Object.keys(status)) {
      const s = status[id]; if (!s || typeof s !== 'object') continue;
      const label = CHAN_LABEL[id] || (id[0] ? id[0].toUpperCase() + id.slice(1) : id);
      if (s.configured) {
        const aid = s.agentName ? (byName[String(s.agentName).toLowerCase()] || null) : null;
        rows.push({ id, label, connected: !!s.connected, answersAs: s.agentName || null, agentId: aid,
          feeds: aid ? !!entry[aid] : null });
      }
      for (const b of (Array.isArray(s.bots) ? s.bots : [])) {
        if (!b || !b.configured) continue;
        rows.push({ id: id + ':' + b.botId, label: label + (b.username ? ' @' + b.username : ' bot'), connected: !!b.connected && b.enabled !== false,
          answersAs: b.agentName || b.agentId || null, agentId: b.agentId || null, feeds: b.agentId ? !!entry[b.agentId] : null });
      }
    }
    return rows;
  }

  /* ---------- schedules: the routines that run the WHOLE line ----------
     A routine runs the line only with runsLine:true AND fired at an ENTRY dock (router.lineOriginFor is
     keyed on reach). A routine at a mid-line dock runs that dock on (the old "skips" rule, said plainly). */
  /* (multi-bay) entryDockIds: a routine that FIRES AT a named bay (job.dockId) is at the entry only when THAT bay is
     one of the line's entry docks — the writer's second bay is mid-line even though the writer's first is not. */
  function lineRoutines(jobs, dockAgentIds, entryAgentIds, entryDockIds) {
    const docks = {}, entry = {}, entryDock = {};
    for (const a of (dockAgentIds || [])) docks[a] = true;
    for (const a of (entryAgentIds || [])) entry[a] = true;
    for (const d of (entryDockIds || [])) entryDock[d] = true;
    const atEntry = j => (j.dockId && entryDockIds) ? !!entryDock[j.dockId] : !!entry[j.agentId];
    return (Array.isArray(jobs) ? jobs : []).filter(j => j && docks[j.agentId]).map(j => ({
      id: j.id, name: j.name || '(unnamed)', agentId: j.agentId, dockId: j.dockId || null, enabled: j.enabled !== false, display: j.scheduleDisplay || '',
      prompt: j.prompt || '', runsLine: j.runsLine === true, atEntry: atEntry(j),
      startsLine: j.runsLine === true && atEntry(j) && j.enabled !== false }));
  }

  /* ---------- LINE TRIGGERS: the folder / webhook events that start THIS line ----------
     list = GET /api/routing/triggers .triggers. A trigger belongs to ONE line by id (lineId = the compiled line key).
     It counts as starting the line only when the SERVER says it is enabled and nothing blocks it (blockedBy null —
     the same preflight a fire runs: E-STOP, armed plan, the line on the floor, a crewed dock, the day cap). */
  function lineEventTriggers(list, lineId) {
    const mine = (Array.isArray(list) ? list : []).filter(t => t && t.lineId === lineId);
    const live = mine.filter(t => t.enabled && !t.blockedBy);
    const sentences = [];
    const folders = live.filter(t => t.kind === 'folder').map(t => 'when a file lands in ' + ((t.config && t.config.path) || 'its folder'));
    const hooks = live.filter(t => t.kind === 'webhook');
    for (const s of folders) sentences.push(s);
    if (hooks.length === 1) sentences.push('when its webhook' + (hooks[0].name ? ' "' + hooks[0].name + '"' : '') + ' is called');
    else if (hooks.length > 1) sentences.push('when one of its ' + hooks.length + ' webhooks is called');
    return { mine, live, sentences };
  }

  /* ---------- LINE TRIGGERS: repaint only what changed (2026-09-24) ----------
     The panel re-reads the trigger list every 5 s while an INBOX is open. Rebuilding the whole card on each read
     remounted the WHEN picker (the picked schedule snapped back to daily 9:00), replaced an ARMED two-click
     DELETE / NEW KEY button (its confirm then missed) and collapsed open sections. triggerSig is a row's data
     fingerprint; rowPatch(prev, next) — each a list of [id, sig] in display order — says what to repaint:
     { all:true } when the rows themselves changed (added / removed / reordered), else just the ids whose data
     changed ([] = touch nothing). Pure: the panel owns the DOM. */
  function triggerSig(t, extra) {
    const str = JSON.stringify([t == null ? null : t, extra == null ? null : extra]);
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36) + '.' + str.length.toString(36);
  }
  function rowPatch(prev, next) {
    const a = Array.isArray(prev) ? prev : [], b = Array.isArray(next) ? next : [];
    if (a.length !== b.length || a.some((r, i) => !r || !b[i] || String(r[0]) !== String(b[i][0]))) return { all: true, changed: [] };
    return { all: false, changed: b.filter((r, i) => String(r[1]) !== String(a[i][1])).map(r => String(r[0])) };
  }

  /* ---------- the test input a dock's "Try this step" starts from ----------
     the previous dock's last test OUTPUT (what it would really hand over), or the line's test job for the
     first dock. null = nothing honest to offer yet ("test <prev> first"). */
  function testInputFor(flow, propId, tests, job) {
    const nb = neighbours(flow, propId);
    if (nb.first || !nb.prev.length) return job ? { text: job, from: 'the INBOX test job' } : null;
    for (const p of nb.prev) { const t = tests && tests[p]; if (t && typeof t.output === 'string' && t.output) return { text: t.output, from: p }; }
    return null;
  }

  /* ---------- step test: plain readings of a session (STEPTEST contract shape) ---------- */
  function pausedNext(session, nameOf) {
    const p = session && session.paused, nx = p && p.next;
    if (!nx) return null;
    if (nx.kind === 'agent') return { kind: 'agent', agentId: nx.agentId, dockId: nx.dockId || null, back: !!nx.back, label: (nameOf ? nameOf(nx.agentId) : nx.agentId) + (nx.back ? ' (sent back)' : '') };
    if (nx.kind === 'outbox') return { kind: 'outbox', label: 'the OUTBOX' };
    return { kind: 'end', label: 'the end (' + (nx.reason || 'no next step') + ')' };
  }
  function hopLabel(h, nameOf) {
    if (!h) return '';
    return (nameOf ? nameOf(h.agentId) : h.agentId) + (h.pass > 1 ? ' ×' + h.pass : '') + (h.rerun ? ' ↻' : '')
      + (typeof h.usd === 'number' ? ' $' + h.usd.toFixed(3) : '') + (h.edited ? ' ✎' : '');
  }
  const TERMINAL = { done: 1, stopped: 1, failed: 1 };
  const isLive = s => !!s && !TERMINAL[s.state];

  return { ROLE, GENERIC, roleInfo, starters, lineFlow, physicalOrder, neighbours, howItRuns, readiness, pillText,
    costEstimate, channelFeeds, lineRoutines, lineEventTriggers, triggerSig, rowPatch, testInputFor, pausedNext, hopLabel, isLive, CHAN_LABEL };
});
