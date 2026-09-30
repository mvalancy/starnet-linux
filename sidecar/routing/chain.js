/* sidecar/routing/chain.js — the AGENTIC GRAPH executor: run the pipeline the Commander DREW.

   The router answers "which agent runs this message?" (one dock). This answers the other half: "and then
   what?" — a dock's output is the next dock's input, hop by hop along the belts, until the line ships out.
   A floor drawn INTAKE -> researcher -> writer -> OUTBOX now runs BOTH agents, and the reply that leaves the
   station is the writer's. Before this, everything downstream of the first dock was scenery.

   PURE ORCHESTRATION — it owns policy and telemetry, never provider/loop internals. Two injected seams:
     nextAgent(agentId, { tag })              -> the downstream agentId, or null (terminal stage)
     runAgent({ agentId, text, hop, from, signal }) -> { text, usd?, error? }
   so it tests headlessly with a fake harness and the hub keeps owning transcripts/consent/media.

   LAWS (each one is a bug this file exists to not have):
   • A CHAIN NEVER GATES THE REPLY. Any stop — hop cap, spend cap, a failed stage, an empty stage, E-STOP —
     delivers the LAST GOOD output with an honest note saying where the line stopped. The belt is never a gate
     (the same law that says work runs with no belts laid); a broken stage 3 must not swallow stage 2's answer.
   • ONE CRATE, ONE RUN. nextAgent returns a single downstream agent, never a fan-out — K crates in, K crates
     out, or the floor is lying about what it charged you for.
   • NEVER RUN A DOCK TWICE IN ONE CHAIN (was "an agent" until multi-bay agents, 2026-09-22 — Andrew's ruling:
     one agent may crew several bays, so writer@A → editor@B → writer@C is a straight line of three DOCKS).
     CHAIN_CYCLE refuses looping floors at compile time, but the plan can be re-posted MID-CHAIN; the visited set
     — keyed by dock — is what makes an infinite paid loop impossible rather than unlikely. The hop ceiling and
     the $ ceilings still bound every line's spend exactly as before.
   • EVERY HOP IS A CRATE. workitem.placed/delivered per hop, so the floor shows the handoff it is really doing
     (additive use of the frozen contract — kind:'chain').
   • WORK BELONGS TO A LINE (2026-08-07, Andrew's ruling). The seed carries the `lineId` the work ENTERED on
     (its line's own trigger: the INBOX it arrived at, the routine that fired, the sample dispatched for it).
     It rides into every nextAgent() call, where Pipeline.chainNext refuses to advance a dock whose line the
     run does not belong to. A seed with no lineId — a direct order — advances nothing and spends nothing.
     This module holds no policy of its own here: it TRANSPORTS the origin, the compiled plan decides. */
'use strict';
const Pipeline = require('../../frontend/app/pipeline.js');
const { note: failNote } = require('../failopen.js');   // tagged fail-open: a swallowed ledger/barrier error stays visible
const Verdict = require('./verdict.js');   // the VERDICT channel (pure parser + reviewer brief)

// the DEFAULT ceilings — a line that sets no LINE BUDGET runs under exactly these. They are the one
// normalizer's defaults (Pipeline.LINE_LIMIT_DEFAULTS) so the compiler and the executor can never disagree.
const MAX_HOPS = Pipeline.LINE_LIMIT_DEFAULTS.maxHops;                  // 6 stages AFTER the first (a drawn floor with more is a design smell, not a run)
const MAX_CHAIN_USD = Pipeline.LINE_LIMIT_DEFAULTS.maxUsdPerMessage;    // $2.00 — the WHOLE chain's spend ceiling, entry run included (seed.entryUsd) — one message must not become an open tab
const PREVIEW = 40;

/* THE STAGE NODE (multi-bay agents, 2026-09-22): a stage is { agentId, dockId } — a seam may answer a bare
   agentId (the agent-keyed executor) or a node (the dock-keyed one); both normalize here. The visited set and
   the loop bookkeeping key on nodeKey: the dock when there is one, else the agent (the pre-dock reading). */
function asNode(x) {
  if (!x) return null;
  if (typeof x === 'string') return { agentId: x, dockId: null };
  if (typeof x === 'object' && (x.agentId || x.dockId)) return { agentId: x.agentId || null, dockId: x.dockId != null ? String(x.dockId) : null };
  return null;
}
function nodeKey(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  return x.dockId != null ? String(x.dockId) : String(x.agentId || '');
}
// an event payload plus the additive dockId when the stage has one (never a key with an undefined value)
function withDock(payload, dockId) { if (dockId) payload.dockId = dockId; return payload; }

/* effectiveLimits(seed, lineLimits(lineId), runnerDefaults) -> { maxHops, maxUsd, maxUsdPerDay, clamped[] }.
   PRECEDENCE (narrowest, most explicit first): seed.limits (a caller that already resolved the line's budget)
   > the injected per-line reader (the compiled plan's LINE BUDGET, via router.lineLimits) > the runner's
   construction-time overrides > the constants. Every layer passes through the ONE normalizer, so a raw
   number from any surface is clamped to the hard ceilings (24 hops / $50 per message / $500 per day) and
   the clamp is RECORDED, never silent. `poolCap` (the global budget pool, a sidecar fact) is applied LAST:
   no line may be allowed to spend more per message than the whole station may spend at all. */
