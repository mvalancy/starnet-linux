/* stationcommands.js — the PAGE half of the station bridge.
 *
 * Sessions and crew are frontend state (App.openWorkstream / summonAgent / selectAgent, workstreams inside
 * agent.save.json), while agent tools run in the sidecar. So a tool that wants to open a session emits
 * `station.command` on the bus; this listens, runs the verb against the live station, and POSTs the outcome
 * back to /api/station/ack.
 *
 * ⛔ EVERY VERB REPORTS TRUTHFULLY. A refusal ("no such agent", "the crew list is not ready") is a real answer
 * and must travel back as ok:false. Never resolve ok:true for something that did not happen — a tool that says
 * "opened a session" with no session behind it is the exact failure this whole bridge is built to prevent.
 * Read-only verbs land first on purpose: they prove the channel with nothing to corrupt.
 */
'use strict';

const StationCommands = (() => {
  /* ONE resolution law for every name-addressed verb (and the same one team.dispatch applies sidecar-side):
     exact id → exact title → UNIQUE substring; anything else throws with the real names, because a
     plausible-but-wrong session is worse than a refusal the agent can read and correct. */
  function resolveSession(want) {
    if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('sessions are not ready yet');
    want = String(want || '').trim();
    if (!want) throw new Error('name which session');
    const generalId = Workstreams.generalId ? Workstreams.generalId() : null;
    const rows = (Workstreams.list() || []).map(w => ({ w, title: String(w.title != null ? w.title : (w.id === generalId ? 'General' : '')).trim() }));
    const lower = want.toLowerCase();
    const byId = rows.filter(r => r.w.id === want);
    const byTitle = rows.filter(r => r.title && r.title.toLowerCase() === lower);
    const byPart = rows.filter(r => r.title && r.title.toLowerCase().indexOf(lower) >= 0);
    const hits = byId.length ? byId : (byTitle.length ? byTitle : byPart);
    if (hits.length === 1) return hits[0];
    const names = rows.map(r => r.title).filter(Boolean).join(', ');
    throw new Error(hits.length > 1
      ? 'more than one session matches "' + want + '" — name it exactly. Open sessions: ' + names
      : 'there is no session called "' + want + '"' + (names ? '. Open sessions: ' + names : ''));
  }

  function taskRows(includeArchived) {
    if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('task board is not ready yet');
    return (Workstreams.list({ includeArchived: !!includeArchived }) || []).filter(w => w && w.kind === 'task');
  }

  function taskView(w) {
    return {
      id: w.id, title: w.title || 'Untitled task', agentId: w.agentId || 'agent',
      lane: w.lane || 'todo', archived: !!w.archived, projectRoot: w.projectRoot || null
    };
  }

  function resolveTask(want, includeArchived) {
    want = String(want || '').trim();
    if (!want) throw new Error('name which task');
    const rows = taskRows(includeArchived);
    const lower = want.toLowerCase();
    const byId = rows.filter(w => w.id === want);
    const byTitle = rows.filter(w => String(w.title || '').trim().toLowerCase() === lower);
    const byPart = rows.filter(w => String(w.title || '').toLowerCase().indexOf(lower) >= 0);
    const hits = byId.length ? byId : (byTitle.length ? byTitle : byPart);
    if (hits.length === 1) return hits[0];
    const names = rows.map(w => w.title).filter(Boolean).join(', ');
    throw new Error(hits.length > 1
      ? 'more than one task matches "' + want + '" - name it exactly. Board tasks: ' + names
      : 'there is no task called "' + want + '"' + (names ? '. Board tasks: ' + names : ''));
  }

  /* A model-facing board mutation is not complete when localStorage changed; it is complete only after the
     sidecar accepted the save and a fresh GET returned the expected workstream/tombstone. A retry after an
     ambiguous transport failure is safe because create and every state-setting manage action are idempotent. */
  async function persistWorkstreams(proof) {
    if (typeof App === 'undefined' || !App.persist) throw new Error('the station cannot save task changes right now');
    if (typeof CloudSave === 'undefined' || !CloudSave.flush || !CloudSave.pull) {
      throw new Error('durable task storage is unavailable - no change can be reported as complete');
    }
    App.persist();
    const landed = await CloudSave.flush({ force: true });
    if (!landed) throw new Error('durable task save was refused or unreachable - do not report this change as complete');
    const saved = await CloudSave.pull();
    if (!saved || !proof(saved)) throw new Error('durable task read-back did not confirm the change - do not report it as complete');
    try { if (App.refreshRail) App.refreshRail(); } catch (_) {}
  }

  /* Delivery crosses browser pages, and frontend workstream ids are page-local until their saves converge.
     Prefer the id that launched the run; if this page does not know it, heal ONLY by a unique exact title.
     Substring matching is deliberately forbidden here: an automatic fold must never guess its destination. */
  function resolveDelivery(a) {
    if (typeof Workstreams === 'undefined' || !Workstreams.get || !Workstreams.list) throw new Error('sessions are not ready yet');
    const id = String((a && a.streamId) || '');
    const byId = id && Workstreams.get(id);
    if (byId) return { w: byId, resolvedBy: 'id' };
    const title = String((a && a.sessionTitle) || '').trim();
    if (title) {
      const lower = title.toLowerCase();
      const generalId = Workstreams.generalId ? Workstreams.generalId() : null;
      const hits = (Workstreams.list() || []).filter(w =>
        String(w.title != null ? w.title : (w.id === generalId ? 'General' : '')).trim().toLowerCase() === lower);
      if (hits.length === 1) return { w: hits[0], resolvedBy: 'title' };
      if (hits.length > 1) throw new Error('more than one session is called "' + title + '" on this station');
    }
    throw new Error('there is no session with id ' + (id || '(none given)') + ' on this station');
  }

  function refreshAndPersist(ws, quiet) {
    if (quiet) return;
    const isOpen = Workstreams.activeId && Workstreams.activeId() === ws.id;
    if (isOpen && typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
  }

  function foldDelivery(a, opts) {
    opts = opts || {};
    const hit = resolveDelivery(a);
    const ws = hit.w;
    const text = String((a && a.text) || '').trim();
    if (!text) throw new Error('nothing to deliver — the worker returned no text');
    const runId = String((a && a.runId) || '');
    if (runId && (ws.runIds || []).indexOf(runId) >= 0) {
      try { if (typeof Channels !== 'undefined' && Channels.end) Channels.end(ws.id); } catch (_) {}
      return { folded: false, reason: 'already delivered', session: ws.title || 'General', resolvedBy: hit.resolvedBy };
    }
    const who = String((a && a.agentId) || 'agent');
    const prompt = String((a && a.prompt) || '').trim();
    const ts = Number(a && a.ts) > 0 ? Number(a.ts) : Date.now();
    if (!Array.isArray(ws.history)) ws.history = [];
    /* The instruction goes in as a sys marker, not a user turn: the Commander did not type it here, and
       chat.js excludes sys lines from historyWindow() so it is never replayed to the model as if they had. */
    if (prompt) ws.history.push({ role: 'system', sys: true, content: '— delegated to ' + who + ': ' + prompt.slice(0, 400) + ' —', ts });
    ws.history.push({ role: 'assistant', content: text, agentId: who, ts });
    if (runId && Workstreams.appendRun) Workstreams.appendRun(ws.id, runId, ts);
    else if (Workstreams.touch) Workstreams.touch(ws.id);
    if (Workstreams.markUnread) Workstreams.markUnread(ws.id);
    try { if (typeof Channels !== 'undefined' && Channels.end) Channels.end(ws.id); } catch (_) {}
    refreshAndPersist(ws, !!opts.quiet);
    return { folded: true, session: ws.title || 'General', agentId: who, resolvedBy: hit.resolvedBy };
  }

  /* ---------- station.layout: THE FLOOR AS THE LEAD READS IT (2026-09-28; builds on PR #48 by @mvanhorn) ----------
     Asked to explain or fix a workflow, the lead could not see the floor, so it guessed. This answers from the live
     WorldModel through the Workflow panel's OWN readers, never a second derivation: WorkflowLine.lineFlow (the run
     order, keyed by BAY, so one agent crewing two Bays is two steps), readiness + pillText (what blocks the line,
     the per-BAY workstation gate and a blocking finding anywhere on the floor included), howItRuns (the sentence),
     and lineStarts (schedules, channels, folder and webhook triggers — and the PAUSED ones, with the server's own
     reason — from the same three reads the panel makes). So the lead says what the panel shows, and a panel fix is
     a lead fix. A brief is the text the agent RECEIVES (the compiled dockBays brief = brief + HANDS OFF). Routing is
     the plan poster's verdict (World.planStatus), read in RUN NOW's order. A fact that could not be read is
     reported as unread, never as "nothing". Bays on no line (a crewed lone BAY is a complete dock) are listed too.
     The page answers with the WHOLE floor in full; the sidecar (sidecar/tools/builtin/station.js) adds what only the
     harness knows — the router's own plan, each line's effective budget, today's numbers, each BAY's last run — and
     shapes the answer to the model's window. ⛔ READ-ONLY: nothing here assigns, edits, saves, or posts a plan.
     (Audit 2026-09-28: lone Bays, paused starts, the station-wide refusal, per-BAY compute, the loop's escalation
     lane, the routing verdict order, the belt CYCLE, crew membership and filter rules were fixed here.) */
  const LAYOUT_FACT_MS = 2500;    // each server read gets this long (the bridge itself gives up at 6 s)
  async function readFact(url) {
    let timer = null;
    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (ctl) timer = setTimeout(() => ctl.abort(), LAYOUT_FACT_MS);
      const r = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      return r && r.ok ? await r.json() : null;
    } catch (_) { return null; } finally { if (timer) clearTimeout(timer); }
  }
  // the three reads the Workflow panel makes for a line's starts (workflowpanel.js refreshServerFacts + ltRefresh)
  async function layoutFacts() {
    const [cron, chans, lt] = await Promise.all([readFact('/api/cron'), readFact('/api/channels/status'), readFact('/api/routing/triggers')]);
    const f = { cron: cron && Array.isArray(cron.jobs) ? cron : null,
      chans: chans && typeof chans === 'object' && !Array.isArray(chans) ? chans : null,
      lt: lt && Array.isArray(lt.triggers) ? lt : null };
    f.unread = [!f.cron && 'routines', !f.chans && 'channels', !f.lt && 'folder and webhook triggers'].filter(Boolean);
    return f;
  }
  const uniq = xs => xs.filter((v, i, a) => a.indexOf(v) === i);
  /* the poster's verdict, read in the order REFIT's RUN NOW gate reads it (build.js finPlanGate): a REFUSED post is
     off; a post that failed or is still in flight is UNCONFIRMED — the router may still be running the previous
     floor — before any compiler finding is read as "off". planHash rides along so the sidecar can confirm the claim
     against the plan the router actually holds. */
  function routingState(sync, drawnBlocking, label) {
    const labels = errs => uniq(errs.map(e => label(e.code))).join(' · ');
    const errs = (sync && sync.errors) || [];
    let out;
    if (!sync || !sync.station) out = { state: 'unknown', note: 'The page could not say whether the router holds this floor.' };
    else if (sync.refusedHash && sync.refusedHash === sync.lastHash) out = { state: 'off', note: 'Routing is OFF for the whole station: the router refused the floor it was last sent, so no line routes work.' + (errs.length ? ' Fix: ' + labels(errs) + '.' : '') };
    else if (sync.stale || sync.inflight || sync.retryPending) out = { state: 'unconfirmed', note: 'The router has not confirmed this floor (the last send failed or is still in flight), so it may still be routing by the previous floor.' };
    else if (errs.length) out = { state: 'off', note: 'Routing is OFF for the whole station: the router refuses the entire floor while any blocking error is on it, so no line routes work. Fix: ' + labels(errs) + '.' };
    else if (!sync.lastHash) out = { state: 'unknown', note: 'The router has not answered for this floor yet.' };
    else out = { state: 'live', note: 'Routing is live: the router is running ' + (sync.pending ? 'the floor as last sent.' : 'this floor.') };
    if (sync && sync.station) out.planHash = sync.hash || null;
    if (sync && sync.station && sync.pending) {
      out.pendingEdits = true;
      out.note += ' The floor has newer edits the router has not received yet (Build mode sends them when it closes, and running a line sends them first)'
        + (out.state === 'off' ? '; they are checked when sent.' : '.');
      if (drawnBlocking.length) out.note += ' As drawn now, the floor has a blocking error the router will refuse: ' + labels(drawnBlocking) + '.';
    }
    return out;
  }
  // one line by exact lineId, exact name, or a UNIQUE name fragment — the same law as resolveSession
  function pickLine(lines, want) {
    const lower = want.toLowerCase();
    const byId = lines.filter(l => l.lineId === want);
    const byName = lines.filter(l => l.name && l.name.toLowerCase() === lower);
    const byPart = lines.filter(l => l.name && l.name.toLowerCase().indexOf(lower) >= 0);
    const hits = byId.length ? byId : (byName.length ? byName : byPart);
    if (hits.length === 1) return hits[0];
    const names = lines.map(l => (l.name || 'unnamed') + ' (' + l.lineId + ')').join(', ');
    throw new Error(hits.length > 1 ? 'more than one line matches "' + want + '" — name it exactly. Lines: ' + names
      : 'there is no line called "' + want + '"' + (names ? '. Lines: ' + names : ' — this station has no assembly lines'));
  }
  // when a LOOP's escalation lane is taken — the router's own rule (chain.js loopDecision), in words
  function escWhen(g) {
    const tries = ' after ' + (g.max || 5) + ' tries';
    if (!g.when) return 'never: the LOOP has no pass condition, so it never gives up';
    return g.when === 'approved' ? 'if it is still not approved' + tries : g.when === 'revise' ? 'if the verdict still does not say revise' + tries
      : 'if it still reads as ' + g.when + ' work' + tries;
  }
  function describeLayout(st, agents, facts, sync, want) {
    const P = Pipeline, W = WorkflowLine, B = typeof Build !== 'undefined' ? Build : null;
    const roster = (agents || []).filter(a => a && a.id);
    const names = {}; for (const a of roster) names[a.id] = a.name || a.id;
    // an id the roster does not hold still RUNS, on the station's default identity; an unread roster says nothing
    const onCrew = id => !roster.length || Object.prototype.hasOwnProperty.call(names, id);
    const who = id => id ? Object.assign({ agentId: id, name: names[id] || id }, onCrew(id) ? {} : { onCrew: false }) : null;
    const upper = id => String(names[id] || id || 'AGENT').toUpperCase();   // the panel's agent label (build.js agentLabelFor)
    const label = code => (B && B.nagLabel) ? B.nagLabel(code) : code;       // the floor's short nag
    const why = code => (B && B.nagWhy) ? B.nagWhy(code) : label(code);      // the panel's full fix sentence (its labelOf)
    const propOf = id => (id && st.propById(id)) || null;
    const roomName = p => { const id = p ? st.roomAt(p.x, p.y) : null; const r = id && st.roomById(id); return r ? (r.name || r.kind || id) : null; };
    const toolsAt = (aid, pid) => { try { return (aid && st.bayObjects(aid, pid)) || []; } catch (_) { return []; } };
    const hasCompute = (aid, pid) => !!aid && toolsAt(aid, pid).indexOf('computer') >= 0;   // PER BAY: router.stationFor(agentId, dockId)
    const toolName = o => (o && typeof o === 'object') ? (o.objectType + (o.connectorId ? ':' + o.connectorId : '')) : String(o);
    // a routine's schedule in words, exactly as the panel says it (build.js wfHost.human)
    const human = d => { const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
      return (typeof CronHuman !== 'undefined' && CronHuman.describeDisplay) ? CronHuman.describeDisplay(d, { tz }) : String(d == null ? '' : d); };

    // geometry props carry the projected frame (station tile = geometry tile + origin); room lookups use station tiles
    const geo = st.projectGeometry(), plan = P.compileRoutingPlan(geo) || {};
    const origin = geo.origin || { tx: 0, ty: 0 };
    const roomAtTile = t => { const id = st.roomAt(t.x + origin.tx, t.y + origin.ty); const r = id && st.roomById(id); return r ? (r.name || r.kind || id) : null; };
    const issue = e => {
      const o = { code: e.code, label: label(e.code), blocking: !e.warn, propId: e.propId || null };
      const f = why(e.code); if (f !== o.label) o.fix = f;
      if (!o.propId && e.tile) { const room = roomAtTile(e.tile); if (room) o.room = room; }   // a belt CYCLE has only a tile: say where it is
      return o;
    };
    const D = P.dockLayer(plan), dockChains = D.dockChains || {};
    const received = {}; for (const d of (plan.dockBays || [])) received[d.propId] = d.brief || '';
    // a crewed Bay: the compiled brief its agent receives; an uncrewed one: what it WILL receive once crewed
    const briefFor = pid => {
      if (Object.prototype.hasOwnProperty.call(received, pid)) return received[pid];
      const p = propOf(pid);
      return (p && P.composeStageBrief && P.composeStageBrief(p.brief, p.hands)) || '';
    };
    const errors = (plan.errors || []).filter(Boolean), claimed = new Set();
    const onLine = (c, e) => (e.propId != null && c.props.indexOf(e.propId) >= 0) || !!(e.tile && c.tiles && c.tiles[e.tile.x + ',' + e.tile.y])
      || (e.propId == null && !e.tile && [].concat(e.agentId || [], e.agents || []).some(a => c.bays.some(b => b.agentId === a)));
    const unread = (facts && facts.unread) || [];
    // FILTER rules: a filter junction's routes (tag -> lane) and default, each lane named by the docks it leads to
    const laneDocks = (P.junctionLaneDocks ? P.junctionLaneDocks(plan) : {}) || {};
    const I = P._internals || {};
    const junctionKeyOf = p => (plan.belts && plan.belts[p.x + ',' + p.y]) ? p.x + ',' + p.y
      : (I.beltTileNear ? (t => t ? t.x + ',' + t.y : null)(I.beltTileNear(plan.belts || {}, p.x, p.y, p.w || 1, p.h || 1)) : null);
    const comps = (P.lineComponents(geo) || []).filter(c => c.intakes.length || c.bays.length || c.outboxes.length);

    let lines = comps.map(c => {
      const flow = W.lineFlow(plan, c, P, geo.props);
      const starts = W.lineStarts(flow, { lt: facts.lt, lineKey: c.key, cron: facts.cron, chans: facts.chans, agents, human });
      const anyStart = !!(starts.schedules.length || starts.channels.length || starts.events.length);
      // the panel's facts, verbatim (build.js wfHost: hasCompute per BAY; workflowpanel.js paintHead: briefOf, labelOf, isCrew)
      const ready = W.readiness(flow, c, { hasCompute, errors: plan.errors || [], labelOf: why, isCrew: onCrew,
        briefOf: pid => { const p = propOf(pid); return p && (p.brief || p.hands); }, triggers: starts });
      const segs = W.howItRuns(flow, { nameOf: upper, handsOf: pid => { const p = propOf(pid); return p && p.hands; }, triggers: starts });
      let hints = ready.hints.map(h => h.what);
      if (unread.length && flow.trigger.propId && !anyStart && !flow.cyclic) {
        // a start the page could not read is unknown, not absent: never let "nothing starts it" stand on a failed read
        const unsure = 'What starts it could not be fully read right now (' + unread.join(', ') + ' unavailable)' + (starts.paused.length ? '; paused: ' + starts.paused.join('; ') : '') + '; ';
        if (segs[0] && /^Nothing starts it/.test(segs[0].s)) segs[0] = { t: 'text', s: unsure };
        hints = hints.filter(h => !/^nothing starts it/.test(h)).concat(['check what starts this line again: ' + unread.join(', ') + ' could not be read']);
      }
      const step = {}; flow.order.forEach((pid, i) => { step[pid] = i + 1; });
      const ref = pid => ({ step: step[pid] || null, propId: pid, agent: flow.docks[pid] && flow.docks[pid].agentId ? upper(flow.docks[pid].agentId) : null });
      // the ESCALATION lanes: gate -> the docks it runs after, and the dock it escalates to (never a plain hand-off)
      const escGates = flow.gates.filter(g => g.kind === 'loop' && g.escTo);
      const escFrom = (from, to) => escGates.some(g => g.escTo === to && (g.after || []).indexOf(from) >= 0);
      const MODE = { all: 'in parallel', turns: 'taking turns', oneof: 'whichever the content routes to' };
      const colMode = {}; for (const col of flow.cols) for (const d of col.docks) colMode[d.propId] = col.docks.length > 1 ? (MODE[col.mode] || null) : null;
      const steps = flow.order.map(pid => {
        const d = flow.docks[pid], sp = propOf(pid), nb = W.neighbours(flow, pid), ch = dockChains[pid];
        const fed = !!(D.reachDock || {})[pid];
        const s = { step: step[pid], propId: pid, role: d.role || null, room: roomName(sp), agent: who(d.agentId),
          routed: !!d.routed, fedByInbox: fed,
          getsWorkFrom: (fed ? ['INBOX'] : []).concat(nb.prev.map(p => escFrom(p, pid) ? Object.assign(ref(p), { onEscalation: true }) : ref(p))),
          sendsTo: d.agentId ? nb.next.filter(n => !escFrom(pid, n)).map(ref).concat(ch && ch.outbox ? ['OUTBOX'] : []) : [],
          brief: briefFor(pid), tools: d.agentId ? toolsAt(d.agentId, pid).map(toolName) : [] };
        const esc = escGates.filter(g => (g.after || []).indexOf(pid) >= 0);
        if (esc.length && d.agentId) s.escalatesTo = esc.map(g => Object.assign(ref(g.escTo), { when: escWhen(g), runs: !!g.when }));
        if (colMode[pid]) s.runsWith = colMode[pid];
        const gate = escGates.find(g => g.escTo === pid);
        if (!d.agentId) s.note = 'no agent yet: not routed until one is assigned';
        else if (flow.cyclic) s.note = 'a belt LOOP on the floor stops all routing';
        else if (d.escalation && gate) s.note = gate.when ? 'runs only on the LOOP\'s escalation lane: ' + escWhen(gate) : 'on the LOOP\'s escalation lane, which never runs: the LOOP has no pass condition';
        else if (d.detached) s.note = 'not connected to the INBOX';
        else if (flow.probeNext && flow.probeNext[pid]) s.note = 'its belt leads on to ' + flow.probeNext[pid].map(n => 'step ' + (step[n] || '?')).join(' or ') + ', which has no agent yet';
        else if (d.deadEnd) s.note = 'its work goes nowhere: connect a belt onward';
        if (d.agentId && !onCrew(d.agentId)) s.note = (s.note ? s.note + '; ' : '') + 'its agent is not on the crew, so its runs use the station\'s default identity';
        return s;
      });
      const gates = flow.gates.map(g => g.kind === 'loop'
        ? Object.assign({ kind: 'loop', propId: g.propId || null, after: (g.after || []).map(ref), sendsBackTo: g.backTo ? ref(g.backTo) : null, until: g.when || null, maxPasses: g.max || null },
          g.escTo ? { escalatesTo: ref(g.escTo), escalation: escWhen(g) } : {})
        : { kind: g.kind, propId: g.propId || null, after: (g.after || []).map(ref) });
      // FILTER rules on this line: which tagged work goes to which step (the rest takes the default lane)
      const filters = [];
      for (const fp of (geo.props || [])) {
        if (fp.t !== 'filter' || c.props.indexOf(fp.id) < 0) continue;
        const jk = junctionKeyOf(fp), j = jk && plan.junctions && plan.junctions[jk], lanes = (jk && laneDocks[jk]) || {};
        if (!j || j.kind !== 'filter') continue;
        const to = dir => (lanes[dir] || []).filter(pid => step[pid]).map(ref);
        filters.push({ propId: fp.id, rules: Object.keys(j.routes || {}).map(tag => ({ tag, goesTo: to(j.routes[tag]) })), otherwise: j.def ? to(j.def) : [] });
      }
      const mine = errors.filter(e => onLine(c, e)); mine.forEach(e => claimed.add(e));
      const out = { lineId: c.key, name: (c.intakes.map(id => propOf(id)).find(p => p && p.label) || {}).label || null,
        status: W.pillText(ready), ready: !!ready.ready, howItRuns: W.sentenceText(segs),
        blocking: ready.blocking.map(b => b.what), hints,
        starts: { schedules: starts.schedules, channels: starts.channels, events: starts.events, paused: starts.paused,
          routines: starts.routines.map(r => ({ name: r.name, agent: upper(r.agentId), enabled: r.enabled, runsWholeLine: r.runsLine, atEntry: r.atEntry, startsLine: r.startsLine, schedule: human(r.display) })),
          channelBots: starts.chanRows.map(r => ({ label: r.label, connected: r.connected, answersAs: r.answersAs, feedsThisLine: r.feeds })) },
        steps, gates, filters, issues: mine.map(issue) };
      if (unread.length) out.startsUnread = unread;
      return out;
    });
    // BAYS ON NO LINE: a crewed lone BAY is a complete dock (work addressed to its agent lands there, with its brief and
    // its room's tools — router.stationFor); an uncrewed one does nothing. Never invisible, never only an issue code.
    const onAnyLine = {}; for (const c of comps) for (const b of c.bays) onAnyLine[b.propId] = true;
    const loneBays = (st.props() || []).filter(p => p && p.t === 'bay' && !onAnyLine[p.id]).map(p => {
      const aid = p.agentId || null;
      const o = { propId: p.id, role: p.role || null, room: roomName(p), agent: who(aid), brief: briefFor(p.id), tools: aid ? toolsAt(aid, p.id).map(toolName) : [] };
      o.note = !aid ? 'no agent and not on a belt line: it does nothing until an agent is assigned'
        : 'not on a belt line: work addressed to ' + upper(aid) + ' arrives at this BAY directly, with this brief and this room\'s tools'
          + (hasCompute(aid, p.id) ? '' : '; it has no workstation here, so those runs cannot compute')
          + (onCrew(aid) ? '' : '; its agent is not on the crew, so its runs use the station\'s default identity');
      return o;
    });
    if (want) lines = [pickLine(lines, want)];
    const drawnBlocking = errors.filter(e => !e.warn);
    const cron = facts && facts.cron;
    return {
      routing: routingState(sync, drawnBlocking, label),
      // the scheduler as the routines panel reads it: E-STOP freezes it even while its arm intent stays on
      automation: cron ? { scheduler: cron.halted ? 'stopped by E-STOP' : cron.enabled ? 'on' : 'off' } : null,
      lines,
      loneBays: want ? [] : loneBays,
      // a finding on no line (a beltless Inbox, a buried belt, a stray CYCLE) is still a finding: reported, never dropped
      otherIssues: want ? [] : errors.filter(e => !claimed.has(e)).map(issue),
      rooms: (st.rooms() || []).filter(r => r && r.kind !== 'corridor').map(r => ({ id: r.id, name: r.name || null, kind: r.kind || null })),
      workstations: (st.props() || []).filter(p => p && p.agentId && p.t !== 'bay').map(p => ({ propId: p.id, type: p.t, room: roomName(p), agent: who(p.agentId),
        grants: (typeof WorldModel !== 'undefined' && WorldModel.capForProp && WorldModel.capForProp(p.t)) || null }))
    };
  }

  const VERBS = {
    /* The floor, read-only, for the lead: routing state, every assembly line as the Workflow panel reads it, rooms,
       and workstation holders. Refuses honestly when the station, routing, or the line reader is not loaded. */
    'station.layout': async (a) => {
      const st = typeof App !== 'undefined' && App.station ? App.station() : null;
      if (!st || !st.projectGeometry || !st.rooms || !st.bayObjects) throw new Error('the station layout is not ready yet');
      if (typeof Pipeline === 'undefined' || !Pipeline.compileRoutingPlan || !Pipeline.lineComponents || !Pipeline.dockLayer) throw new Error('workflow routing is not loaded on this page');
      if (typeof WorkflowLine === 'undefined' || !WorkflowLine.lineStarts) throw new Error('the workflow line reader is not loaded on this page');
      const want = String((a && a.line) || '').trim().slice(0, 80);
      let sync = null;
      try { sync = (typeof World !== 'undefined' && World && World.planStatus) ? World.planStatus() : null; } catch (_) { sync = null; }   // unreadable = unknown, never live
      const facts = await layoutFacts();
      return describeLayout(st, typeof App !== 'undefined' && App.agents ? App.agents() : [], facts, sync, want);
    },

    'station.agent_config': (args) => {
      if (typeof App === 'undefined' || !App.agents) throw new Error('the crew roster is not ready yet');
      const crew = App.agents();
      if (!args.agentId) return { agents: crew.map(a => ({ id: a.id, name: a.name })) };
      const a = crew.find(row => row.id === args.agentId);
      if (!a) throw new Error('unknown agentId; list the crew with team.config first');
      return { id: a.id, name: a.name,
        docs: Object.fromEntries(['identity', 'purpose', 'manual', 'context'].map(field => [field, String((a.docs || {})[field] || '')])) };
    },

    'station.update_agent': async (a) => {
      if (typeof App === 'undefined' || !App.agents || !App.applyConfig || !App.configSynced) throw new Error('agent configuration is unavailable');
      if (typeof CloudSave === 'undefined' || !CloudSave.flush || !CloudSave.pull) throw new Error('durable agent storage is unavailable');
      const target = App.agents().find(row => row.id === a.agentId);
      if (!target) throw new Error('unknown agentId; read team.config before editing');
      if (!['identity', 'purpose', 'manual', 'context'].includes(a.field)) throw new Error('only Dossier documents can be edited');
      if (typeof a.text !== 'string' || a.text.length > 20000 || typeof a.previousText !== 'string') throw new Error('text and previousText are required; text is limited to 20000 characters');
      const current = String((target.docs || {})[a.field] || '');
      // Compare before writing: never overwrite a newer Dossier edit or guess a target.
      if (current !== a.previousText && current !== a.text) throw new Error('the document changed; read team.config again before editing');
      App.applyConfig({ [a.field]: a.text }, target.id);
      if (await App.configSynced() !== true) throw new Error('agent roster sync failed; the edit may be local only, do not report completion');
      if (!await CloudSave.flush({ force: true })) throw new Error('agent save failed; do not report completion');
      const saved = await CloudSave.pull();
      const row = saved && ((saved.agents || []).find(x => x.id === target.id) || (saved.agent && saved.agent.id === target.id ? saved.agent : null));
      if (!row || !row.docs || row.docs[a.field] !== a.text) throw new Error('saved agent read-back did not confirm the edit; do not report completion');
      return { agentId: target.id, field: a.field, text: a.text, durable: true, applies: 'next run' };
    },

    /* Everything the station can currently see: which sessions exist, which is active, who is busy, what is
       waiting on approval. Reuses VoiceLive's snapshot so voice and tools cannot drift into two answers. */
    'station.status': () => {
      if (typeof VoiceLive === 'undefined' || !VoiceLive.statusSnapshot) throw new Error('the station view is not ready yet');
      const snap = VoiceLive.statusSnapshot();
      if (!snap || (snap.active === null && !(snap.workstreams || []).length)) {
        throw new Error('the station is still starting up — no sessions are readable yet');
      }
      return snap;
    },

    /* The sessions that exist, by name. This is what turns "the research session" into a real workstream id:
       the sidecar resolves against THIS list and refuses anything it cannot match uniquely, so the resolution
       is only ever as good as the truth here — report ids and titles verbatim, never a guess or a default. */
    'station.sessions': () => {
      if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('sessions are not ready yet');
      const rows = Workstreams.list() || [];
      const activeId = Workstreams.activeId ? Workstreams.activeId() : null;
      const generalId = Workstreams.generalId ? Workstreams.generalId() : null;
      return {
        count: rows.length,
        activeId: activeId,
        sessions: rows.map(w => ({
          id: w.id,
          // General is the untitled home stream; it has no name of its own, so give it the one the UI shows.
          title: w.title != null ? w.title : (w.id === generalId ? 'General' : null),
          agentId: w.agentId || 'agent',
          lane: w.lane || null,
          active: w.id === activeId
        }))
      };
    },

    'station.tasks': () => {
      const rows = taskRows(false).map(taskView);
      return { count: rows.length, tasks: rows };
    },

    'station.new_task': async (a) => {
      if (typeof Workstreams === 'undefined' || !Workstreams.create) throw new Error('task board is not ready yet');
      const title = String((a && a.title) || '').trim().slice(0, 80);
      if (!title) throw new Error('a task needs a title');
      const existing = taskRows(true).find(w => String(w.title || '').trim().toLowerCase() === title.toLowerCase());
      const agentId = String((a && a.agentId) || '').trim();
      if (agentId && typeof App !== 'undefined' && App.agents && !(App.agents() || []).some(x => x && x.id === agentId)) {
        throw new Error('no crew member with id "' + agentId + '" - use station.crew for the roster, or omit agentId');
      }
      const ws = existing || Workstreams.create(title, { kind: 'task', activate: false, agentId: agentId || undefined });
      if (!ws) throw new Error('the station could not create the task');
      if (existing && existing.archived) Workstreams.archive(existing.id, false);
      if (agentId && ws.agentId !== agentId && !Workstreams.setAgent(ws.id, agentId)) throw new Error('the task could not be assigned');
      await persistWorkstreams(save => (save.workstreams || []).some(w => w && w.id === ws.id && w.kind === 'task' && !w.archived));
      return Object.assign({ created: !existing, duplicate: !!existing, durable: true }, taskView(Workstreams.get(ws.id)));
    },

    'station.manage_task': async (a) => {
      const action = String((a && a.action) || '');
      const task = resolveTask(a && a.task, action === 'restore');
      const before = taskView(task);
      let removed = false;
      if (action === 'move') {
        const lane = String((a && a.lane) || '');
        if (['todo', 'active', 'shipped'].indexOf(lane) < 0) throw new Error('task lane must be todo, active, or shipped');
        if (task.lane !== lane && !Workstreams.setLane(task.id, lane)) throw new Error('the task could not move');
      } else if (action === 'rename') {
        const title = String((a && a.title) || '').trim().slice(0, 80);
        if (!title) throw new Error('a renamed task needs a title');
        const clash = taskRows(true).find(w => w.id !== task.id && String(w.title || '').trim().toLowerCase() === title.toLowerCase());
        if (clash) throw new Error('a task called "' + title + '" already exists');
        if (task.title !== title && !Workstreams.rename(task.id, title)) throw new Error('the task could not be renamed');
      } else if (action === 'assign') {
        const agentId = String((a && a.agentId) || '').trim();
        if (!agentId) throw new Error('assign needs an agentId');
        if (typeof App !== 'undefined' && App.agents && !(App.agents() || []).some(x => x && x.id === agentId)) throw new Error('no crew member with id "' + agentId + '"');
        if (task.agentId !== agentId && !Workstreams.setAgent(task.id, agentId)) throw new Error('the task could not be assigned');
      } else if (action === 'archive' || action === 'restore') {
        const archived = action === 'archive';
        if (task.archived !== archived && !Workstreams.archive(task.id, archived)) throw new Error('the task could not be ' + action + 'd');
      } else if (action === 'remove') {
        if (!Workstreams.del(task.id)) throw new Error('the task could not be removed');
        removed = true;
      } else {
        throw new Error('task action must be move, rename, assign, archive, restore, or remove');
      }
      await persistWorkstreams(save => {
        const rows = save.workstreams || [];
        if (removed) return !rows.some(w => w && w.id === task.id) && (save.deletedIds || []).indexOf(task.id) >= 0;
        const w = rows.find(x => x && x.id === task.id);
        if (!w) return false;
        if (action === 'move') return w.lane === String(a.lane);
        if (action === 'rename') return w.title === String(a.title).trim().slice(0, 80);
        if (action === 'assign') return w.agentId === String(a.agentId).trim();
        return !!w.archived === (action === 'archive');
      });
      const current = removed ? null : Workstreams.get(task.id);
      return { changed: removed || JSON.stringify(before) !== JSON.stringify(taskView(current)), removed, durable: true, task: current ? taskView(current) : null, id: task.id };
    },

    /* Create a NAMED session. Refuses a duplicate title rather than minting a twin: two sessions with one
       name would make every later name-addressed action (dispatch's `session`, switch below) AMBIGUOUS and
       therefore refused — a create that quietly poisons the namespace is worse than telling the agent to
       reuse what exists. `focus` is honored only when explicitly asked, so an agent opening sessions in the
       background can never steal what the Commander is looking at. */
    'station.new_session': async (a) => {
      if (typeof Workstreams === 'undefined' || !Workstreams.create) throw new Error('sessions are not ready yet');
      const title = String((a && a.title) || '').trim().slice(0, 80);
      if (!title) throw new Error('a session needs a title');
      const clash = (Workstreams.list() || []).find(w => String(w.title || (w.id === Workstreams.generalId() ? 'General' : '')).trim().toLowerCase() === title.toLowerCase());
      if (clash) throw new Error('a session called "' + title + '" already exists — delegate into it, focus it, or pick another name');
      const agentId = String((a && a.agentId) || '').trim();
      if (agentId && typeof App !== 'undefined' && App.agents && !(App.agents() || []).some(x => x && x.id === agentId)) {
        throw new Error('no crew member with id "' + agentId + '" — use station.crew for the roster, or omit agentId');
      }
      if (a && a.focus) requireCurrentFocus(a.origin);
      const ws = Workstreams.create(title, { agentId: agentId || undefined, activate: !!(a && a.focus) });
      if (!ws) throw new Error('the station could not create the session');
      if (a && a.focus && typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      await persistWorkstreams(save => (save.workstreams || []).some(w => w && w.id === ws.id && w.kind === 'chat')
        && (!(a && a.focus) || save.activeId === ws.id));
      return { id: ws.id, title: ws.title, agentId: ws.agentId || 'agent', focused: !!(a && a.focus), durable: true };
    },

    /* Focus an existing session by the name the Commander says (or exact id) — resolveSession's shared law,
       because a switch that lands on a plausible-but-wrong session moves the Commander's eyes somewhere
       they did not ask to be. */
    'station.switch_session': async (a) => {
      const hit = resolveSession(a && a.session);
      requireCurrentFocus(a && a.origin);
      const ws = Workstreams.switch(hit.w.id);
      if (!ws) throw new Error('the station could not switch sessions');
      if (typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      await persistWorkstreams(save => save.activeId === ws.id && (save.workstreams || []).some(w => w && w.id === ws.id));
      try { await reconcile(ws.id); } catch (_) {}
      // Only the call-owning run may rebind voice. An unrelated run cannot transfer the call.
      try { if (typeof VoiceLive !== 'undefined' && VoiceLive.isActive && VoiceLive.isActive() && VoiceLive.rebind
          && VoiceLive.boundSessionId && VoiceLive.boundSessionId() === a.origin.streamId) VoiceLive.rebind(ws.id); } catch (_) {}
      return { id: ws.id, title: ws.title != null ? ws.title : 'General', durable: true };
    },

    /* Read a session's recent visible conversation — the agent's EYES into work that happened elsewhere.
       Exists because of a live failure: asked "what did the researcher do?", a lead with no way to read the
       other session guessed "nothing" while the finished answer sat right there. Visible dialogue only
       (same filter the session power tools use — sys markers ride along labeled, hidden/internal never). */
    'station.read_session': (a) => {
      const hit = resolveSession(a && a.session);
      const ws = hit.w;
      const limit = Math.max(1, Math.min(30, Number(a && a.limit) || 12));
      const turns = (ws.history || [])
        .filter(m => m && !m.hidden && !m.internal && typeof m.content === 'string'
          && (m.role === 'user' || m.role === 'assistant' || m.sys))
        .slice(-limit)
        .map(m => ({
          speaker: m.sys ? 'station' : (m.role === 'user' ? 'commander' : (m.agentId || ws.agentId || 'agent')),
          sys: !!m.sys,
          text: String(m.content).slice(0, 600)
        }));
      const busy = (typeof Channels !== 'undefined' && Channels.isBusy) ? !!Channels.isBusy(ws.id) : false;
      return {
        id: ws.id, title: hit.title || 'General', agentId: ws.agentId || 'agent',
        busy, runCount: (ws.runIds || []).length, turns,
        note: turns.length ? undefined : 'this session has no visible conversation yet'
      };
    },

    /* Fold a finished delegated run's answer into the session it was filed under. APPENDS — a session usually
       already holds the Commander's own conversation, and replacing that history (the way the cron auto-session
       path can, because it OWNS its stream) would delete their thread. Idempotent by runId so a retry, a
       duplicated command, or a re-delivered background worker can never double-post. */
    'station.deliver': (a) => foldDelivery(a),

    /* A delegated worker runs in the target session while the Commander is free to remain in General. The
       bridge supplies the real runId, so this is proven activity rather than a hopeful local spinner. */
    'station.dispatch_start': (a) => {
      const hit = resolveDelivery(a);
      const ws = hit.w;
      const runId = String((a && a.runId) || '');
      if (!runId) throw new Error('dispatch start needs a run id');
      if (typeof Channels === 'undefined' || !Channels.begin || !Channels.setRunId) throw new Error('session activity is not ready yet');
      Channels.begin(ws.id, Date.now());
      Channels.setRunId(ws.id, runId, Date.now());
      if (Channels.setStatus) Channels.setStatus(ws.id, 'working…');
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
      return { started: true, session: ws.title || 'General', runId, resolvedBy: hit.resolvedBy };
    },

    'station.dispatch_end': (a) => {
      const hit = resolveDelivery(a);
      if (typeof Channels !== 'undefined' && Channels.end) Channels.end(hit.w.id);
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
      return { settled: true, session: hit.w.title || 'General', resolvedBy: hit.resolvedBy };
    },

    /* Who is on the roster and what each one is for — the list a delegate call has to choose from. */
    'station.crew': () => {
      if (typeof App === 'undefined' || !App.agents) throw new Error('the crew roster is not ready yet');
      const crew = App.agents() || [];
      if (!crew.length) throw new Error('no crew are on this station yet');
      return {
        count: crew.length,
        crew: crew.map(a => ({ id: a.id, name: a.name || a.id, role: a.role || null, model: a.model || null }))
      };
    }
  };

  const reconciling = Object.create(null);

  /* Recover a station.deliver command that no page received (or that the wrong page acknowledged first).
     The completed answer is stored with the run itself; fold by runId exactly once, resolving a divergent
     page-local id by the unique exact session title. A read failure is fail-open and never blocks page boot. */
  function reconcile(targetId) {
    const target = String(targetId || '');
    const key = target || '*';
    if (reconciling[key]) return reconciling[key];
    reconciling[key] = (async () => {
      let rows = [];
      try {
        const r = await fetch('/api/runs?agent=*&limit=500', { cache: 'no-store' });
        if (!r.ok) return 0;
        rows = ((await r.json()) || {}).runs || [];
      } catch (_) { return 0; }
      let folded = 0;
      // /api/runs is newest-first. Fold oldest-first so multiple missed answers preserve conversation order.
      for (const row of rows.slice().reverse()) {
        if (!row || ['done', 'max_iters', 'budget'].indexOf(String(row.reason || 'done')) < 0) continue;
        if (!String(row.sessionTitle || '').trim() || !String(row.deliveryText || '').trim()) continue;
        const args = {
          streamId: row.streamId, sessionTitle: row.sessionTitle, agentId: row.agentId,
          runId: row.runId, prompt: row.deliveryPrompt, text: row.deliveryText, ts: row.ts
        };
        let hit;
        try { hit = resolveDelivery(args); } catch (_) { continue; }
        if (target && hit.w.id !== target) continue;
        if (row.runId && (hit.w.runIds || []).indexOf(String(row.runId)) >= 0) continue;
        try {
          const out = foldDelivery(args, { quiet: true });
          if (out && out.folded) folded++;
        } catch (_) {}
      }
      if (folded) {
        try {
          const active = Workstreams.activeId && Workstreams.get(Workstreams.activeId());
          if (active && typeof Chat !== 'undefined' && Chat.load) Chat.load(active);
        } catch (_) {}
        try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
        try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
      }
      return folded;
    })();
    return reconciling[key].finally(() => { delete reconciling[key]; });
  }

  function requireCurrentFocus(origin) {
    if (typeof Chat === 'undefined' || !Chat.canFocusSession || !Chat.canFocusSession(origin)) {
      throw new Error('session focus was left unchanged: the originating run is no longer current or the Commander has a draft; do not retry the switch automatically');
    }
  }

  async function run(id, verb, args) {
    let out;
    try {
      const fn = VERBS[String(verb || '')];
      if (!fn) throw new Error('unknown station verb: ' + verb);
      out = { id, ok: true, result: await fn(args || {}) };
    } catch (error) {
      out = { id, ok: false, error: String((error && error.message) || error) };
    }
    try {
      await fetch('/api/station/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(out)
      });
    } catch (_) {
      // The sidecar's own timeout is the backstop: if the ack cannot be delivered, the command fails there
      // as unattended rather than hanging. Nothing to retry — a retried side-effect is a duplicated action.
    }
  }

  function init() {
    if (typeof U === 'undefined' || !U.bus || !U.bus.on) return;
    U.bus.on('station.command', msg => {
      if (!msg || !msg.id || !msg.verb) return;
      run(String(msg.id), String(msg.verb), msg.args);
    });
  }

  return { init, run, reconcile, verbs: () => Object.keys(VERBS) };
})();

document.addEventListener('DOMContentLoaded', () => StationCommands.init());
