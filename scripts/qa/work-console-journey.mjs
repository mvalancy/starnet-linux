#!/usr/bin/env node
/* scripts/qa/work-console-journey.mjs — WORK-area DOM→dispatch journey corps (standalone).
 *
 * WHY THIS EXISTS
 * The Truth Auditor + the corps journeys (scripts/qa/journeys.mjs) already guard the TASK BOARD
 * lifecycle (J1) and the deliverable OPEN contract (J4). Three WORK-area button→dispatch SEAMS were
 * live-audited but had NO machine assertion, so their atlas entries were pinned at `audited` (EL-3
 * coverage gap) rather than `perfected`:
 *   (46cab512) TASK BOARD empty-state ▸ OUTBOX footnote — a render-condition + openTerm('outbox')
 *              click with no assertion (routes/store were tested, this seam was not).
 *   (7e02c493) ROUTINES console button→cron-route dispatch — the routes (cron.api/arm/run-now) are
 *              unit/e2e tested, but no journey drove the real console buttons through to /api/cron.
 *   (72f74d2c) RECIPES marketplace button→dispatch/filter — the store primitives (recipes.test.js)
 *              are unit-tested, but no journey drove the real .mkt overlay filter + LAUNCH→RUN NOW.
 *
 * This file closes all three by driving the REAL DOM against a SEEDED sidecar and asserting the
 * OBSERVABLE truth on both sides of each seam (the DOM the human sees AND the authoritative store /
 * GET /api/cron / Workstreams globals). It is the same class of coverage the project already accepts
 * as `perfected` evidence for the shared window-chrome entries (scripts/qa/terminal-resize-journey.mjs).
 *
 * LAWS (Charter Part 5 + StarNet task doctrine):
 *   - ZERO PAID CALLS: the only provider is a local quick-mock (streams a canned reply). A RECIPES
 *     RUN NOW dispatches a real kind:'task' workstream; its run completes against the mock.
 *   - NO-FAKE-GREEN: a setup that cannot run exits BLOCKED (2), never a silent pass.
 *   - Asserts DOM/store TRUTH, never a mutated fixture read back to itself.
 *   - Ports (Charter §8): standalone journeys use the 8960s lane; defaults 8968 / CDP 9368.
 *
 * Usage:
 *   node scripts/qa/work-console-journey.mjs
 *   SKYNET_WORK_PORT=8968 SKYNET_WORK_CDP=9368 node scripts/qa/work-console-journey.mjs
 *   node scripts/qa/work-console-journey.mjs --keep   # keep the scratch workspace + browser profile
 *
 * Exit code: 0 all blocks green · 3 a hard assertion failed · 2 BLOCKED (could not run).
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from '../lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from '../lib/seed.mjs';

const PORT = process.env.SKYNET_WORK_PORT || '8968';
const CDP_PORT = Number(process.env.SKYNET_WORK_CDP || 9368);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const OUT_DIR = process.env.SKYNET_WORK_DIR || join(process.cwd(), '.uijourneys-work');
const WIN = process.env.SKYNET_SHOT_SIZE || '1440,900';
const KEEP = process.argv.includes('--keep');
const SCRATCH = join(OUT_DIR, '_seed-workspace');
const PROFILE = join(OUT_DIR, '_profile');
const J = (v) => JSON.stringify(v);

/* ── minimal quick-mock provider (zero paid): a canned streamed reply so a RUN NOW completes ── */
function startQuickMock(model) {
  return new Promise((resolve) => {
    const state = { calls: 0 };
    const server = createServer((req, res) => {
      if (req.url && req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: model || DEFAULT_MODEL, name: 'Work Journey Mock', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url && req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => {
          state.calls++;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'working' } }] }) + '\n\n');
          setTimeout(() => {
            try {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ' done' } }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
              res.write('data: [DONE]\n\n'); res.end();
            } catch (_) {}
          }, 300);
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port + '/api/v1', callCount: () => state.calls }));
  });
}