function effectiveLimits(raw, fallback, poolCap) {
  const f = fallback || {};
  const out = { maxHops: (typeof f.maxHops === 'number' && f.maxHops >= 0) ? f.maxHops : MAX_HOPS, maxUsd: (typeof f.maxUsd === 'number' && f.maxUsd > 0) ? f.maxUsd : MAX_CHAIN_USD, maxUsdPerDay: (typeof f.maxUsdPerDay === 'number' && f.maxUsdPerDay > 0) ? f.maxUsdPerDay : null, clamped: [] };
  const n = Pipeline.normalizeLineLimits(raw);
  if (n) {
    out.maxHops = n.maxHops; out.maxUsd = n.maxUsdPerMessage; out.maxUsdPerDay = n.maxUsdPerDay;
    // a plan carries ALREADY-clamped numbers plus the record of that clamp — re-normalizing sees no excess,
    // so the record is carried forward from the input rather than recomputed (never lost, never doubled).
    const prior = (raw && Array.isArray(raw.clamped)) ? raw.clamped : [];
    for (const c of prior.concat(Array.isArray(n.clamped) ? n.clamped : [])) if (out.clamped.indexOf(c) < 0) out.clamped.push(c);
  }
  const pool = (typeof poolCap === 'number' && isFinite(poolCap) && poolCap > 0) ? poolCap : null;
  if (pool != null) {
    if (out.maxUsd > pool) { out.maxUsd = pool; out.clamped.push('maxUsdPerMessage>pool:' + pool); }
    if (out.maxUsdPerDay != null && out.maxUsdPerDay > pool) { out.maxUsdPerDay = pool; out.clamped.push('maxUsdPerDay>pool:' + pool); }
  }
  return out;
}

/* ---- PURE STEP HELPERS (2026-09-22) — factored out of advance() so the conveyor STEP-THROUGH TEST
   (routing/steptest.js) runs one dock at a time on the SAME decisions, never a second dialect of them.
   advance() calls each exactly where its inline code used to sit; behaviour is byte-for-byte unchanged. */

/* loopDecision(step, ctx, n, visited, text) -> { again, target, text, exhausted } — THE ONE LOOP RULE
   (2026-08-22, matches the LOOP card word for word):
     when = a VERDICT word   -> the crate goes BACK while the reviewer's verdict is NOT that word
                                (no verdict line = not that word); leaves on DONE the moment it is;
     when = a classifier tag -> goes back while the output still READS as that kind of work;
     no when                 -> every pass goes back;
   and in every case MAX PASSES ends it on DONE. A `when` still unmet when the passes ran out marks the
   done-lane handoff EXHAUSTED so the downstream stage knows nobody approved it. `n` = passes already taken
   round this gate; `text` = the output about to be handed on (returned annotated). Pure: mutates nothing. */
function loopDecision(step, ctx, n, visited, text) {
  const byVerdict = Verdict.isVerdictWord(step.when);
  const wants = !step.when ? true : byVerdict ? (ctx.verdict !== String(step.when).toLowerCase()) : (ctx.tag === step.when);
  const again = step.backTo && n < step.max && wants;
  if (again) {
    return { again: true, target: step.backTo, exhausted: false,
      text: '[LOOP — pass ' + (n + 1) + ' of ' + step.max + ' round the gate at ' + step.loop + ']\n' + text };
  }
  // spent (or the verdict passed): leave on the done lane
  let target = step.next, out = text, exhausted = false;
  if (step.when && wants && n >= step.max) {
    exhausted = true;
    /* THE ESCALATION LANE (2026-08-30): a gate with a third wired lane sends verdict-exhausted
       work THERE — a fresh dock (the fixer, the human-facing summarizer) instead of an apology
       stapled to the done lane. The escalated dock is a real stage: its output continues down
       ITS chain. `visited` still refuses a dock that already ran — then the honest done-lane
       note stands, never a silent second run. */
    if (step.esc && !visited[nodeKey(step.esc)]) {
      target = step.esc;
      out = '[LOOP — escalated: ' + n + ' pass' + (n === 1 ? '' : 'es') + ' round the gate at ' + step.loop
        + (byVerdict ? ' without VERDICT: ' + String(step.when).toLowerCase() : ' while the output still read as ' + step.when)
        + ' — handed to the escalation lane]\n' + text;
    } else {
      out = '[LOOP — exhausted: ' + n + ' pass' + (n === 1 ? '' : 'es') + ' round the gate at ' + step.loop
        + (byVerdict ? ' without VERDICT: ' + String(step.when).toLowerCase() : ' while the output still read as ' + step.when)
        + ' — leaving on DONE unapproved]\n' + text;
    }
  }
  return { again: false, target, text: out, exhausted };
}

