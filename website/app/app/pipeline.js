/* frontend/app/pipeline.js — the belt-graph -> RoutingPlan compiler. Phase B's single authority.

   Pure, zero-dep, UMD: node tests + the browser sim + the sidecar router all require() the SAME module,
   so "the box you watch ride to a bay" and "the agent that actually runs" are provably one plan — they
   cannot drift. This is to ROUTING what resolveTools(agentId, station) is to CAPABILITY.

   compileRoutingPlan(geo)  -> a validated { sources, bays, junctions, belts, bayTileToAgent, reach, errors, hash }
   resolveTarget(plan,{tag}) -> the agentId a work-item routes to (following FILTER content-routing), or null.

   DETERMINISM: no Math.random, no wall-clock, no mutation of inputs. A belt CYCLE is a HARD error (a loop
   would be infinite paid runOnce). The plan is plain JSON (no Maps) so the sidecar can hold the same one. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.Pipeline = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIRV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  const OPP = { E: 'W', W: 'E', S: 'N', N: 'S' };
  const LANE_ORDER = ['E', 'S', 'W', 'N'];          // fixed order so routing is deterministic (mirrors conveyor.js)
  const key = (x, y) => x + ',' + y;
  const LOOP_MAX_DEFAULT = 5, LOOP_MAX_CEILING = 20;   // bounded loop (2026-08-21): plan-configurable, hard-capped

  const buildBeltMap = belts => { const m = {}; for (const b of (belts || [])) m[key(b.x, b.y)] = b.dir; return m; };
  // a junction's out-lanes: neighbour belts that DON'T flow back into the tile (the lane it came from)
  function outLanes(map, x, y) {
    const lanes = [];
    for (const d of LANE_ORDER) { const v = DIRV[d], nb = map[key(x + v[0], y + v[1])]; if (nb && nb !== OPP[d]) lanes.push(d); }
    return lanes;
  }
  // a junction's IN-lanes: neighbour belts that flow INTO the tile (a JOINER counts these — one per branch)
  function inLanes(map, x, y) {
    const lanes = [];
    for (const d of LANE_ORDER) { const v = DIRV[d], nb = map[key(x + v[0], y + v[1])]; if (nb && nb === OPP[d]) lanes.push(d); }
    return lanes;
  }
  /* a LOOP gate's exits (2026-08-21; esc 2026-08-30): `done` = the lane the crate leaves on when the verdict
     passes or the cap is reached (configured, else the FIRST out-lane), `back` = the lane that re-enters the
     line upstream, and `esc` = the ESCALATION lane — where a crate goes when its passes are EXHAUSTED while
     the verdict still says revise. esc is the gate's THIRD out-lane (wire one and it IS the fire escape; a
     two-lane gate has none) or a configured `esc` dir; back stays the first non-done lane so every existing
     two-lane floor reads exactly as before. Static analysis (cycle detection, reachability, chains) follows
     `done` and `esc` — both head downstream; only the back edge is the one legal way round. */
  function loopLanes(map, x, y, cfg) {
    const lanes = outLanes(map, x, y);
    const done = (cfg && cfg.done && lanes.indexOf(cfg.done) >= 0) ? cfg.done : (lanes[0] || null);
    const rest = lanes.filter(d => d !== done);
    let esc = (cfg && cfg.esc && rest.indexOf(cfg.esc) >= 0) ? cfg.esc : null;
    const back = rest.find(d => d !== esc) || null;
    if (!esc) esc = rest.find(d => d !== back) || null;   // unconfigured: the third wired lane is the escape
    return { done, back, esc, lanes };
  }
  // the first belt tile on/adjacent to a footprint (its tiles + a 1-tile ring) — a prop's connection point
  function beltTileNear(map, tx, ty, tw, th) {
    for (let yy = ty - 1; yy <= ty + th; yy++)
      for (let xx = tx - 1; xx <= tx + tw; xx++)
        if (map[key(xx, yy)]) return { x: xx, y: yy };
    return null;
  }
  // every feed mouth of an INTAKE source: `tiles` when compiled by this version, `tile` alone when the plan
  // was persisted by an older compile (the sidecar restores plans from disk — never assume the new shape).
  const srcTiles = s => (s.tiles && s.tiles.length) ? s.tiles : (s.tile ? [s.tile] : []);
  // small deterministic FNV-1a hash of the plan topology (frontend<->sidecar agree they hold the same plan)
  function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  /* LINE BUDGET (per-line limits, 2026-08-21). A line's INBOX prop may carry `limits` — the Commander's
     ceilings for work that enters THROUGH that line: { maxHops, maxUsdPerMessage, maxUsdPerDay }. This is
     the ONE normalizer both surfaces use (REFIT writes through it, the compiler attaches it, the sidecar's
     chain executor reads it), so a floor can never carry a limit the executor reads differently.
       defaults  = the executor's historical constants (6 stages after the first, $2.00 per message) and
                   NO daily cap (null = off) — a floor with no limits set runs exactly as before.
       ceilings  = hard: maxHops <= 24, $ per message <= 50, $ per day <= 500. Anything above is CLAMPED and
                   the clamp is RECORDED (`clamped: ['maxHops>24', …]`) so a surface can say why the number
                   the Commander typed is not the number in force. The global budget pool is a SIDECAR fact
                   (router.lineLimits clamps to it at read time) — the compiler never knows it.
     Returns null for no/garbage input (absent = defaults everywhere, and nothing rides the plan). */
  const LINE_LIMIT_DEFAULTS = { maxHops: 6, maxUsdPerMessage: 2.00, maxUsdPerDay: null };
  const LINE_LIMIT_CEILINGS = { maxHops: 24, maxUsdPerMessage: 50, maxUsdPerDay: 500 };
  function normalizeLineLimits(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = { clamped: [] };
    const num = v => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null);
    let any = false;
    const h = num(raw.maxHops);
    if (h != null) { any = true; let v = Math.max(0, Math.floor(h)); if (v > LINE_LIMIT_CEILINGS.maxHops) { v = LINE_LIMIT_CEILINGS.maxHops; out.clamped.push('maxHops>' + LINE_LIMIT_CEILINGS.maxHops); } out.maxHops = v; }
    else out.maxHops = LINE_LIMIT_DEFAULTS.maxHops;
    const m = num(raw.maxUsdPerMessage);
    if (m != null && m > 0) { any = true; let v = Math.round(m * 100) / 100; if (v > LINE_LIMIT_CEILINGS.maxUsdPerMessage) { v = LINE_LIMIT_CEILINGS.maxUsdPerMessage; out.clamped.push('maxUsdPerMessage>' + LINE_LIMIT_CEILINGS.maxUsdPerMessage); } out.maxUsdPerMessage = v; }
    else out.maxUsdPerMessage = LINE_LIMIT_DEFAULTS.maxUsdPerMessage;
    const d = num(raw.maxUsdPerDay);
    if (d != null && d > 0) { any = true; let v = Math.round(d * 100) / 100; if (v > LINE_LIMIT_CEILINGS.maxUsdPerDay) { v = LINE_LIMIT_CEILINGS.maxUsdPerDay; out.clamped.push('maxUsdPerDay>' + LINE_LIMIT_CEILINGS.maxUsdPerDay); } out.maxUsdPerDay = v; }
    else out.maxUsdPerDay = LINE_LIMIT_DEFAULTS.maxUsdPerDay;
    if (!any) return null;
    if (!out.clamped.length) delete out.clamped;
    return out;
  }


  // the tile(s) a box flows to next from t (a junction fans out to ALL its out-lanes for reachability/cycle)
  function nextTiles(map, junctions, t) {
    if (!map[key(t.x, t.y)]) return [];
    const jc = junctions[key(t.x, t.y)];
    // a LOOP gate's back lane is NOT a static edge (see loopLanes) — only the done lane counts here
    const ll0 = (jc && jc.kind === 'loop') ? loopLanes(map, t.x, t.y, jc) : null;
    const dirs = ll0 ? [ll0.done, ll0.esc].filter(Boolean) : jc ? outLanes(map, t.x, t.y) : [map[key(t.x, t.y)]];
    const out = [];
    for (const d of dirs) { const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1]; if (map[key(nx, ny)]) out.push({ x: nx, y: ny }); }
    return out;
  }

  /* DFS along belt flow for a cycle (a back-edge to a GRAY node). Returns the offending tile, or null.

     ITERATIVE (explicit stack) ON PURPOSE: the recursive version recursed once per tile along the flow and
     blew the JS call stack at ~5k chained belt tiles — a 71x71 serpentine, well inside the 240-tile MAX_SPAN
     a floor may span. compileRoutingPlan is called UNGUARDED from build.js rebake() (inside the REFIT render
     loop) and world.js compileRouting(), so that RangeError took the renderer down with it. Same three-colour
     marking, same child order, same first-back-edge answer — only the stack moved off the interpreter's. */
  function detectCycle(map, junctions) {
    const color = {};   // undefined=white, 1=gray (on stack), 2=black (done)
    for (const root in map) {
      if (color[root]) continue;
      color[root] = 1;
      const stack = [{ k: root, kids: null, i: 0 }];      // kids resolved lazily, exactly when visit() would have
      while (stack.length) {
        const fr = stack[stack.length - 1];
        if (fr.kids === null) { const p = fr.k.split(','); fr.kids = nextTiles(map, junctions, { x: +p[0], y: +p[1] }); }
        if (fr.i >= fr.kids.length) { color[fr.k] = 2; stack.pop(); continue; }   // exhausted → black, unwind
        const nt = fr.kids[fr.i++], nk = key(nt.x, nt.y);
        if (color[nk] === 1) return { x: nt.x, y: nt.y };                         // back-edge to a node on the stack
        if (!color[nk]) { color[nk] = 1; stack.push({ k: nk, kids: null, i: 0 }); }
      }
    }
    return null;
  }

  function compileRoutingPlan(geo) {
    const props = (geo && geo.props) || [];
    const map = buildBeltMap(geo && geo.belts);
    const errors = [], sources = [], bays = [], junctions = {}, bayTileToAgent = {}, escExplicit = {};
    /* THE DOCK KEY (multi-bay agents, 2026-09-22 — Andrew's ruling: one bay has ONE agent, one agent may crew
       MANY bays). A dock is its bay PROP id: stable in the station doc, already on bays[]/dockBays[]. Every
       routing walk below keys on the dock that owns a tile (bayTileToDock), never on the agent crewing it —
       writer@A → editor@B → writer@C is three docks and two agents. The agent-keyed maps stay as VIEWS. */
    const bayTileToDock = {}, agentOfDock = {};

    for (const p of props) {
      if (p.t === 'intake') {
        const t = beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
        // WARN, never a blocker (2026-07-26): an intake with no belt contributes no source, so it can neither
        // loop nor route work into a void — the two things `ok()` exists to prevent. Blocking on it meant ONE
        // decorative INTAKE anywhere on the floor made the whole plan non-deployable, which the sidecar
        // refuses wholesale — taking per-bay capability isolation down with it (see router.stationFor).
        // Same standing as its neighbours ORPHAN_BAY / BAY_NOT_FED: the floor still nags, it just isn't fatal.
        if (!t) { errors.push({ code: 'ORPHAN_SOURCE', propId: p.id, warn: true }); continue; }
        // EVERY ring belt tile is a feed mouth (2026-08-04 audit — same multi-hookup rule bays and outboxes
        // already follow): a single recorded tile left an intake's SECOND lane dark and unroutable whenever
        // the reaching lane started on a later-scanned ring tile. `tile` stays = first hit (back compat:
        // persisted plans and older callers read it); every walker fans out from `tiles`.
        const iw = p.w || 1, ih = p.h || 1, tiles = [];
        for (let yy = p.y - 1; yy <= p.y + ih; yy++)
          for (let xx = p.x - 1; xx <= p.x + iw; xx++)
            if (map[key(xx, yy)]) tiles.push({ x: xx, y: yy });
        sources.push({ propId: p.id, tile: t, tiles });
      } else if (p.t === 'splitter' || p.t === 'filter' || p.t === 'merger' || p.t === 'joiner' || p.t === 'loop') {
        const t = map[key(p.x, p.y)] ? { x: p.x, y: p.y } : beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
        // a junction touching NO belt routes nothing — it silently compiled to nothing, which after a MOVE
        // one tile too far read as "my filter stopped working" with zero feedback. Warn (not a blocker: an
        // unattached junction can neither loop nor void work) so REFIT can nag it back onto the line.
        if (!t) { errors.push({ code: 'ORPHAN_JUNCTION', propId: p.id, warn: true }); continue; }
        const kind = p.t === 'splitter' ? 'split' : p.t === 'merger' ? 'merge' : p.t === 'joiner' ? 'join' : p.t === 'loop' ? 'loop' : 'filter';
        const cfg = { kind };
        /* JOINER (2026-08-21) — the real fan-in BARRIER the merger never was: it holds one crate per in-lane
           for a run, then releases ONE merged crate. `expect` = its in-lane count (the branches it waits for);
           `timeoutMin` = how long the sidecar barrier waits for a missing branch before releasing partial
           (default 10, clamped 1..120). Plan-configurable per prop like a filter's routes. */
        if (kind === 'join') {
          cfg.expect = inLanes(map, t.x, t.y).length;
          const tm = +p.timeoutMin;
          cfg.timeoutMin = (isFinite(tm) && tm >= 1) ? Math.min(120, Math.floor(tm)) : 10;
          if (cfg.expect < 2) errors.push({ code: 'JOIN_ONE_LANE', propId: p.id, warn: true });
        }
        /* LOOP gate (2026-08-21) — the ONE legal way round: a crate re-enters the line upstream on the back
           lane until its iteration count reaches `max` (default 5, hard ceiling 20), then leaves on `done`. */
        if (kind === 'loop') {
          const mx = +p.maxIter;
          cfg.max = (isFinite(mx) && mx >= 1) ? Math.min(LOOP_MAX_CEILING, Math.floor(mx)) : LOOP_MAX_DEFAULT;
          const ll = loopLanes(map, t.x, t.y, { done: p.done || null, esc: p.esc || null });
          cfg.done = ll.done; cfg.back = ll.back;
          if (ll.esc) cfg.esc = ll.esc;   // the ESCALATION lane (2026-08-30): exhausted crates leave here
          if (p.esc && ll.esc === p.esc) escExplicit[key(t.x, t.y)] = true;   // configured: never re-guessed
          // optional verdict tag: re-enter ONLY when the output's tag matches (else every pass loops until max)
          if (typeof p.when === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(p.when)) cfg.when = p.when;
          // LOOP_NO_DONE (rule fixed 2026-08-22): an UNSET `done` takes the compiler's own default — the first
          // exit in E,S,W,N order — and that is a working gate, not a finding (every user-drawn loop used to
          // nag). Warn only when NO exit qualifies, or when a configured `done` names a lane that is not an
          // exit (the config was silently overridden by the default).
          if (!ll.done || (p.done && p.done !== ll.done)) errors.push({ code: 'LOOP_NO_DONE', propId: p.id, warn: true });
          if (!ll.back) errors.push({ code: 'LOOP_NO_BACK', propId: p.id, warn: true });
        }
        if (kind === 'filter') {
          cfg.routes = (p.routes && typeof p.routes === 'object') ? p.routes : {};   // {tag -> out-lane dir}
          cfg.def = p.def || null;                                                    // default out-lane dir
          // WARN, never a blocker (2026-08-04 audit): a def-less filter never drops or loops work — the
          // engine and resolveTarget share the same fallback (routed lane -> def -> FIRST lane), so every
          // crate still lands somewhere deterministic. That fails the bar a blocking error must meet
          // ("genuinely able to loop or void work"); the floor nags the missing default, it isn't fatal.
          if (!cfg.def) errors.push({ code: 'FILTER_NO_DEFAULT', propId: p.id, warn: true });
        }
        // a MERGE carries no config: it is a LANE FUNNEL (several lanes converge, every crate rides on).
        // The old `bufferSize` K described a hold-K-then-combine barrier the harness never performed —
        // see the chooseExit note in conveyor.js. The prop's `bufferSize` field is still carried by the
        // world model so old saves round-trip, it just no longer compiles into anything.
        // a splitter with fewer than two out-lanes fans nothing — it silently acts as a plain tile. Warn
        // (not a blocker: the line still works, it just isn't doing what the prop claims) so the UI can nag.
        if (kind === 'split' && outLanes(map, t.x, t.y).length < 2) errors.push({ code: 'SPLIT_ONE_LANE', propId: p.id, warn: true });
        junctions[key(t.x, t.y)] = cfg;
      }
    }

    // OUTBOX hookups: the legal END of an outbound lane (bay/desk -> outbox). Legibility-only — dispatch
    // never routes THROUGH an outbox — but recording them lets a bay->outbox line count as a VALID build
    // instead of being shamed as unreachable (the 2026-07-05 "NO ROUTE IN on a correct outbound lane" bug).
    const outs = [];
    for (const p of props) {
      if (p.t !== 'outbox') continue;
      // EVERY ring belt tile is a delivery mouth (same multi-hookup rule as bays — a single-tile hookup
      // left the final approach tile of a second lane dark)
      const ow = p.w || 1, oh = p.h || 1;
      for (let yy = p.y - 1; yy <= p.y + oh; yy++)
        for (let xx = p.x - 1; xx <= p.x + ow; xx++)
          if (map[key(xx, yy)]) outs.push({ propId: p.id, tile: { x: xx, y: yy } });
    }

    /* A SOLID PROP BURIES THE LINE (2026-08-04 legibility audit): a blocking prop placed over a belt run
       used to be silently legal — the line stayed compiled + energized and crates drew straight over the
       prop. Warn, never a blocker (transport still conserves every crate; the floor just looks wrong).
       Only an EXPLICIT blocks:true prop counts: belt machines (intake/bay/outbox/junctions) legitimately
       sit on/next to the line, and flat decor (block:false) buries nothing. geo already carries `block`
       per prop (worldmodel.projectGeometry emits it) — no contract change; a geo without the field
       (older callers/tests) simply never trips this. Anchored on the first covered belt tile. */
    const BELT_MACHINES = { intake: 1, bay: 1, outbox: 1, filter: 1, splitter: 1, merger: 1, joiner: 1, loop: 1 };
    for (const p of props) {
      if (p.block !== true || BELT_MACHINES[p.t]) continue;
      const pw = p.w || 1, ph = p.h || 1;
      let hit = null;
      for (let yy = p.y; yy < p.y + ph && !hit; yy++)
        for (let xx = p.x; xx < p.x + pw && !hit; xx++)
          if (map[key(xx, yy)]) hit = { x: xx, y: yy };
      if (hit) errors.push({ code: 'BELT_BURIED', propId: p.id, tile: hit, warn: true });
    }

    const unboundBays = [], dockBays = [], unboundBayTile = {}, capRoomsOf = {};
    const hasLine = sources.length > 0;   // an INTAKE line exists — only then can "not fed by it" be a finding
    for (const p of props) {
      if (p.t !== 'bay') continue;
      if (!p.agentId) {
        errors.push({ code: 'UNBOUND_BAY', propId: p.id, warn: true });
        // an unbound bay is not a routing target, but the legibility layer (hover tags, nags) needs to know
        // a belt runs past it — record its connection tile additively (never enters bayTileToAgent/hash).
        const ut = beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
        if (ut) unboundBays.push({ propId: p.id, tile: ut });
        // …and EVERY ring tile of it, for the walkers that ask "does this lane reach a dock at all?"
        // (the LOOP gate's back lane). A wired lane that lands on an UNCREWED dock is not a wiring
        // fault — UNBOUND_BAY already names it — so LOOP_NO_BACK must not fire a second nag for it.
        { const uw = p.w || 1, uh = p.h || 1;
          for (let yy = p.y - 1; yy <= p.y + uh; yy++)
            for (let xx = p.x - 1; xx <= p.x + uw; xx++)
              if (map[key(xx, yy)]) unboundBayTile[key(xx, yy)] = p.id; }
        continue;
      }
      // EVERY bound bay is a working dock (legibility list; NOT the dispatch `bays` — router semantics untouched).
      // A LONE assigned bay is a COMPLETE build: work addressed to its agent arrives at the dock, no belts needed.
      // `brief` (step editor, 2026-08-05) rides THIS list only — the Commander's standing job brief for this
      // station, PROMPT TEXT ONLY: it never touches routing (resolveTarget/chainNext ignore it) or capability
      // (stationFor reads objects, never brief), and `dockBays` is outside the hash so it cannot move dispatch
      // either. Bounded here so no surface can post an unbounded blob.
      // HANDS OFF (workflow panel, 2026-09-22): the dock's optional hand-off phrase is COMPOSED into the brief
      // here, so the agent is actually told it (object=capability — never a cosmetic field). Same list, same
      // bound, still outside the hash: prompt text only.
      const brief = composeStageBrief(p.brief, p.hands);
      agentOfDock[p.id] = p.agentId;
      // the CAPABILITY room this bay's runs get (worldmodel.projectGeometry stamps it: the agent's desk room when
      // it has a desk, else this bay's room) — only read by the SPLIT_CREW warning below
      if (typeof p.capRoom === 'string' && p.capRoom) { const rs = capRoomsOf[p.agentId] || (capRoomsOf[p.agentId] = []); if (rs.indexOf(p.capRoom) < 0) rs.push(p.capRoom); }
      const dockRec = { propId: p.id, agentId: p.agentId, x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 };
      if (brief) dockRec.brief = brief;
      dockBays.push(dockRec);
      const t = beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1);
      if (!t) {
        // beltless bound bay: valid alone; merely "not on the line" (warn) when an intake line exists elsewhere
        if (hasLine) errors.push({ code: 'ORPHAN_BAY', propId: p.id, agentId: p.agentId, warn: true });
        continue;
      }
      /* ONE AGENT, MANY BAYS (Andrew's ruling, 2026-09-22). DUP_AGENT used to refuse a second bay for the same
         agent; routing is keyed by DOCK now (bayTileToDock / dockChains), so writer@A → editor@B → writer@C is a
         straight three-stage line and every bay is a dispatch target of its own. Each BAY still has exactly one
         agent (the prop carries one agentId). */
      // A DOCK TOUCHES THE LINE WHEREVER THE LINE TOUCHES IT: record EVERY ring belt tile as a hookup —
      // an inbound lane arrives at one, an outbound lane leaves from another, and both must count (a
      // single-tile hookup left a bay's out-lane dark and spawned its product crates on the in-lane).
      const tiles = [];
      const bw = p.w || 1, bh = p.h || 1;
      for (let yy = p.y - 1; yy <= p.y + bh; yy++)
        for (let xx = p.x - 1; xx <= p.x + bw; xx++)
          if (map[key(xx, yy)]) tiles.push({ x: xx, y: yy });
      // NO BRIEF ON THE DISPATCH RECORD. `bays` is a HASH INPUT, and prompt text is not dispatch topology:
      // carrying the brief here made typing one word into a step editor move plan.hash, which re-posts the
      // plan, which resets the router's splitter round-robin balance — an edit to what an agent is TOLD
      // perturbing which agent work is SENT to. The brief still reaches the sidecar on `dockBays` (the
      // legibility list, outside the hash) and router.stageBrief reads it from there (2026-08-07).
      bays.push({ agentId: p.agentId, propId: p.id, tile: t, tiles });
      for (const ht of tiles) { bayTileToAgent[key(ht.x, ht.y)] = p.agentId; bayTileToDock[key(ht.x, ht.y)] = p.id; }
    }

    /* BACK vs ESC on a THREE-LANE gate (2026-08-30): lane order can't tell them apart — S sorts before N,
       so a gate whose escape happened to point south would have claimed the escape as its BACK lane and
       turned the real back wire into a static edge (instant CHAIN_CYCLE). Physics decides instead: THE
       BACK LANE IS THE ONE THAT COMES BACK — walk each candidate to its first dock, then ask whether that
       dock's outbound flow returns to this gate. Exactly one candidate should; when the guess has it
       backwards, swap. A configured `esc` is never re-guessed; ties keep the deterministic guess. */
    {
      const bayByDock = {}; for (const b of bays) bayByDock[b.propId] = b;
      const laneDock = (jk, dir) => {
        const p0 = jk.split(','), v = DIRV[dir]; let t = { x: +p0[0] + v[0], y: +p0[1] + v[1] };
        const seen = {}; let guard = 0;
        while (t && map[key(t.x, t.y)] && guard++ < 4096 && !seen[key(t.x, t.y)]) {
          const k2 = key(t.x, t.y); seen[k2] = true;
          if (bayTileToDock[k2]) return bayTileToDock[k2];
          const nts = nextTiles(map, junctions, t); t = nts[0] || null;
        }
        return null;
      };
      const dockReaches = (dockId, gateK) => {
        /* BFS along flow, HOPPING THROUGH DOCKS: a lane physically sinks at the dock it feeds and the
           work re-emerges on that dock's other hookups — so hitting any dock's hookup enqueues all of
           that dock's ring tiles. Without the hop, drafter→reviewer→gate read as "never returns".
           Keyed by DOCK: a writer crewing two bays of one line hops through its OTHER bay like any other. */
        const b = bayByDock[dockId]; if (!b) return false;
        const seen = {}, q = (b.tiles || []).slice(); let guard = 0;
        while (q.length && guard++ < 8192) {
          const t = q.shift(), k2 = t && key(t.x, t.y);
          if (!t || !map[k2] || seen[k2]) continue; seen[k2] = true;
          if (k2 === gateK) return true;
          const owner = bayTileToDock[k2];
          if (owner && owner !== dockId) { const ob = bayByDock[owner]; if (ob) for (const ot of (ob.tiles || [])) q.push(ot); }
          for (const nt of nextTiles(map, junctions, t)) { q.push(nt); break; }   // single-path forward, first lane
        }
        return false;
      };
      for (const jk in junctions) {
        const jc = junctions[jk];
        if (jc.kind !== 'loop' || !jc.esc || escExplicit[jk]) continue;
        const bD = laneDock(jk, jc.back), eD = laneDock(jk, jc.esc);
        const bR = bD ? dockReaches(bD, jk) : false, eR = eD ? dockReaches(eD, jk) : false;
        if (!bR && eR) { const tmp = jc.back; jc.back = jc.esc; jc.esc = tmp; }
      }
    }
    // LOOP backTo: the first DOCK the back lane reaches (the stage the crate re-enters at). Pre-cycle so the
    // back edge is resolved on the same pass that cuts it from static flow (nextTiles). The junction keeps the
    // AGENT (a hash input — unchanged for every 1:1 floor); the dock rides gateDocks, outside the hash.
    const gateDocks = {};
    for (const jk in junctions) {
      const jc = junctions[jk];
      if (jc.kind !== 'loop' || !jc.back) continue;
      const p0 = jk.split(','), jx = +p0[0], jy = +p0[1];
      const r = laneFirstDock(map, junctions, bayTileToDock, jx, jy, jc.back, unboundBayTile);
      jc.backTo = r.dock ? agentOfDock[r.dock] : null;
      (gateDocks[jk] = gateDocks[jk] || { backTo: null, escTo: null }).backTo = r.dock;
      if (!jc.backTo && !r.uncrewed) errors.push({ code: 'LOOP_NO_BACK', tile: { x: jx, y: jy }, warn: true });
    }
    /* LOOP escTo (2026-08-30) — the first dock the ESCALATION lane reaches, resolved exactly like backTo
       so the runner escalates by name instead of walking at run time. An esc lane to an OUTBOX resolves
       null: exhausted work then ships out on the esc lane (still honest — the crate leaves marked). */
    for (const jk in junctions) {
      const jc = junctions[jk];
      if (jc.kind !== 'loop' || !jc.esc) continue;
      const p0 = jk.split(','), jx = +p0[0], jy = +p0[1];
      const r = laneFirstDock(map, junctions, bayTileToDock, jx, jy, jc.esc, null);
      jc.escTo = r.dock ? agentOfDock[r.dock] : null;
      (gateDocks[jk] = gateDocks[jk] || { backTo: null, escTo: null }).escTo = r.dock;
    }
    const cyc = detectCycle(map, junctions);
    if (cyc) errors.push({ code: 'CYCLE', tile: cyc });

    // reachability: BFS from every source along the flow; a bay CONSUMES the box (don't expand past it).
    // Computed per DOCK (reachDock); `reach` is the agent VIEW — an agent is reached when ANY dock it crews is.
    const reach = {};
    for (const b of bays) reach[b.agentId] = false;
    const reachDock = dockReachOf({ sources, bays, belts: map, junctions, bayTileToDock }, !!cyc);
    for (const d in reachDock) if (reachDock[d]) reach[agentOfDock[d]] = true;
    // outbound reach: does this hooked bay's flow arrive at an OUTBOX? (a pure outbound lane is a VALID build)
    const outSet = {};
    for (const o of outs) outSet[key(o.tile.x, o.tile.y)] = true;
    function flowsToOutbox(from) {
      if (cyc) return false;
      const seen = {}, q = [from]; seen[key(from.x, from.y)] = true;
      while (q.length) {
        const t = q.shift(), k = key(t.x, t.y);
        if (outSet[k]) return true;
        for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
      }
      return false;
    }
    const plan = { sources, bays, junctions, belts: map, bayTileToAgent, unboundBays, dockBays, outs, reach, errors };
    plan.bayTileToDock = bayTileToDock;
    /* SPLIT_CREW (multi-bay, 2026-09-22): a DESK-LESS agent whose bays sit in more than one room gets a
       different toolbox at each bay (station isolation is per dock — never the union), which is surprising.
       Advice, never a blocker: "PLACE A DESK — TOOLS FOLLOW THE DOCK" — a desk pins every bay to one room.
       Anchored on the agent's second-oldest bay (the one whose room differs from the first). */
    for (const a in capRoomsOf) {
      if (capRoomsOf[a].length < 2) continue;
      const mine = props.filter(q => q.t === 'bay' && q.agentId === a).map(q => q.id).sort(propIdCmp);
      errors.push({ code: 'SPLIT_CREW', agentId: a, propId: mine[1] || mine[0], rooms: capRoomsOf[a].slice().sort(), warn: true });
    }

    /* THE CHAIN LAYER (agentic graphs, 2026-07-27) — bay -> bay edges. Until this existed the floor was a
       DISPATCHER: it picked one agent per inbound message, the dock consumed the crate, and everything drawn
       downstream of that dock was scenery. `chains` compiles the other half of the graph: where a dock's OUTPUT
       goes. Computed here (not on demand) so the frontend engine, the sidecar chain runner and the REFIT nags
       all read ONE fact — the same reason resolveTarget lives in this module. Compiled BEFORE the BAY_NOT_FED
       pass because it is now one of the three ways a dock can be fed.
       DOCK-KEYED (multi-bay, 2026-09-22): `dockChains` is the truth (dockId -> next docks); `chains` is the
       agent VIEW every older surface reads (an agent's record = its entry dock's, next = the agents crewing
       the next docks) — byte-identical to the pre-dock compile on every floor where an agent crews one dock. */
    plan.dockChains = compileDockChains(plan, agentOfDock);
    const docksOfAgent = docksOfAgentOf(agentOfDock);
    const entryDock = entryDocksOf(docksOfAgent, reachDock, plan.dockChains);
    plan.chains = agentChainsView(plan, entryDock, docksOfAgent, agentOfDock);
    /* FAN-OUT (2026-08-21): a SPLIT whose flow reaches a JOINER runs EVERY lane — the joiner is what makes
       the branches rejoin, so load-balancing them would be a barrier that waits forever. Marked on the split's
       compiled cfg so the chain runner, the router and the floor all read one fact. A split with no joiner
       downstream keeps its round-robin meaning exactly. Hash input by design (topology changed). The walk
       crosses DOCKS the way work does — in at a hookup, out at the ship tile (plan.dockChains). */
    for (const jk in junctions) {
      const jc = junctions[jk];
      if (jc.kind !== 'split') continue;
      const p0 = jk.split(','), seen = {}, q = [{ x: +p0[0], y: +p0[1] }]; seen[jk] = true; let hit = false;
      while (q.length && !hit) {
        const t = q.shift(), owner = bayTileToDock[key(t.x, t.y)];
        const ship = owner && plan.dockChains[owner] && plan.dockChains[owner].tile;
        // a hookup that is NOT the dock's ship tile is an entrance: work re-emerges at the ship tile
        const nts = (ship && !(ship.x === t.x && ship.y === t.y)) ? [ship] : nextTiles(map, junctions, t);
        for (const nt of nts) { const nk = key(nt.x, nt.y); if (seen[nk]) continue; seen[nk] = true; if (junctions[nk] && junctions[nk].kind === 'join') { hit = true; break; } q.push(nt); }
      }
      if (hit) jc.fanout = true;
    }
    const chainFed = {};
    for (const d in plan.dockChains) for (const n of plan.dockChains[d].next) chainFed[n] = true;
    // an ESCALATION dock is fed by its gate, not by a door — it must never be shamed BAY_NOT_FED
    for (const jk in gateDocks) if (gateDocks[jk].escTo) chainFed[gateDocks[jk].escTo] = true;

    // a HOOKED bay whose belt serves NO direction — no intake feeds it, no UPSTREAM DOCK hands off to it, and
    // no outbox receives from it — is a belt to nowhere. A warning, never a blocker (dispatch can't route to it
    // anyway: resolveTarget only walks from sources). This replaces the old blocking DEAD_BAY, which condemned
    // valid outbound lanes; the chainFed clause is the same correction for valid stage-two docks, which are fed
    // by an agent rather than by a door and were being shamed for it. Per DOCK: a writer's second bay is judged
    // on its own belts, never excused by its first.
    // UNDER A BELT CYCLE reach is deliberately never computed (all false — a glowing lane must mean "a route runs
    // here", and nothing routes while the loop stands), so "not fed" would be a GUESS: it sent the Commander to
    // belt bays that were already fed while the real fault — the CYCLE, a blocking error — went unread (station.layout
    // audit 2026-09-28). Only the CYCLE speaks until it is broken.
    if (!cyc) for (const b of bays) if (!reachDock[b.propId] && !chainFed[b.propId] && !flowsToOutbox(b.tile)) errors.push({ code: 'BAY_NOT_FED', propId: b.propId, agentId: b.agentId, warn: true });
    // A CHAIN LOOP IS A BLOCKING ERROR — and it is INVISIBLE to detectCycle. A's ship tile feeding B's dock and
    // B's ship tile feeding A's dock are two separate physical lanes with no belt cycle anywhere; the loop only
    // exists across the docks (consume here, respawn there). Left unguarded that is an infinite chain of PAID
    // runs, which is exactly the bar `ok()` sets for a wholesale refusal ("a blocking error must genuinely be
    // able to loop or void work"). Walked over DOCKS: writer@A → editor@B → writer@C revisits an AGENT, not a
    // dock, and is a straight line — only a dock whose output returns to itself is a loop.
    const cc = chainCycle(plan.dockChains);
    if (cc) {
      // carry a propId so the REFIT/world overlay can ANCHOR the finding on a dock the loop runs through —
      // an error the Commander can't see on the floor is an error they can't fix. First agent, sorted: stable.
      const ccAgents = cc.map(d => agentOfDock[d]).filter((v, i, a) => v && a.indexOf(v) === i).sort();
      const onLoop = bays.find(b => b.agentId === ccAgents[0] && cc.indexOf(b.propId) >= 0);
      errors.push(onLoop ? { code: 'CHAIN_CYCLE', agents: ccAgents, propId: onLoop.propId } : { code: 'CHAIN_CYCLE', agents: ccAgents });
    }

    /* ---------- LINE IDENTITY — WORK BELONGS TO A LINE (2026-08-07, Andrew's ruling) ----------
       "each conveyor system built has a purpose and a different workflow — the conveyor system should
       visually run ONLY when the specific workflow is running."

       Every belt machine on a floor belongs to exactly ONE physical line (lineComponents: the connected
       component over belt tiles, plus every machine touching it through its footprint + 1-tile ring).
       `lineId` names that line. It is computed HERE, on the compiled plan, so the browser and the sidecar
       answer "which line does this dock belong to?" from the SAME artifact — the one-compiler law. There
       is no second derivation anywhere.

       DERIVATION: lineId === the component's key === the OLDEST member PROP id, ordered by the numeric
       suffix of the minted id and NOT by string order (propIdCmp — 'p9' is older than 'p10'). Prop ids are
       stable in the save doc, so a line keeps its identity across reloads and across every edit that keeps
       THE KEYING PROP; deleting that prop re-keys the line to its next-oldest machine (work already in
       flight then carries a lineId that no longer names it, and the gate stops it — that is the honest
       cost of identity-by-member). Pure: no clock, no RNG, no iteration luck (components are sorted by
       key, bays within a component by propId, and an agent takes the FIRST line that claims it).

       Attached AFTER the hash inputs are fixed, and only onto the LEGIBILITY list (`dockBays`) plus these
       lookup maps — the dispatch topology is unchanged, so the same floor keeps the same plan.hash it had
       before line identity existed and no station needlessly re-arms on upgrade. */
    const lines = [], lineOfProp = {}, lineOfAgent = {}, lineLimits = {};
    for (const c of lineComponents(geo)) {
      const lineId = c.key, rec = { lineId, propIds: c.props.slice(), intakes: c.intakes.slice(), outboxes: c.outboxes.slice(), agents: [] };
      for (const pid of c.props) lineOfProp[pid] = lineId;
      // an agent is on EVERY line it crews a dock of (multi-bay): rec.agents lists each crew member once
      for (const b of c.bays) if (b.agentId) { if (!lineOfAgent[b.agentId]) lineOfAgent[b.agentId] = lineId; if (rec.agents.indexOf(b.agentId) < 0) rec.agents.push(b.agentId); }
      rec.agents.sort();
      // LINE BUDGET rides the line's INBOX prop (the line's front door — same home as its name). The first
      // intake (component order = oldest first) carrying limits speaks; normalized HERE so the plan never
      // carries a raw, unclamped number. Legibility+policy list only: outside plan.hash (not topology).
      for (const iid of c.intakes) {
        const ip = props.find(q => q.id === iid);
        const lim = ip ? normalizeLineLimits(ip.limits) : null;
        if (lim) { rec.limits = lim; lineLimits[lineId] = lim; break; }
      }
      // The first Inbox with a project supplies the whole connected workflow.
      for (const iid of c.intakes) {
        const ip = props.find(q => q.id === iid);
        if (ip && typeof ip.projectRoot === 'string' && ip.projectRoot.trim()) {
          rec.projectRoot = ip.projectRoot.trim().slice(0, 4096); break;
        }
      }
      lines.push(rec);
    }
    plan.lines = lines;
    plan.lineLimits = lineLimits;     // lineId -> normalized { maxHops, maxUsdPerMessage, maxUsdPerDay, clamped? } (only lines that set one)
    plan.lineOfProp = lineOfProp;     // propId  -> lineId
    /* the agent VIEW of line identity: the line of its ENTRY dock (the dock unaddressed work for it enters at)
       when that dock is on a line, else the first line that claims it. One dock per agent = the dock's line. */
    for (const a in entryDock) { const l = lineOfProp[entryDock[a]]; if (l) lineOfAgent[a] = l; }
    plan.lineOfAgent = lineOfAgent;   // agentId -> the lineId of the (entry) dock it crews
    // THE DOCK LAYER, outside the hash (legibility + executor keys; derivable from the plan — see deriveDockLayer)
    const lineOfDock = {};
    for (const d in agentOfDock) if (lineOfProp[d]) lineOfDock[d] = lineOfProp[d];
    plan.agentOfDock = agentOfDock;   // dockId -> the agent crewing it (every bound bay, beltless included)
    plan.docksOfAgent = docksOfAgent; // agentId -> [dockId…] oldest first (propIdCmp)
    plan.reachDock = reachDock;       // dockId -> an INBOX reaches it
    plan.gateDocks = gateDocks;       // loop junction key -> { backTo: dockId|null, escTo: dockId|null }
    plan.lineOfDock = lineOfDock;     // dockId -> lineId
    plan.entryDock = entryDock;       // agentId -> the dock work ADDRESSED to the agent enters at
    for (const d of dockBays) { const l = lineOfProp[d.propId]; if (l) d.lineId = l; }

    // THE HASH IS DISPATCH TOPOLOGY, NOTHING ELSE — sources, dispatch bays, junctions, belts. Every legibility
    // extra (dockBays + their briefs, unboundBays, outs, reach, chains, lines) is OUTSIDE it, so the same floor
    // keeps the same hash and no station needlessly re-arms: typing a job brief, naming a line or upgrading to
    // line identity moves nothing here. Verified by test/pipeline.test.js ("a brief edit does not move the hash").
    plan.hash = hashStr(JSON.stringify({ sources, bays, junctions, belts: map }));
    return plan;
  }

  /* lineOf(plan, agentId) -> the lineId of the dock this agent crews, or null. The ONE reader every
     surface uses (router.lineOfAgent, the gate below, the floor's crate honesty) so "which line is this"
     can never be answered two different ways. A plan compiled before line identity existed answers null,
     which the gate reads as TERMINAL — see chainNext. */
  /* composeStageBrief(brief, hands) -> the standing brief a dock's agent RECEIVES, or null. The workflow panel's
     HANDS OFF phrase ("a 200-word draft") rides on the prop as `hands` and becomes a closing instruction —
     "When you're done, hand off: <hands>" — so what the card says the step hands off is what the agent is told
     to produce. Bounded like the brief (2000 total); the phrase itself is capped at 160 (worldmodel's cap). */
  const HANDS_LEAD = "When you're done, hand off: ";
  function composeStageBrief(brief, hands) {
    const b = (typeof brief === 'string' && brief.trim()) ? brief.trim() : '';
    const h = (typeof hands === 'string' && hands.trim()) ? hands.trim().slice(0, 160) : '';
    const out = b && h ? b + '\n\n' + HANDS_LEAD + h : (b || (h ? HANDS_LEAD + h : ''));
    return out ? out.slice(0, 2000) : null;
  }

  function lineOf(plan, agentId) {
    if (!plan || !agentId || !plan.lineOfAgent) return null;
    return plan.lineOfAgent[agentId] || null;
  }

  /* lineOriginOf(plan, agentId) -> the lineId that work ARRIVING FROM OUTSIDE at this dock belongs to, or
     null. Asked of the agent that actually RUNS, never of how the message was addressed — the per-agent
     channel bots deliberately hard-lock stage one to their bound agent and consult no floor routing at all,
     so a resolution-flavoured answer would have said "no line" for exactly the case the belts were drawn for.

     WHAT COUNTS AS "THE LINE'S OWN TRIGGER" is the station's existing law, not a new idea: **work handed
     over in person skips the ride in.** The REFIT flow strip has said so since belt-teach — "COMMS orders
     skip the ride in — you gave them in person" — and world.js already refuses to spawn an INTAKE crate for
     a kind:'directive' work-item. So the test is "did it ride in through this line's front door?": the dock
     must be one the plan's INBOX sources actually REACH. A dock no door feeds — a lone dock, or a MID-LINE
     stage a message merely named — was not triggered by anything, so its work is terminal and buys nothing
     downstream.

     Deliberately NOT keyed on a chat's agent binding. That binding cannot distinguish the Commander's
     explicit /talk from the hub's own bookkeeping — hub.js auto-saves the floor's pick onto any previously
     unbound chat (as a notifier index), so every channel chat looks "bound" from its second message on.
     Denying the line on that silently stopped channels from driving their lines after one message, which
     test/routing.sample.e2e.test.js reproduces exactly. An in-app COMMS directive stays terminal by a much
     stronger route than any heuristic: chat.js sends no lineId at all. */
  function lineOriginOf(plan, agentId) {
    if (!plan || !agentId || !plan.reach || !plan.reach[agentId]) return null;
    return lineOf(plan, agentId);
  }

  /* ---------- the chain layer: a dock's OUTPUT is another dock's INPUT ----------

     A DOCK NEVER EATS ITS OWN OUTPUT. A handoff crate leaves its producer's dock and rides THROUGH every other
     hookup tile of that same bay (a lane running along a dock's edge touches several ring tiles) — it is consumed
     only by a FOREIGN bound bay. The engine enforces the identical rule since 2026-08-04: world.js stamps the
     producer on the crate (`payload.fromAgentId`) and conveyor.js's dock-delivery check rides a crate past any
     stop whose owner IS its producer — physics, which is what makes a self-loop structurally impossible rather
     than merely unlikely. */

  // walk the flow from `starts`, fanning ALL junction lanes: which foreign DOCKS / outboxes can this reach?
  // Keyed by DOCK (multi-bay): the producer is `selfDock`; any OTHER dock consumes — including another bay the
  // same agent crews (writer@A's output is consumed at writer@C like at any foreign dock).
  function chainWalk(plan, selfDock, starts) {
    const map = plan.belts, junctions = plan.junctions || {}, dockAt = plan.bayTileToDock || {};
    const outAt = {};
    for (const o of (plan.outs || [])) outAt[key(o.tile.x, o.tile.y)] = true;
    const found = {}, seen = {}, q = [];
    let outbox = false, deadEnd = false, gated = false;
    for (const t of starts) { const k = key(t.x, t.y); if (map[k] && !seen[k]) { seen[k] = true; q.push(t); } }
    while (q.length) {
      const t = q.shift(), k = key(t.x, t.y), owner = dockAt[k];
      if (owner && owner !== selfDock) { found[owner] = true; continue; }   // a foreign dock CONSUMES the handoff
      if (outAt[k]) outbox = true;                                          // this lane also ships out
      // a LOOP gate / JOINER on the lane is a RUNTIME stage even when nothing static lies past it (2026-08-22):
      // a reviewer whose done lane goes straight to OUTBOX has `next: []`, yet its back lane still re-runs
      // the line. `gated` keeps that lane a chain step so the runner meets the gate (the draft→review→LOOP
      // floor that never looped).
      const jg = junctions[k]; if (jg && (jg.kind === 'loop' || jg.kind === 'join')) gated = true;
      const nts = nextTiles(map, junctions, t);
      if (!nts.length) { if (!outAt[k]) deadEnd = true; continue; }
      for (const nt of nts) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
    }
    return { next: Object.keys(found), outbox, deadEnd, gated };
  }

  /* which ring hookup does a dock SHIP from? A bay can touch several lanes (one in, one out). Pick the tile whose
     onward flow actually goes somewhere, in a fixed preference so frontend and sidecar spawn on the same tile:
     a lane that reaches another DOCK > a lane that reaches an OUTBOX > the first hookup. Deterministic: `tiles`
     is recorded in ring-scan order. Returns { tile, next:[dockId…], outbox, deadEnd } or null for a beltless dock. */
  function shipFrom(plan, bay) {
    const tiles = bayTilesOf(bay);
    let viaGate = null, viaOutbox = null, first = null;
    for (const t of tiles) {
      // the walk STARTS ON the hookup itself (not its successor): a dock's ring tile is very often ALSO the
      // outbox's ring tile on a short bay->OUTBOX lane, and starting one tile downstream stepped straight over
      // the delivery mouth and reported the ship-out lane as a dead end.
      const r = chainWalk(plan, bay.propId, [t]);
      const rec = { tile: t, next: r.next, outbox: r.outbox, deadEnd: r.deadEnd };
      if (r.gated) rec.gated = true;                    // additive: only present when a gate sits on the lane
      if (r.next.length) return rec;                    // feeds another dock — the strongest signal
      if (r.gated && !viaGate) viaGate = rec;           // a gate (loop/join) lane outranks a plain ship-out lane
      if (r.outbox && !viaOutbox) viaOutbox = rec;
      if (!first) first = rec;
    }
    return viaGate || viaOutbox || first;
  }

  function bayTilesOf(b) { return (b && b.tiles && b.tiles.length) ? b.tiles : (b && b.tile ? [b.tile] : []); }

  /* { dockId -> { tile, next:[dockId…], outbox, deadEnd, gated? } } for every belt-hooked bound bay. `next` is
     ordered by (crewing agent, then prop age) so a floor where every agent crews one dock walks its edges in
     exactly the order the agent-keyed compile did (chainCycle picks the same loop, the view sorts the same). */
  function compileDockChains(plan, agentOfDock) {
    const out = {}, aod = agentOfDock || {};
    const cmp = (a, b) => { const x = String(aod[a] || ''), y = String(aod[b] || ''); return x < y ? -1 : x > y ? 1 : propIdCmp(a, b); };
    for (const b of (plan.bays || [])) {
      if (!b || b.propId == null) continue;
      const r = shipFrom(plan, b);
      if (r) { r.next.sort(cmp); out[b.propId] = r; }
    }
    return out;
  }

  // agentId -> [dockId…] oldest first — every bound bay (beltless docks included: they are real stations)
  function docksOfAgentOf(agentOfDock) {
    const out = {};
    for (const d in agentOfDock) { const a = agentOfDock[d]; if (a) (out[a] = out[a] || []).push(d); }
    for (const a in out) out[a].sort(propIdCmp);
    return out;
  }

  /* THE ENTRY DOCK (Andrew's ruling, 2026-09-22): work ADDRESSED to a multi-dock agent — a /talk chat, a bot
     bound to it, a routine naming only the agent — enters at the agent's OLDEST dock an INBOX reaches; with no
     reached dock, its oldest belt-hooked dock (a beltless bay is on no line, so it can never run one); with
     neither, its oldest dock. Deterministic (propIdCmp). One dock per agent = that dock, always. */
  function entryDocksOf(docksOfAgent, reachDock, dockChains) {
    const out = {};
    for (const a in docksOfAgent) {
      const ds = docksOfAgent[a];
      out[a] = ds.find(d => reachDock && reachDock[d]) || ds.find(d => dockChains && dockChains[d]) || ds[0];
    }
    return out;
  }

  /* the AGENT VIEW of the chain layer: { agentId -> { tile, next:[agentId…], outbox, deadEnd, gated? } } — the
     agent's ENTRY dock's record with `next` read as the agents crewing those docks (sorted, unique). Exactly the
     old `chains` on any floor where an agent crews one dock; older surfaces keep reading it unchanged. */
  function agentChainsView(plan, entryDock, docksOfAgent, agentOfDock) {
    const out = {}, dc = plan.dockChains || {};
    for (const b of (plan.bays || [])) {
      const a = b && b.agentId;
      if (!a || out[a]) continue;
      const d = (entryDock && dc[entryDock[a]]) ? entryDock[a] : ((docksOfAgent && docksOfAgent[a]) || []).find(x => dc[x]);
      const r = d && dc[d];
      if (!r) continue;
      const next = r.next.map(x => agentOfDock[x]).filter((v, i, arr) => v && arr.indexOf(v) === i).sort();
      const rec = { tile: r.tile, next, outbox: r.outbox, deadEnd: r.deadEnd };
      if (r.gated) rec.gated = true;
      out[a] = rec;
    }
    return out;
  }
  // (kept for callers of the old internal) the agent-keyed chain map of a plan
  function compileChains(plan) { const L = dockLayer(plan); return agentChainsView(Object.assign({}, plan, { dockChains: L.dockChains }), L.entryDock, L.docksOfAgent, L.agentOfDock); }

  // the first DOCK a lane reaches walking from junction (jx,jy) out along `dir` (first lane at each junction)
  function laneFirstDock(map, junctions, dockAt, jx, jy, dir, unboundAt) {
    const v = DIRV[dir]; if (!v) return { dock: null, uncrewed: false };
    let t = { x: jx + v[0], y: jy + v[1] }, guard = 0; const seen = {};
    while (t && map[key(t.x, t.y)] && guard++ < 4096 && !seen[key(t.x, t.y)]) {
      const k2 = key(t.x, t.y); seen[k2] = true;
      if (dockAt[k2]) return { dock: dockAt[k2], uncrewed: false };
      if (unboundAt && unboundAt[k2]) return { dock: null, uncrewed: true };   // wired, just not crewed yet — UNBOUND_BAY has it
      const nts = nextTiles(map, junctions, t); t = nts[0] || null;
    }
    return { dock: null, uncrewed: false };
  }

  // dockId -> does an INBOX reach it? BFS from every feed mouth; a dock CONSUMES the box (no expansion past it).
  function dockReachOf(plan, cyclic) {
    const out = {}, dockAt = plan.bayTileToDock || {}, map = plan.belts || {}, junctions = plan.junctions || {};
    for (const b of (plan.bays || [])) if (b && b.propId != null) out[b.propId] = false;
    if (cyclic) return out;
    const seen = {}, q = [];
    for (const s of (plan.sources || [])) for (const st of srcTiles(s)) { const sk = key(st.x, st.y); if (!seen[sk]) { seen[sk] = true; q.push(st); } }
    while (q.length) {
      const t = q.shift(), k = key(t.x, t.y);
      if (dockAt[k]) { out[dockAt[k]] = true; continue; }
      for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
    }
    return out;
  }

  /* deriveDockLayer(plan) -> the dock maps of ANY plan, from the fields every stored plan already carries
     (bays[].propId + tiles, dockBays, belts, junctions, sources, outs, lineOfProp). The compiler attaches the
     same maps itself; this is for a plan persisted BEFORE the dock layer existed (planlines.healPlan) and for a
     hand-built plan a test or an older surface passes in. Pure; never mutates `plan`. A pre-dock plan was
     compiled while DUP_AGENT (retired 2026-09-22) was in force, so its agent->dock map is 1:1 and the
     derivation is lossless; a plan that carries docks for a multi-bay agent derives them from bays[].propId. */
  function deriveDockLayer(plan) {
    const p = plan || {};
    const bayTileToDock = {}, agentOfDock = {};
    for (const d of (p.dockBays || [])) if (d && d.propId != null && d.agentId) agentOfDock[d.propId] = d.agentId;
    for (const b of (p.bays || [])) {
      if (!b || b.propId == null) continue;
      if (b.agentId) agentOfDock[b.propId] = b.agentId;
      for (const t of bayTilesOf(b)) bayTileToDock[key(t.x, t.y)] = b.propId;
    }
    const map = p.belts || {}, junctions = p.junctions || {};
    const base = Object.assign({}, p, { bayTileToDock });
    const cyclic = (p.errors || []).some(e => e && e.code === 'CYCLE');
    const reachDock = dockReachOf(base, cyclic);
    const gateDocks = {};
    for (const jk in junctions) {
      const jc = junctions[jk];
      if (!jc || jc.kind !== 'loop') continue;
      const q = jk.split(','), jx = +q[0], jy = +q[1];
      gateDocks[jk] = { backTo: jc.back ? laneFirstDock(map, junctions, bayTileToDock, jx, jy, jc.back, null).dock : null,
                        escTo: jc.esc ? laneFirstDock(map, junctions, bayTileToDock, jx, jy, jc.esc, null).dock : null };
    }
    const dockChains = compileDockChains(base, agentOfDock);
    const docksOfAgent = docksOfAgentOf(agentOfDock);
    const entryDock = entryDocksOf(docksOfAgent, reachDock, dockChains);
    const lineOfDock = {}, lop = p.lineOfProp || {};
    for (const d in agentOfDock) {
      if (lop[d]) lineOfDock[d] = lop[d];
      else if (p.lineOfAgent && p.lineOfAgent[agentOfDock[d]] && docksOfAgent[agentOfDock[d]].length === 1) lineOfDock[d] = p.lineOfAgent[agentOfDock[d]];
    }
    return { bayTileToDock, agentOfDock, docksOfAgent, dockChains, reachDock, gateDocks, lineOfDock, entryDock };
  }
  /* dockLayer(plan) -> the plan's own dock maps when it carries them, else a derived layer (memoized per plan
     object — plans are not mutated after compile). Every dock-keyed reader goes through here, so a plan from
     any era answers the same questions. */
  const DOCK_KEYS = ['bayTileToDock', 'agentOfDock', 'docksOfAgent', 'dockChains', 'reachDock', 'gateDocks', 'lineOfDock', 'entryDock'];
  const layerMemo = typeof WeakMap === 'function' ? new WeakMap() : null;
  function hasDockLayer(plan) { return !!(plan && plan.dockChains && plan.bayTileToDock && plan.agentOfDock && plan.entryDock); }
  function dockLayer(plan) {
    if (!plan || typeof plan !== 'object') return deriveDockLayer(null);
    if (hasDockLayer(plan)) { const out = {}; for (const k of DOCK_KEYS) out[k] = plan[k] || {}; return out; }
    if (layerMemo && layerMemo.has(plan)) return layerMemo.get(plan);
    const L = deriveDockLayer(plan);
    if (layerMemo) layerMemo.set(plan, L);
    return L;
  }
  // a cycle over the chain edges (A→B→…→A). Returns the agents on the loop (sorted) or null. Iterative, same
  // three-colour marking as detectCycle — a bay graph is small, but the stack discipline is not negotiable here.
  function chainCycle(chains) {
    const color = {};
    for (const root in chains) {
      if (color[root]) continue;
      color[root] = 1;
      const stack = [{ a: root, i: 0 }];
      while (stack.length) {
        const fr = stack[stack.length - 1], kids = (chains[fr.a] && chains[fr.a].next) || [];
        if (fr.i >= kids.length) { color[fr.a] = 2; stack.pop(); continue; }
        const nb = kids[fr.i++];
        if (color[nb] === 1) return stack.map(f => f.a).concat([nb]).sort().filter((v, i, a) => a.indexOf(v) === i);
        if (!color[nb] && chains[nb]) { color[nb] = 1; stack.push({ a: nb, i: 0 }); }
      }
    }
    return null;
  }

  /* ---------- DOCK RESOLUTION (multi-bay, 2026-09-22) ----------
     dockOf(plan, agentId, dockId) -> the dock an agent-keyed call means: `dockId` itself when it is a dock this
     agent crews (or any known dock when no agent is named), else the agent's ENTRY dock (entryDocksOf). Every
     agent-keyed reader below routes through it, so an older caller that names only the agent reads the entry
     dock — which, on a floor where each agent crews one dock, is simply THE dock. */
  function dockOf(plan, agentId, dockId) {
    if (!plan) return null;
    const L = dockLayer(plan);
    if (dockId != null && dockId !== '' && L.agentOfDock[dockId] && (!agentId || L.agentOfDock[dockId] === agentId)) return String(dockId);
    return (agentId && L.entryDock[agentId]) || null;
  }
  function agentOfDockIn(plan, dockId) { if (!plan || dockId == null) return null; return dockLayer(plan).agentOfDock[dockId] || null; }
  // lineOfDock(plan, dockId) -> the lineId of the line this DOCK sits on, or null (the gate's `own` — see chainNext)
  function lineOfDock(plan, dockId) {
    if (!plan || dockId == null) return null;
    return dockLayer(plan).lineOfDock[dockId] || null;
  }
  // lineOriginOfDock(plan, dockId) -> lineOriginOf for one dock: its line, only when an INBOX reaches THIS dock
  function lineOriginOfDock(plan, dockId) {
    if (!plan || dockId == null) return null;
    const L = dockLayer(plan);
    return L.reachDock[dockId] ? (L.lineOfDock[dockId] || null) : null;
  }
  // entryDockOf(plan, agentId) -> the dock work ADDRESSED to this agent enters at (entryDocksOf), or null
  function entryDockOf(plan, agentId) { if (!plan || !agentId) return null; return dockLayer(plan).entryDock[agentId] || null; }
  function docksOf(plan, agentId) { if (!plan || !agentId) return []; return (dockLayer(plan).docksOfAgent[agentId] || []).slice(); }
  const nodeOf = (L, d) => ({ dockId: d, agentId: L.agentOfDock[d] || null });

  /* chainNext(plan, agentId, ctx, pick) -> the SINGLE agent this dock's output actually hands off to, or null.
     Mirrors the crate physics exactly (K crates in, K crates out — one output crate is one downstream run, never
     a fan-out to every lane): follows the belt from the ship tile, a FILTER branches on the OUTPUT's tag (this is
     how you draw "route the result by what it turned out to be"), a SPLIT round-robins through `pick`, own-dock
     hookups are ridden through, the first foreign dock consumes. null = the handoff ships out / dead-ends, i.e.
     this dock is a terminal stage and its reply is the pipeline's answer.

     THE GATE (work belongs to a line, 2026-08-07 — Andrew's ruling). A dock's output advances the work
     line ONLY when the run carries the lineId of THIS dock's line, i.e. only when the work entered
     through that line's own trigger (its INBOX / a channel routed down its belts / one of its routines /
     its sample job). A run with no lineId — a direct COMMS order, a /talk task, any ad-hoc job — is
     TERMINAL: the agent answers, and nothing downstream fires or spends. Living HERE, in the one module
     every surface already loads, is what makes the rule un-drift-able: the browser's COMMS line, the
     channel hub, cron and run-now all ask this same function, so no surface can disagree.

     OLD PLANS DEGRADE TO TERMINAL, ON PURPOSE. A plan compiled before line identity existed (one restored
     from disk at boot, say) has no lineOfAgent, so `own` is null and every dock is terminal until the app
     posts a fresh plan. That is the SAFER of the two defaults: the failure mode is "a line did not run",
     which the Commander can see and re-trigger, versus "money was spent on stages the user never asked
     for", which is silent and unrefundable. It is also self-healing — world.js re-posts the compiled plan
     on the first floor change after the app opens.

     DOCK-KEYED (multi-bay, 2026-09-22): the truth is chainNextDock(plan, dockId) -> { dockId, agentId } | null.
     chainNext is its agent reading — the dock is ctx.dockId when the caller knows it, else the agent's entry
     dock — kept byte-identical for every surface that still speaks agents. */
  function chainNextDock(plan, dockId, ctx, pick) {
    if (!plan || !(plan.chains || plan.dockChains) || !plan.belts || dockId == null) return null;
    const L = dockLayer(plan);
    const carried = (ctx && ctx.lineId != null && String(ctx.lineId)) || null;
    const own = L.lineOfDock[dockId] || null;
    if (!carried || !own || carried !== own) return null;
    const rec = L.dockChains[dockId];
    if (!rec || !rec.tile || !rec.next.length) return null;
    const map = plan.belts, junctions = plan.junctions || {}, dockAt = L.bayTileToDock;
    const tag = (ctx && ctx.tag) || 'general';
    let t = rec.tile, guard = 0; const seen = {};
    while (t && guard++ < 4096) {
      const k = key(t.x, t.y);
      if (dockAt[k] && dockAt[k] !== dockId) return nodeOf(L, dockAt[k]);   // a foreign dock consumes it
      if (seen[k]) return null;                                 // (a CYCLE is already a compile error)
      seen[k] = true;
      const here = map[k]; if (!here) return null;
      const j = junctions[k];
      let d = here;
      if (j && j.kind === 'filter') {
        const lanes = outLanes(map, t.x, t.y), want = j.routes && j.routes[tag];
        d = (want && lanes.indexOf(want) >= 0) ? want : (j.def && lanes.indexOf(j.def) >= 0) ? j.def : (lanes[0] || here);
      } else if (j && j.kind === 'split') {
        const lanes = outLanes(map, t.x, t.y);
        if (lanes.length) { const i = pick ? ((pick(k, lanes.length) % lanes.length) + lanes.length) % lanes.length : 0; d = lanes[i]; }
      } else if (j && j.kind === 'loop') {
        d = loopLanes(map, t.x, t.y, j).done || here;           // static reading: the loop is spent, leave on done
      }
      const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1];
      if (!map[key(nx, ny)]) return null;                       // shipped out / sank with no dock
      t = { x: nx, y: ny };
    }
    return null;
  }
  function chainNext(plan, agentId, ctx, pick) {
    if (!plan || !plan.chains || !plan.belts) return null;
    const n = chainNextDock(plan, dockOf(plan, agentId, ctx && ctx.dockId), ctx, pick);
    return n ? n.agentId : null;
  }

  /* chainStep(plan, agentId, ctx, pick) -> what this dock's output meets NEXT along its belt (2026-08-21):
       { agentId }                                   a foreign dock consumes it (== chainNext)
       { branches: [agentId…], split: key }          a FAN-OUT split: every lane runs (the split feeds a JOINER)
       { join: key, expect, timeoutMin, next }       a JOINER barrier; `next` = the dock past it (may be null)
       { loop: key, max, backTo, next }              a LOOP gate; `backTo` = the stage re-entered, `next` = the done dock
       null                                          terminal / gate refused (same rule as chainNext)
     Same line gate, same walk, same pick counter as chainNext — the runner calls THIS and chainNext stays the
     plain single-dock reading every older surface uses. `ctx.fromTile` lets the runner resume the walk from a
     junction it just released (a join) or re-enter from a loop gate (`ctx.via === 'back'`).
     DOCK-KEYED (multi-bay): chainStepDock(plan, dockId, ctx, pick) answers the same shapes with every agentId
     replaced by a node { dockId, agentId } — `{ dockId, agentId }`, `branches: [node…]`, join/loop `next`,
     loop `backTo`/`esc`. chainStep is its agent reading (ctx.dockId picks the dock, else the entry dock). */
  function chainStepDock(plan, dockId, ctx, pick) {
    if (!plan || !(plan.chains || plan.dockChains) || !plan.belts || dockId == null) return null;
    const L = dockLayer(plan);
    const carried = (ctx && ctx.lineId != null && String(ctx.lineId)) || null;
    const own = L.lineOfDock[dockId] || null;
    if (!carried || !own || carried !== own) return null;
    const rec = L.dockChains[dockId];
    const map = plan.belts, junctions = plan.junctions || {}, dockAt = L.bayTileToDock, gates = L.gateDocks || {};
    const tag = (ctx && ctx.tag) || 'general';
    const fromTile = ctx && ctx.fromTile;
    // a lane with no static next dock is still a step when a LOOP/JOIN gate sits on it (rec.gated) — the
    // gate's back lane / barrier is what runs, and only the walk below can see it
    if (!fromTile && (!rec || !rec.tile || (!rec.next.length && !rec.gated))) return null;
    const walkNode = r => (r && r.dockId) ? { dockId: r.dockId, agentId: r.agentId } : null;
    const gateNode = d => d ? nodeOf(L, d) : null;
    // walk one lane to the first foreign dock, honouring filters/merges; stops at a join, a loop or a fan-out split
    function walk(start, startDir) {
      let t = start, forced = startDir || null, guard = 0; const seen = {};
      while (t && guard++ < 4096) {
        const k = key(t.x, t.y);
        if (dockAt[k] && dockAt[k] !== dockId) return nodeOf(L, dockAt[k]);
        if (seen[k]) return null;
        seen[k] = true;
        const here = map[k]; if (!here) return null;
        const j = junctions[k];
        let d = here;
        if (forced) { d = forced; forced = null; }
        else if (j && j.kind === 'join') {
          const ex = outLanes(map, t.x, t.y)[0] || here, v = DIRV[ex];
          const nt = { x: t.x + v[0], y: t.y + v[1] };
          return { join: k, expect: j.expect || 0, timeoutMin: j.timeoutMin || 10, next: map[key(nt.x, nt.y)] ? walkNode(walk(nt)) : null };
        } else if (j && j.kind === 'loop') {
          const ll = loopLanes(map, t.x, t.y, j), vd = ll.done ? DIRV[ll.done] : null;
          const nt = vd ? { x: t.x + vd[0], y: t.y + vd[1] } : null;
          const g = gates[k] || {};
          // esc (2026-08-30): the dock the ESCALATION lane reaches (pre-resolved at compile like backTo) —
          // the runner sends a verdict-exhausted crate THERE instead of annotating it onto the done lane
          return { loop: k, max: j.max || LOOP_MAX_DEFAULT, backTo: gateNode(g.backTo), when: j.when || null, esc: gateNode(g.escTo), next: (nt && map[key(nt.x, nt.y)]) ? walkNode(walk(nt)) : null };
        } else if (j && j.kind === 'split' && j.fanout) {
          /* a lane may lead to an INNER fan-out split (a cascade — how a floor goes wider than 3
             branches): its walk returns { branches }, and dropping that on the floor lost every dock
             behind it (the joiner then waited on branches nobody launched, 2026-08-30). Splice the
             inner split's branches in — recursion handles any depth. */
          const lanes = outLanes(map, t.x, t.y), branches = [];
          const has = d0 => branches.some(b => b.dockId === d0);
          for (const ld of lanes) {
            const v = DIRV[ld], nt = { x: t.x + v[0], y: t.y + v[1] }; if (!map[key(nt.x, nt.y)]) continue;
            const r = walk(nt);
            if (r && r.branches) { for (const b of r.branches) if (!has(b.dockId)) branches.push(b); }
            else if (r && r.dockId && !has(r.dockId)) branches.push(walkNode(r));
          }
          return { branches, split: k };
        } else if (j && j.kind === 'filter') {
          const lanes = outLanes(map, t.x, t.y), want = j.routes && j.routes[tag];
          d = (want && lanes.indexOf(want) >= 0) ? want : (j.def && lanes.indexOf(j.def) >= 0) ? j.def : (lanes[0] || here);
        } else if (j && j.kind === 'split') {
          const lanes = outLanes(map, t.x, t.y);
          if (lanes.length) { const i = pick ? ((pick(k, lanes.length) % lanes.length) + lanes.length) % lanes.length : 0; d = lanes[i]; }
        }
        const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1];
        if (!map[key(nx, ny)]) return null;
        t = { x: nx, y: ny };
      }
      return null;
    }
    if (fromTile) {
      // resume from a junction: a released JOIN leaves on its single exit; a LOOP re-entry takes the back lane
      const jk = key(fromTile.x, fromTile.y), j = junctions[jk];
      if (j && j.kind === 'loop' && ctx.via === 'back') { if (!j.back) return null; return walk(fromTile, j.back); }
      const ex = outLanes(map, fromTile.x, fromTile.y)[0]; if (!ex) return null;
      return walk(fromTile, ex);
    }
    return walk(rec.tile);
  }
  /* the AGENT reading of a chainStepDock answer — the exact shapes (and key order) chainStep always returned */
  function stepToAgents(s) {
    if (!s) return s;
    const a = n => (n && n.agentId) || null;
    if (s.dockId) return { agentId: s.agentId };
    if (s.branches) { const out = []; for (const b of s.branches) { const x = a(b); if (x && out.indexOf(x) < 0) out.push(x); } return { branches: out, split: s.split }; }
    if (s.join) return { join: s.join, expect: s.expect, timeoutMin: s.timeoutMin, next: a(s.next) };
    if (s.loop) return { loop: s.loop, max: s.max, backTo: a(s.backTo), when: s.when, esc: a(s.esc), next: a(s.next) };
    return s;
  }
  function chainStep(plan, agentId, ctx, pick) {
    if (!plan || !plan.chains || !plan.belts) return null;
    return stepToAgents(chainStepDock(plan, dockOf(plan, agentId, ctx && ctx.dockId), ctx, pick));
  }

  /* ---------- legibility layer: pure readouts of the compiled plan (no routing behavior) ----------
     liveTiles(plan) -> { "x,y": true } for every belt tile on a COMPLETE route, in EITHER direction:
       • inbound  — reachable forward from an INTAKE source AND flowing onward into a bound bay;
       • outbound — reachable forward from a bound bay's hookup AND flowing onward into an OUTBOX.
     The renderer draws these tiles energized and the rest cold, so "the line powers on" is literally the
     compiled plan — truthful telemetry by construction. A bay->outbox ship-out lane glows exactly like an
     intake->bay feed lane: both genuinely carry real crates. */
  function liveTiles(plan) {
    const out = {};
    if (!plan || !plan.belts) return out;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    // shared reverse adjacency (tileKey -> upstream tileKeys), built once for both direction passes
    const rev = {};
    for (const k in map) {
      const p = k.split(','), t = { x: +p[0], y: +p[1] };
      for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); (rev[nk] = rev[nk] || []).push(k); }
    }
    // forward flood from `starts`, intersected with a reverse flood from `ends` — the tiles on a complete route
    function segment(starts, stopAtBay, ends) {
      const fwd = {}, q = [];
      for (const s of starts) { const k = key(s.x, s.y); if (map[k] && !fwd[k]) { fwd[k] = true; q.push(s); } }
      while (q.length) {
        const t = q.shift();
        if (stopAtBay && bayAt[key(t.x, t.y)]) continue;   // a bound bay consumes inbound boxes
        for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!fwd[nk]) { fwd[nk] = true; q.push(nt); } }
      }
      const bwd = {}, q2 = [];
      for (const e of ends) { const k = key(e.x, e.y); if (map[k] && !bwd[k]) { bwd[k] = true; q2.push(k); } }
      while (q2.length) {
        const k = q2.shift();
        for (const uk of (rev[k] || [])) if (!bwd[uk]) { bwd[uk] = true; q2.push(uk); }
      }
      for (const k in fwd) if (bwd[k]) out[k] = true;
    }
    // inbound: intake sources -> bound-bay hookups
    const bayTiles = [];
    for (const k in bayAt) { const p = k.split(','); bayTiles.push({ x: +p[0], y: +p[1] }); }
    if (plan.sources && plan.sources.length && bayTiles.length) {
      const starts = [];   // EVERY feed mouth of every source — a second lane off a later ring tile is just as live
      for (const s of plan.sources) for (const st of srcTiles(s)) starts.push(st);
      segment(starts, true, bayTiles);
    }
    // outbound: bound-bay hookups -> outbox hookups
    const outTiles = (plan.outs || []).map(o => o.tile);
    if (bayTiles.length && outTiles.length) segment(bayTiles, false, outTiles);
    // HANDOFF: dock -> dock. A stage-to-stage lane carries real crates (and buys real runs) the moment the
    // chain layer exists, so leaving it COLD would be the energized-tile promise lying in the other direction.
    // Starts at the SHIP tile and ends only on a DOWNSTREAM dock's hookups, so a stub hookup that reaches no
    // other dock stays dark instead of lighting itself.
    // Per DOCK (multi-bay): a writer's second bay is a downstream end in its own right.
    const L = (plan.chains || plan.dockChains) ? dockLayer(plan) : null;
    const chains = L ? L.dockChains : {}, dockAt = L ? L.bayTileToDock : {};
    for (const did in chains) {
      const c = chains[did];
      if (!c || !c.tile || !c.next || !c.next.length) continue;
      const ends = [];
      for (const k in dockAt) if (c.next.indexOf(dockAt[k]) >= 0) { const p = k.split(','); ends.push({ x: +p[0], y: +p[1] }); }
      if (ends.length) segment([c.tile], false, ends);
    }
    /* THE LOOP GATE'S BACK LANE IS LIVE (2026-08-29). Static flow deliberately cuts the back edge
       (nextTiles follows `done` only) so a gated cycle can't loop the compiler — but the crate really
       does ride that lane, so flooding only the static graph left a stamped REVISION LOOP two-thirds
       frozen: the honest-telemetry promise lying in the COLD direction. Lit only when the gate itself
       is already live (a stranded gate's back lane stays dark) and only as far as a bound dock.
       stopAtBay=false (2026-08-30): the flood must ride THROUGH the re-entry dock's first ring tile —
       a back column's final merge tile sat one tile past the hookup and rendered frozen mid-column,
       which reads exactly like the missing-belt gap the column exists to avoid. The reverse flood
       from bayTiles still bounds the wash to tiles that actually reach a dock. */
    for (const jk in junctions) {
      const j = junctions[jk];
      if (!j || j.kind !== 'loop' || !j.back || !out[jk]) continue;
      const p = jk.split(','), v = DIRV[j.back];
      segment([{ x: +p[0] + v[0], y: +p[1] + v[1] }], false, bayTiles);
    }
    /* …and its ESCALATION lane (2026-08-30): a live gate's esc lane carries real exhausted crates to a
       dock (or the outbox), so it energizes on the same condition as the back lane. */
    for (const jk in junctions) {
      const j = junctions[jk];
      if (!j || j.kind !== 'loop' || !j.esc || !out[jk]) continue;
      const p = jk.split(','), v = DIRV[j.esc];
      segment([{ x: +p[0] + v[0], y: +p[1] + v[1] }], false, bayTiles.concat(outTiles));
    }
    return out;
  }

  /* routeFrom(plan, x, y) -> where does the flow from THIS belt tile end up?
     { agents: [agentId...], unbound: n, outbox: bool, deadEnd: bool } — agents sorted (deterministic),
     unbound counts distinct unassigned-bay hookups passed, outbox true when the flow reaches an OUTBOX
     hookup (a ship-out lane), deadEnd true if any branch sinks with none of the above. Fans out ALL
     junction lanes (a hover tag answers "where CAN this go", not one dispatch decision). */
  function routeFrom(plan, x, y) {
    const res = { agents: [], unbound: 0, outbox: false, deadEnd: false };
    if (!plan || !plan.belts || !plan.belts[key(x, y)]) return res;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    const unboundAt = {}, outAt = {};
    for (const u of (plan.unboundBays || [])) unboundAt[key(u.tile.x, u.tile.y)] = u.propId;
    for (const o of (plan.outs || [])) outAt[key(o.tile.x, o.tile.y)] = true;
    const agents = {}, unboundSeen = {}, seen = {}, q = [{ x, y }];
    seen[key(x, y)] = true;
    while (q.length) {
      const t = q.shift(), k = key(t.x, t.y);
      if (bayAt[k]) { agents[bayAt[k]] = true; continue; }   // a bound bay consumes the box
      if (unboundAt[k]) unboundSeen[unboundAt[k]] = true;     // riding past a dead hookup — note it, flow continues
      if (outAt[k]) res.outbox = true;                        // this lane ships out (flow may continue past)
      const nts = nextTiles(map, junctions, t);
      if (!nts.length) { if (!outAt[k]) res.deadEnd = true; continue; }   // an open end AT the outbox is a delivery, not a dead end
      for (const nt of nts) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
    }
    res.agents = Object.keys(agents).sort();
    res.unbound = Object.keys(unboundSeen).length;
    return res;
  }

  // which agentId does a work-item with this tag route to? Follows belt flow from the (first) source, applying
  // FILTER content-routing by tag, until it reaches a bound bay. null = no bay on the route.
  // `pick(tileKey, laneCount) -> index` chooses the lane at a SPLIT/MERGE junction (FILTER is deterministic by
  // tag and ignores it). Omitted -> lane 0 (a pure, replay-stable read). The sidecar router passes a stateful
  /* junctionLaneOwners(plan) -> { junctionTileKey: { dir: [agentIds…] } } — for each junction out-lane,
     every bound-bay owner that lane can reach (fanning through downstream junctions; a bound bay consumes,
     so the walk never fans past one). The conveyor engine reads this so an ADDRESSED crate (payload.agentId
     — a cron, a bound chat) takes the lane that leads HOME instead of obeying content/balance routing:
     filters and splitters only ever decide for unowned work. Pure, deterministic, sorted output.
     junctionLaneDocks(plan) is the same readout by DOCK (multi-bay): a crate addressed to ONE dock of a
     multi-dock agent (payload.dockId) steers to that bay, not to whichever bay of the agent a lane reaches. */
  function laneOwnersBy(plan, atMap, cmp) {
    const out = {};
    if (!plan || !plan.belts) return out;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = atMap || {};
    function ownersFrom(start) {
      const seen = {}, q = [start], found = {};
      seen[key(start.x, start.y)] = true;
      while (q.length) {
        const t = q.shift(), k = key(t.x, t.y);
        if (bayAt[k]) { found[bayAt[k]] = true; continue; }
        for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
      }
      return found;
    }
    for (const jk in junctions) {
      const p = jk.split(','), x = +p[0], y = +p[1];
      const rec = {};
      for (const d of outLanes(map, x, y)) {
        const v = DIRV[d], nt = { x: x + v[0], y: y + v[1] };
        if (!map[key(nt.x, nt.y)]) continue;
        const ids = Object.keys(ownersFrom(nt)).sort(cmp);
        if (ids.length) rec[d] = ids;
      }
      if (Object.keys(rec).length) out[jk] = rec;
    }
    return out;
  }
  function junctionLaneOwners(plan) { return laneOwnersBy(plan, plan && plan.bayTileToAgent, undefined); }
  function junctionLaneDocks(plan) { return plan && plan.belts ? laneOwnersBy(plan, dockLayer(plan).bayTileToDock, propIdCmp) : {}; }

  /* sourceFor(plan, agentId, dockId?) -> the INBOX source whose flow actually REACHES this agent's dock, or null.
     Multi-network law (2026-07-05, Andrew's two-room bug): each room's INBOX feeds its OWN line — an
     addressed work-item must enter through the door that leads home, never sail another agent's lane to
     their outbox. Mirrors the ENGINE's addressed-crate physics exactly: fans ALL junction lanes (owners
     steer it home), rides THROUGH foreign docks (only the owner's dock consumes an addressed crate).
     First matching source in plan order (deterministic); null -> no line on this floor reaches the agent
     (caller lands the work directly at the dock — the lone-bay law). With `dockId` (multi-bay) the target
     is that ONE dock; without it, any dock the agent crews (the pre-dock reading, unchanged). */
  function sourceFor(plan, agentId, dockId) {
    if (!plan || !plan.sources || !plan.sources.length || !agentId) return null;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToAgent || {};
    const want = (dockId != null && dockId !== '') ? String(dockId) : null;
    const dockAt = want ? dockLayer(plan).bayTileToDock : null;
    const home = want ? (k => dockAt[k] === want) : (k => bayAt[k] === agentId);
    for (const s of plan.sources) {
      // walk each feed mouth SEPARATELY (ring-scan order): the tile returned is the mouth whose lane
      // actually leads home, so an addressed crate spawns on the reaching lane — not on a first-recorded
      // mouth that feeds a different lane entirely (the 2026-08-04 multi-lane-intake fix).
      for (const st of srcTiles(s)) {
        const seen = {}, q = [st];
        seen[key(st.x, st.y)] = true;
        let hit = false;
        while (q.length && !hit) {
          const t = q.shift(), k = key(t.x, t.y);
          if (home(k)) { hit = true; break; }
          // a FOREIGN dock hookup does not consume an addressed crate — keep riding
          for (const nt of nextTiles(map, junctions, t)) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
        }
        if (hit) return st;
      }
    }
    return null;
  }

  // round-robin picker so autonomous dispatch genuinely SPREADS splitter work across agents, matching the
  // engine's load-balance intent instead of always running the first lane.

  /* resolveDock(plan, ctx, pick) -> { agentId, dockId } of the dock a work-item routes to, or null. THE entry
     dispatcher (multi-bay, 2026-09-22): resolveTarget is its agent reading. An ADDRESSED item enters at the
     addressee's ENTRY dock (entryDocksOf — Andrew's ruling: the oldest dock an INBOX reaches, else the oldest);
     an unaddressed one rides the belts to the first bound dock, and THAT dock is the answer — the one whose
     brief, room and line the run gets. */
  function resolveDock(plan, ctx, pick) {
    if (!plan) return null;
    // ADDRESSED WORK GOES TO ITS ADDRESSEE (2026-07-05, Andrew's consistency ruling): when the message is
    // explicitly bound to an agent (a COMMS session, a /talk binding) and that agent owns a dock on this
    // floor, the floor's answer IS that dock — content/filter routing only ever sorts UNADDRESSED work
    // (group intake, unbound chats). Without this, a two-room floor sent "message to agent B" down room A's
    // line because A's INBOX compiled first.
    const bound = ctx && ctx.boundAgentId;
    if (bound) {
      const docks = plan.dockBays || plan.bays || [];
      for (const b of docks) if (b.agentId === bound) return { agentId: bound, dockId: entryDockOf(plan, bound) || b.propId || null };
    }
    if (!plan.sources || !plan.sources.length) return null;
    const tag = (ctx && ctx.tag) || 'general';
    const map = plan.belts, junctions = plan.junctions, bayAt = plan.bayTileToAgent;
    const dockAt = dockLayer(plan).bayTileToDock;
    // walk EVERY source in plan order (not just sources[0] — a second room's network was invisible), and
    // EVERY feed mouth of each source in ring-scan order (not just the first — an intake touching two lanes
    // could only ever dispatch down the first-recorded one). The first lane that lands on a bound bay wins.
    // Deterministic: plan order + ring-scan order + lane rules are all fixed.
    for (const s of plan.sources) for (const st of srcTiles(s)) {
      let t = st, guard = 0; const seen = {};
      let hit = null;
      while (t && guard++ < 4096) {
        const k = key(t.x, t.y);
        if (bayAt[k]) { hit = { agentId: bayAt[k], dockId: dockAt[k] || null }; break; } // arrived at a bound bay
        if (seen[k]) break;                            // loop guard (a CYCLE is already a compile error)
        seen[k] = true;
        const here = map[k]; if (!here) break;         // sank with no bay
        const j = junctions[k];
        let d = here;
        if (j && j.kind === 'filter') {
          // mirror conveyor.chooseExit EXACTLY: routed lane -> default lane -> first lane (never an invalid dir),
          // so the agent the sidecar resolves is provably the bay the box physically rides to.
          const lanes = outLanes(map, t.x, t.y);
          const want = j.routes && j.routes[tag];
          d = (want && lanes.indexOf(want) >= 0) ? want
            : (j.def && lanes.indexOf(j.def) >= 0) ? j.def
            : (lanes[0] || here);
        }
        else if (j && j.kind === 'split') {   // pick a lane (default 0; the router's picker round-robins to spread work)
          const lanes = outLanes(map, t.x, t.y);
          if (lanes.length) { const i = pick ? ((pick(k, lanes.length) % lanes.length) + lanes.length) % lanes.length : 0; d = lanes[i]; } else d = here;
        }
        // a MERGE follows the belt (it funnels lanes IN; its single exit IS the tile's dir), and must not
        // burn a round-robin tick — that counter belongs to splitters, which are the only real branch.
        const v = DIRV[d], nx = t.x + v[0], ny = t.y + v[1];
        if (!map[key(nx, ny)]) break;                  // stepped off the belt with no bay
        t = { x: nx, y: ny };
      }
      if (hit) return hit;
    }
    return null;
  }
  // which agentId does a work-item with this tag route to? The agent reading of resolveDock (see above).
  function resolveTarget(plan, ctx, pick) {
    const r = resolveDock(plan, ctx, pick);
    return r ? r.agentId : null;
  }

  /* THE HANDOFF TURN — lives HERE, in the module both the sidecar executor and the browser's COMMS loop
     already load, because the same floor must produce the same run on every surface. A downstream stage is
     NOT the user, it is a machine being handed material, so the turn names the line explicitly. Carrying the
     ORIGINAL request as well as the upstream output is load-bearing: a writer handed only research has no
     idea what was asked and invents one. */
  function handoffPrompt(originalText, fromAgentId, upstream, hop, stageBrief, verdictBrief) {
    // stageBrief (step editor, 2026-08-05): the RECEIVING dock's standing job brief — optional 5th param so
    // every existing caller composes byte-identical turns. Prompt text only; bounded like the compiled copy.
    // verdictBrief (LOOP verdicts, 2026-08-22): the VERDICT-line instruction for a dock whose lane meets a
    // verdict-keyed LOOP gate (sidecar/routing/verdict.js composes it) — optional 6th param, same law.
    const brief = (typeof stageBrief === 'string' && stageBrief.trim()) ? stageBrief.trim().slice(0, 2000) : '';
    const verdict = (typeof verdictBrief === 'string' && verdictBrief.trim()) ? verdictBrief.trim().slice(0, 600) : '';
    return 'PIPELINE HANDOFF — you are stage ' + (hop + 1) + ' of a work line on this station.\n\n'
      + 'The original request was:\n' + String(originalText || '(none recorded)') + '\n\n'
      + 'The upstream stage (' + fromAgentId + ') produced:\n' + String(upstream) + '\n\n'
      + (brief ? 'YOUR STANDING BRIEF FOR THIS STATION:\n' + brief + '\n\n' : '')
      + (verdict ? verdict + '\n\n' : '')
      + 'Do YOUR part of this work and produce the output for the next stage. Do not restate the upstream '
      + 'output — build on it. Answer with the work itself, not a description of what you would do.';
  }

  /* fanSiblings(plan, agentId) -> the OTHER first docks of the fan-out split that feeds this dock, sorted
     (2026-08-21). The entry dispatcher (resolveTarget) still names ONE dock for an inbound message — that is
     the one that ran. When that dock sits on a lane of a split that feeds a JOINER, the remaining lanes are
     parallel branches the line promised to run; the chain runner runs them from the original text so the
     joiner barrier can actually fill. [] when the dock is not on a fan-out lane. */
  function fanSiblingsDock(plan, dockId) {
    if (!plan || !plan.belts || !plan.junctions || dockId == null) return [];
    const map = plan.belts, junctions = plan.junctions, L = dockLayer(plan), bayAt = L.bayTileToDock;
    /* every first dock this split's crates are PROMISED to reach. Fans through nested FAN-OUT splits
       (a cascaded split is how a floor goes wider than 3 branches — the old single-path walk saw one
       dock per lane and the runner silently never launched the rest, so the joiner sat on a partial
       until timeout, 2026-08-30). A plain split or filter mid-lane keeps the old first-lane reading:
       a load-balancer's pick is a run-time decision, not a promise of extra branches. */
    function fanDocks(start) {
      const out = [], seen = {}, q = [start]; let guard = 0;
      while (q.length && guard++ < 4096) {
        const t = q.shift(), k = t && key(t.x, t.y);
        if (!t || !map[k] || seen[k]) continue; seen[k] = true;
        if (bayAt[k]) { if (out.indexOf(bayAt[k]) < 0) out.push(bayAt[k]); continue; }   // each path ends at its FIRST dock
        const j = junctions[k], nts = nextTiles(map, junctions, t);
        if (j && j.kind === 'split' && j.fanout) { for (const nt of nts) q.push(nt); continue; }
        if (nts.length) q.push(nts[0]);
      }
      return out;
    }
    /* a dock inside a CASCADE belongs to every fan-out group that reaches it (the inner split's group
       and the outer's); its siblings are the UNION minus itself, so whichever dock the entry dispatcher
       picked, every other promised branch still runs. */
    const res = [];
    for (const jk in junctions) {
      const j = junctions[jk]; if (j.kind !== 'split' || !j.fanout) continue;
      const p = jk.split(',');
      const docks = fanDocks({ x: +p[0], y: +p[1] });
      if (docks.indexOf(dockId) < 0) continue;
      for (const a of docks) if (a !== dockId && res.indexOf(a) < 0) res.push(a);
    }
    const aod = L.agentOfDock;
    res.sort((a, b) => { const x = String(aod[a] || ''), y = String(aod[b] || ''); return x < y ? -1 : x > y ? 1 : propIdCmp(a, b); });
    return res.map(d => nodeOf(L, d));
  }
  /* fanSiblings(plan, agentId, dockId?) -> the agent reading of fanSiblingsDock (DOCK-KEYED since multi-bay:
     the walk compares docks, so a writer on two lanes of one fan-out is its own sibling). Sorted agents. */
  function fanSiblings(plan, agentId, dockId) {
    if (!plan || !plan.belts || !plan.junctions || !agentId) return [];
    const self = dockOf(plan, agentId, dockId);
    const out = [];
    for (const n of fanSiblingsDock(plan, self)) if (n.agentId && n.agentId !== agentId && out.indexOf(n.agentId) < 0) out.push(n.agentId);
    return out.sort();
  }

  /* joinPayload(parts, missing) -> the ONE merged crate a JOINER releases. `parts` = [{ agentId, text }] in
     delivery order; `missing` = branch names that never delivered before the timeout (marked, never hidden —
     a downstream stage must know it is working from a partial set). Shared module so the floor and the
     sidecar describe the same crate. */
  function joinPayload(parts, missing) {
    const ps = parts || [], ms = missing || [], n = ps.length + ms.length;
    const body = ps.map((p, i) => '=== BRANCH ' + (i + 1) + ' of ' + n + ' — ' + (p.agentId || '?') + ' ===\n' + String(p.text || '').trim());
    let out = 'JOINED OUTPUT — ' + ps.length + ' of ' + n + ' branch' + (n === 1 ? '' : 'es') + ' delivered.\n\n' + body.join('\n\n');
    if (ms.length) out += '\n\n=== PARTIAL: ' + ms.length + ' branch' + (ms.length === 1 ? '' : 'es') + ' never delivered before the joiner timed out (' + ms.join(', ') + ') ===';
    return out;
  }

  const ok = plan => !plan.errors.some(e => !e.warn);   // a plan is deployable iff it has no non-warning errors

  /* ---------- LINE COMPONENTS (guided workflows, 2026-08-05) ----------
     Groups the floor's belt machinery into physical LINES: connected components over belt tiles
     (4-neighbour adjacency, direction-blind — a lane and its return leg are one line) plus every
     machine (intake/bay/outbox/junction) that touches a component through its footprint + 1-tile
     ring — the exact hookup semantics compileRoutingPlan's passes use. Pure + deterministic
     (no RNG, no clock, inputs unmutated); the finish-the-line card derives its checklist from
     these against the compiled plan, and the delivery-retirement hook hit-tests `tiles`.
     `key` = the OLDEST member PROP id — oldest by the monotonic counter the save doc mints ids from
     (`p1`, `p2`, … `p10`), NOT by string order. See propIdCmp: a default string sort puts 'p10'
     BEFORE 'p9', so the tenth prop on a line would silently steal the key from the ninth and rename
     the whole line. Prop ids are stable in the save doc, so a line keeps its identity across reloads
     and across every edit that keeps THE KEYING PROP. It does NOT survive deleting that prop: the
     line then re-keys to its next-oldest member, and anything latched on the old key (a lineId a
     run is carrying, a localStorage entry) no longer names it. That is the real behaviour — a line's
     identity is its oldest surviving machine, not the line itself. */
  /* PROP-ID ORDER (2026-08-07 conveyor audit). Ids come from worldmodel's monotonic `_nid` as
     'p' + N, so numeric order IS creation order. Compare the suffix numerically; anything that is
     not 'p<N>' (a legacy/hand-authored id) falls back to a plain string compare and sorts AFTER the
     minted ids, so the answer stays total and deterministic on any doc. */
  const PROP_ID_N = /^p(\d+)$/;
  function propIdCmp(a, b) {
    const ma = PROP_ID_N.exec(a), mb = PROP_ID_N.exec(b);
    if (ma && mb) { const d = (+ma[1]) - (+mb[1]); return d || (a < b ? -1 : a > b ? 1 : 0); }
    if (ma) return -1;
    if (mb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function lineComponents(geo) {
    const props = (geo && geo.props) || [];
    const map = buildBeltMap(geo && geo.belts);
    const MACH = { intake: 1, bay: 1, outbox: 1, filter: 1, splitter: 1, merger: 1, joiner: 1, loop: 1 };
    // union-find over belt-tile keys
    const parent = {};
    const find = k => { let r = k; while (parent[r] !== r) r = parent[r]; let c = k; while (parent[c] !== r) { const n = parent[c]; parent[c] = r; c = n; } return r; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    for (const k in map) parent[k] = k;
    for (const k in map) {
      const p = k.split(','), x = +p[0], y = +p[1];
      for (const d of LANE_ORDER) { const v = DIRV[d], nk = key(x + v[0], y + v[1]); if (map[nk]) union(k, nk); }
    }
    // a machine joins (and can BRIDGE) every component its footprint+ring touches
    const propTiles = {};   // propId -> [belt keys]
    for (const pr of props) {
      if (!MACH[pr.t]) continue;
      const w = pr.w || 1, h = pr.h || 1, hits = [];
      for (let yy = pr.y - 1; yy <= pr.y + h; yy++)
        for (let xx = pr.x - 1; xx <= pr.x + w; xx++)
          if (map[key(xx, yy)]) hits.push(key(xx, yy));
      if (!hits.length) continue;   // a beltless machine is on no line
      for (let i = 1; i < hits.length; i++) union(hits[0], hits[i]);
      propTiles[pr.id] = hits;
    }
    // fold members per root
    const byRoot = {};
    const compOf = r => byRoot[r] || (byRoot[r] = { key: null, props: [], bays: [], intakes: [], outboxes: [], tiles: {}, beltCount: 0, bbox: null });
    const grow = (c, x, y) => { const b = c.bbox; if (!b) c.bbox = { x1: x, y1: y, x2: x, y2: y }; else { if (x < b.x1) b.x1 = x; if (y < b.y1) b.y1 = y; if (x > b.x2) b.x2 = x; if (y > b.y2) b.y2 = y; } };
    for (const k in map) {
      const c = compOf(find(k)), p = k.split(',');
      c.tiles[k] = true; c.beltCount++; grow(c, +p[0], +p[1]);
    }
    for (const pr of props) {
      const hits = propTiles[pr.id];
      if (!hits) continue;
      const c = compOf(find(hits[0]));
      c.props.push(pr.id);
      if (pr.t === 'bay') c.bays.push({ propId: pr.id, agentId: pr.agentId || null, role: pr.role || null, x: pr.x, y: pr.y, w: pr.w || 1, h: pr.h || 1 });
      else if (pr.t === 'intake') c.intakes.push(pr.id);
      else if (pr.t === 'outbox') c.outboxes.push(pr.id);
      grow(c, pr.x, pr.y); grow(c, pr.x + (pr.w || 1) - 1, pr.y + (pr.h || 1) - 1);
    }
    const out = [];
    for (const r in byRoot) {
      const c = byRoot[r];
      if (!c.props.length) continue;              // bare belt scribbles are not a line
      c.props.sort(propIdCmp); c.key = c.props[0];
      c.bays.sort((a, b) => propIdCmp(a.propId, b.propId));
      out.push(c);
    }
    out.sort((a, b) => propIdCmp(a.key, b.key));
    return out;
  }

  /* lineLimitsOf(plan, lineId) -> the normalized LINE BUDGET for this line, or null (= the executor's
     defaults). The ONE reader (router.lineLimits, the chain route) — never re-derived from props. */
  function lineLimitsOf(plan, lineId) {
    if (!plan || lineId == null) return null;
    const m = plan.lineLimits;
    const rec = m && typeof m === 'object' ? m[String(lineId)] : null;
    return rec && typeof rec === 'object' ? rec : null;
  }

  return { compileRoutingPlan, composeStageBrief, HANDS_LEAD, resolveTarget, lineOf, lineOriginOf, lineLimitsOf, normalizeLineLimits, LINE_LIMIT_DEFAULTS, LINE_LIMIT_CEILINGS, sourceFor, ok, liveTiles, routeFrom, junctionLaneOwners, chainNext, chainStep, fanSiblings, handoffPrompt, joinPayload, lineComponents, LOOP_MAX_DEFAULT, LOOP_MAX_CEILING,
    // THE DOCK LAYER (multi-bay agents, 2026-09-22) — the dock-keyed truth the agent readings above are views of
    resolveDock, chainNextDock, chainStepDock, fanSiblingsDock, junctionLaneDocks, lineOfDock, lineOriginOfDock, entryDockOf, docksOf, dockOf, agentOfDock: agentOfDockIn, deriveDockLayer, dockLayer, hasDockLayer, stepToAgents, propIdCmp,
    _internals: { DIRV, OPP, LANE_ORDER, key, buildBeltMap, outLanes, inLanes, loopLanes, beltTileNear, nextTiles, detectCycle, hashStr, compileChains, compileDockChains, chainCycle, shipFrom, propIdCmp, entryDocksOf, agentChainsView } };
});
