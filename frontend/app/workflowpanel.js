/* STARNET — workflowpanel.js : the DOCKED WORKFLOW PANEL of REFIT (2026-09-22, Andrew's rulings).

   One card for the whole line, docked to the side of build mode — NOT a modal. The floor stays visible
   and interactive: clicking the INBOX, any BAY or a LOOP/JOINER/MERGER/SPLITTER gate of a line (or the
   OUTBOX) opens THIS panel with that part selected; selecting a part here highlights and pans to it on
   the floor. The card and the floor are two views of one line.

   It replaced the two modal flow cards (openFlowCard for the INBOX/gates, openStepCard for the BAY) and
   keeps every capability they had, reorganized — never removed (project law: simplify = organization):
   line name · trigger zone (schedule picker + create + existing routines + channels) · LINE BUDGET ·
   loop/joiner gate config · agent picker + recruit + assign-by-id · the brief · compute check / ⊕ ADD A
   WORKSTATION · the line facts.

   TRUTH: every sentence, badge and count reads the compiled plan (WorkflowLine, fed by build.js's valPlan —
   the same compile the sidecar routes by) or a server answer (GET /api/cron, /api/channels/status, the
   step-test session). Tests are REAL runs (POST /api/routing/steptest, see the STEPTEST contract); the
   panel feature-detects that route and keeps the whole-line sample button when it is absent.

   build.js owns the floor and hands this module a HOST (see Build's `wfHost`): station, plan, camera,
   flash/sfx, the sample seam, the plan gate. This file owns only its own DOM. */
'use strict';