/* preHopRefusal({ visited, target, loopHop, hop, loopHops, lim, spent, dayLedger, lineId, text, cur }) -> the
   honest stop reason when the NEXT hop may not run, else null. The executor's pre-hop guards, in order:
   a re-visit outside a loop, the hop ceiling, the $ ceiling (PRE-hop — a hop's cost is unknowable before it
   runs, so it is enforced to within one hop's spend), the line's daily cap, and an empty crate. */
function preHopRefusal(g) {
  if (g.visited[g.targetKey != null ? g.targetKey : g.target] && !g.loopHop) return 'the line loops back to ' + g.target;
  if (g.hop - g.loopHops > g.lim.maxHops) return 'the line is longer than ' + g.lim.maxHops + ' stages';
  if (g.spent >= g.lim.maxUsd) return 'the line reached its $' + g.lim.maxUsd.toFixed(2) + ' limit';
  // THE DAILY CAP — same pre-hop posture, measured against the durable per-line day ledger (entry run and
  // every earlier message today included). Only a line with a ledger AND a cap can refuse; a line with no
  // cap, or no lineId (a direct order), never does — the executor does not invent a day it cannot prove.
  if (g.dayLedger && g.lim.maxUsdPerDay != null) {
    let today = 0; try { today = g.dayLedger.spentToday(g.lineId); } catch (_) { today = 0; }
    if (today >= g.lim.maxUsdPerDay) return 'the line reached its $' + g.lim.maxUsdPerDay.toFixed(2) + ' daily limit';
  }
  // a stage that produced nothing has nothing to hand on — handing it an empty crate would buy a run that
  // can only hallucinate its input (and the floor would draw a crate carrying nothing).
  if (!String(g.text || '').trim()) return g.cur + ' produced no output to hand on';
  return null;
}

/* hopTurn({ handoffText, stageBrief, loopGateAfter, originalText, from, upstream, hop, target, lineId }) -> the
   handoff turn a RECEIVING dock is handed: the shared Pipeline.handoffPrompt (or an injected stand-in), the
   receiver's standing brief (null-safe: no seam / no brief = the exact pre-brief prompt), and — when that
   dock's lane meets a verdict-keyed LOOP gate — the VERDICT-line instruction (verdict.js). `targetDock`
   (multi-bay) names WHICH of the receiving agent's bays this hop runs at, so the brief is that bay's. */
function hopTurn(t) {
  const compose = typeof t.handoffText === 'function' ? t.handoffText : Pipeline.handoffPrompt;
  const td = t.targetDock != null && String(t.targetDock) ? String(t.targetDock) : undefined;
  let brief = null;
  if (typeof t.stageBrief === 'function') { try { brief = td ? t.stageBrief(t.target, td) : t.stageBrief(t.target); } catch (_) { brief = null; } }
  let verdictWhen = null;
  if (typeof t.loopGateAfter === 'function') { try { const g = td ? t.loopGateAfter(t.target, t.lineId, td) : t.loopGateAfter(t.target, t.lineId); verdictWhen = (g && Verdict.isVerdictWord(g.when)) ? g.when : null; } catch (_) { verdictWhen = null; } }
  return compose(t.originalText, t.from, t.upstream, t.hop, brief, verdictWhen ? Verdict.verdictBrief(verdictWhen) : '');
}

/* lineRefusalNote(lineOfAgent, dock, lineId) -> the honest note when the line GATE refused to advance this work
   past `dock` (the run carries a line that is not this dock's own), else null. See refusalNote's full reasoning
   inside makeChainRunner — conservative by construction: it only turns a PROVEN refusal into words. */
function lineRefusalNote(lineOfAgent, dock, lineId, dockId) {
  if (typeof lineOfAgent !== 'function' || !lineId) return null;
  let own = null;
  try { own = (dockId != null && String(dockId)) ? lineOfAgent(dock, String(dockId)) : lineOfAgent(dock); } catch (_) { return null; }
  if (!own || String(own) === String(lineId)) return null;
  // plain language, no ids, no belt vocabulary — the same voice the floor speaks (build.js step card)
  return 'this job did not come in through this line’s door, so the line did not run past ' + dock;
}