/* ── asserter (mirrors journeys.mjs) ── */
function makeAsserter() {
  const results = [];
  const ok = (name, pass, detail) => {
    results.push({ name, pass: !!pass, detail: detail || '' });
    console.log(`    ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    return !!pass;
  };
  return { ok, results };
}

/* ── CDP driving helpers ── */
const clickSel = (cdp, sel) => evalJS(cdp, `(() => { const el = document.querySelector(${J(sel)}); if (!el) return 'NOTFOUND'; el.click(); return 'clicked'; })()`).catch((e) => 'ERR:' + e.message);
async function waitSel(cdp, sel, tries = 40) {
  for (let i = 0; i < tries; i++) { if (await evalJS(cdp, `!!document.querySelector(${J(sel)})`).catch(() => false)) return true; await sleep(150); }
  return false;
}
async function waitFor(cdp, expr, tries = 50) {
  for (let i = 0; i < tries; i++) { if (await evalJS(cdp, expr).catch(() => false)) return true; await sleep(150); }
  return false;
}
const closeAllTerms = (cdp) => evalJS(cdp, `(() => { document.querySelectorAll('.term .term-x').forEach(b => { try { b.click(); } catch(_){} }); const ov = document.querySelector('.mkt-close, .mkt-x'); if (ov) { try { ov.click(); } catch(_){} } return true; })()`).catch(() => {});

/* ═══════════════════════════ JW-OUTBOX — task-board empty-state OUTBOX footnote (46cab512) ═══════════════════════════
 * The footnote is rendered ONLY when the board is empty (stationui.js buildTasks: `streams.length ? '' : …`)
 * and clicking it runs openTerm('outbox'). Assert BOTH halves of the render condition plus the click seam:
 *   - empty board → #kb-outbox-link present with the "▸ OUTBOX" label,
 *   - click → the OUTBOX — FINISHED WORK window opens (openTerm('outbox') fired),
 *   - add ONE task → the footnote disappears (the condition flips the instant the board is non-empty).  */
async function journeyOutboxFootnote(cdp, A) {
  await closeAllTerms(cdp);
  // force an EMPTY board deterministically (the scratch seed is thrown away on teardown): archive every
  // kind:'task' workstream so boardStreams() is empty and the footnote's render condition is satisfied.
  const emptied = await evalJS(cdp, `(() => {
    if (typeof Workstreams === 'undefined') return 'NO_WS';
    const gid = Workstreams.generalId();
    const tasks = Workstreams.list().filter(w => w.id !== gid && w.kind === 'task');
    tasks.forEach(w => Workstreams.archive(w.id, true));
    if (typeof App !== 'undefined' && App.persist) App.persist();
    return Workstreams.list().filter(w => w.id !== gid && w.kind === 'task').length;
  })()`).catch((e) => 'ERR:' + e.message);
  A.ok('JW-outbox/board-emptied', emptied === 0, 'remaining task streams = ' + emptied);

  await clickSel(cdp, '[data-term="tasks"]');
  const boardOpen = await waitSel(cdp, '.kb-cols', 40);
  A.ok('JW-outbox/board-open', boardOpen, boardOpen ? 'TASK BOARD open (.kb-cols present)' : 'board never opened');

  const empty = await evalJS(cdp, `(() => {
    const cards = document.querySelectorAll('.kb-card').length;
    const link = document.querySelector('#kb-outbox-link');
    return { cards, linkPresent: !!link, linkText: link ? link.textContent.trim() : '' };
  })()`).catch(() => ({ cards: -1, linkPresent: false, linkText: '' }));
  A.ok('JW-outbox/empty-board-no-cards', empty.cards === 0, 'kb-card count = ' + empty.cards);
  A.ok('JW-outbox/footnote-present-when-empty', empty.linkPresent && /OUTBOX/.test(empty.linkText), 'kb-outbox-link text = ' + J(empty.linkText));

  // click the footnote → the OUTBOX window must open (openTerm('outbox') → "OUTBOX — FINISHED WORK").
  const clicked = await clickSel(cdp, '#kb-outbox-link');
  A.ok('JW-outbox/footnote-clickable', clicked === 'clicked', 'click → ' + clicked);
  const outboxOpen = await waitFor(cdp, `Array.from(document.querySelectorAll('.term')).some(t => /OUTBOX/.test(t.textContent) && /FINISHED WORK/i.test(t.textContent))`, 40);
  A.ok('JW-outbox/click-opens-outbox', outboxOpen, outboxOpen ? 'OUTBOX — FINISHED WORK window opened' : 'no OUTBOX window after click');

  // add ONE task through the real board input → the footnote must vanish (render condition flips).
  await closeAllTerms(cdp);
  await clickSel(cdp, '[data-term="tasks"]');
  await waitSel(cdp, '.kb-cols', 40);
  const added = await evalJS(cdp, `(() => {
    const inp = document.querySelector('#kb-in'); if (!inp) return 'NO_INPUT';
    const before = Workstreams.list().filter(w => w.kind === 'task').length;
    inp.value = 'JW footnote guard task';
    const add = document.querySelector('#kb-add'); if (!add) return 'NO_ADD';
    add.click();
    return before;
  })()`).catch((e) => 'ERR:' + e.message);
  const nowState = await waitFor(cdp, `(() => { const t = Workstreams.list().filter(w => w.kind === 'task').length; return t >= 1 && !document.querySelector('#kb-outbox-link'); })()`, 40);
  const post = await evalJS(cdp, `(() => ({ tasks: Workstreams.list().filter(w => w.kind === 'task').length, footnote: !!document.querySelector('#kb-outbox-link'), cards: document.querySelectorAll('.kb-card').length }))()`).catch(() => ({}));
  A.ok('JW-outbox/add-creates-task', typeof added === 'number' && post.tasks >= 1 && post.cards >= 1, 'task store now ' + post.tasks + ', cards ' + post.cards);
  A.ok('JW-outbox/footnote-hidden-when-nonempty', nowState && post.footnote === false, 'kb-outbox-link present with a card? ' + post.footnote);

  // cleanup: archive the guard task + close the board so the next block starts on a tidy floor.
  await evalJS(cdp, `(() => { const gid = Workstreams.generalId(); Workstreams.list().filter(w => w.id !== gid && w.kind === 'task').forEach(w => Workstreams.archive(w.id, true)); if (typeof App !== 'undefined' && App.persist) App.persist(); return true; })()`).catch(() => {});
  await closeAllTerms(cdp);
}

/* ═══════════════════════════ JW-ROUTINES — console button→cron-route dispatch (7e02c493) ═══════════════════════════
 * Drive the REAL ROUTINES console buttons and assert the authoritative GET /api/cron changes each seam claims:
 *   create-tab → server-math PREVIEW (#rt-preview) → #rt-add (POST /api/cron, count +1) →
 *   active-tab list row → #rt-arm (POST /api/cron/arm, enabled false→true) → DELETE two-step (POST
 *   /api/cron/remove, count back to baseline). Every displayed state is read back from GET /api/cron.  */
async function journeyRoutines(cdp, A) {
  await closeAllTerms(cdp);
  const NAME = 'JW Routine ' + Date.now();
  const PROMPT = 'summarize the top three AI-policy headlines';
  const cron = (path, method, payload) => evalJS(cdp, `(async () => {
    try { const r = await fetch(${J(path)}, ${method === 'GET' ? '{ cache: "no-store" }' : `{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${J(payload || {})}) }`}); return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) }; } catch (e) { return { ok: false, error: String(e) }; }
  })()`).catch((e) => ({ ok: false, error: String(e) }));

  const base = await cron('/api/cron', 'GET');
  const baseCount = base && base.json && Array.isArray(base.json.jobs) ? base.json.jobs.length : -1;
  A.ok('JW-routines/api-cron-readable', baseCount >= 0, 'GET /api/cron baseline jobs = ' + baseCount);

  await evalJS(cdp, `(typeof StationUI !== 'undefined' && StationUI.openTerm) ? StationUI.openTerm('routines') : null`).catch(() => {});
  // NAV CONDENSE (2026-08-04): ROUTINES is a lane of the AUTOMATION console, so its tab ids carry the
  // console key — con-tab-automation-<section>. The pre-condense id this waited on ('#con-tab-routines-
  // create') stopped existing then, and because mountConsole mounts every pane up-front, every LATER
  // step still passed against the hidden pane — the journey ran 25/26 for a week and the one FAIL read
  // as "window never opened" when the window was open the whole time.
  const winOpen = await waitSel(cdp, '#con-tab-automation-routines-create', 40);
  A.ok('JW-routines/window-open', winOpen, winOpen ? 'ROUTINES console open (create/active tabs present)' : 'ROUTINES window never opened');

  // CREATE tab: reveal the create pane, then drive the server-math preview.
  await clickSel(cdp, '#con-tab-automation-routines-create');
  await waitSel(cdp, '#rt-sched', 40);
  const preview = await evalJS(cdp, `(() => {
    const s = document.querySelector('#rt-sched'); if (!s) return 'NO_SCHED';
    s.value = 'every 30m'; s.dispatchEvent(new Event('input', { bubbles: true })); return 'typed';
  })()`).catch((e) => 'ERR:' + e.message);
  const previewShown = await waitFor(cdp, `(() => { const p = document.querySelector('#rt-preview'); return !!p && !!p.querySelector('.rt-next-label') && /Next run/.test(p.textContent) && /in 30m/.test(p.textContent); })()`, 40);
  const previewText = await evalJS(cdp, `(document.querySelector('#rt-preview') || {}).textContent || ''`).catch(() => '');
  A.ok('JW-routines/preview-server-math', preview === 'typed' && previewShown, 'rt-preview = ' + J(String(previewText).slice(0, 90)));

  // fill name/prompt + ADD → POST /api/cron; the authoritative count must go +1.
  const filled = await evalJS(cdp, `(() => {
    const nm = document.querySelector('#rt-name'), pr = document.querySelector('#rt-prompt');
    if (!nm || !pr) return 'NO_FIELDS';
    nm.value = ${J(NAME)}; pr.value = ${J(PROMPT)};
    const add = document.querySelector('#rt-add'); if (!add) return 'NO_ADD'; add.click(); return 'added';
  })()`).catch((e) => 'ERR:' + e.message);
  const grew = await waitFor(cdp, `(async () => { try { const r = await fetch('/api/cron', { cache: 'no-store' }); const j = await r.json(); return (j.jobs || []).some(x => x && x.name === ${J(NAME)}); } catch (_) { return false; } })()`, 40);
  const afterAdd = await cron('/api/cron', 'GET');
  const job = afterAdd && afterAdd.json && (afterAdd.json.jobs || []).find(x => x && x.name === NAME);
  A.ok('JW-routines/add-posts-cron', filled === 'added' && grew && !!job, 'jobs now ' + ((afterAdd.json && afterAdd.json.jobs || []).length) + ', created id = ' + (job && job.id));
  A.ok('JW-routines/name+prompt-stored', !!job && job.name === NAME && job.prompt === PROMPT, 'stored name=' + J(job && job.name) + ' prompt=' + J(job && job.prompt));
  A.ok('JW-routines/schedule-server-parsed', !!job && job.schedule && job.schedule.kind === 'interval' && Number(job.schedule.minutes) === 30, 'parsed schedule = ' + J(job && job.schedule));
  // honest "saved but won't fire yet": the SCHEDULER (top-level GET /api/cron `.enabled`, the live cronArmed) is
  // still disarmed right after creation — the create-confirm tells that truth until ENABLE SCHEDULING is clicked.
  A.ok('JW-routines/scheduler-off-until-armed', afterAdd.json && afterAdd.json.enabled === false, 'scheduler enabled (cronArmed) = ' + (afterAdd.json && afterAdd.json.enabled) + ' at create time');
  const jobId = job && job.id;

  // ACTIVE tab: the row must render from GET /api/cron with the name + cadence + RUN/DISABLE/DELETE actions.
  await clickSel(cdp, '#con-tab-routines-active');
  const rowShown = await waitSel(cdp, `.mc-row[data-id="${jobId}"]`, 40);
  const rowInfo = await evalJS(cdp, `(() => {
    const r = document.querySelector('.mc-row[data-id="${jobId}"]'); if (!r) return { present: false };
    return { present: true, text: r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160), run: !!r.querySelector('button[data-act="run"]'), toggle: !!r.querySelector('button[data-act="toggle"]'), remove: !!r.querySelector('button[data-act="remove"]') };
  })()`).catch(() => ({ present: false }));
  A.ok('JW-routines/active-list-row', rowShown && rowInfo.present && rowInfo.run && rowInfo.toggle && rowInfo.remove, 'row = ' + J(rowInfo));

  // ARM: click ENABLE SCHEDULING → POST /api/cron/arm → GET /api/cron enabled false→true.
  const armClicked = await clickSel(cdp, '#rt-arm');
  const armed = await waitFor(cdp, `(async () => { try { const r = await fetch('/api/cron', { cache: 'no-store' }); const j = await r.json(); return j.enabled === true; } catch (_) { return false; } })()`, 40);
  const armState = await cron('/api/cron', 'GET');
  A.ok('JW-routines/arm-flips-enabled', armClicked === 'clicked' && armed && armState.json && armState.json.enabled === true, 'GET /api/cron enabled = ' + (armState.json && armState.json.enabled));
  const armLabelFlips = await waitFor(cdp, `(() => { const b = document.querySelector('#rt-arm'); return !!b && b.dataset.arm === '0' && /DISABLE/i.test(b.textContent); })()`, 40);
  A.ok('JW-routines/arm-label-authoritative', armLabelFlips, 'rt-arm now reads DISABLE (data-arm=0) from the authoritative read');

  // DELETE (two-step DOM): click DELETE → CONFIRM → POST /api/cron/remove → count back to baseline.
  await clickSel(cdp, `.mc-row[data-id="${jobId}"] button[data-act="remove"]`);
  await sleep(200);
  await clickSel(cdp, `.mc-row[data-id="${jobId}"] button[data-act="remove"]`);   // second click = CONFIRM
  const removed = await waitFor(cdp, `(async () => { try { const r = await fetch('/api/cron', { cache: 'no-store' }); const j = await r.json(); return !(j.jobs || []).some(x => x && x.id === ${J(jobId)}); } catch (_) { return false; } })()`, 40);
  const afterRemove = await cron('/api/cron', 'GET');
  const finalCount = afterRemove && afterRemove.json && Array.isArray(afterRemove.json.jobs) ? afterRemove.json.jobs.length : -1;
  A.ok('JW-routines/delete-removes-cron', removed && finalCount === baseCount, 'jobs back to ' + finalCount + ' (baseline ' + baseCount + ')');

  // tidy the floor: disarm scheduling again (the created job is gone; leave the scheduler as we found it).
  await cron('/api/cron/arm', 'POST', { enabled: false });
  await closeAllTerms(cdp);
}

/* ═══════════════════════════ JW-RECIPES — marketplace button→dispatch/filter (72f74d2c) ═══════════════════════════
 * Drive the REAL .mkt overlay: render contract (cards === store), category FILTER (developer count from the
 * real store === visible grid), and LAUNCH: SET UP & LAUNCH → RUN NOW dispatches a real kind:'task' workstream
 * titled after the recipe. Zero paid calls — the RUN NOW run completes against the local quick-mock.  */
async function journeyRecipes(cdp, A) {
  await closeAllTerms(cdp);
  // ensure the agent is idle (launchRecipe no-ops while a run is in flight); the mock completes fast.
  await waitFor(cdp, `!(typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy())`, 40);

  const open = await clickSel(cdp, '#bb-missions');
  const gridOpen = await waitSel(cdp, '.mkt-card', 40);
  A.ok('JW-recipes/overlay-open', open === 'clicked' && gridOpen, gridOpen ? '.mkt overlay open (.mkt-card present)' : 'marketplace overlay never opened');

  // RENDER CONTRACT: DOM card count === the real store (builtins + customs), every card carries data-id.
  const render = await evalJS(cdp, `(() => {
    const cards = Array.from(document.querySelectorAll('.mkt-card'));
    const withId = cards.filter(c => c.dataset.id).length;
    const store = (typeof Recipes !== 'undefined') ? (Recipes.builtins().length + Recipes.customs().length) : -1;
    return { cards: cards.length, withId, store };
  })()`).catch(() => ({ cards: -1, withId: -1, store: -2 }));
  A.ok('JW-recipes/render-contract', render.cards > 0 && render.cards === render.store && render.withId === render.cards, 'cards=' + render.cards + ' store=' + render.store + ' withId=' + render.withId);

  // CATEGORY FILTER: click DEVELOPER → the visible grid count must equal the store-derived label count (>0);
  // click ALL → grid count === all label count === builtins+customs. The label count is computed from the store.
  await clickSel(cdp, '.mkt-lane[data-cat="developer"]');
  await sleep(300);
  const dev = await evalJS(cdp, `(() => {
    const btn = document.querySelector('.mkt-lane[data-cat="developer"]');
    const label = btn ? parseInt((btn.querySelector('.ct') || {}).textContent || '0', 10) : -1;
    const grid = document.querySelectorAll('.mkt-card').length;
    return { label, grid };
  })()`).catch(() => ({ label: -1, grid: -1 }));
  A.ok('JW-recipes/filter-developer', dev.label > 0 && dev.grid === dev.label, 'DEVELOPER label=' + dev.label + ' visible grid=' + dev.grid);

  await clickSel(cdp, '.mkt-lane[data-cat="all"]');
  await sleep(300);
  const all = await evalJS(cdp, `(() => {
    const btn = document.querySelector('.mkt-lane[data-cat="all"]');
    const label = btn ? parseInt((btn.querySelector('.ct') || {}).textContent || '0', 10) : -1;
    const grid = document.querySelectorAll('.mkt-card').length;
    const store = (typeof Recipes !== 'undefined') ? (Recipes.builtins().length + Recipes.customs().length) : -1;
    return { label, grid, store };
  })()`).catch(() => ({ label: -1, grid: -1, store: -2 }));
  A.ok('JW-recipes/filter-all', all.label === all.store && all.grid === all.store && all.store > dev.label, 'ALL label=' + all.label + ' grid=' + all.grid + ' store=' + all.store + ' (> developer ' + dev.label + ')');

  // LAUNCH SEAM: pick a recipe (morning-brief if present, else the first card), SET UP & LAUNCH, fill params,
  // RUN NOW → launchRecipe mints a kind:'task' workstream titled after the recipe.
  const pick = await evalJS(cdp, `(() => {
    const want = document.querySelector('.mkt-card[data-id="morning-brief"]');
    const card = want || document.querySelector('.mkt-card');
    if (!card) return null;
    const id = card.dataset.id; card.click();
    const rec = (typeof Recipes !== 'undefined' && Recipes.get) ? Recipes.get(id) : null;
    return { id, name: rec ? rec.name : '' };
  })()`).catch(() => null);
  A.ok('JW-recipes/card-selected', pick && pick.id && pick.name, 'selected recipe id=' + (pick && pick.id) + ' name=' + J(pick && pick.name));
  if (!pick || !pick.name) return;

  // Recipe details now contain the launch form directly; no intermediary launch button.
  const formShown = await waitSel(cdp, '.mkt-do-launch', 40);
  A.ok('JW-recipes/setup-launch-opens-form', formShown, formShown ? 'inline START SESSION form shown' : 'recipe selection did not reveal its run form');

  const taskBefore = await evalJS(cdp, `(typeof Workstreams !== 'undefined') ? Workstreams.list().filter(w => w.kind === 'task').map(w => w.id) : []`).catch(() => []);
  const filled = await evalJS(cdp, `(() => {
    const ins = Array.from(document.querySelectorAll('.mkt-p-in'));
    ins.forEach(i => { i.value = 'journey test input'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    const go = document.querySelector('.mkt-do-launch'); if (!go) return 'NO_RUN'; go.click(); return 'ran:' + ins.length;
  })()`).catch((e) => 'ERR:' + e.message);
  // launchRecipe creates the workstream SYNCHRONOUSLY on RUN NOW (before the model answers) — assert it appears.
  const created = await waitFor(cdp, `(() => {
    if (typeof Workstreams === 'undefined') return false;
    const before = ${J(taskBefore)};
    return Workstreams.list().some(w => w.kind === 'task' && before.indexOf(w.id) < 0 && w.title === ${J(pick.name)});
  })()`, 40);
  const newTask = await evalJS(cdp, `(() => {
    const before = ${J(taskBefore)};
    const w = Workstreams.list().find(x => x.kind === 'task' && before.indexOf(x.id) < 0 && x.title === ${J(pick.name)});
    return w ? { id: w.id, title: w.title, kind: w.kind } : null;
  })()`).catch(() => null);
  A.ok('JW-recipes/run-now-dispatches-task', String(filled).indexOf('ran:') === 0 && created && newTask && newTask.kind === 'task', 'new kind:task workstream = ' + J(newTask) + ' (fill=' + filled + ')');

  // cleanup: archive the launched task + close the overlay for a tidy exit.
  await evalJS(cdp, `(() => { const gid = Workstreams.generalId(); Workstreams.list().filter(w => w.id !== gid && w.kind === 'task').forEach(w => Workstreams.archive(w.id, true)); if (typeof App !== 'undefined' && App.persist) App.persist(); return true; })()`).catch(() => {});
  await closeAllTerms(cdp);
}

/* ═══════════════════════════ orchestration ═══════════════════════════ */
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let mock = null, sidecar = null, proc = null, cdp = null;
  const blocks = [];
  const finish = (code) => {
    const all = blocks.flatMap(b => b.results);
    const passed = all.filter(r => r.pass).length;
    try { cdp?.ws.close(); } catch (_) {}
    try { proc && proc.kill('SIGKILL'); } catch (_) {}
    try { sidecar && sidecar.kill('SIGKILL'); } catch (_) {}
    try { mock && mock.server && mock.server.close(); } catch (_) {}
    if (!KEEP) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) {} try { rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {} }
    const verdict = code === 0 ? 'WORK-CONSOLE JOURNEY PASS' : code === 2 ? 'WORK-CONSOLE JOURNEY BLOCKED' : 'WORK-CONSOLE JOURNEY FAIL (exit ' + code + ')';
    try { writeFileSync(join(OUT_DIR, 'work-console-report.json'), JSON.stringify({ url: APP_URL, ranAt: new Date().toISOString(), passed, total: all.length, blocks }, null, 2)); } catch (_) {}
    console.log(`\n${verdict} — ${passed}/${all.length} assertions passed → ${OUT_DIR}`);
    process.exit(code);
  };

  try {
    if (await isUp(APP_URL)) { console.error(`BLOCKED: work-journey port :${PORT} already has a server; set SKYNET_WORK_PORT to a free port`); return finish(2); }
    mock = await startQuickMock(DEFAULT_MODEL);
    process.env.SKYNET_OPENROUTER_BASE = mock.base;
    process.env.STARNET_OPENROUTER_BASE = mock.base;
    console.log(`provider: quick-mock on ${mock.base}`);
    console.log(`sidecar: booting SEEDED SKYNET_DEV on :${PORT} (model=${DEFAULT_MODEL}) ...`);
    materializeSeedWorkspace(SCRATCH);
    sidecar = bootSeededSidecar({ port: PORT, scratchDir: SCRATCH });
    if (!(await waitUp(APP_URL))) { console.error('BLOCKED: seeded sidecar failed to come up on :' + PORT); return finish(2); }
    console.log('sidecar: ready');
  } catch (e) {
    console.error('BLOCKED: setup threw — ' + (e && e.stack || e));
    return finish(2);
  }

  const { proc: chromeProc } = launchChrome({ cdpPort: CDP_PORT, win: WIN, profileDir: PROFILE });
  proc = chromeProc;
  proc.on('error', (e) => { console.error('chrome spawn error', e); });

  let diag;
  try {
    cdp = await connectCDP(CDP_PORT);
    diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP_URL });
    const floorReady = await waitDevReady(cdp, evalJS, { tries: 40, url: APP_URL });
    const testReady = floorReady && await (async () => { for (let i = 0; i < 24; i++) { if (await evalJS(cdp, "typeof Workstreams === 'object' && typeof StationUI === 'object'").catch(() => false)) return true; await sleep(1000); } return false; })();
    if (!testReady) {
      console.error('BLOCKED: never reached in-game (floor + globals).');
      try { await capture(cdp, OUT_DIR, '_BLOCKED-not-in-game'); } catch (_) {}
      return finish(2);
    }
    console.log('floor ready\n');

    const BLOCKS = [
      { id: 'JW-OUTBOX', name: 'task-board empty-state OUTBOX footnote (46cab512)', fn: journeyOutboxFootnote },
      { id: 'JW-ROUTINES', name: 'routines console → cron-route dispatch (7e02c493)', fn: journeyRoutines },
      { id: 'JW-RECIPES', name: 'recipes marketplace filter + LAUNCH→RUN NOW (72f74d2c)', fn: journeyRecipes },
    ];
    let exitCode = 0;
    for (const b of BLOCKS) {
      console.log(`journey ${b.id}: ${b.name}`);
      const A = makeAsserter();
      try { await b.fn(cdp, A); }
      catch (e) { A.ok(`${b.id}/ran`, false, 'threw: ' + (e && e.message || e)); }
      const hardFail = A.results.some(r => !r.pass);
      try { await capture(cdp, OUT_DIR, hardFail ? `_FAIL-${b.id}` : b.id); } catch (_) {}
      blocks.push({ id: b.id, name: b.name, passed: !hardFail, results: A.results });
      if (hardFail) exitCode = 3;
      await closeAllTerms(cdp);
      await sleep(300);
      console.log('');
    }
    if (diag.exceptions.length) { console.log(`uncaught exceptions during journeys: ${diag.exceptions.length}`); diag.exceptions.slice(0, 8).forEach(e => console.log('  ' + e)); }
    return finish(exitCode);
  } catch (e) {
    console.error('BLOCKED: journey driver threw — ' + (e && e.stack || e));
    return finish(2);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