const WorkflowPanel = (() => {
  let H = null, el = null;
  const S = {
    lineKey: null, lone: null, sel: null, view: 'edit', insertAt: null,
    seam: null, trying: {}, tryErr: {}, session: null, sessionErr: null, pollTimer: 0, pollFor: null,
    hop: null, handoff: null, handoffFor: null, busy: false,
    cron: null, chans: null, trgOpen: false, trgDock: null, drafts: {}, testJob: {},
    projects: null, projectMsg: null,   // GET /api/projects answer (trusted folders for the INBOX working-folder pick)
    lt: null, ltSig: null, ltForm: null, ltMsg: null, ltReveal: null, ltTimer: 0,   // LINE TRIGGERS (folder / webhook), server truth + the once-only key
  };
  const WL = () => (typeof WorkflowLine !== 'undefined' ? WorkflowLine : null);
  const esc = s => (H && H.esc ? H.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const $ = q => (el ? el.querySelector(q) : null);
  const $$ = q => (el ? Array.prototype.slice.call(el.querySelectorAll(q)) : []);
  const api = (path, method, body) => fetch(H.api(path), method ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) } : { cache: 'no-store' })
    .then(r => r.json().catch(() => null).then(j => ({ status: r.status, j })));

  /* ---------- tests: real step-test answers, remembered per station (a per-viewer convenience) ---------- */
  const TKEY = () => 'starnet.refit.wftests.' + (H ? H.stationKey() : 'default');
  let tests = null;
  function loadTests() {
    try { const o = JSON.parse(localStorage.getItem(TKEY()) || '{}'); tests = (o && typeof o === 'object') ? o : {}; } catch (e) { tests = {}; }
    S.testJob = (tests.__jobs && typeof tests.__jobs === 'object') ? tests.__jobs : {};
  }
  function saveTests() {
    try { tests.__jobs = S.testJob; localStorage.setItem(TKEY(), JSON.stringify(tests)); } catch (e) {}
  }
  const testOf = pid => (tests && pid && tests[pid] && typeof tests[pid] === 'object' && pid !== '__jobs') ? tests[pid] : null;
  function testsMap() { const o = {}; for (const k in (tests || {})) if (k !== '__jobs') o[k] = tests[k]; return o; }

  /* ---------- the line under the panel ---------- */
  function comp() {
    const comps = H.comps() || [];
    return comps.find(c => c.key === S.lineKey) || null;
  }
  function flow() {
    const c = comp(), W = WL();
    if (!W || !c) return null;
    const g = H.geo();
    return W.lineFlow(H.plan(), c, typeof Pipeline !== 'undefined' ? Pipeline : null, g ? g.props : []);
  }
  const prop = id => (id && H.station().propById(id)) || null;
  const nameOf = aid => H.agentLabel(aid);
  /* an agent is shown by its SKIN — the same body the floor draws (AgentPortraits.thumbHTML: crisp, cached per skin
     + size + device scale, a neutral silhouette while a skin loads). An id the roster does not know gets the
     silhouette, never a guessed skin. */
  const agentOf = aid => (aid && (H.agents() || []).find(a => a && a.id === aid)) || null;
  // crew membership for readiness: an id not on the roster still RUNS, on the station's default identity. An unread
  // (empty) roster says nothing, so the whole crew is never flagged just because the list has not loaded yet.
  const isCrew = aid => { const list = H.agents() || []; return !list.length || list.some(a => a && a.id === aid); };
  // the belt INTO an escalation column says when that lane is taken — never "on DONE" (station.layout audit 2026-09-28)
  const escCarry = e => !e.live ? 'never: no pass condition' : 'if still ' + (e.when === 'approved' ? 'not approved' : 'unmet') + ' after ' + (e.max || 5);
  const thumb = (aid, w, h, cls) => (typeof AgentPortraits !== 'undefined' && AgentPortraits.thumbHTML) ? AgentPortraits.thumbHTML(agentOf(aid), w, h, cls) : '';
  const lineName = () => { const c = comp(); return c ? H.lineNameOf(c) : null; };
  function dockLabel(f, pid) {
    const d = f && f.docks[pid]; if (!d) { const p = prop(pid); return p ? (p.role || 'BAY') : 'BAY'; }
    const i = f.order.indexOf(pid);
    return (d.role || 'BAY ' + (i + 1)) + (d.agentId ? ' · ' + nameOf(d.agentId) : '');
  }
  // (multi-bay) the ENTRY DOCKS themselves — a routine that fires at one bay of a multi-dock agent is judged by its bay
  const entryDocks = f => { const W = WL(); return W ? W.entryDocksOf(f) : []; };

  // what starts this line — composed by WorkflowLine.lineStarts, the ONE reader the lead's station.layout shares
  function triggers(f) {
    const W = WL();
    if (!W || !f) return { schedules: [], channels: [], routines: [], chanRows: [], events: [] };
    return W.lineStarts(f, { lt: S.lt, lineKey: S.lineKey, cron: S.cron, chans: S.chans, agents: H.agents(), human: H.human });
  }
  function refreshServerFacts() {
    api('/api/cron').then(r => { if (r.j && Array.isArray(r.j.jobs)) S.cron = r.j; paint(); }).catch(() => {});
    api('/api/channels/status').then(r => { if (r.j && typeof r.j === 'object' && r.status === 200) S.chans = r.j; paint(); }).catch(() => {});
    api('/api/projects').then(r => {
      S.projects = (r.status === 200 && r.j && Array.isArray(r.j.projects)) ? { rows: r.j.projects.filter(x => x && x.blessed === true) } : { err: 'Could not load trusted projects.' };
      paint();
    }).catch(() => { S.projects = { err: 'Could not load trusted projects.' }; paint(); });
    ltRefresh();
    H.pollFeed().then(() => paint(), () => {});   // the floor-wide FEED truth, re-asked now (never a 60 s-stale NO FEED)
  }
  function probeSeam() {
    if (S.seam !== null) return;
    S.seam = 'probing';
    api('/api/routing/steptest').then(r => {
      S.seam = !!(r && r.status !== 404 && r.status !== 405 && r.j && r.j.ok === true);
      const s = S.seam && r.j.session;
      if (s && s.lineId === S.lineKey && !s.single && WL().isLive(s)) { S.session = s; S.view = 'test'; poll(); }
      paint();
    }).catch(() => { S.seam = false; paint(); });
  }

  /* ---------- open / close / select ---------- */
  function open(host, propId, opts) {
    H = host;
    const p = prop(propId); if (!p) return;
    if (!tests) loadTests();
    const c = H.lineOfProp(propId);
    const newLine = !el || (c ? c.key : null) !== S.lineKey || (!c && S.lone !== propId);
    S.lineKey = c ? c.key : null; S.lone = c ? null : propId;
    S.sel = propId; S.insertAt = null;
    if (!el) mount();
    if (newLine) { S.drafts = {}; S.trgOpen = false; S.trgMsg = null; S.ltForm = null; S.ltMsg = null; S.ltReveal = null; S.hop = null; if (!S.session || S.session.lineId !== S.lineKey) S.view = 'edit'; refreshServerFacts(); refreshToday(); }
    if (!todayTimer) todayTimer = setInterval(() => { if (el) paintToday(); }, 60000);
    probeSeam();
    // line triggers change on their own (a file lands, a webhook is called): re-read them while the INBOX is open
    if (!S.ltTimer) S.ltTimer = setInterval(() => { const sp = el && S.sel ? prop(S.sel) : null; if (sp && sp.t === 'intake') ltRefresh(); }, 5000);
    paint(true);
    H.highlight(propId);
    // the panel may have just docked over the line: a newly shown line is framed in the visible floor; a part
    // picked in the panel is centred; a floor click leaves the camera alone unless the part went under the panel
    if (newLine && S.lineKey) H.frameLine(S.lineKey);
    else H.focusProp(propId, !!(opts && opts.fromFloor));
  }
  function mount() {
    el = document.createElement('aside');
    el.className = 'wf-panel';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Workflow');
    el.innerHTML = '<div class="wf-scroll" id="wf-scroll"><header class="wf-head" id="wf-head"></header><div class="wf-strip-wrap"><div class="wf-strip" id="wf-strip"></div></div><div class="wf-ins" id="wf-ins"></div>'
      + '<div class="wf-body" id="wf-body"></div></div><footer class="wf-foot" id="wf-foot"></footer>';
    H.root().appendChild(el);
    el.addEventListener('keydown', e => { if (e.key === 'Escape' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.stopPropagation(); close(); } });
    el.addEventListener('input', e => { const t = e.target; if (t && t.dataset && t.dataset.keep) { t.dataset.typed = '1'; S.drafts[t.dataset.keep] = t.value; } }, true);
    H.panelShown(true);   // the Build Library steps aside so the floor is not squeezed between two panels
  }
  function close() {
    if (!el) return;
    saveOpenFields();
    stopPoll();
    if (todayTimer) { clearInterval(todayTimer); todayTimer = 0; }
    if (S.ltTimer) { clearInterval(S.ltTimer); S.ltTimer = 0; }
    S.ltReveal = null; S.ltForm = null;   // a key shown once is gone once the panel closes
    el.remove(); el = null;
    S.sel = null; S.lineKey = null; S.lone = null;
    H.highlight(null); H.pausedMarker(null);
    H.panelShown(false);   // the Build Library comes back as it was — unless the Commander reopened it meanwhile
  }
  const isOpen = () => !!el;
  // the floor's click lands here while the panel is open: the same part, selected in the card
  function selectFromFloor(propId) { if (el && H) open(H, propId, { fromFloor: true }); }
  function select(propId) {
    if (!el || !H) return;
    saveOpenFields();
    S.sel = propId; S.insertAt = null; S.view = 'edit';
    paint(true);
    H.highlight(propId); H.focusProp(propId);
  }
  // called by build.js after every plan recompile (and on edits) — the card follows the floor
  function refresh() {
    if (!el || !H) return;
    // the selected part may have moved lines (a belt connected it) or been deleted
    if (S.sel && !prop(S.sel)) {   // an UNDO / delete took the selected part: stay on its line if the line survives
      const c0 = comp();
      const next = c0 && ((c0.intakes || [])[0] || ((c0.bays || [])[0] || {}).propId);
      if (!next) { close(); return; }
      S.sel = next; H.highlight(next); paint(true); return;
    }
    const c = S.sel ? H.lineOfProp(S.sel) : null;
    if (c && c.key !== S.lineKey) { S.lineKey = c.key; S.lone = null; }
    else if (!c && S.lineKey && !comp()) { S.lineKey = null; S.lone = S.sel; }
    paint(false);
  }

  /* ---------- painting ---------- */
  const typing = () => { const a = document.activeElement; return !!(a && el && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
  // a draft is only what the Commander TYPED: a field painted empty (e.g. before the INBOX had a test job) must
  // never be remembered as an empty draft and later clobber the real default it now has
  function keepDrafts() { for (const n of $$('[data-keep]')) if (n.dataset.typed === '1') S.drafts[n.dataset.keep] = n.value; }
  function paint(force) {
    if (!el || !H) return;
    const f = flow();
    paintHead(f);
    paintStrip(f);
    paintFoot(f);
    if (force || !typing()) { keepDrafts(); paintBody(f); }
    else paintLive(f);
    if (S.session && S.session.state === 'paused') {
      const h = S.session.hops[S.session.paused.afterHop];
      H.pausedMarker(h ? { agentId: h.agentId, dockId: h.dockId || null, label: 'HANDOFF WAITING ▸ ' + ((WL().pausedNext(S.session, nameOf) || {}).label || '') } : null);
    } else H.pausedMarker(null);
  }

  /* LINE WATCH (2026-09-23): today's numbers for THIS line — runs / shipped / failed / $ today vs the daily cap /
     median time per run — read from the floor's own reconciled cache (World.lineStatsFor, fed by GET
     /api/routing/lines/stats on the SHIPPED counter's 60 s cadence). Nothing is shown until the server answered. */
  function paintToday() {
    const row = $('#wf-today'); if (!row) return;
    const st = (S.lineKey && typeof World !== 'undefined' && World.lineStatsFor) ? World.lineStatsFor(S.lineKey) : null;
    const cells = (st && typeof LineWatch !== 'undefined') ? LineWatch.statsRow(st) : null;
    row.hidden = !cells;
    if (!cells) { row.innerHTML = ''; return; }
    row.innerHTML = '<span class="wf-today-l">TODAY</span>' + cells.map(c => '<span><span class="k">' + esc(c[0]) + '</span> <b' + (c[0] === 'FAILED' && c[1] !== '0' ? ' class="bad"' : '') + '>' + esc(c[1]) + '</b></span>').join('');
  }
  let todayTimer = 0;
  function refreshToday() {
    if (typeof World === 'undefined' || !World.pollLineStats) return;
    World.pollLineStats();
    setTimeout(() => { if (el) paintToday(); }, 1500);   // the answer lands in the floor's cache; repaint from it
  }
  function paintHead(f) {
    const head = $('#wf-head'); if (!head) return;
    const W = WL(), c = comp(), intake = f && f.trigger.propId ? prop(f.trigger.propId) : null;
    const tr = triggers(f);
    const r = f && c ? W.readiness(f, c, { hasCompute: H.hasCompute, errors: (H.plan() || {}).errors || [], labelOf: H.valLabel, isCrew,
      briefOf: pid => { const p = prop(pid); return p && (p.brief || p.hands); }, triggers: tr }) : null;
    const est = f ? W.costEstimate(f, testsMap()) : null;
    const nSteps = f ? f.order.length : 1;
    if (!head.dataset.line || head.dataset.line !== String(S.lineKey || S.lone)) {
      head.dataset.line = String(S.lineKey || S.lone);
      head.innerHTML = '<div class="wf-head-row"><span class="wf-kick" id="wf-kick"></span><button type="button" class="bb sm wf-x" id="wf-close" aria-label="Close workflow panel">✕</button></div>'
        + '<div class="wf-name">' + (intake
          ? '<input id="wf-name" class="wf-name-in" type="text" maxlength="48" aria-label="Workflow name" placeholder="' + esc(H.stampName(intake.id) || 'Name this workflow') + '" value="' + esc(intake.label || '') + '" />'
          : '<span class="wf-name-none">' + (c ? 'Unnamed line' : 'A single BAY') + '</span>') + '</div>'
        + '<div class="wf-ready"><span class="wf-pill" id="wf-pill"></span><span class="wf-est" id="wf-est"></span></div>'
        + '<p class="wf-today" id="wf-today" aria-label="This line today"></p>'
        + '<p class="wf-sentence" id="wf-sentence" aria-live="polite"></p><ul class="wf-hints" id="wf-hints"></ul>';
      $('#wf-close').onclick = () => { H.sfx('click'); close(); };
      const nameIn = $('#wf-name');
      if (nameIn) {
        let saved = intake.label || '';
        const save = () => { const v = nameIn.value.trim(); if (v === saved) return; const res = H.station().setPropLabel(intake.id, v);
          if (res && res.ok) { saved = res.label || ''; H.sfx('click'); H.flashTip(v ? 'line named — ' + v : 'line name cleared', true); H.lineRenamed(); } else H.sfx('bad'); };
        nameIn.addEventListener('blur', save);
        nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); nameIn.blur(); } if (e.key === 'Escape') { e.stopPropagation(); nameIn.blur(); } });
        el._saveName = save;
      } else el._saveName = null;
    }
    $('#wf-kick').textContent = 'WORKFLOW · ' + nSteps + ' STEP' + (nSteps === 1 ? '' : 'S') + ' · BUILD MODE';
    const pill = $('#wf-pill');
    if (r) { pill.textContent = W.pillText(r); pill.className = 'wf-pill' + (r.ready ? ' ok' : ''); pill.dataset.go = r.ready ? '' : (r.blocking[0].propId || ''); }
    else { pill.textContent = 'CONNECT IT TO A LINE'; pill.className = 'wf-pill'; pill.dataset.go = ''; }
    pill.onclick = () => { if (pill.dataset.go) select(pill.dataset.go); };
    $('#wf-est').textContent = est ? est.text : '';
    paintToday();
    const sent = $('#wf-sentence');
    if (f && c) {
      const segs = W.howItRuns(f, { nameOf, handsOf: pid => { const p = prop(pid); return p && p.hands; }, triggers: tr });
      sent.innerHTML = segs.map(s => s.t === 'agent' ? '<b class="wf-ag" data-go="' + esc(s.propId) + '">' + esc(s.s) + '</b>'
        : s.t === 'miss' ? '<button type="button" class="wf-miss" data-go="' + esc(s.propId || '') + '">' + esc(s.s) + '</button>'
        : s.t === 'loop' ? '<span class="wf-lp">' + esc(s.s) + '</span>' : esc(s.s)).join('');
      sent.querySelectorAll('[data-go]').forEach(n => { n.onclick = () => { if (n.dataset.go) select(n.dataset.go); }; });
    } else sent.textContent = 'This BAY is not on a belt line. Work addressed to its agent arrives here directly; use the BELT tool to connect it to an INBOX and an OUTBOX.';
    const hints = $('#wf-hints');
    hints.innerHTML = r ? r.blocking.slice(1).concat(r.hints).slice(0, 4).map(h => '<li><button type="button" class="wf-hint" data-go="' + esc(h.propId || '') + '">' + esc(h.what) + '</button></li>').join('') : '';
    hints.querySelectorAll('[data-go]').forEach(n => { n.onclick = () => { if (n.dataset.go) select(n.dataset.go); }; });
  }

  /* ---------- the flow strip: trigger ▸ docks in compiled order ▸ OUTBOX, loop gates as back-arcs ---------- */
  function paintStrip(f) {
    const strip = $('#wf-strip'); if (!strip) return;
    const W = WL();
    const nodes = [];   // {kind, propId, html, from, to}
    const tr = triggers(f);
    if (f && comp()) {
      const ip = f.trigger.propId;
      const sch = tr.schedules.length, ch = tr.channels.length, ev = tr.events.length;
      const kinds = (sch ? 1 : 0) + (ch ? 1 : 0) + (ev ? 1 : 0);
      nodes.push({ kind: 'trigger', propId: ip, cls: 'wf-term' + (ip ? '' : ' none'), ok: !!ip && (sch + ch + ev) > 0,
        html: '<span class="k">INBOX</span><span class="t">' + (ip ? (kinds > 1 ? 'AUTO' : sch ? 'SCHEDULE' : ch ? 'CHANNEL' : ev ? 'TRIGGER' : 'MANUAL') : 'NO INBOX') + '</span>'
          + '<span class="a">' + esc(ip ? (tr.channels.concat(tr.schedules.slice(0, 1), tr.events.length ? [tr.events.length === 1 ? tr.events[0].replace(/^when /, '') : tr.events.length + ' events'] : []).join(' · ') || 'no trigger yet') : 'add one on the floor') + '</span>' });
      f.cols.forEach(col => {
        nodes.push({ kind: 'col', col, ok: col.docks.every(d => d.agentId && H.hasCompute(d.agentId, d.propId)) });
        if (col.gate) nodes.push({ kind: 'gate', gate: col.gate, propId: col.gate.propId });
      });
      nodes.push({ kind: 'outbox', propId: f.outbox.propId, cls: 'wf-term', ok: f.outbox.reached,
        html: '<span class="k">OUTBOX</span><span class="t">RESULT</span><span class="a">' + (f.outbox.reached ? 'the line ends here' : f.outbox.propId ? (f.outbox.reachedOnceCrewed ? 'connected · waiting on agents' : 'not connected yet') : 'no OUTBOX') + '</span>' });
    } else if (S.lone) {
      nodes.push({ kind: 'col', col: { docks: [{ propId: S.lone, agentId: (prop(S.lone) || {}).agentId || null, role: (prop(S.lone) || {}).role || null, routed: false }], mode: 'single' }, ok: false });
    }
    let html = '';
    const machineOf = n => n.kind === 'trigger' || n.kind === 'outbox' ? n.propId : n.kind === 'col' && n.col.docks.length === 1 ? n.col.docks[0].propId : null;
    nodes.forEach((n, i) => {
      if (i > 0 && n.kind === 'col' && n.col.detached) html += '<div class="wf-belt gap"><span class="carry">not connected</span></div>';
      else if (i > 0) {
        const prev = nodes[i - 1], a = machineOf(prev), b = machineOf(n);
        const carry = n.kind === 'col' && n.col.escalation ? escCarry(n.col.escalation) : prev.kind === 'trigger' ? 'the job' : prev.kind === 'col' && prev.col.docks.length === 1 ? ((prop(prev.col.docks[0].propId) || {}).hands || '…') : prev.kind === 'gate' ? (prev.gate.kind === 'loop' ? 'on DONE' : 'as one') : '…';
        const canPlus = !!(a && b && S.lineKey);
        html += '<div class="wf-belt"><span class="carry">' + esc(carry) + '</span><span class="rail"></span>'
          + (canPlus ? '<button type="button" class="wf-plus" data-plus="' + i + '" data-from="' + esc(a) + '" data-to="' + esc(b) + '" aria-label="Add a step here">+</button>' : '')
          + '</div>';
      }
      html += nodeHTML(n, f);
    });
    strip.innerHTML = html;
    const ins = $('#wf-ins'), open = S.insertAt != null && strip.querySelector('[data-plus="' + S.insertAt + '"]');
    ins.innerHTML = open ? inserterHTML(open.dataset.from, open.dataset.to, f) : '';
    ins.hidden = !open;
    if (open) open.classList.add('on');
    strip.querySelectorAll('[data-node]').forEach(b => { b.onclick = () => { if (b.dataset.node) { H.sfx('click'); select(b.dataset.node); } }; });
    strip.querySelectorAll('.wf-plus').forEach(b => { b.onclick = e => { e.stopPropagation(); S.insertAt = S.insertAt === +b.dataset.plus ? null : +b.dataset.plus; paintStrip(flow()); }; });
    ins.querySelectorAll('[data-ins-role]').forEach(b => { b.onclick = e => { e.stopPropagation(); insertStep(open.dataset.from, open.dataset.to, b.dataset.insRole); }; });
    const cx = ins.querySelector('[data-ins-close]'); if (cx) cx.onclick = () => { S.insertAt = null; paintStrip(flow()); };
    drawArcs(strip, f);
    const selN = strip.querySelector('.wf-node.sel');
    if (selN) { const wrap = strip.parentNode, l = selN.offsetLeft, r = l + selN.offsetWidth; if (l < wrap.scrollLeft || r > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = Math.max(0, l - (wrap.clientWidth - selN.offsetWidth) / 2); }
  }
  function inserterHTML(from, to, f) {
    const roles = ['RESEARCHER', 'WRITER', 'REVIEWER', 'ENGINEER', 'ANALYST', 'SHIPPER', 'GENERALIST'];
    const nm = id => { const p = prop(id); return !p ? '?' : p.t === 'intake' ? 'the INBOX' : p.t === 'outbox' ? 'the OUTBOX' : dockLabel(f, id); };
    return '<div class="wf-inserter" role="group" aria-label="Add a BAY"><div class="h">ADD A BAY BETWEEN ' + esc(nm(from)) + ' AND ' + esc(nm(to)) + '<button type="button" class="bb sm" data-ins-close aria-label="Cancel">✕</button></div>'
      + '<div class="wf-chips">' + roles.map(r => '<button type="button" class="wf-chip" data-ins-role="' + r + '">' + r + '</button>').join('')
      + '<button type="button" class="wf-chip" data-ins-role="">NO ROLE</button></div><span class="n">A real BAY is placed on the floor near this belt and the belts re-route through it — one UNDO takes it all back. If there is no room, nothing changes.</span></div>';
  }
  function nodeHTML(n, f) {
    const sel = id => (id && id === S.sel ? ' sel' : '');
    const dot = ok => '<span class="dot' + (ok ? ' ok' : '') + '"></span>';
    if (n.kind === 'trigger' || n.kind === 'outbox') {
      return '<button type="button" class="wf-node ' + n.cls + sel(n.propId) + '" data-node="' + esc(n.propId || '') + '"' + (n.propId ? '' : ' disabled') + '>'
        + n.html.replace('</span>', dot(n.ok) + '</span>') + '</button>';
    }
    if (n.kind === 'gate') {
      const g = n.gate, back = g.backTo && f.docks[g.backTo];
      const txt = g.kind === 'loop' ? '⟲ back to ' + (back ? (back.agentId ? nameOf(back.agentId) : back.role || 'BAY') : '?') + ' · up to ' + (g.max || 5) + '×' : 'waits for every part';
      return '<button type="button" class="wf-node gate ' + g.kind + sel(g.propId) + '" data-node="' + esc(g.propId || '') + '" data-gate="' + esc(g.key) + '">'
        + '<span class="k">' + (g.kind === 'loop' ? 'LOOP GATE' : 'JOINER') + '</span><span class="a">' + esc(txt) + '</span></button>';
    }
    const col = n.col;
    const inner = col.docks.map(d => {
      const p = prop(d.propId) || {}, t = testOf(d.propId), i = f ? f.order.indexOf(d.propId) + 1 : 1;
      const ok = !!(d.agentId && H.hasCompute(d.agentId, d.propId));
      return '<button type="button" class="wf-node dock' + sel(d.propId) + '" data-node="' + esc(d.propId) + '">'
        + '<span class="k">BAY ' + i + dot(ok) + '</span><span class="t">' + esc(d.role || 'STEP') + '</span>'
        + '<span class="a' + (d.agentId ? '' : ' none') + '">' + (d.agentId ? thumb(d.agentId, 22, 28, 'wf-nthumb') : '') + '<span class="an">' + esc(d.agentId ? nameOf(d.agentId) : 'no agent yet') + '</span></span>'
        + '<span class="s">' + (p.brief ? esc(String(p.brief).slice(0, 90)) : '<i>no instructions yet</i>') + '</span>'
        + (d.agentId && !d.routed ? '<span class="warn">not routed yet</span>' : '')
        + (t ? '<span class="badge">✓ TESTED</span>' : '') + '</button>';
    }).join('');
    if (col.docks.length === 1) return inner;
    return '<div class="wf-colgroup ' + col.mode + '"><span class="wf-colmode">' + (col.detached ? 'NOT CONNECTED' : col.mode === 'all' ? 'ALL RUN' : col.mode === 'turns' ? 'TAKE TURNS' : 'ONE BY CONTENT') + '</span>' + inner + '</div>';
  }
  function drawArcs(strip, f) {
    if (!f) return;
    const loops = f.gates.filter(g => g.kind === 'loop' && g.backTo);
    if (!loops.length) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'wf-arcs'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', strip.scrollWidth); svg.setAttribute('height', strip.scrollHeight);
    for (const g of loops) {
      const a = strip.querySelector('[data-gate="' + g.key + '"]'), b = strip.querySelector('[data-node="' + g.backTo + '"]');
      if (!a || !b) continue;
      const ax = a.offsetLeft + a.offsetWidth / 2, bx = b.offsetLeft + b.offsetWidth / 2;
      const y0 = Math.max(a.offsetTop + a.offsetHeight, b.offsetTop + b.offsetHeight), y1 = y0 + 18;
      const d = 'M' + ax + ' ' + (a.offsetTop + a.offsetHeight) + ' L' + ax + ' ' + y1 + ' L' + bx + ' ' + y1 + ' L' + bx + ' ' + (b.offsetTop + b.offsetHeight);
      for (const c of ['', 'chev']) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); if (c) p.setAttribute('class', c); svg.appendChild(p); }
      const t = document.createElementNS(NS, 'text'); t.setAttribute('x', (ax + bx) / 2); t.setAttribute('y', y1 + 15); t.setAttribute('text-anchor', 'middle');
      t.textContent = '⟲ BACK ' + (g.when === 'approved' || g.when === 'revise' ? 'UNTIL ' + g.when.toUpperCase() : g.when ? 'WHILE ' + String(g.when).toUpperCase() : 'EVERY PASS') + ' · UP TO ' + (g.max || 5) + '×';
      svg.appendChild(t);
    }
    strip.appendChild(svg);
  }
  function insertStep(fromId, toId, role) {
    const res = H.insertBay(fromId, toId, role || null);
    S.insertAt = null;
    if (res && res.ok) { H.sfx('chime'); H.flashTip('BAY placed on the floor · belts re-routed · UNDO removes it', true); S.sel = res.id; paint(true); H.highlight(res.id); H.focusProp(res.id); }
    else { H.sfx('bad'); H.flashTip((res && res.msg) || 'could not add a step here', false); paintStrip(flow()); }
    return res;
  }

  /* ---------- the footer: step-test the line (or the whole-line sample when the route is absent) ---------- */
  function paintFoot(f) {
    const foot = $('#wf-foot'); if (!foot) return;
    const c = comp(), W = WL();
    const s = S.session && S.session.lineId === S.lineKey ? S.session : null;
    let html = '<span class="wf-foot-note">' + (S.view === 'test' ? 'Test runs are real runs and count against the LINE BUDGET.' : 'Edits save as you leave a field.') + '</span>';
    if (c && S.seam === true) {
      html += S.view === 'test' ? '<button type="button" class="bb sm" id="wf-back">◂ SETUP</button>'
        : '<button type="button" class="bb sm refit-primary" id="wf-steptest">' + (s && W.isLive(s) ? '▶ STEP TEST · ' + s.state.toUpperCase() : '▶ STEP-TEST THE LINE') + '</button>';
    } else if (c && S.seam === false) {
      const sr = H.sampleState(), mine = sr && sr.key === c.key ? sr : null;
      if (mine && mine.view) html = '<div class="wf-sample-res">' + H.sampleHTML(mine.view) + '</div>' + html;   // the server's own verdict on the sample, on the panel
      html += '<button type="button" class="bb sm refit-primary" id="wf-sample"' + (mine && mine.pending ? ' disabled' : '') + '>' + (mine && mine.pending ? (mine.phase === 'post' ? 'POSTING LINE…' : 'SAMPLE RIDING THE LINE…') : '▶ RUN A SAMPLE JOB') + '</button>';
    }
    html += '<button type="button" class="bb sm" id="wf-done">✓ DONE</button>';
    foot.innerHTML = html;
    const b1 = $('#wf-steptest'); if (b1) b1.onclick = () => { H.sfx('click'); S.view = 'test'; paint(true); if (s && s.state === 'paused') refreshPaused(); };
    const b2 = $('#wf-back'); if (b2) b2.onclick = () => { H.sfx('click'); S.view = 'edit'; paint(true); };
    const b3 = $('#wf-sample'); if (b3) b3.onclick = () => { H.runSample(c, { text: (S.testJob[S.lineKey] || '').trim() || undefined, onUpdate: () => paint(false) }); };
    $('#wf-done').onclick = () => { H.sfx('click'); close(); };
  }

  /* ---------- the body: the selected part's editor (or the step-test view) ---------- */
  /* an OPEN section stays open across a repaint of the SAME card (a floor edit, a server answer) — keyed by the
     section's class + its ordinal among same-class sections, so a card whose shape changed simply starts fresh */
  const detailsKeys = body => { const seen = {}; return Array.from(body.querySelectorAll('details')).map(d => { const c = d.className || '-'; seen[c] = (seen[c] || 0) + 1; return [c + '#' + seen[c], d]; }); };
  function paintBody(f) {
    const body = $('#wf-body'); if (!body) return;
    const cardKey = S.view + '|' + (S.sel || '');
    const wasOpen = body.dataset.card === cardKey ? new Map(detailsKeys(body).map(([k, d]) => [k, d.open])) : null;
    body.dataset.card = cardKey;
    paintBodyInner(body, f);
    if (wasOpen) for (const [k, d] of detailsKeys(body)) if (wasOpen.has(k) && d.open !== wasOpen.get(k)) d.open = wasOpen.get(k);
  }
  function paintBodyInner(body, f) {
    if (S.view === 'test' && comp() && S.seam === true) { paintTest(body, f); restoreDrafts(); return; }
    const p = prop(S.sel);
    if (!p) { body.innerHTML = '<p class="wf-help">Select a part of the line.</p>'; return; }
    if (p.t === 'bay') paintBay(body, f, p);
    else if (p.t === 'intake') paintTrigger(body, f, p);
    else if (p.t === 'loop' || p.t === 'joiner') paintGate(body, f, p);
    else paintPlain(body, f, p);
    restoreDrafts();
  }
  function restoreDrafts() { for (const n of $$('[data-keep]')) { const v = S.drafts[n.dataset.keep]; if (typeof v === 'string' && v !== n.value && n.dataset.keepRestore !== '0') n.value = v; } }
  function paintLive(f) {
    // a field has focus: refresh only the facts that follow the floor, never the field being typed in
    for (const n of $$('[data-live]')) { const fn = LIVE[n.dataset.live]; if (fn) n.innerHTML = fn(f, n); }
    wireLive();
  }
  const LIVE = {};
  function wireLive() { const b = $('#wf-pc'); if (b && !b._wired) { b._wired = true; b.onclick = () => addWorkstation(b); } }
  function saveOpenFields() {
    if (!el) return;
    if (el._saveName) el._saveName();
    if (el._saveBay) el._saveBay();
    if (el._saveLimits) el._saveLimits();
    if (el._saveGate) el._saveGate();
  }

  /* ===== BAY: who works here · the contract (GETS → DOES → HANDS OFF → TO) · try this step ===== */
  function contractRows(f, p) {
    const W = WL(), nb = f ? W.neighbours(f, p.id) : null;
    const d = f && f.docks[p.id];
    let gets = 'work addressed to ' + (p.agentId ? nameOf(p.agentId) : 'its agent') + ' (not on a line)';
    if (nb) {
      if (nb.detached && !nb.prev.length) gets = 'nothing — no INBOX reaches this step';
      else if (nb.first || !nb.prev.length) gets = f.trigger.propId ? 'the job from the INBOX' : 'nothing — no INBOX feeds this line';
      else gets = nb.prev.map(pid => { const pp = prop(pid) || {}; return (pp.hands ? pp.hands + ' from ' : 'the output of ') + dockLabel(f, pid); }).join(' or ');
      if (nb.backFrom && nb.backFrom.length) gets += ', or the draft sent back by the LOOP gate';
    }
    let to = 'no onward connection';
    if (nb && d) {
      const g = nb.gate;
      if (g && g.kind === 'loop') {
        const nx = g.next ? dockLabel(f, g.next) : (f.outbox.reached ? 'the OUTBOX' : 'nowhere yet');
        to = 'the LOOP gate: ' + (g.when === 'approved' ? 'on VERDICT: revise' : 'each pass') + ' back to ' + (g.backTo ? dockLabel(f, g.backTo) : '?') + ', else on to ' + nx
          + (g.escTo ? (g.when ? '; after ' + (g.max || 5) + ' tries unmet, ' + dockLabel(f, g.escTo) : '; its escalation lane to ' + dockLabel(f, g.escTo) + ' never runs (no pass condition)') : '');
      } else if (g && g.kind === 'join') to = 'the JOINER, then ' + (g.next ? dockLabel(f, g.next) : 'onward');
      else if (nb.next.length) to = nb.next.map(pid => dockLabel(f, pid)).join(' or ');
      else if (!d.agentId) to = 'decided once it has an agent';
      else if (f.outbox.reached && !d.deadEnd) to = 'the OUTBOX';
      // the belt IS there — the bay it leads to just has no agent yet (never "connect a belt" for a belt that exists)
      else if (f.probeNext && f.probeNext[p.id]) to = 'nowhere yet — ' + f.probeNext[p.id].map(pid => dockLabel(f, pid)).join(' or ') + ' needs an agent';
      else to = d.deadEnd ? 'nowhere — connect a belt to the next BAY or the OUTBOX' : 'no onward connection confirmed yet';
    }
    return { gets, to };
  }
  LIVE.gets = (f) => { const p = prop(S.sel); return p ? '→ <b>' + esc(contractRows(f, p).gets) + '</b>' : ''; };
  LIVE.to = (f) => { const p = prop(S.sel); return p ? '→ <b>' + esc(contractRows(f, p).to) + '</b>' : ''; };
  LIVE.compute = () => computeHTML(prop(S.sel));
  function computeHTML(p) {
    if (!p || !p.agentId) return '';
    if (H.hasCompute(p.agentId, p.id)) return '<span class="wf-ok">✓ ' + esc(nameOf(p.agentId)) + ' has a workstation for this step.</span>';
    return '<span class="wf-warnline">' + esc(nameOf(p.agentId)) + ' needs an assigned workstation in this room before this step can run.</span>'
      + '<button type="button" class="bb sm refit-primary" id="wf-pc">⊕ ADD A WORKSTATION HERE</button>';
  }
  function addWorkstation(b) {
    b.disabled = true;
    const res = H.requisitionPcFor(S.sel);
    if (res.ok) { H.sfx('chime'); H.flashTip('PC placed + assigned — compute is on', true); paint(true); }
    else { b.disabled = false; H.sfx('bad'); H.flashTip(res.reason === 'no-room-for-a-desk' ? 'no clear 2×1 floor in this room — make space first' : 'could not place a PC here', false); }
  }
  /* MULTI-BAY (Andrew's ruling, 2026-09-22): each bay has ONE agent, but one agent may crew MANY bays — so an
     agent already on another bay is NOT disabled here; the row says where else it works ("also on WRITER bay").
     Picking it adds this bay to its docks; its body stays at its home dock and this bay lights when work lands. */
  function agentStatus(aid, bayId) {
    const others = H.station().props().filter(q => q.t === 'bay' && q.agentId === aid && q.id !== bayId);
    if (!others.length) return { busy: false, txt: 'free' };
    const other = others[0];
    const c = H.lineOfProp(other.id), ln = c ? H.lineNameOf(c) : null;
    return { busy: false, also: true, txt: 'also on ' + (ln ? ln + ' ' : '') + (other.role || 'another') + ' bay' + (others.length > 1 ? ' +' + (others.length - 1) : '') };
  }
  function paintBay(body, f, p) {
    const W = WL(), ri = p.role ? H.roleInfo(p.role) : null, agents = H.agents();
    const cur = p.agentId || '', canSummon = !!(ri && H.canSummon());
    const rows = agents.map(a => {
      const st = a.id === cur ? { busy: false, txt: 'works this bay' } : agentStatus(a.id, p.id);
      return '<button type="button" class="wf-agent' + (a.id === cur ? ' on' : '') + (st.also ? ' also' : '') + '" data-aid="' + esc(a.id) + '" aria-pressed="' + (a.id === cur) + '">'
        + thumb(a.id, 34, 42, 'av')
        + '<span class="nm">' + esc(String(a.name || a.id).toUpperCase()) + '</span><span class="st' + (st.txt === 'free' ? ' free' : '') + '">' + esc(st.txt) + '</span></button>';
    }).join('') + (canSummon ? '<button type="button" class="wf-agent recruit" id="wf-recruit"><span class="av">+</span><span class="nm">RECRUIT</span><span class="st">a new ' + esc(p.role.toLowerCase()) + '</span></button>' : '');
    const pos = H.stepPositionOf(cur, p.id);   // THIS bay's position (multi-bay: the agent may crew another)
    const ph = pos === 'entry' ? 'The arriving job is the task. What does this step always do with it?' : pos === 'chain' ? "Work arrives as the previous step's output. What does this step do with it?" : 'What this step does with arriving work' + (ri ? ' — e.g. ' + ri.desc : '');
    const st = W.starters(p.role);
    const cr = contractRows(f, p);
    const tr = tryInfo(f, p);
    body.innerHTML = '<section class="wf-sec"><h3><span class="n">BAY ' + (f ? f.order.indexOf(p.id) + 1 : 1) + '</span>Who works here?</h3>'
      + (ri ? '<p class="wf-help">Suggested role: <b>' + esc(p.role) + '</b> — ' + esc(ri.desc) + '.</p>' : '')
      + (agents.length > 8 ? '<input id="wf-agent-find" class="refit-input wf-find" type="search" placeholder="Find an agent…" aria-label="Find an agent" />' : '')
      + '<div class="wf-agents" id="wf-agents">' + (agents.length || canSummon ? rows : '<p class="wf-help">No agents yet — recruit one from CREW.</p>') + '</div>'
      + '<details class="wf-more"><summary>Assign by agent ID</summary><div class="wf-row"><input id="wf-aid" class="refit-input" type="text" maxlength="40" placeholder="agent id" value="' + esc(cur) + '" />'
      + '<button type="button" class="bb sm" id="wf-aid-ok">▸ ASSIGN</button><button type="button" class="bb sm" id="wf-aid-clear">UNASSIGN</button></div><div class="refit-error" id="wf-aid-err">unknown agent — pick one above, or check the id</div></details>'
      + '<div class="wf-compute" data-live="compute">' + computeHTML(p) + '</div></section>'
      + '<section class="wf-sec"><h3>What is their job?</h3>'
      + '<div class="wf-chips" aria-label="Starters">' + st.map((x, i) => '<button type="button" class="wf-chip" data-st="' + i + '">' + esc(x.label) + '</button>').join('') + '</div>'
      + '<div class="wf-contract">'
      + '<div class="row"><span class="lab">GETS</span><span class="val ro" data-live="gets">→ <b>' + esc(cr.gets) + '</b></span></div>'
      + '<div class="row"><label class="lab" for="wf-does">DOES</label><span class="val"><textarea id="wf-does" data-keep="does:' + esc(p.id) + '" maxlength="2000" rows="4" placeholder="' + esc(ph) + '">' + esc(p.brief || '') + '</textarea></span></div>'
      + '<div class="row"><label class="lab" for="wf-hands">HANDS OFF</label><span class="val"><input id="wf-hands" data-keep="hands:' + esc(p.id) + '" type="text" maxlength="160" placeholder="optional — e.g. a 200-word draft" value="' + esc(p.hands || '') + '" /></span></div>'
      + '<div class="row"><span class="lab">TO</span><span class="val ro" data-live="to">→ <b>' + esc(cr.to) + '</b></span></div></div>'
      + '<p class="wf-help">These instructions apply to every job that reaches this step. HANDS OFF is added to them as <i>' + esc((typeof Pipeline !== 'undefined' && Pipeline.HANDS_LEAD) || "When you're done, hand off: ") + '…</i></p>'
      + (f && f.order.length > 1 ? '<p class="wf-help dim">A direct COMMS message to this agent runs only this step. The whole line runs from its INBOX triggers or a test.</p>' : '')
      + '</section>' + tr.html;
    // agent picks — ONE CLICK is the assignment
    $$('.wf-agent[data-aid]').forEach(b => b.onclick = () => {
      const res = H.station().assignPropAgent(p.id, b.dataset.aid);
      if (res && res.ok) { H.sfx('click'); H.flashTip('bay → ' + nameOf(b.dataset.aid), true); paint(true); } else H.sfx('bad');
    });
    const find = $('#wf-agent-find');
    if (find) find.oninput = () => { const q = find.value.trim().toLowerCase(); $$('.wf-agent[data-aid]').forEach(b => { b.hidden = !b.textContent.toLowerCase().includes(q); }); };
    const rec = $('#wf-recruit');
    if (rec) rec.onclick = () => {
      rec.disabled = true;
      const a = H.summonForRole(p.role, ri), res = a && H.station().assignPropAgent(p.id, a.id);
      if (res && res.ok) { H.sfx('chime'); H.flashTip(a.name + ' recruited → works this bay', true); paint(true); }
      else { rec.disabled = false; H.sfx('bad'); H.flashTip(a ? 'recruited, but the bay refused the assignment' : 'recruit failed — pick an agent above', false); }
    };
    const aid = $('#wf-aid'), aerr = $('#wf-aid-err');
    aid.oninput = () => aerr.classList.remove('show');
    $('#wf-aid-ok').onclick = () => { const res = H.station().assignPropAgent(p.id, aid.value.trim()); if (res && res.ok) { H.sfx('click'); paint(true); } else { aerr.classList.add('show'); H.sfx('bad'); } };
    $('#wf-aid-clear').onclick = () => { H.station().assignPropAgent(p.id, ''); H.sfx('click'); paint(true); };
    wireLive();
    // the contract: DOES (the standing brief) + HANDS OFF save on blur / Ctrl-Enter / close
    const does = $('#wf-does'), hands = $('#wf-hands');
    const saveBay = () => {
      const pp = prop(p.id); if (!pp) return;
      let changed = false;
      if (does && does.value.trim() !== (pp.brief || '')) { const r = H.station().setPropBrief(p.id, does.value); changed = !!(r && r.ok); }
      if (hands && hands.value.replace(/\s+/g, ' ').trim() !== (pp.hands || '') && H.station().setPropHands) { const r = H.station().setPropHands(p.id, hands.value); changed = changed || !!(r && r.ok); }
      if (changed) { H.sfx('click'); H.flashTip('step saved', true); }
    };
    el._saveBay = saveBay;
    for (const n of [does, hands]) {
      n.addEventListener('blur', saveBay);
      n.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || n === hands)) { e.preventDefault(); saveBay(); } if (e.key === 'Escape') { e.stopPropagation(); n.blur(); } });
      n.addEventListener('input', () => { S.drafts[n.dataset.keep] = n.value; });
    }
    $$('[data-st]').forEach(b => b.onclick = () => {
      const x = st[+b.dataset.st]; if (!x) return;
      does.value = x.does; hands.value = x.hands;
      S.drafts[does.dataset.keep] = x.does; S.drafts[hands.dataset.keep] = x.hands;
      saveBay(); H.sfx('click');
    });
    tr.wire();
  }

  /* ===== TRY THIS STEP — a real single run (POST /api/routing/steptest {single:true}) ===== */
  function tryInfo(f, p) {
    const c = comp(), W = WL();
    const none = { html: '', wire() {} };
    if (!c || !p.agentId || S.seam !== true) return none;
    const t = testOf(p.id), src = W.testInputFor(f, p.id, testsMap(), (S.testJob[S.lineKey] || '').trim());
    const pending = !!S.trying[p.id], err = S.tryErr[p.id];
    const nb = f ? W.neighbours(f, p.id) : null;
    const nextPid = nb && nb.gate && nb.gate.kind === 'loop' ? nb.gate.next : nb && nb.next.length === 1 ? nb.next[0] : null;
    const firstPid = f && f.order[0];
    let inputHtml;
    if (src) inputHtml = '<div class="wf-from"><span>INPUT</span><span class="src">from ' + esc(src.from === 'the INBOX test job' ? src.from : dockLabel(f, src.from) + "'s last test") + '</span></div>'
      + '<textarea class="wf-io" id="wf-tin" data-keep="tin:' + esc(p.id) + '" rows="4" aria-label="Test input">' + esc(t && t.input != null && t.input !== src.text ? t.input : src.text) + '</textarea>';
    else if (nb && (nb.first || !nb.prev.length)) inputHtml = '<p class="wf-help">Write a test job on the <button type="button" class="wf-link" data-go="' + esc(f.trigger.propId || '') + '">INBOX</button> first — it is what this step would receive.</p>'
      + '<textarea class="wf-io" id="wf-tin" data-keep="tin:' + esc(p.id) + '" rows="3" aria-label="Test input" placeholder="or type a test job here"></textarea>';
    else inputHtml = '<p class="wf-help">This step\'s input is ' + esc(dockLabel(f, nb.prev[0])) + '\'s output. <b>Test that step first</b>, then its result flows in here.</p>'
      + '<div class="wf-row"><button type="button" class="bb sm" data-go="' + esc(nb.prev[0]) + '">◂ Go to ' + esc(dockLabel(f, nb.prev[0])) + '</button></div>';
    let outHtml = '';
    if (pending) outHtml = '<div class="wf-log"><span class="wf-spin"></span>' + thumb(p.agentId, 16, 20, 'wf-ithumb') + esc(nameOf(p.agentId)) + ' is working… (a real run)</div>';
    else if (err) outHtml = '<div class="wf-warnline">✕ ' + esc(err) + '</div>';
    else if (t) {
      const v = /VERDICT:\s*(approved|revise)/i.exec(t.output || '');
      outHtml = '<div class="wf-from"><span>OUTPUT · WHAT ' + esc(nextPid ? dockLabel(f, nextPid).split(' · ')[0] + ' WILL GET' : 'SHIPS') + '</span><span class="src">' + (t.ms ? Math.round(t.ms / 1000) + 's' : '') + '</span></div>'
        + '<div class="wf-io out">' + esc(t.output || '(empty reply)') + '</div>'
        + '<div class="wf-meta"><span>cost <b>$' + (typeof t.usd === 'number' ? t.usd.toFixed(4) : '?') + '</b></span><span>' + (t.tools || 0) + ' tool call' + (t.tools === 1 ? '' : 's') + '</span><span>' + esc(nameOf(t.agentId || p.agentId)) + '</span></div>'
        + (v ? '<div class="wf-verdict">VERDICT: ' + esc(v[1].toUpperCase()) + '</div>' : '')
        + (nextPid ? '<div class="wf-flowon">↳ This is now <b>' + esc(dockLabel(f, nextPid)) + '</b>\'s test input.</div><div class="wf-row"><button type="button" class="bb sm refit-primary" data-go="' + esc(nextPid) + '">Next: set up ' + esc(dockLabel(f, nextPid).split(' · ')[0]) + ' ▸</button></div>'
          : '<div class="wf-flowon">↳ This is what would land in the OUTBOX.</div>');
    } else outHtml = '<p class="wf-help">Runs ' + esc(nameOf(p.agentId)) + ' once with this step\'s real brief and model, for real cost. Nothing else on the line runs.</p>';
    const canRun = !pending && !S.busy;
    const html = '<section class="wf-sec wf-try"><h3>Try this step</h3>' + inputHtml
      + '<div class="wf-row"><button type="button" class="bb sm' + (t ? '' : ' refit-primary') + '" id="wf-run"' + (canRun ? '' : ' disabled') + '>▶ ' + (t ? 'RUN AGAIN' : 'RUN THIS STEP') + '</button>'
      + (firstPid && firstPid !== p.id && !src ? '' : '') + '</div>' + outHtml + '</section>';
    return { html, wire() {
      $$('[data-go]').forEach(b => { if (!b._go) { b._go = true; b.onclick = () => { if (b.dataset.go) select(b.dataset.go); }; } });
      const run = $('#wf-run');
      if (run) run.onclick = () => {
        const tin = $('#wf-tin'), text = tin ? tin.value.trim() : '';
        if (!text) { H.sfx('bad'); H.flashTip('give this step a test input first', false); return; }
        tryStep(p.id, p.agentId, text);   // startAt = THIS bay (multi-bay: the agent may crew another)
      };
    } };
  }
  function tryStep(pid, agentId, text) {
    const c = comp(); if (!c) return;
    saveOpenFields();
    S.trying[pid] = true; delete S.tryErr[pid]; S.busy = true; paint(true);
    H.planGate(c).then(gate => {
      if (gate && gate.refuse) throw new Error(gate.refuse);
      return api('/api/routing/steptest', 'POST', { line: c.key, text, startAt: pid, single: true });
    }).then(r => {
      if (!r.j || !r.j.ok || !r.j.session) throw new Error((r.j && r.j.error) || 'step test refused (HTTP ' + r.status + ')');
      return waitDone(r.j.session);
    }).then(sess => {
      const h = (sess.hops || []).find(x => x.dockId ? x.dockId === pid : x.agentId === agentId) || (sess.hops || [])[0];
      if (sess.state === 'failed' || !h) throw new Error(sess.error || 'the step did not finish');
      tests[pid] = { input: h.input != null ? h.input : text, output: String(h.output || ''), usd: typeof h.usd === 'number' ? h.usd : null, tools: Array.isArray(h.tools) ? h.tools.length : (+h.tools || 0), ms: h.ms || null, agentId: h.agentId, at: sess.updatedAt || null };
      saveTests(); H.sfx('chime');
    }).catch(e => { S.tryErr[pid] = String((e && e.message) || e); H.sfx('bad'); })
      .then(() => { delete S.trying[pid]; S.busy = false; paint(true); });
  }
  // poll a single-run session to its end (contract: ~700 ms while running)
  function waitDone(sess) {
    return new Promise((resolve, reject) => {
      let n = 0;
      const tick = s => {
        if (!s) return reject(new Error('session lost'));
        if (!WL().isLive(s) || (s.single && s.state !== 'running')) return resolve(s);
        // the panel closed: stop polling (a closed panel must not keep asking the sidecar for ~14 minutes). The run itself
        // is real and carries on — its result lands in COMMS and the run history (sweep 2026-09-25)
        if (!el) return reject(new Error('the panel was closed while this step ran — it kept running; its result is in COMMS'));
        if (++n > 1200) return reject(new Error('the step is still running — check COMMS'));
        setTimeout(() => api('/api/routing/steptest/' + encodeURIComponent(s.id)).then(r => tick(r.j && r.j.session)).catch(reject), 700);
      };
      tick(sess);
    });
  }

  /* ===== THE TRIGGER (INBOX): name lives in the header; here — schedules, channels, the test job, LINE BUDGET ===== */
  function paintTrigger(body, f, p) {
    const W = WL(), tr = triggers(f), c = comp();
    const docks = f ? f.order.map(pid => f.docks[pid]).filter(d => d.agentId) : [];
    // FIRES AT a BAY (multi-bay): S.trgDock is the chosen dock's prop id — the writer's two bays are two choices
    const entries = entryDocks(f);
    if (!S.trgDock || !docks.some(d => d.propId === S.trgDock)) S.trgDock = entries[0] || (docks[0] && docks[0].propId) || null;
    const trgAgent = () => { const d = docks.find(x => x.propId === S.trgDock); return d ? d.agentId : null; };
    const armed = !!(S.cron && S.cron.enabled && !S.cron.halted);
    const routines = tr.routines;
    const rtRows = !S.cron ? '<div class="wf-help dim">reading routines…</div>'
      : !routines.length ? '<div class="wf-help dim">No routines target this line’s docks yet.</div>'
      : routines.map(r => {
        const said = H.human(r.display);
        return '<div class="trg-row"><span class="trg-state' + (r.enabled && armed ? ' on' : '') + '">' + (r.enabled ? (armed ? '●' : '◍') : '○') + '</span> <b>' + esc(r.name) + '</b>'
          + '<div class="trg-row-meta"><span' + (said !== r.display ? ' data-tip="' + esc(r.display) + '"' : '') + '>' + esc(said) + '</span> · fires at ' + thumb(r.agentId, 16, 20, 'wf-ithumb') + esc(nameOf(r.agentId))
          + (r.startsLine ? (armed ? ' · <b class="wf-okc">runs the whole line</b>' : ' · <span class="trg-warn">saved — scheduler OFF</span>')
            : r.runsLine ? ' · <span class="trg-warn">runs from a mid-line step</span>' : ' · <span class="dim">runs only that agent</span>')
          + (r.enabled ? '' : ' · paused') + '</div></div>';
      }).join('');
    const chanRows = !S.chans ? '<div class="wf-help dim">checking channels…</div>'
      : !tr.chanRows.length ? '<div class="wf-help dim">No channel is connected yet.</div>'
      : tr.chanRows.map(r => '<div class="trg-row"><span class="trg-state' + (r.connected ? ' on' : '') + '">' + (r.connected ? '●' : '○') + '</span> <b>' + esc(r.label) + '</b>'
        + '<div class="trg-row-meta">' + (r.answersAs ? 'answers as ' + esc(String(r.answersAs).toUpperCase()) : 'no fixed agent') + ' · '
        + (r.feeds === true ? '<b class="wf-okc">a message runs this whole line</b>' : r.feeds === false ? 'not this line’s first step — a message runs only that agent' : 'the floor routes it')
        + (r.connected ? '' : ' · <span class="trg-warn">not connected</span>') + '</div></div>').join('');
    const feed = H.feedState();
    const feedTxt = !feed.known ? 'Checking what feeds this floor…' : feed.fed ? '✓ FED — a channel, an armed routine, a watched folder or a webhook is wired to drop work on this floor.' : 'NO FEED — nothing is wired to drop work on this floor yet.';
    const dockChip = d => '<button type="button" class="bb sm trg-dock' + (d.propId === S.trgDock ? ' active' : '') + '" data-dock="' + esc(d.propId) + '" data-aid="' + esc(d.agentId) + '">' + thumb(d.agentId, 16, 20, 'wf-ithumb') + esc(dockLabel(f, d.propId)) + '</button>';   // the BAY, not just the agent: one agent may crew several (sweep 2026-09-25)
    const dockHint = pid => { const order = docks.map(d => d.propId), i = order.indexOf(pid); if (i <= 0) return 'starts at the first step — the whole line runs, ' + docks.length + ' step' + (docks.length === 1 ? '' : 's');
      return 'skips ' + order.slice(0, i).map(x => dockLabel(f, x)).join(' and ') + ' — the line runs from ' + dockLabel(f, pid) + ' on (' + (docks.length - i) + ' of ' + docks.length + ' steps)'; };
    const LD = (typeof Pipeline !== 'undefined' && Pipeline.LINE_LIMIT_DEFAULTS) || { maxHops: 6, maxUsdPerMessage: 2, maxUsdPerDay: null };
    const LC = (typeof Pipeline !== 'undefined' && Pipeline.LINE_LIMIT_CEILINGS) || { maxHops: 24, maxUsdPerMessage: 50, maxUsdPerDay: 500 };
    const lim0 = (p.limits && typeof p.limits === 'object') ? p.limits : {};
    const limVal = k => (typeof lim0[k] === 'number' && isFinite(lim0[k]) && lim0[k] > 0) ? String(lim0[k]) : '';
    const lbDefaultNote = 'blank = station default · ceilings ' + LC.maxHops + ' stages / $' + LC.maxUsdPerMessage + ' / $' + LC.maxUsdPerDay + ' a day, never above the global pool — saved on Enter / blur';
    const limField = (id, k, label, ph, step) => '<label class="refit-field lb-field" for="' + id + '">' + label
      + '<input id="' + id + '" class="refit-num lb-num" type="number" min="0" step="' + step + '" data-k="' + k + '" placeholder="' + esc(ph) + '" value="' + esc(limVal(k)) + '" /></label>';
    body.innerHTML = '<section class="wf-sec"><h3><span class="n">INBOX</span>What starts this line?</h3>'
      + '<p class="wf-help">A schedule, a message on a connected channel, a file landing in a watched folder, or a webhook call runs the <b>whole line</b>. A direct COMMS message only runs the agent you message.</p>'
      + '<h4>Schedules</h4><div class="trg-list" id="wf-routines">' + rtRows + '</div>'
      + '<div class="wf-row"><button type="button" class="bb sm' + (S.trgOpen ? ' active' : '') + '" id="trg-new" aria-expanded="' + S.trgOpen + '" aria-controls="trg-form">⊕ ADD A SCHEDULE</button><button type="button" class="bb sm" id="trg-auto">MANAGE SCHEDULES</button></div>'
      + '<div id="trg-form" class="trg-form"' + (S.trgOpen ? '' : ' hidden') + '>'
        + '<label class="trg-form-k" for="trg-prompt">What task should start each run?</label>'
        + '<textarea id="trg-prompt" data-keep="trgprompt:' + esc(p.id) + '" class="refit-input refit-brief" maxlength="2000" rows="3" placeholder="e.g. Find this week’s AI news and summarize the three biggest stories."></textarea>'
        + '<div class="rt-when trg-when" id="trg-when"><div class="trg-form-k">WHEN SHOULD IT RUN?</div>'
        + (typeof SchedPicker !== 'undefined' ? SchedPicker.html({ inputId: 'trg-sched' }) : '<input id="trg-sched" class="refit-input" type="text" maxlength="80" placeholder="schedule — every 30m · 0 9 * * * · in 2h" />')
        + '</div><div class="trg-preview" id="trg-preview"></div>'
        + (docks.length > 1 ? '<details class="wf-more"><summary>Starting agent · ' + esc(nameOf(trgAgent())) + '</summary><p class="wf-help">Usually, start with the first step. Choosing a later step skips the steps before it.</p><div class="wf-chips" id="trg-docks">' + docks.map(dockChip).join('') + '</div><div class="wf-help trg-dock-hint" id="trg-dock-hint">' + esc(dockHint(S.trgDock)) + '</div></details>'
          : docks.length === 1 ? '<div class="wf-help">fires at ' + thumb(docks[0].agentId, 16, 20, 'wf-ithumb') + '<b>' + esc((docks[0].role ? docks[0].role + ' · ' : '') + nameOf(docks[0].agentId)) + '</b> — this line’s first step</div>'
          : '<div class="wf-warnline">Assign an agent to a connected BAY first. A schedule needs an agent to start the work.</div>')
        + '<div class="wf-row"><button type="button" class="bb sm refit-primary" id="trg-create"' + (docks.length ? '' : ' disabled') + '>▸ SAVE SCHEDULE</button><button type="button" class="bb sm" id="trg-cancel">CANCEL</button></div>'
        + '</div><div class="wf-help trg-msg' + (S.trgMsg && S.trgMsg.bad ? ' bad' : '') + '" id="trg-msg"' + (S.trgMsg ? '' : ' hidden') + '>' + esc(S.trgMsg ? S.trgMsg.t : '') + '</div>'
      + '<h4>Channels</h4><div class="trg-list" id="wf-chans">' + chanRows + '</div>'
      + '<div class="wf-row"><button type="button" class="bb sm" id="trg-chan">CONNECT A CHANNEL ▸</button></div>'
      + (S.lineKey ? ltSectionHtml() : '')
      + '<p class="wf-help dim" id="trg-feed">' + esc(feedTxt) + '</p></section>'
      + projectSectionHtml(p)
      + '<section class="wf-sec"><h3>Test job</h3><p class="wf-help">What a test sends in, as if it arrived at the INBOX. Used by Try this step and the step test. Not saved to the line.</p>'
      + '<textarea id="wf-job" class="refit-input refit-brief" rows="3" maxlength="4000" placeholder="e.g. Find this week’s most useful research on sleep and memory.">' + esc(S.testJob[S.lineKey] || (routines.find(r => r.startsLine) || {}).prompt || '') + '</textarea>'
      + (docks[0] ? '<div class="wf-row"><button type="button" class="bb sm" data-go="' + esc(f.order[0]) + '">Set up the first step ▸</button></div>' : '') + '</section>'
      + '<details class="wf-sec refit-workflow-advanced"><summary>Optional limits · LINE BUDGET</summary>'
      + limField('lb-hops', 'maxHops', 'max stages after the first', String(LD.maxHops), '1')
      + limField('lb-msg', 'maxUsdPerMessage', '$ per message, whole line', LD.maxUsdPerMessage.toFixed(2), '0.05')
      + limField('lb-day', 'maxUsdPerDay', '$ per day, this line', 'off', '0.50')
      + '<div class="wf-help lb-note" id="lb-note">' + esc(lbDefaultNote) + '</div></details>';
    // test job
    const job = $('#wf-job');
    job.addEventListener('input', () => { S.testJob[S.lineKey] = job.value; saveTests(); });
    $$('[data-go]').forEach(b => b.onclick = () => { if (b.dataset.go) select(b.dataset.go); });
    // LINE BUDGET: one save for the three fields; the saved (clamped) answer is re-painted INTO the fields
    const lbNums = $$('.lb-num'), lbNote = $('#lb-note');
    let lbSaved = JSON.stringify(Object.keys(lim0).length ? lim0 : null);
    const lbName = k => k === 'maxHops' ? 'stages' : k === 'maxUsdPerMessage' ? '$ per message' : '$ per day';
    const saveLimits = () => {
      if (!lbNums.length || typeof H.station().setPropLimits !== 'function') return;
      const raw = {};
      for (const n of lbNums) { const v = String(n.value || '').trim(); if (v !== '' && isFinite(+v) && +v > 0) raw[n.dataset.k] = +v; }
      const res = H.station().setPropLimits(p.id, Object.keys(raw).length ? raw : null);
      if (!res || !res.ok) { H.sfx('bad'); return; }
      const next = JSON.stringify(res.limits || null);
      for (const n of lbNums) { const k = n.dataset.k, v = res.limits && res.limits[k]; n.value = (typeof v === 'number' && v > 0) ? String(v) : ''; }
      if (lbNote) lbNote.textContent = (res.clamped && res.clamped.length) ? 'clamped to the ceiling — ' + res.clamped.map(x => lbName(x.split('>')[0])).join(', ') + ' (the numbers shown are the ones in force)' : lbDefaultNote;
      if (next === lbSaved) return;
      lbSaved = next; H.sfx('click');
      if (lbNote) lbNote.textContent = (res.limits ? '✓ line budget saved · ' : '✓ cleared — station defaults · ') + lbNote.textContent;
      H.flashTip(res.limits ? 'line budget saved' : 'line budget cleared — station defaults', true);
    };
    el._saveLimits = saveLimits;
    for (const n of lbNums) {
      n.addEventListener('blur', saveLimits);
      n.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveLimits(); } if (e.key === 'Escape') { e.stopPropagation(); n.blur(); } });
    }
    wireProjectPick(p);
    wireScheduleForm(p, docks, dockHint);
    if (S.lineKey) wireLineTriggers();
    $('#trg-chan').onclick = () => { H.sfx('click'); saveOpenFields(); H.openTerm('messaging'); };
    $('#trg-auto').onclick = () => { H.sfx('click'); saveOpenFields(); H.openTerm('routines'); };
  }
  /* WORKING FOLDER (#25): the trusted project every stage of this line runs in. The value shown is the INBOX's own
     saved field (setPropProject writes every connected INBOX in one step, and the compiler copies it onto the plan
     line the sidecar routes by — the compiled line only answers if the prop is gone). Only folders the server reports as still trusted are offered; a saved folder that lost its trust
     stays visible, disabled, and says so — the sidecar refuses to run a stage there anyway. */
  function projectOf(p) {
    const live = prop(p.id);
    if (live) return live.projectRoot || '';
    const plan = H.plan(), line = plan && (plan.lines || []).find(l => (l.intakes || []).indexOf(p.id) >= 0);
    return (line && line.projectRoot) || '';
  }
  function projectSectionHtml(p) {
    const cur = projectOf(p), P = S.projects;
    const chip = (root, label, on, off) => '<button type="button" class="bb sm wf-proj' + (on ? ' active' : '') + '" data-root="' + esc(root) + '" aria-pressed="' + on + '"' + (off ? ' disabled' : '') + '>' + esc(label) + '</button>';
    let chips = '', note = 'All workflow stages use this folder. Add trusted folders in Projects.';
    if (!P) chips = '<div class="wf-help dim">Loading projects…</div>';
    else if (P.err) note = P.err;
    else {
      chips = chip('', 'Agent workspace (default)', !cur, false)
        + P.rows.map(r => chip(r.root, r.displayPath || r.root, r.root === cur, false)).join('');
      if (cur && !P.rows.some(r => r.root === cur)) {
        chips += chip(cur, cur + ' (unavailable)', true, true);
        note = 'This project is no longer trusted. Restore access in Projects or choose another folder.';
      }
    }
    if (S.projectMsg && S.projectMsg.id === p.id) note = S.projectMsg.t;
    return '<section class="wf-sec"><h3>Working folder</h3><div class="trg-form-k">Trusted project</div>'
      + '<div class="wf-chips" id="wf-project" role="group" aria-label="Trusted project">' + chips + '</div>'
      + '<p class="wf-help" id="wf-project-note">' + esc(note) + '</p></section>';
  }
  function wireProjectPick(p) {
    $$('.wf-proj').forEach(b => b.onclick = () => {
      if (b.disabled || b.getAttribute('aria-pressed') === 'true') return;
      const st = H.station();
      const res = typeof st.setPropProject === 'function' ? st.setPropProject(p.id, b.dataset.root || '') : { ok: false, message: 'this station model cannot save a project' };
      S.projectMsg = { id: p.id, t: res && res.ok ? 'Working folder saved for all workflow stages. Existing tool permissions still apply.' : ((res && (res.msg || res.message)) || 'Could not save the project.') };
      H.sfx(res && res.ok ? 'click' : 'bad');
      H.layoutChanged();
      paint();
    });
  }
  /* ===== LINE TRIGGERS (2026-09-23): "when a file lands in a folder" · "when a webhook is called" =====
     Every row is the SERVER's record (GET /api/routing/triggers): enabled, blockedBy (the same preflight a fire
     runs), fires, lastFiredAt, lastOutcome, lastError. The webhook key is answered ONCE by create/regenerate and
     lives only in S.ltReveal until the Commander dismisses it or leaves the line — it is never fetched again.
     Email is not offered: the server reports email.available:false (no mail connector exists). */
  const ago = iso => { const t = Date.parse(iso || ''); if (!isFinite(t)) return ''; const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 172800 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const ltMine = () => (S.lt && Array.isArray(S.lt.triggers) ? S.lt.triggers : []).filter(t => t.lineId === S.lineKey);
  /* THE 5 s RE-READ NEVER REBUILDS THE CARD (2026-09-24). It used to call paint(), which rebuilt the whole INBOX
     card: the WHEN picker remounted (a picked schedule snapped back to daily 9:00), an ARMED DELETE / NEW KEY
     button was replaced mid-confirm, and open sections collapsed. Now: an unchanged answer touches nothing but the
     "x ago" text; a changed one patches only the rows that changed (WorkflowLine.rowPatch) plus the head/strip
     sentences that quote the triggers. Only the FIRST answer (the lists still say "reading triggers…") paints. */
  function ltRefresh() {
    return api('/api/routing/triggers').then(r => {
      if (!(r.status === 200 && r.j && Array.isArray(r.j.triggers))) return;
      const sig = JSON.stringify(r.j);
      if (S.lt && sig === S.ltSig) { ltTickAgo(); return; }
      const first = !S.lt;
      S.lt = r.j; S.ltSig = sig;
      if (first) paint(); else ltPatch();
    }).catch(() => {});
  }
  const ltRowSig = t => WL().triggerSig(t, S.ltReveal && S.ltReveal.id === t.id ? 'reveal' : null);
  function ltListHtml(kind) {
    if (!S.lt) return '<div class="wf-help dim">reading triggers…</div>';
    const list = ltMine().filter(t => t.kind === kind);
    return list.length ? list.map(ltRowHtml).join('') : '<div class="wf-help dim">' + (kind === 'folder' ? 'No folder is watched for this line.' : 'No webhook starts this line.') + '</div>';
  }
  function ltPatch() {
    if (!el || !H) return;
    const f = flow();
    paintHead(f); paintStrip(f);   // the header + strip quote the live trigger sentences
    for (const pair of [['#lt-folders', 'folder'], ['#lt-hooks', 'webhook']]) {
      const box = $(pair[0]), rowKind = pair[1]; if (!box) continue;
      const list = ltMine().filter(t => t.kind === rowKind);
      const prev = Array.from(box.children).filter(n => n.classList.contains('lt-row')).map(n => [n.dataset.lt, n.dataset.sig]);
      const plan = WL().rowPatch(prev, list.map(t => [t.id, ltRowSig(t)]));
      if (plan.all) { box.innerHTML = ltListHtml(rowKind); wireLtRows(box); continue; }
      for (const id of plan.changed) {
        const old = Array.from(box.children).find(n => n.dataset.lt === id), t = list.find(x => x.id === id);
        if (!old || !t) continue;
        const tmp = document.createElement('div'); tmp.innerHTML = ltRowHtml(t);
        const row = tmp.firstElementChild; old.replaceWith(row); wireLtRows(row);
      }
    }
    ltTickAgo();
  }
  // the one thing that moves with no data change: "last fired 3m ago"
  function ltTickAgo() { if (el) for (const n of $$('.lt-ago')) { const s = ago(n.dataset.at); if (s && n.textContent !== s) n.textContent = s; } }
  function ltRowHtml(t) {
    const blocked = t.enabled && t.blockedBy;
    const glyph = !t.enabled ? '○' : blocked ? '◍' : '●';
    const title = t.kind === 'folder' ? ((t.config && t.config.path) || 'a folder') : (t.name ? '“' + t.name + '”' : '(unnamed)');
    const lo = t.lastOutcome;
    const last = t.running ? '<b class="wf-okc">running now</b>'
      : t.lastFiredAt ? 'last fired <span class="lt-ago" data-at="' + esc(t.lastFiredAt) + '">' + esc(ago(t.lastFiredAt)) + '</span>' + (lo ? (lo.ok ? ' · <b class="wf-okc">✓ reached the OUTBOX</b>' + (lo.runs ? ' (' + lo.runs + ' run' + (lo.runs === 1 ? '' : 's') + ')' : '') : ' · <span class="trg-warn">✕ did not finish</span>') : '')
      : 'never fired';
    const state = !t.enabled ? 'paused' : blocked ? '<span class="trg-warn">waiting — ' + esc(t.blockedBy) + '</span>'
      : t.kind === 'folder' ? 'watching — each new file runs the whole line' : 'listening — each call runs the whole line';
    let html = '<div class="trg-row lt-row" data-lt="' + esc(t.id) + '" data-sig="' + esc(ltRowSig(t)) + '"><span class="trg-state' + (t.enabled && !blocked ? ' on' : '') + '">' + glyph + '</span> <b>' + (t.kind === 'folder' ? 'FOLDER ' : 'WEBHOOK ') + '</b>' + esc(title)
      + '<div class="trg-row-meta">' + state + '</div>'
      + '<div class="trg-row-meta">fired ' + (t.fires || 0) + '× · ' + last + (t.queued ? ' · ' + t.queued + ' waiting' : '') + ' · at most ' + t.maxPerHour + '/hour</div>'
      + (t.config && t.config.task ? '<div class="trg-row-meta">task: ' + esc(t.config.task.length > 90 ? t.config.task.slice(0, 88) + '…' : t.config.task) + '</div>' : '')
      + (t.lastError ? '<div class="trg-row-meta"><span class="trg-warn">last error: ' + esc(t.lastError) + '</span></div>' : '');
    if (t.kind === 'webhook') {
      html += '<div class="trg-row-meta lt-url">POST <code class="lt-code">' + esc(t.url || '') + '</code> <button type="button" class="bb sm" data-lt-copy="' + esc(t.url || '') + '">COPY URL</button></div>';
      const rv = S.ltReveal && S.ltReveal.id === t.id ? S.ltReveal : null;
      if (rv) html += '<div class="lt-reveal" role="status"><div class="trg-form-k">YOUR KEY — SHOWN ONCE</div>'
        + '<code class="lt-code lt-key">' + esc(rv.secret) + '</code>'
        + '<div class="wf-row"><button type="button" class="bb sm refit-primary" data-lt-copy="' + esc(rv.secret) + '">COPY KEY</button><button type="button" class="bb sm" id="lt-reveal-done">I SAVED IT</button></div>'
        + '<p class="wf-help">Send it as the <b>X-StarNet-Hook-Key</b> header (or <b>Authorization: Bearer …</b>, or <b>?key=</b> on the URL). StarNet keeps only a fingerprint of it: once this box closes it cannot be shown again. Lost it? Make a new key.</p></div>';
    }
    html += '<div class="wf-row lt-acts"><button type="button" class="bb sm" data-lt-act="toggle">' + (t.enabled ? 'PAUSE' : 'RESUME') + '</button>'
      + '<button type="button" class="bb sm" data-lt-act="edit">EDIT</button>'
      + (t.kind === 'webhook' ? '<button type="button" class="bb sm" data-lt-act="rekey">NEW KEY</button>' : '')
      + '<button type="button" class="bb sm" data-lt-act="delete">DELETE</button></div></div>';
    return html;
  }
  function ltFormHtml(kind) {
    const F = S.ltForm, editing = !!(F && F.id), cur = editing ? ltMine().find(t => t.id === F.id) : null;
    const ceil = (S.lt && S.lt.maxPerHourCeiling) || 120;
    const val = (k, dflt) => esc(S.drafts['lt:' + k] != null ? S.drafts['lt:' + k] : dflt);
    return '<div class="trg-form lt-form" id="lt-form">'
      + (kind === 'folder'
        ? '<label class="trg-form-k" for="lt-path">Folder to watch (full path)</label>'
          + '<input id="lt-path" data-keep="lt:path" class="refit-input" type="text" maxlength="1024" spellcheck="false" placeholder="e.g. C:\\Users\\you\\Drops\\invoices" value="' + val('path', cur ? cur.config.path : '') + '" />'
          + '<p class="wf-help dim">Files placed directly in this folder (not in its subfolders) start the line — once each, after the file finishes writing. Files already there are skipped. It must be inside your home folder or a project you added; system folders are refused.</p>'
        : '<p class="wf-help dim">You get a web address and a secret key. Anything that POSTs to the address with the key starts the line; the request body becomes the job.</p>')
      + '<label class="trg-form-k" for="lt-task">What should the line do with ' + (kind === 'folder' ? 'each file' : 'each call') + '? (optional)</label>'
      + '<textarea id="lt-task" data-keep="lt:task" class="refit-input refit-brief" maxlength="2000" rows="2" placeholder="' + (kind === 'folder' ? 'e.g. Pull out the total and the due date.' : 'e.g. Summarize this order for the team.') + '">' + val('task', cur ? cur.config.task : '') + '</textarea>'
      + '<label class="trg-form-k" for="lt-name">Name (optional)</label>'
      + '<input id="lt-name" data-keep="lt:name" class="refit-input" type="text" maxlength="60" placeholder="' + (kind === 'folder' ? 'e.g. Invoices' : 'e.g. New orders') + '" value="' + val('name', cur ? cur.name : '') + '" />'
      + '<label class="refit-field lb-field" for="lt-rate">at most this many runs an hour'
      + '<input id="lt-rate" data-keep="lt:rate" class="refit-num lb-num" type="number" min="1" max="' + ceil + '" step="1" value="' + val('rate', cur ? String(cur.maxPerHour) : '20') + '" /></label>'
      + '<div class="wf-row"><button type="button" class="bb sm refit-primary" id="lt-save">' + (editing ? '▸ SAVE CHANGES' : kind === 'folder' ? '▸ WATCH THIS FOLDER' : '▸ CREATE WEBHOOK') + '</button><button type="button" class="bb sm" id="lt-cancel">CANCEL</button></div></div>';
  }
  function ltSectionHtml() {
    const F = S.ltForm;
    const rows = ltListHtml;
    const port = (S.lt && /:(\d+)\//.exec(S.lt.hookBase || '')) ? /:(\d+)\//.exec(S.lt.hookBase)[1] : '';
    return '<h4>When a file lands in a folder</h4><div class="trg-list" id="lt-folders">' + rows('folder') + '</div>'
      + (F && F.kind === 'folder' ? ltFormHtml('folder') : '<div class="wf-row"><button type="button" class="bb sm" id="lt-new-folder">⊕ WATCH A FOLDER</button></div>')
      + '<h4>When a webhook is called</h4><div class="trg-list" id="lt-hooks">' + rows('webhook') + '</div>'
      + (F && F.kind === 'webhook' ? ltFormHtml('webhook') : '<div class="wf-row"><button type="button" class="bb sm" id="lt-new-hook">⊕ ADD A WEBHOOK</button></div>')
      + '<p class="wf-help dim">A webhook address lives on this computer (127.0.0.1' + (port ? ':' + port : '') + '). Nothing outside this machine can reach it unless you set up a tunnel yourself (for example cloudflared or ngrok) pointed at that port.</p>'
      + '<div class="wf-help trg-msg' + (S.ltMsg && S.ltMsg.bad ? ' bad' : '') + '" id="lt-msg"' + (S.ltMsg ? '' : ' hidden') + '>' + esc(S.ltMsg ? S.ltMsg.t : '') + '</div>';
  }
  const ltSay = (t, bad) => { S.ltMsg = { t, bad: !!bad }; const m = $('#lt-msg'); if (m) { m.hidden = false; m.classList.toggle('bad', !!bad); m.textContent = t; } };
  const ltClearForm = () => { for (const k of ['path', 'task', 'name', 'rate']) delete S.drafts['lt:' + k]; S.ltForm = null; };
  // a Commander action changed the triggers: re-read, then ONE deliberate repaint (the action's own result)
  const ltAfter = (msg, bad) => { S.ltMsg = msg ? { t: msg, bad: !!bad } : null; return ltRefresh().then(() => H.pollFeed()).then(() => paint(true), () => paint(true)); };
  /* the per-row controls (COPY / PAUSE / EDIT / NEW KEY / DELETE / I SAVED IT) inside `scope` — the whole card on a
     paint, or just the rows ltPatch replaced (an untouched row keeps its handlers AND an armed confirm) */
  function wireLtRows(scope) {
    const say = ltSay, clearForm = ltClearForm, after = ltAfter;
    const q = s => (scope.matches && scope.matches(s) ? [scope] : []).concat(Array.from(scope.querySelectorAll(s)));
    q('#lt-reveal-done').forEach(done => { done.onclick = () => { H.sfx('click'); S.ltReveal = null; paint(true); }; });
    q('[data-lt-copy]').forEach(b => b.onclick = () => {
      const v = b.dataset.ltCopy || '', rest = b.textContent;
      const ok = () => { H.sfx('click'); b.textContent = 'COPIED'; setTimeout(() => { if (b.isConnected) b.textContent = rest; }, 1400); };
      try { navigator.clipboard.writeText(v).then(ok, () => say('copy failed — select the text and copy it by hand', true)); } catch (e) { say('copy failed — select the text and copy it by hand', true); }
    });
    q('.lt-row').forEach(row => {
      const id = row.dataset.lt, t = ltMine().find(x => x.id === id); if (!t) return;
      row.querySelectorAll('[data-lt-act]').forEach(b => {
        const act = b.dataset.ltAct;
        if (act === 'toggle') b.onclick = () => { b.disabled = true; api('/api/routing/triggers/' + encodeURIComponent(id), 'PATCH', { enabled: !t.enabled })
          .then(({ status, j }) => { if (status !== 200 || !j || !j.ok) { H.sfx('bad'); say('✕ ' + ((j && j.error) || 'not changed'), true); b.disabled = false; return; } H.sfx('click'); return after(t.enabled ? '✓ paused' : '✓ resumed' + (t.kind === 'folder' ? ' — files already in the folder are skipped' : '')); })
          .catch(() => { b.disabled = false; say('✕ not changed', true); }); };
        else if (act === 'edit') b.onclick = () => { H.sfx('click'); clearForm(); S.ltForm = { kind: t.kind, id }; paint(true); };
        else if (act === 'rekey' && typeof ArmConfirm !== 'undefined') ArmConfirm.wire(b, { armedLabel: 'OLD KEY STOPS — SURE?', onArm: () => H.sfx('bad'),
          onConfirm: () => api('/api/routing/triggers/' + encodeURIComponent(id) + '/secret', 'POST', {}).then(({ status, j }) => {
            if (status !== 200 || !j || !j.secret) { H.sfx('bad'); say('✕ ' + ((j && j.error) || 'no new key'), true); return; }
            S.ltReveal = { id, secret: j.secret }; H.sfx('chime'); return after('✓ new key made — the old one no longer works; copy this one now');
          }) });
        else if (act === 'delete' && typeof ArmConfirm !== 'undefined') ArmConfirm.wire(b, { armedLabel: 'REALLY DELETE?', onArm: () => H.sfx('bad'),
          onConfirm: () => api('/api/routing/triggers/' + encodeURIComponent(id), 'DELETE').then(({ status, j }) => {
            if (status !== 200 || !j || !j.ok) { H.sfx('bad'); say('✕ ' + ((j && j.error) || 'not deleted'), true); return; }
            if (S.ltReveal && S.ltReveal.id === id) S.ltReveal = null;
            if (S.ltForm && S.ltForm.id === id) clearForm();
            H.sfx('click'); return after('✓ trigger deleted');
          }) });
      });
    });
  }
  function wireLineTriggers() {
    const say = ltSay, clearForm = ltClearForm, after = ltAfter;
    const open = kind => { H.sfx('click'); clearForm(); S.ltForm = { kind, id: null }; S.ltMsg = null; paint(true); const i = $(kind === 'folder' ? '#lt-path' : '#lt-task'); if (i) i.focus(); };
    const nf = $('#lt-new-folder'); if (nf) nf.onclick = () => open('folder');
    const nh = $('#lt-new-hook'); if (nh) nh.onclick = () => open('webhook');
    const cancel = $('#lt-cancel'); if (cancel) cancel.onclick = () => { H.sfx('click'); clearForm(); paint(true); };
    const save = $('#lt-save');
    if (save) save.onclick = () => {
      const F = S.ltForm; if (!F) return;
      const path = $('#lt-path') ? $('#lt-path').value.trim() : '';
      const task = $('#lt-task').value.trim(), name = $('#lt-name').value.trim(), rate = parseInt($('#lt-rate').value, 10);
      if (F.kind === 'folder' && !path) { H.sfx('bad'); say('enter the folder to watch', true); return; }
      if (!S.lineKey) { H.sfx('bad'); say('connect this INBOX to a line first', true); return; }
      const config = F.kind === 'folder' ? { path, task } : { task };
      const body = { name, config, maxPerHour: isFinite(rate) && rate > 0 ? rate : 20 };
      save.disabled = true; say('saving…');
      const req = F.id ? api('/api/routing/triggers/' + encodeURIComponent(F.id), 'PATCH', body)
        : api('/api/routing/triggers', 'POST', Object.assign({ kind: F.kind, lineId: S.lineKey }, body));
      req.then(({ status, j }) => {
        save.disabled = false;
        if (status !== 200 || !j || !j.ok || !j.trigger) { H.sfx('bad'); say('✕ ' + ((j && j.error) || 'not saved'), true); return; }
        H.sfx('chime'); clearForm();
        if (j.secret) S.ltReveal = { id: j.trigger.id, secret: j.secret };
        return after(F.id ? '✓ saved' : F.kind === 'folder' ? '✓ watching ' + j.trigger.config.path + ' — files already there are skipped' : '✓ webhook created — copy the key now, it is shown once');
      }).catch(() => { save.disabled = false; H.sfx('bad'); say('✕ not saved — check the connection and try again', true); });
    };
    const card = $('#wf-body'); if (card) wireLtRows(card);
  }

  /* the schedule form: the SAME SchedPicker + /api/cron/preview + the SAME create body the AUTOMATION
     window posts, plus runsLine:true — minted here, under FOR THIS LINE, it is the Commander asking for the
     line to run (cron-store `runsLine`). No unattendedGrants, no toolsets. Read-back confirms the saved id. */
  function wireScheduleForm(p, docks, dockHint) {
    const formEl = $('#trg-form'), newBtn = $('#trg-new'), promptEl = $('#trg-prompt'), schedEl = $('#trg-sched');
    const pvEl = $('#trg-preview');
    // the chosen BAY's agent, resolved from THIS function's docks (paintTrigger's own lookup is not in scope here —
    // reaching for it threw a ReferenceError and SAVE SCHEDULE never saved; locked by test/sibling-scope.test.js)
    const agentOfDock = pid => { const d = docks.find(x => x.propId === pid); return d ? d.agentId : null; };
    // the answer outlives a re-render (a save repaints the card): kept on S, painted wherever #trg-msg is now
    const say = (t, bad) => { S.trgMsg = { t, bad: !!bad }; const m = $('#trg-msg'); if (m) { m.hidden = false; m.classList.toggle('bad', !!bad); m.textContent = t; } };
    const relFmt = iso => { const d = Date.parse(iso) - Date.now(); if (!isFinite(d)) return ''; const m = Math.round(d / 60000); return m < 1 ? 'under a minute' : m < 60 ? 'in ' + m + 'm' : m < 2880 ? 'in ' + Math.round(m / 60) + 'h' : 'in ' + Math.round(m / 1440) + 'd'; };
    // ONE timezone for the preview AND the create (the preview used to omit it, so its 'next:' could name a different
    // hour than the routine the server then saved)
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch (e) { return undefined; } })();
    let pvTimer = null;
    const preview = () => {
      clearTimeout(pvTimer);
      const v = schedEl.value.trim();
      if (!v) { pvEl.textContent = ''; return; }
      pvTimer = setTimeout(() => {
        api('/api/cron/preview', 'POST', { schedule: v, tz }).then(({ j: r }) => {
          if (!pvEl.isConnected || schedEl.value.trim() !== v) return;
          if (r && r.ok) {
            const nx = (Array.isArray(r.localNext) && r.localNext[0]) ? r.localNext[0] : (Array.isArray(r.next) && r.next[0] ? relFmt(r.next[0]) : '');
            const said = H.human(r.display);
            pvEl.innerHTML = '✓ <span' + (said !== r.display ? ' data-tip="' + esc(r.display) + '"' : '') + '>' + esc(said) + '</span>' + (nx ? ' → next: ' + esc(nx) : '');
          } else pvEl.innerHTML = '<span class="trg-warn">' + esc((r && r.error) || 'unrecognized schedule') + '</span>';
        }).catch(() => {});
      }, 300);
    };
    schedEl.addEventListener('input', preview);
    /* THE PICKED SCHEDULE SURVIVES A REPAINT (2026-09-24): #trg-sched is a kept draft. The picker's mount seeds its
       default (daily 9:00) into the input, so the Commander's pick is read BEFORE the mount and put back through
       set() — which also rebuilds the picker's own mode/day/hour controls, not just the text. */
    const schedKey = 'trgsched:' + p.id, wantSched = S.drafts[schedKey];
    schedEl.dataset.keep = schedKey;
    // mount the WHEN picker AFTER the listener exists (it types its default schedule in on mount)
    const picker = typeof SchedPicker !== 'undefined' ? SchedPicker.mount($('#trg-when'), { onChange: () => H.sfx('click') }) : null;
    if (typeof wantSched === 'string' && wantSched.trim() && wantSched !== schedEl.value) {
      if (picker && typeof picker.set === 'function') picker.set(wantSched); else schedEl.value = wantSched;
    }
    $$('.trg-dock').forEach(b => b.onclick = () => {
      S.trgDock = b.dataset.dock; H.sfx('click');
      $$('.trg-dock').forEach(x => x.classList.toggle('active', x.dataset.dock === S.trgDock));
      const hintEl = $('#trg-dock-hint'); if (hintEl) hintEl.textContent = dockHint(S.trgDock);
      b.closest('details').querySelector('summary').textContent = 'Starting agent · ' + nameOf(b.dataset.aid);
    });
    const showForm = on => { S.trgOpen = on; S.trgMsg = null; const m = $('#trg-msg'); if (m) m.hidden = true; formEl.hidden = !on; newBtn.classList.toggle('active', on); newBtn.setAttribute('aria-expanded', on ? 'true' : 'false'); if (on) promptEl.focus(); else newBtn.focus(); };
    newBtn.onclick = () => { H.sfx('click'); showForm(formEl.hidden); };
    $('#trg-cancel').onclick = () => { H.sfx('click'); showForm(false); };
    $('#trg-create').onclick = () => {
      const prompt = promptEl.value.trim(), schedule = schedEl.value.trim();
      if (!prompt || !schedule) { H.sfx('bad'); say('a task and a schedule are required', true); return; }
      const dockId = S.trgDock, agentId = agentOfDock(dockId);
      if (!dockId || !agentId) { H.sfx('bad'); say('assign an agent to a step first — a routine fires at an agent', true); return; }
      const btn = $('#trg-create'); btn.disabled = true; say('saving…');
      const ln = lineName();
      const name = (ln ? ln + ' — ' : '') + (prompt.length > 48 ? prompt.slice(0, 45) + '…' : prompt);
      const refuse = m => { btn.disabled = false; H.sfx('bad'); say('✕ ' + m, true); };
      // FIRES AT a bay: the agent that runs + WHICH of its bays (multi-bay; cron-store keeps dockId additively)
      api('/api/cron', 'POST', { name, prompt, schedule, agentId, dockId, provider: H.provider(), tz, runsLine: true }).then(async ({ status, j: r }) => {
        if (r && r.error) return refuse(r.error);
        if (r && r.declined) return refuse(r.message || 'this routine name was deleted before — reword the task');
        if (r && r.duplicate) return refuse('a similar routine already exists' + (r.job && r.job.name ? ' ("' + r.job.name + '")' : '') + ' — reword the task; nothing new was created');
        if (status !== 200 || !r || r.ok !== true || !r.job || !r.job.id) return refuse('save not confirmed — check AUTOMATION before retrying');
        const rb = await api('/api/cron');
        const cur = rb.j, saved = cur && Array.isArray(cur.jobs) && cur.jobs.find(x => x.id === r.job.id);
        if (!saved || cur.degraded) return refuse('save not confirmed — check AUTOMATION before retrying');
        S.cron = cur; btn.disabled = false; H.sfx('chime');
        const armedNow = !!(cur.enabled && !cur.halted);
        if (!S.testJob[S.lineKey]) { S.testJob[S.lineKey] = prompt; saveTests(); }
        // saved: the form starts clean (un-flag the fields too, or the next paint's keepDrafts re-remembers them)
        S.drafts['trgprompt:' + p.id] = ''; delete S.drafts[schedKey]; promptEl.dataset.typed = ''; schedEl.dataset.typed = '';
        S.trgOpen = false;
        H.pollFeed().then(() => paint(true), () => paint(true));
        say(saved.state === 'completed' ? '✓ routine completed — see its result in AUTOMATION' : !saved.enabled ? '✓ saved — this routine is paused; manage it in AUTOMATION'
          : armedNow ? '✓ schedule saved — fires at ' + nameOf(agentId) : '✓ saved — but scheduling is OFF or STOPPED; enable it in AUTOMATION', !saved.enabled || !armedNow);
        paint(true);
      }).catch(() => refuse('save not confirmed — check AUTOMATION before retrying'));
    };
  }

  /* ===== LOOP / JOINER gates — the same configureJunction path, the same compiled-plan labels ===== */
  function paintGate(body, f, p) {
    const isJoiner = p.t === 'joiner', isLoop = p.t === 'loop';
    const jnField = (id, label, min, max, step, val, ph) => '<label class="refit-field lb-field" for="' + id + '">' + label
      + '<input id="' + id + '" class="refit-num lb-num" type="number" min="' + min + '" max="' + max + '" step="' + step + '" placeholder="' + esc(ph) + '" value="' + esc(val) + '" /></label>';
    const loopExits = isLoop ? H.loopExits(p.id) : [];
    const loopMaxDef = (typeof Pipeline !== 'undefined' && Pipeline.LOOP_MAX_DEFAULT) || 5;
    const loopMaxCeil = (typeof Pipeline !== 'undefined' && Pipeline.LOOP_MAX_CEILING) || 20;
    const loopDoneCur = (p.done && loopExits.some(x => x.dir === p.done)) ? p.done : (loopExits[0] ? loopExits[0].dir : null);
    const joinerHtml = isJoiner
      ? '<section class="wf-sec"><h3><span class="n">JOINER</span>How long should it wait?</h3><p class="wf-help">Work waits here for every parallel part of the same job, then continues as one combined result.</p>'
        + jnField('jn-timeout', 'minutes to wait for a late branch', 1, 120, 1, p.timeoutMin ? String(p.timeoutMin) : '', '10')
        + '<div class="wf-help" id="jn-note">If a part is late, the available results continue without it, marked PARTIAL. Leave blank for 10 minutes. Choose 1–120 minutes.</div></section>'
      : '';
    const loopHtml = isLoop
      ? '<section class="wf-sec"><h3><span class="n">LOOP</span>Where should finished work go?</h3>'
        + (loopExits.length
            ? '<div class="wf-chips loop-exits" id="loop-exits">' + loopExits.map(x => '<button type="button" class="bb sm loop-exit' + (x.dir === loopDoneCur ? ' active' : '') + '" data-dir="' + x.dir + '">' + esc(x.label) + '</button>').join('') + '</div>'
              + '<div class="wf-help" id="loop-back">' + esc(H.loopBackTxt(loopExits, loopDoneCur)) + '</div>'
            : '<div class="wf-warnline">Add two outgoing belts first: one to the next step and one back to an earlier BAY.</div>')
        + '</section><section class="wf-sec"><h3>Limit the number of attempts</h3>'
        + jnField('loop-max', 'MAX PASSES', 1, loopMaxCeil, 1, p.maxIter ? String(p.maxIter) : '', String(loopMaxDef))
        + '<p class="wf-help">A pass is one attempt. The line stops repeating when it reaches this limit.</p></section>'
        + '<section class="wf-sec"><h3>When should it stop repeating?</h3><p class="wf-help">Choose the reviewer’s verdict that lets work move on. Ask the reviewer to end with <b>VERDICT: approved</b> or <b>VERDICT: revise</b> — the REVIEWER starters already do.</p>'
        + '<div class="wf-chips loop-when-row">' + [['approved', 'APPROVED'], ['revise', 'REVISE']].map(([tag, lbl]) => '<button type="button" class="bb sm loop-when loop-verdict' + (p.when === tag ? ' sel' : '') + '" data-tag="' + tag + '">' + lbl + '</button>').join('') + '</div>'
        + '<details class="wf-more"' + (p.when && p.when !== 'approved' && p.when !== 'revise' ? ' open' : '') + '><summary>Repeat based on content instead</summary>'
        + '<p class="wf-help">Repeat while the result matches this type. Other results move on.</p><div class="wf-chips loop-when-row">'
        + [['code', 'CODE'], ['research', 'RESEARCH'], ['general', 'GENERAL']].map(([tag, lbl]) => '<button type="button" class="bb sm loop-when' + (p.when === tag ? ' sel' : '') + '" data-tag="' + tag + '">' + lbl + '</button>').join('')
        + '</div></details>'
        + '<div class="wf-help" id="loop-note">' + esc(H.loopRuleTxt(p.when, p.maxIter || loopMaxDef)) + ' Blank max = ' + loopMaxDef + '.</div></section>'
      : '';
    body.innerHTML = joinerHtml + loopHtml;
    const jnTimeout = $('#jn-timeout'), jnNote = $('#jn-note');
    const loopMax = $('#loop-max'), loopNote = $('#loop-note'), loopBackEl = $('#loop-back');
    const gate = { done: loopDoneCur, when: p.when || null };
    let gateSaved = JSON.stringify(isJoiner ? { timeoutMin: p.timeoutMin || null } : { maxIter: p.maxIter || null, done: p.done || null, when: p.when || null });
    const saveGate = () => {
      if (!prop(p.id) || typeof H.station().configureJunction !== 'function') return;
      const cfg = {};
      if (isJoiner) { const v = +String((jnTimeout && jnTimeout.value) || '').trim(); if (isFinite(v) && v >= 1) cfg.timeoutMin = Math.min(120, Math.floor(v)); }
      if (isLoop) {
        const v = +String((loopMax && loopMax.value) || '').trim(); if (isFinite(v) && v >= 1) cfg.maxIter = Math.min(loopMaxCeil, Math.floor(v));
        if (gate.done) cfg.done = gate.done;
        if (gate.when) cfg.when = gate.when;
      }
      const res = H.station().configureJunction(p.id, Object.keys(cfg).length ? cfg : null);
      if (!res || !res.ok) { H.sfx('bad'); return; }
      if (jnTimeout) jnTimeout.value = res.timeoutMin ? String(res.timeoutMin) : '';
      if (loopMax) loopMax.value = res.maxIter ? String(res.maxIter) : '';
      const next = JSON.stringify(isJoiner ? { timeoutMin: res.timeoutMin || null } : { maxIter: res.maxIter || null, done: res.done || null, when: res.when || null });
      if (next === gateSaved) return;
      gateSaved = next; H.sfx('click');
      const said = isJoiner
        ? (res.timeoutMin ? '✓ saved — waits ' + res.timeoutMin + ' min, then releases partial' : '✓ saved — station default (10 min), then releases partial')
        : '✓ saved — ' + H.loopRuleTxt(res.when, res.maxIter || loopMaxDef) + (res.done ? ' DONE on ' + res.done + '.' : '');
      if (isJoiner && jnNote) jnNote.textContent = said;
      if (isLoop && loopNote) loopNote.textContent = said;
      // THE WRONG DONE LANE IS A CYCLE: said HERE, on the field that caused it, with the lane that fixes it
      if (isLoop && loopNote && H.lineCycles()) {
        const onward = loopExits.find(x => x.dir !== (res.done || gate.done));
        loopNote.textContent = '⚠ with DONE on ' + (res.done || gate.done) + ' the line goes round with no way out — it is refused until DONE points onward' + (onward ? ' (' + onward.label + ')' : '');
      }
      H.flashTip(isJoiner ? 'joiner timeout saved' : 'loop gate saved', true);
    };
    el._saveGate = saveGate;
    for (const n of [jnTimeout, loopMax]) {
      if (!n) continue;
      n.addEventListener('blur', saveGate);
      n.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveGate(); } if (e.key === 'Escape') { e.stopPropagation(); n.blur(); } });
    }
    $$('.loop-exit').forEach(b => b.onclick = () => {
      gate.done = b.dataset.dir;
      $$('.loop-exit').forEach(x => x.classList.toggle('active', x.dataset.dir === gate.done));
      if (loopBackEl) loopBackEl.textContent = H.loopBackTxt(loopExits, gate.done);
      saveGate();
    });
    $$('.loop-when').forEach(b => b.onclick = () => {
      gate.when = (gate.when === b.dataset.tag) ? null : b.dataset.tag;   // click again to clear
      $$('.loop-when').forEach(x => x.classList.toggle('sel', x.dataset.tag === gate.when));
      saveGate();
    });
  }
  // OUTBOX / MERGER / SPLITTER — pure topology, explained (no settings to fill in)
  function paintPlain(body, f, p) {
    const TXT = {
      outbox: ['OUTBOX', 'Collect the finished work', 'The OUTBOX receives completed work. Leave build mode and click it to browse delivered work in the Logbook.' + (f && f.outbox.reached ? ' This line reaches it.' : ' Connect the last BAY to it with the BELT tool.')],
      merger: ['MERGER', 'Bring paths together', 'Connect several belts into one outgoing belt. Each task keeps going separately. This joins paths, not the contents of the tasks.'],
      splitter: ['SPLITTER', 'Send work down different paths', 'Connect one incoming belt to several outgoing belts. Tasks without an assigned agent are spread across those paths. Tasks already assigned to an agent follow that agent’s path. Feed a JOINER to run every path for the same job.'],
    }[p.t] || [String(p.t).toUpperCase(), 'Part of the line', 'Connections are made with the BELT tool.'];
    body.innerHTML = '<section class="wf-sec workflow-no-settings"><h3><span class="n">' + esc(TXT[0]) + '</span>' + esc(TXT[1]) + '</h3><p class="wf-help">' + esc(TXT[2]) + '</p>'
      + '<p class="wf-help dim">No extra settings needed — the belts you draw decide the paths.</p></section>';
  }

  /* ===== THE STEP TEST — the whole line, pausing at every handoff (STEPTEST contract) ===== */
  function stopPoll() { clearTimeout(S.pollTimer); S.pollTimer = 0; S.pollFor = null; }
  function poll() {
    stopPoll();
    if (S.session && typeof World !== 'undefined' && World.noteStepTest) World.noteStepTest(S.session);   // LINE WATCH: the bay lamps follow this session
    const s = S.session; if (!s || !WL().isLive(s) || s.state !== 'running') return;
    S.pollFor = s.id;
    S.pollTimer = setTimeout(() => {
      const id = S.pollFor;
      api('/api/routing/steptest/' + encodeURIComponent(id)).then(r => {
        if (!el || S.pollFor !== id) return;
        if (r.j && r.j.session) { S.session = r.j.session; S.sessionErr = null; if (S.session.state === 'paused') { S.handoff = null; S.handoffFor = null; H.sfx('chime'); } }
        else S.sessionErr = (r.j && r.j.error) || 'lost the session (HTTP ' + r.status + ')';
        paint(!typing()); poll();
      }).catch(() => { S.sessionErr = 'sidecar unreachable — the test may still be running'; paint(!typing()); S.pollTimer = setTimeout(poll, 2000); });
    }, 700);
  }
  /* (sweep 2026-09-25) THE FLOOR FIRST: the sidecar resolves a paused crate's next dock (and a re-run's brief) from the
     plan it HOLDS — a bay added or crewed in the panel reaches it only when the plan is posted. Every verb that walks
     the line flushes the plan first (as the brief rewrite always did): CONTINUE after "add a BAY" + crewing it used to
     end the test at the old plan's dead end. */
  function afterFlush(fn) {
    S.busy = true; paint(true);
    H.planGate(comp()).then(gate => {
      S.busy = false;
      if (gate && gate.refuse) { S.sessionErr = gate.refuse; H.sfx('bad'); paint(true); return; }
      fn();
    }, () => { S.busy = false; fn(); });
  }
  // re-read a paused session after the floor may have changed: the server re-previews the next dock on GET
  function refreshPaused() {
    const id = S.session && S.session.id; if (!id) return;
    H.planGate(comp()).then(() => api('/api/routing/steptest/' + encodeURIComponent(id))).then(r => {
      if (el && r && r.j && r.j.session && S.session && S.session.id === id) { S.session = r.j.session; paint(!typing()); }
    }).catch(() => {});
  }
  function sessionCall(verb, body) {
    const s = S.session; if (!s) return Promise.resolve();
    S.busy = true; paint(true);
    return api('/api/routing/steptest/' + encodeURIComponent(s.id) + '/' + verb, 'POST', body || {}).then(r => {
      if (r.j && r.j.session) { S.session = r.j.session; S.sessionErr = null; }
      else S.sessionErr = (r.j && r.j.error) || verb + ' refused (HTTP ' + r.status + ')';
    }).catch(() => { S.sessionErr = 'sidecar unreachable'; }).then(() => { S.busy = false; paint(true); poll(); });
  }
  function startSession(text, pause) {
    const c = comp(); if (!c) return;
    saveOpenFields();
    S.busy = true; S.sessionErr = null; S.hop = null; paint(true);
    H.planGate(c).then(gate => {
      if (gate && gate.refuse) throw new Error(gate.refuse);
      return api('/api/routing/steptest', 'POST', { line: c.key, text, pause });
    }).then(r => {
      if (!r.j || !r.j.ok || !r.j.session) throw new Error((r.j && r.j.error) || 'step test refused (HTTP ' + r.status + ')');
      S.session = r.j.session; S.testJob[S.lineKey] = text; saveTests();
    }).catch(e => { S.sessionErr = String((e && e.message) || e); H.sfx('bad'); })
      .then(() => { S.busy = false; paint(true); poll(); });
  }
  // the BAY a hop ran at: its own dockId (multi-bay), else the first bay the agent crews on this line (older sessions)
  function hopDock(f, h) { if (!f || !h) return null; if (h.dockId && f.docks[h.dockId]) return h.dockId; const pid = f.order.find(x => f.docks[x].agentId === h.agentId); return pid || null; }
  const nextDockOf = (f, nx) => !f || !nx || nx.kind !== 'agent' ? null : ((nx.dockId && f.docks[nx.dockId]) ? nx.dockId : f.order.find(x => f.docks[x].agentId === nx.agentId) || null);
  function paintTest(body, f) {
    const W = WL(), s = S.session && S.session.lineId === S.lineKey ? S.session : null;
    const live = s && W.isLive(s);
    const budget = s && s.limits ? '<div class="wf-budget"><span>$' + (+s.totalUsd || 0).toFixed(3) + '</span><span class="meter"><i style="width:' + Math.min(100, ((+s.totalUsd || 0) / (+s.limits.maxUsdPerMessage || 2)) * 100) + '%"></i></span><span class="dim">of $' + (+s.limits.maxUsdPerMessage || 2).toFixed(2) + ' line cap' + (+s.droppedUsd > 0 ? ' · includes $' + (+s.droppedUsd).toFixed(3) + ' from rewound steps' : '') + '</span></div>' : '';
    const log = s && s.hops && s.hops.length ? '<div class="wf-runlog" aria-label="Run log"><span class="lbl">RUN LOG</span>' + s.hops.map((h, i) => (i ? '<span class="arr">▸</span>' : '')
      + '<button type="button" class="wf-hop' + (S.hop === i ? ' sel' : '') + (h.edited ? ' edited' : '') + (h.verdict === 'revise' ? ' revise' : '') + '" data-hop="' + i + '">' + thumb(h.agentId, 16, 20, 'wf-ithumb') + esc(W.hopLabel(h, nameOf)) + '</button>').join('') + '</div>' : '';
    const err = S.sessionErr ? '<div class="wf-warnline">✕ ' + esc(S.sessionErr) + '</div>' : '';
    let main = '';
    if (S.hop != null && s && s.hops[S.hop]) main = hopDetailHTML(s, S.hop);
    else if (!s || !live) {
      const done = s && s.state === 'done', stopped = s && (s.state === 'stopped' || s.state === 'failed');
      const lastH = s && s.hops && s.hops[s.hops.length - 1];
      const shipped = done && !s.ended && typeof s.final === 'string';
      const meta = s ? '<div class="wf-meta"><span>total cost <b>$' + (+s.totalUsd || 0).toFixed(4) + '</b></span>' + (+s.droppedUsd > 0 ? '<span>incl. <b>$' + (+s.droppedUsd).toFixed(4) + '</b> from rewound steps</span>' : '')
        + '<span>' + s.hops.length + ' step run' + (s.hops.length === 1 ? '' : 's') + '</span><span>' + s.hops.filter(h => h.edited).length + ' edited by you</span></div>' : '';
      main = (shipped ? '<div class="wf-sec"><h3>✓ Reached the OUTBOX</h3><div class="wf-io out">' + esc(s.final) + '</div>' + meta + '</div>'
        : done ? '<div class="wf-sec"><h3>The line ended before the OUTBOX</h3><p class="wf-help">' + esc(s.ended || 'there was no next step') + '</p>'
          + (lastH ? '<div class="wf-from"><span>LAST OUTPUT · ' + esc(nameOf(lastH.agentId)) + '</span></div><div class="wf-io">' + esc(lastH.output || '') + '</div>' : '') + meta + '</div>' : '')
        + (stopped ? '<div class="wf-sec"><h3>' + (s.state === 'failed' ? 'Test failed' : 'Test stopped') + '</h3><p class="wf-help">' + esc(s.error || 'Stopped by you · nothing shipped.') + '</p>' + meta + '</div>' : '')
        + '<section class="wf-sec"><h3>' + (s ? 'Run it again' : 'Step-test the whole line') + '</h3>'
        + '<p class="wf-help">Your input runs through the real line and <b>pauses after each step</b>, showing the exact text handed to the next one. Edit it, re-run a step with a better brief, or add a BAY right there. A paused test holds no model connection and spends nothing.</p>'
        + '<textarea id="wf-st-in" data-keep="stin" class="wf-io" rows="4" aria-label="Test input" placeholder="What should the line work on?">' + esc(S.testJob[S.lineKey] || '') + '</textarea>'
        + '<div class="wf-chips" role="group" aria-label="When to pause"><button type="button" class="wf-chip" data-pause="every" aria-pressed="' + (S.pauseMode !== 'none') + '">PAUSE AT EVERY HANDOFF</button><button type="button" class="wf-chip" data-pause="none" aria-pressed="' + (S.pauseMode === 'none') + '">RUN TO THE END</button></div>'
        + '<div class="wf-row"><button type="button" class="bb sm refit-primary" id="wf-st-go"' + (S.busy ? ' disabled' : '') + '>▶ START STEP TEST</button></div></section>';
    } else if (s.state === 'running') {
      const who = s.running ? nameOf(s.running.agentId) : 'the line';
      main = '<section class="wf-sec"><h3><span class="wf-spin"></span>' + (s.running ? thumb(s.running.agentId, 16, 20, 'wf-ithumb') : '') + esc(who) + ' is working…</h3><p class="wf-help">A real run. It pauses when this step hands off.</p>'
        + '<div class="wf-row"><button type="button" class="bb sm" id="wf-st-stop">■ STOP</button></div></section>';
    } else if (s.state === 'paused') main = pausedHTML(s, f);
    body.innerHTML = '<section class="wf-sec wf-sthead"><h3><span class="n">STEP TEST</span>' + esc(lineName() || 'This line') + '</h3>' + budget + '</section>' + err + log + main;
    // wiring
    $$('[data-hop]').forEach(b => b.onclick = () => { S.hop = S.hop === +b.dataset.hop ? null : +b.dataset.hop; paint(true); });
    $$('[data-pause]').forEach(b => b.onclick = () => { S.pauseMode = b.dataset.pause; $$('[data-pause]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
    const go = $('#wf-st-go'); if (go) go.onclick = () => { const t = $('#wf-st-in').value.trim(); if (!t) { H.sfx('bad'); H.flashTip('give the test an input first', false); return; } H.sfx('click'); startSession(t, S.pauseMode === 'none' ? 'none' : 'every'); };
    const stp = $('#wf-st-stop'); if (stp) stp.onclick = () => sessionCall('stop');
    wirePaused(s, f);
    const back = $('#wf-hop-back'); if (back) back.onclick = () => { S.hop = null; paint(true); };
    const rew = $('#wf-hop-rewind'); if (rew) rew.onclick = () => { const i = S.hop; S.hop = null; H.sfx('click'); afterFlush(() => sessionCall('rewind', { hop: i })); };
  }
  function hopDetailHTML(s, i) {
    const h = s.hops[i];
    const canRewind = s.state === 'paused' || s.state === 'done' || s.state === 'stopped' || s.state === 'failed';
    return '<section class="wf-sec"><h3>' + esc(nameOf(h.agentId)) + (h.pass > 1 ? ' · pass ' + h.pass : '') + (h.rerun ? ' · re-run' : '') + '</h3>'
      + '<div class="wf-from"><span>WHAT IT GOT</span></div><div class="wf-io">' + esc(h.input || '') + '</div>'
      + (h.turn && h.turn !== h.input ? '<details class="wf-more"><summary>The exact turn it was sent (brief + handoff)</summary><div class="wf-io">' + esc(h.turn) + '</div></details>' : '')
      + (h.error ? '<div class="wf-warnline">✕ ' + esc(h.error) + '</div>' : '')
      + '<div class="wf-from"><span>WHAT IT REPLIED</span><span class="src">$' + (+h.usd || 0).toFixed(4) + ' · ' + (Array.isArray(h.tools) ? h.tools.length : (+h.tools || 0)) + ' tools</span></div><div class="wf-io out">' + esc(h.output || '') + '</div>'
      + (h.edited ? '<div class="wf-from"><span>WHAT YOU SENT ON</span><span class="wf-tag">EDITED BY YOU</span></div><div class="wf-io edited">' + esc(h.sent || '') + '</div>' : '')
      + '<div class="wf-row"><button type="button" class="bb sm" id="wf-hop-back">◂ BACK</button>' + (canRewind ? '<button type="button" class="bb sm refit-primary" id="wf-hop-rewind">↺ RE-RUN FROM ' + esc(nameOf(h.agentId)) + '</button>' : '') + '</div>'
      + '<p class="wf-help dim">Re-running from here keeps the earlier steps and their cost; everything after is run again.</p></section>';
  }
  function pausedHTML(s, f) {
    const W = WL(), h = s.hops[s.paused.afterHop], nx = W.pausedNext(s, nameOf) || { kind: 'end', label: 'the end' };
    const pid = hopDock(f, h), p = prop(pid) || {};
    if (S.handoffFor !== s.id + ':' + s.paused.afterHop + ':' + s.updatedAt) { S.handoffFor = s.id + ':' + s.paused.afterHop + ':' + s.updatedAt; S.handoff = s.paused.text; }
    const edited = S.handoff !== s.paused.text;
    const toOut = nx.kind === 'outbox';
    const nextPid = nextDockOf(f, nx);
    const v = (h.verdict ? '<div class="wf-verdict' + (h.verdict === 'revise' ? ' revise' : '') + '">VERDICT: ' + esc(h.verdict.toUpperCase()) + (nx.back ? ' — goes back for another pass' : '') + '</div>' : '')
      + (s.paused.next && s.paused.next.blocked ? '<div class="wf-warnline">⚠ Continuing will stop here: ' + esc(s.paused.next.blocked) + '</div>' : '');
    return '<section class="wf-sec"><h3>✓ ' + esc(nameOf(h.agentId)) + ' finished' + (h.pass > 1 ? ' (pass ' + h.pass + ')' : '') + '</h3>'
      + '<div class="wf-meta"><span>cost <b>$' + (+h.usd || 0).toFixed(4) + '</b></span><span>' + (Array.isArray(h.tools) ? h.tools.length : (+h.tools || 0)) + ' tool calls</span>' + (h.ms ? '<span>' + Math.round(h.ms / 1000) + 's</span>' : '') + '</div>' + v
      + '<div class="wf-from"><span>' + (toOut ? 'FINAL RESULT · WHAT SHIPS' : nx.kind === 'end' ? 'THE LINE ENDS HERE · ' + esc(nx.label) : 'EXACT TEXT ' + esc(nx.label) + ' WILL GET') + '</span><span class="wf-tag" id="wf-edtag"' + (edited ? '' : ' hidden') + '>EDITED BY YOU</span></div>'
      + '<textarea id="wf-handoff" class="wf-io' + (edited ? ' edited' : '') + '" rows="7" aria-label="Handoff text">' + esc(S.handoff) + '</textarea>'
      + '<div class="wf-row"><button type="button" class="bb sm" id="wf-restore"' + (edited ? '' : ' hidden') + '>UNDO MY EDIT</button></div>'
      + '<div class="wf-row"><button type="button" class="bb sm refit-primary' + (edited ? ' cyan' : '') + '" id="wf-cont"' + (S.busy ? ' disabled' : '') + '>' + (edited ? (toOut ? '▶ SHIP MY VERSION' : '▶ CONTINUE WITH MY EDIT') : (toOut ? '▶ SHIP IT' : '▶ CONTINUE')) + '</button>'
      + '<button type="button" class="bb sm" id="wf-rerun"' + (S.busy ? ' disabled' : '') + '>↻ RE-RUN STEP</button><button type="button" class="bb sm" id="wf-toend"' + (S.busy ? ' disabled' : '') + '>▶▶ RUN TO END</button><button type="button" class="bb sm" id="wf-st-stop2"' + (S.busy ? ' disabled' : '') + '>■ STOP</button></div>'
      + (pid ? '<details class="wf-more" id="wf-rebrief"><summary>Rewrite ' + esc((p.role || nameOf(h.agentId))) + '’s brief &amp; re-run</summary>'
        + '<textarea id="wf-rebrief-in" data-keep="rebrief:' + esc(pid) + '" class="wf-io" rows="4">' + esc(p.brief || '') + '</textarea>'
        + '<div class="wf-row"><button type="button" class="bb sm refit-primary" id="wf-rebrief-go">↻ SAVE BRIEF &amp; RE-RUN ' + esc(nameOf(h.agentId)) + '</button></div></details>' : '')
      + (pid && (nextPid || toOut) ? '<details class="wf-more" id="wf-addbay"><summary>Add a BAY before ' + esc(nextPid ? dockLabel(f, nextPid) : 'the OUTBOX') + '</summary>'
        + '<p class="wf-help">It is placed on the floor between ' + esc(dockLabel(f, pid)) + ' and ' + esc(nextPid ? dockLabel(f, nextPid) : nx.label) + ', and the paused work rides into it when you continue.</p>'
        + '<div class="wf-chips">' + ['REVIEWER', 'RESEARCHER', 'WRITER', 'GENERALIST'].map(r => '<button type="button" class="wf-chip" data-addbay="' + r + '">' + r + '</button>').join('') + '</div></details>' : '')
      + '</section>';
  }
  function wirePaused(s, f) {
    if (!s || s.state !== 'paused') return;
    const ta = $('#wf-handoff'); if (!ta) return;
    const tag = $('#wf-edtag'), rs = $('#wf-restore'), cont = $('#wf-cont');
    const nx = WL().pausedNext(s, nameOf) || {}, toOut = nx.kind === 'outbox';
    const sync = () => {
      S.handoff = ta.value;
      const ed = ta.value !== s.paused.text;
      tag.hidden = !ed; rs.hidden = !ed; ta.classList.toggle('edited', ed); cont.classList.toggle('cyan', ed);
      cont.textContent = ed ? (toOut ? '▶ SHIP MY VERSION' : '▶ CONTINUE WITH MY EDIT') : (toOut ? '▶ SHIP IT' : '▶ CONTINUE');
    };
    ta.addEventListener('input', sync);
    rs.onclick = () => { ta.value = s.paused.text; sync(); };
    cont.onclick = () => { H.sfx('click'); const ed = ta.value !== s.paused.text, text = ta.value; afterFlush(() => sessionCall('continue', ed ? { text } : {})); };
    $('#wf-rerun').onclick = () => { H.sfx('click'); afterFlush(() => sessionCall('rerun')); };
    $('#wf-toend').onclick = () => { H.sfx('click'); const ed = ta.value !== s.paused.text, text = ta.value;
      afterFlush(() => sessionCall('pause', { pause: 'none' }).then(() => { if (S.session && S.session.state === 'paused') sessionCall('continue', ed ? { text } : {}); })); };
    $('#wf-st-stop2').onclick = () => { H.sfx('click'); sessionCall('stop'); };
    const rb = $('#wf-rebrief-go');
    if (rb) rb.onclick = () => {
      const h = s.hops[s.paused.afterHop], pid = hopDock(f, h), v = $('#wf-rebrief-in').value;
      const res = H.station().setPropBrief(pid, v);
      if (!res || !res.ok) { H.sfx('bad'); return; }
      rb.disabled = true; S.busy = true;
      // the rerun reads the dock's CURRENT brief from the CURRENT plan: flush the plan post first
      H.planGate(comp()).then(gate => {
        S.busy = false;
        if (gate && gate.refuse) { S.sessionErr = gate.refuse; H.sfx('bad'); paint(true); return; }
        H.flashTip('brief saved · re-running ' + nameOf(h.agentId), true);
        sessionCall('rerun');
      });
    };
    $$('[data-addbay]').forEach(b => b.onclick = () => {
      const h = s.hops[s.paused.afterHop], from = hopDock(f, h);
      const to = nx.kind === 'agent' ? nextDockOf(f, nx) : f.outbox.propId;
      const res = insertStep(from, to, b.dataset.addbay);
      if (res && res.ok) {
        S.view = 'edit';   // the new BAY needs its agent: set it up, then ▶ STEP TEST · PAUSED returns here
        H.planGate(comp()).then(gate => { if (gate && gate.refuse) S.sessionErr = gate.refuse + ' — crew the new BAY, then continue'; paint(true); });
        H.flashTip('BAY added — pick its agent, then back in the STEP TEST, CONTINUE rides the work into it', true);
      }
    });
  }

  return { open, close, isOpen, refresh, select, selectFromFloor, _state: S, _flow: () => flow() };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WorkflowPanel;