function makeChainRunner(o) {
  o = o || {};
  const nextAgent = typeof o.nextAgent === 'function' ? o.nextAgent : null;
  const defaultRunAgent = typeof o.runAgent === 'function' ? o.runAgent : null;
  const emit = typeof o.emit === 'function' ? o.emit : function () {};
  const getTag = typeof o.getTag === 'function' ? o.getTag : function () { return undefined; };
  /* THE VERDICT CHANNEL (2026-08-22): a stage's output may end with `VERDICT: approved|revise` (verdict.js). It
     rides ctx.verdict BESIDE the classifier tag — a FILTER keyed on code|research|general never sees it, and a
     LOOP gate whose `when` is a verdict word reads IT, not the classifier. loopGateAfter(agentId, lineId) ->
     { when } when that dock's own lane meets a LOOP gate (router.loopGateAfter): the dock is told to END with
     the verdict line, else the model never emits one. Both optional; absent = the pre-verdict runner. */
  const getVerdict = typeof o.getVerdict === 'function' ? o.getVerdict : Verdict.parseVerdict;
  const loopGateAfter = typeof o.loopGateAfter === 'function' ? o.loopGateAfter : null;
  // the clock is INJECTED (sidecar determinism law — this module holds no wall-clock of its own). Uninjected it
  // reports 0ms hops rather than inventing a time: honest, and the tests run on a fake clock.
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const maxHops = (typeof o.maxHops === 'number' && o.maxHops >= 0) ? o.maxHops : MAX_HOPS;
  const maxUsd = (typeof o.maxUsd === 'number' && o.maxUsd > 0) ? o.maxUsd : MAX_CHAIN_USD;
  /* LINE BUDGET seams (2026-08-21). lineLimits(lineId) -> the compiled plan's normalized limits for the line
     this work entered on, or null (router.lineLimits in production; a direct order has no line and runs on
     the defaults). poolCap() -> the station's global $ pool (budget.js effective cap), or null = ungoverned.
     daySpend -> { spentToday(lineId), note(lineId, usd) }: the durable per-line day ledger (line-spend.js).
     All optional; absent = exactly the pre-budget executor. */
  const lineLimits = typeof o.lineLimits === 'function' ? o.lineLimits : null;
  const poolCap = typeof o.poolCap === 'function' ? o.poolCap : function () { return null; };
  const daySpend = (o.daySpend && typeof o.daySpend.spentToday === 'function' && typeof o.daySpend.note === 'function') ? o.daySpend : null;
  let seq = 0;
  const newId = typeof o.newId === 'function' ? o.newId : function () { return 'chain' + (++seq); };
  const say = (n, p) => { try { emit(n, p); } catch (_) {} };

  // The handoff turn is composed by the SHARED pure module (frontend/app/pipeline.js) that also compiles the
  // plan — the browser's COMMS work line loads the same function, so the same floor cannot produce a different
  // run on a different surface. Injectable only so a test can watch what a stage was handed.
  const handoffText = typeof o.handoffPrompt === 'function' ? o.handoffPrompt : Pipeline.handoffPrompt;
  // stageBrief(agentId) -> the RECEIVING dock's standing job brief, or null (step editor, 2026-08-05).
  // Injected like nextAgent — the runner never reads the plan itself. Prompt text only: it rides into the
  // handoff turn below and can never change which agent runs (nextAgent alone decides that).
  const stageBrief = typeof o.stageBrief === 'function' ? o.stageBrief : null;

  /* lineOfAgent(agentId) -> the lineId of the line this dock crews, or null. OPTIONAL, injected exactly
     like nextAgent (router.lineOfAgent is the production implementation; the runner never reads the plan).

     WHY IT EXISTS (2026-08-07 conveyor audit). nextAgent() answers null for two completely different
     situations and this module could not tell them apart:
       (a) THIS DOCK IS THE END OF ITS LINE — its reply IS the answer. Correct, silent, the common case.
       (b) THE LINE REFUSED THE WORK — Pipeline.chainNext's gate found the run carrying a lineId that is
           not this dock's line (a stale id: the floor was edited mid-run and the line re-keyed; or work
           that entered somewhere else entirely). The line does not run and nothing downstream spends.
     Both returned `{ stopped: null }` — i.e. "the line ran to its end", which in case (b) is a lie, and
     this file's FIRST law says every stop delivers an honest note saying where the line stopped. A
     silently-truncated work line is the single hardest thing to diagnose from the outside: the Commander
     drew four stages, paid for one, and every surface told them it finished.

     CONSERVATIVE BY CONSTRUCTION — it may only turn a KNOWN refusal into a note:
       • not injected, or it throws          -> no note (we cannot prove a refusal; never invent one)
       • the dock crews no line on the plan  -> no note (terminal — same degradation Pipeline documents
                                                for plans compiled before line identity existed)
       • the run's line IS this dock's line  -> no note (the gate passed; null means genuinely terminal)
       • the two lines DISAGREE              -> the note. Proven: the gate is the only thing that could
                                                have stopped it.
     A DIRECT ORDER (no lineId at all) stays silent on purpose: "a job you hand this agent yourself is
     answered right here and stops here" is the designed contract (Andrew's ruling, 2026-08-07) and the
     step editor says so on the floor — it is not a line that failed to run. */
  const lineOfAgent = typeof o.lineOfAgent === 'function' ? o.lineOfAgent : null;
  function refusalNote(node, lineId) { const n = asNode(node) || {}; return lineRefusalNote(lineOfAgent, n.agentId, lineId, n.dockId); }

  /* JOINER + LOOP seams (2026-08-21) — all optional, all injected like nextAgent:
       stepAgent(agentId, ctx) -> Pipeline.chainStep's answer (router.chainStep in production). When absent the
                                  runner behaves byte-for-byte as before (nextAgent only: no barriers, no loops).
       fanSiblings(agentId)     -> the other first docks of a fan-out split feeding this dock (router.fanSiblings).
       tileOf(junctionKey)      -> { x, y } (the key IS "x,y" — parsed here, injectable for tests).
       setTimer(fn, ms)         -> the joiner timeout clock (default setTimeout; tests inject a fake).
       barrierStore             -> { load() -> obj, save(obj) } — see RESTART below. */
  const stepAgent = typeof o.stepAgent === 'function' ? o.stepAgent : null;
  const fanSiblings = typeof o.fanSiblings === 'function' ? o.fanSiblings : null;
  const tileOf = typeof o.tileOf === 'function' ? o.tileOf : function (k) { const p = String(k).split(','); return { x: +p[0], y: +p[1] }; };
  const setTimer = typeof o.setTimer === 'function' ? o.setTimer : function (fn, ms) { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
  const barrierStore = (o.barrierStore && typeof o.barrierStore.load === 'function' && typeof o.barrierStore.save === 'function') ? o.barrierStore : null;
  /* DOCK seams (multi-bay agents, 2026-09-22) — optional, injected like stepAgent:
       stepDock(dockId, ctx)        -> Pipeline.chainStepDock's answer (router.chainStepDock): the same shapes as
                                       stepAgent with every agentId a node { dockId, agentId }.
       fanSiblingsDock(dockId)      -> [node…] the other first docks of the fan-out split feeding this dock.
       entryDockOf(agentId)         -> the dock a seed with no dockId starts at (router.entryDockOf).
     With stepDock and a starting dock the runner keys every stage by DOCK; without them it is unchanged. */
  const stepDock = typeof o.stepDock === 'function' ? o.stepDock : null;
  const fanSiblingsDock = typeof o.fanSiblingsDock === 'function' ? o.fanSiblingsDock : null;
  const entryDockOf = typeof o.entryDockOf === 'function' ? o.entryDockOf : null;

  /* THE JOIN BARRIER — in-memory, keyed "joinTile|runId". A branch DELIVERS its output; the barrier releases
     when `expect` deliveries are in, or when a waiter's timeout (the joiner's timeoutMin) fires with fewer —
     then the merged crate is MARKED partial (Pipeline.joinPayload) so the next stage knows.

     RESTART IS FAIL-LOUD, NOT DURABLE — decided, not defaulted: the continuation of a parked line is a live
     closure inside advance() (the hub's reply path, the cron driver's ledger), and nothing about an in-flight
     chain is persisted anywhere today (the plan is; runs are not). A "durable" barrier that survived a restart
     would release into nobody. So the parked records alone are written through `barrierStore` (beside
     routing.plan.json in production), and at the next boot every leftover is reported — a console line plus
     a workitem.superseded per parked branch, so the floor drops the crate it was drawing — and cleared. */
  const barriers = new Map();
  function persistBarriers() {
    if (!barrierStore) return;
    const snap = {};
    for (const [k, b] of barriers) snap[k] = { expect: b.expect, parts: b.parts.map(p => (p.dockId ? { agentId: p.agentId, dockId: p.dockId, workitemId: p.workitemId } : { agentId: p.agentId, workitemId: p.workitemId })), ts: b.ts };
    try { barrierStore.save(snap); } catch (e) { failNote('chain.barrier.persist', e); }
  }
  const barrier = {
    deliver(k, expect, agentId, text, timeoutMin, dockId) {
      let b = barriers.get(k);
      if (!b) { b = { expect: expect || 0, parts: [], waiters: [], ts: now(), timeoutMin: timeoutMin || 10 }; barriers.set(k, b); }
      const part = { agentId, text, workitemId: newId() };
      if (dockId) part.dockId = dockId;
      b.parts.push(part);
      if (b.parts.length >= b.expect) {
        barriers.delete(k); persistBarriers();
        const res = { released: true, parts: b.parts, missing: [] };
        for (const w of b.waiters.splice(0)) w(res);
        return res;
      }
      persistBarriers();
      return { released: false, parts: b.parts, missing: [] };
    },
    wait(k, timeoutMin) {
      const b = barriers.get(k);
      if (!b) return Promise.resolve(null);
      return new Promise(resolve => {
        let done = false;
        const fin = res => { if (done) return; done = true; resolve(res); };
        b.waiters.push(fin);
        setTimer(() => {
          if (done || !barriers.has(k)) return;
          barriers.delete(k); persistBarriers();
          const missing = []; for (let i = b.parts.length; i < b.expect; i++) missing.push('lane ' + (i + 1));
          fin({ released: true, parts: b.parts, missing, timedOut: true });
        }, Math.max(1, (timeoutMin || b.timeoutMin || 10)) * 60 * 1000);
      });
    },
    size() { return barriers.size; }
  };
  // boot: a barrier left on disk is a line that died mid-join — say so, drop its crates, start clean
  if (barrierStore) {
    let left = null; try { left = barrierStore.load(); } catch (_) { left = null; }
    const keys = left && typeof left === 'object' ? Object.keys(left) : [];
    for (const k of keys) {
      const b = left[k] || {};
      try { console.warn('[chain] join barrier lost on restart: ' + k + ' (' + ((b.parts || []).length) + '/' + (b.expect || '?') + ' branches had delivered) — the line will not resume'); } catch (e) { failNote('chain.barrier.restartWarn', e); }
      for (const p of (b.parts || [])) if (p && p.workitemId) say('workitem.superseded', withDock({ workitemId: p.workitemId, agentId: p.agentId || '', ts: now() }, p.dockId || null));
    }
    if (keys.length) { try { barrierStore.save({}); } catch (e) { failNote('chain.barrier.clear', e); } }
  }

  const preview = s => String(s || '').replace(/\s+/g, ' ').slice(0, PREVIEW);

  /* advance({ agentId, text, originalText, signal, runAgent, entryUsd }) — run every downstream stage of the
     line that starts at the dock which just finished. `runAgent` may be supplied PER CALL: the runner is built once in
     index.js with the floor's edge function bound, and each caller (the channel hub, a cron fire, the dev
     route) hands in its own way to execute a hop — the hub keeps owning transcripts/persona/consent and stays
     require-free, exactly like the runOnce it is already handed. Returns:
       { text, agentId, hops:[{agentId,usd,ms}], usd, stopped } — `text` is what the caller should DELIVER,
       `agentId` who produced it, `stopped` a short honest reason when the line did not run to its end (null
       when it did). Never throws: a chain is an enhancement to a reply the caller already holds. */
  async function advance(seed) {
    const s = seed || {};
    const startAgent = s.agentId, originalText = s.originalText != null ? s.originalText : s.text;
    // the line this work ENTERED on (null for a direct order — the gate then keeps every dock terminal)
    const lineId = (s.lineId != null && String(s.lineId)) || null;
    const runAgent = typeof s.runAgent === 'function' ? s.runAgent : defaultRunAgent;
    /* the ENTRY run's reconciled spend (2026-08-10 audit): maxUsd bounds the WHOLE chain and stage one is part
       of the chain — seeded by the caller because this module never sees that run. `out.usd` stays HOP-ONLY:
       both production callers ADD it to their own entry accounting (cron-driver `state.usd += line.usd`, the
       hub's onLineOutcome), so totalling the entry into it here would double-count the same dollars. */
    const entryUsd = (typeof s.entryUsd === 'number' && isFinite(s.entryUsd) && s.entryUsd > 0) ? s.entryUsd : 0;
    // the ceilings THIS advance runs under — seed.limits wins, else the line's LINE BUDGET, else the runner's
    let fromPlan = null;
    if (lineLimits && lineId) { try { fromPlan = lineLimits(lineId); } catch (_) { fromPlan = null; } }
    let pool = null; try { pool = poolCap(); } catch (_) { pool = null; }
    const lim = effectiveLimits(s.limits || fromPlan, { maxHops, maxUsd }, pool);
    const out = { text: s.text, agentId: startAgent, hops: [], usd: 0, stopped: null, limits: { maxHops: lim.maxHops, maxUsd: lim.maxUsd, maxUsdPerDay: lim.maxUsdPerDay, clamped: lim.clamped } };
    if (!nextAgent || !runAgent || !startAgent) return out;
    // the entry run's spend lands in the line's DAY bucket here — the caller never sees this ledger
    // (out.usd stays HOP-ONLY; the ledger is the only place entry + hops are summed across messages).
    const dayLedger = (daySpend && lineId) ? daySpend : null;
    if (dayLedger && entryUsd) { try { dayLedger.note(lineId, entryUsd); } catch (e) { failNote('chain.dayLedger.entry', e); } }

    /* THE DOCK KEY (multi-bay agents, 2026-09-22). A stage is a NODE { agentId, dockId } — the dock is what the
       walk, the visited set and the brief key on; the agent is who runs. DOCK MODE needs the dock seams
       (stepDock) and a starting dock: seed.dockId (the dock the entry run was resolved at), else the agent's
       entry dock (entryDockOf). Without them every node carries dockId null and the runner is byte-for-byte
       the agent-keyed executor it always was. */
    let startDock = (s.dockId != null && String(s.dockId)) || null;
    if (!startDock && stepDock && entryDockOf) { try { startDock = entryDockOf(startAgent) || null; } catch (_) { startDock = null; } }
    const dockMode = !!(stepDock && startDock);
    if (dockMode) out.dockId = startDock;
    let cur = { agentId: startAgent, dockId: dockMode ? String(startDock) : null };
    const visited = { [nodeKey(cur)]: true };
    let spent = entryUsd;   // entry + hops — what the $ ceiling is actually measured against
    /* JOIN + LOOP state (2026-08-21) — per advance() call, never across calls:
       runId    keys the joiner barrier: one barrier per (joiner tile, run) — branches of the SAME run rejoin,
                two different messages never get glued together.
       iter     loopKey -> how many times this run has been sent back round that gate.
       pending  fan-out branches still to run: [{ node, text, from }] — branches run SEQUENTIALLY (one
                sidecar, one loop; parallel runs would double the RAM and the floor draws one crate at a time).
       fromTile resume a walk from a junction the previous hop released (a joiner exit / a loop gate lane). */
    const runId = (s.runId != null && String(s.runId)) || (s.workitemId != null && String(s.workitemId)) || newId();
    const iter = {}, pending = [];
    let fromTile = null, via = null, loopHops = 0;
    // inside a loop pass every hop is a re-visit by design (the body runs again); `looping` is raised at a
    // re-entry and lowered when the gate lets the crate out on its done lane
    let looping = false;
    // while a queued fan-out branch is running, the line's LAST GOOD answer is still the entry's own output
    const entryOut = { text: s.text, agentId: startAgent, dockId: cur.dockId }; let branchMode = false;
    /* ENTRY FAN-OUT: resolveTarget named ONE dock for the inbound message and it has already run (`cur`). If
       that dock sits on a lane of a split that feeds a JOINER, the other lanes are parallel branches the drawn
       line promised; queue them from the ORIGINAL text so the barrier can fill. The entry's own output goes
       first, the siblings follow — deterministic, sorted by fanSiblings. */
    if (lineId && ((dockMode && fanSiblingsDock) || fanSiblings)) {
      let sib = [];
      try { sib = (dockMode && fanSiblingsDock) ? (fanSiblingsDock(cur.dockId, { lineId }) || []) : (fanSiblings(cur.agentId, { lineId }) || []); } catch (_) { sib = []; }
      for (const a of sib) { const n = asNode(a); if (n) pending.push({ node: n, text: originalText, from: null, entry: true }); }
    }
    // a branch that ends (terminal / parked at the joiner) hands the loop to the next queued branch
    const nextPending = () => { const b = pending.shift(); if (!b) return false; cur = b.from || cur; out.text = b.text; branchMode = true; return b; };
    let forced = null;   // a queued branch's node, run on this hop in place of the walk's answer
    for (let hop = 1; hop <= 400; hop++) {
      if (s.signal && s.signal.aborted) { out.stopped = 'stopped'; return out; }
      // the tag is derived from the OUTPUT of the stage that just ran — this is what makes a FILTER downstream
      // of a dock a real branch on the result rather than a re-read of the original message.
      let target = null, step = null, loopHop = false, entryBranch = false;
      if (forced) {
        target = forced.node; entryBranch = !!forced.entry; forced = null;
      } else {
        const ctx = { tag: getTag(out.text), verdict: getVerdict(out.text), lineId: lineId, fromTile: fromTile, via: via };
        fromTile = null; via = null;
        try { step = (dockMode && cur.dockId) ? stepDock(cur.dockId, ctx) : stepAgent ? stepAgent(cur.agentId, ctx) : null; } catch (_) { step = null; }
        if (step && step.branches) {
          // a FAN-OUT split mid-line: every lane runs from this output; first lane now, the rest queued
          const br = step.branches.map(asNode).filter(Boolean);
          target = br.shift() || null;
          for (const n of br) pending.push({ node: n, text: out.text, from: cur });
        } else if (step && step.join) {
          // THE BARRIER. Park this branch's output; release only when every in-lane has delivered for this run.
          const r = barrier.deliver(step.join + '|' + runId, step.expect, cur.agentId, out.text, step.timeoutMin, cur.dockId);
          if (!r.released) {
            if (pending.length) { forced = nextPending(); hop--; continue; }   // run the next branch; it may fill the barrier
            // nothing left to run in THIS call: wait for another deliverer (same run) or the joiner's timeout
            const w = await barrier.wait(step.join + '|' + runId, step.timeoutMin);
            if (!w) { out.stopped = 'the joiner at ' + step.join + ' lost its branches'; return out; }
            out.text = Pipeline.joinPayload(w.parts, w.missing);
            say('workitem.delivered', withDock({ workitemId: newId(), finalQueueId: cur.agentId, agentId: cur.agentId, box: 'join:' + step.join, ms: 0, ts: now() }, cur.dockId));
          } else {
            out.text = Pipeline.joinPayload(r.parts, []);
          }
          branchMode = false;
          // the merged crate continues from the joiner's exit; the last deliverer is its producer
          fromTile = tileOf(step.join);
          if (!step.next) { out.stopped = null; return out; }   // the joiner ships straight out: merged text IS the answer
          hop--; continue;
        } else if (step && step.loop) {
          // THE ONE LOOP RULE — loopDecision (module level) holds it; the step-through test reads the same one
          const n = iter[step.loop] || 0;
          const d = loopDecision(step, ctx, n, visited, out.text);
          target = asNode(d.target); out.text = d.text;
          if (d.again) { iter[step.loop] = n + 1; loopHop = true; looping = true; fromTile = null; }
          else { looping = false; if (d.exhausted) out.loopExhausted = true; }
        } else if (step && (step.dockId || step.agentId)) {
          target = asNode(step);
        } else if (!stepAgent && !(dockMode && cur.dockId)) {
          try { target = asNode(nextAgent(cur.agentId, ctx)); } catch (_) { target = null; }
        }
      }
      // no target = EITHER a terminal stage (its reply IS the answer — silent, correct) OR the line gate
      // refusing this work. refusalNote tells the two apart, and only speaks when it can prove the second.
      if (!target) {
        if (pending.length) { forced = nextPending(); hop--; continue; }
        out.stopped = refusalNote(cur, lineId); return out;
      }
      const tKey = nodeKey(target);
      if (looping) loopHop = true;
      // NEVER RUN A DOCK TWICE (multi-bay): the visited set keys on the DOCK — writer@A then writer@C is two
      // docks, a straight line; only the SAME dock coming round again (outside a loop pass) is a loop.
      if (visited[tKey] && !loopHop) { out.stopped = 'the line loops back to ' + target.agentId; return out; }
      if (loopHop) loopHops++;
      // the remaining pre-hop guards (hop ceiling, $ ceiling measured on `spent` — entry seeded, so stage one
      // no longer rides free — daily cap, empty crate) live in preHopRefusal, shared with the step-through test
      const refused = preHopRefusal({ visited, target: target.agentId, targetKey: tKey, loopHop: true, hop, loopHops, lim, spent, dayLedger, lineId, text: out.text, cur: cur.agentId });
      if (refused) { out.stopped = refused; return out; }

      if (!loopHop) visited[tKey] = true;
      const workitemId = newId(), t0 = now();
      // `from` = the PRODUCER dock (additive, 2026-08-04): the frontend used to GUESS the upstream dock
      // (alphabetically-first dock whose chain reaches the target) and drew handoff crates leaving the wrong
      // bay on any floor where two lines feed one dock. obj() stanzas carry no additionalProperties:false,
      // so the extra field validates against the frozen workitem.placed contract; old consumers ignore it.
      // `lineId` rides the crate too (additive, same obj() latitude as `from`): the floor reads it to tell a
      // line-owned handoff from an ad-hoc run's own product, so the pipeline never animates a workflow that
      // did not run — and never hides one that did.
      // `dockId` / `fromDock` (multi-bay, 2026-09-22 — additive, same latitude): WHICH bay receives the crate
      // and which bay produced it, so the floor lands writer@C's crate at bay C, never at the writer's first bay.
      const placed = { workitemId, queueId: target.agentId, agentId: target.agentId, kind: 'chain', from: entryBranch ? undefined : cur.agentId, lineId: lineId || undefined, preview: preview(out.text), ts: t0 };
      if (target.dockId) placed.dockId = target.dockId;
      if (!entryBranch && cur.dockId) placed.fromDock = cur.dockId;
      say('workitem.placed', placed);

      let r = null;
      // the RECEIVING dock's standing brief + (a verdict-keyed LOOP gate ahead) the VERDICT-line instruction
      // ride the handoff turn — hopTurn, shared with the step-through test. An ENTRY branch is stage one of
      // its own lane: it gets the original message, not a handoff turn.
      const turn = entryBranch ? String(originalText || '') : hopTurn({ handoffText, stageBrief, loopGateAfter, originalText, from: cur.agentId, upstream: out.text, hop, target: target.agentId, targetDock: target.dockId, lineId });
      const call = { agentId: target.agentId, text: turn, hop, from: entryBranch ? null : cur.agentId, signal: s.signal, workitemId };
      if (target.dockId) { call.dockId = target.dockId; call.fromDock = entryBranch ? null : cur.dockId; }
      if (lineId) call.lineId = lineId;   // LINE WATCH (additive): the host stamps the hop's run row with its line
      try { r = await runAgent(call); }
      catch (e) { r = { error: (e && e.message) || String(e || 'stage failed') }; }
      r = r || {};
      const usd = (typeof r.usd === 'number' && isFinite(r.usd) && r.usd > 0) ? r.usd : 0;
      out.usd += usd; spent += usd;
      if (dayLedger && usd) { try { dayLedger.note(lineId, usd); } catch (e) { failNote('chain.dayLedger.hop', e); } }

      // A FAILED STAGE KEEPS THE LAST GOOD ANSWER. The reply the user gets is still real work by a real agent;
      // the note says the line stopped short, so the floor and the channel tell the same story.
      if (r.error || !String(r.text || '').trim()) {
        say('workitem.superseded', withDock({ workitemId, agentId: target.agentId, ts: now() }, target.dockId));
        out.stopped = target.agentId + (r.error ? ' failed: ' + r.error : ' returned nothing');
        if (branchMode) { out.text = entryOut.text; out.agentId = entryOut.agentId; if (entryOut.dockId) out.dockId = entryOut.dockId; }   // a dead branch never replaces the entry's answer
        return out;
      }
      say('workitem.delivered', withDock({ workitemId, finalQueueId: target.agentId, agentId: target.agentId, box: '', ms: now() - t0, ts: now() }, target.dockId));
      const hopRec = { agentId: target.agentId, usd, ms: now() - t0 };
      if (target.dockId) hopRec.dockId = target.dockId;
      out.hops.push(hopRec);
      out.text = r.text; out.agentId = target.agentId;
      if (target.dockId) out.dockId = target.dockId;
      cur = target;
    }
    out.stopped = 'the line ran past its hop ceiling';
    return out;
  }

  // the honest one-liner appended to a reply whose line stopped short (the caller decides whether to show it).
  function stopNote(res) {
    if (!res || !res.stopped) return '';
    return '\n\n⚠ the work line stopped early — ' + res.stopped + '.';
  }

  return { advance, stopNote, _limits: { maxHops, maxUsd }, _barrier: barrier };
}

module.exports = { makeChainRunner, effectiveLimits, loopDecision, preHopRefusal, hopTurn, lineRefusalNote, asNode, nodeKey, MAX_HOPS, MAX_CHAIN_USD };
