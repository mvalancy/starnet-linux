/* sidecar/routing/line-stats.js — the PER-LINE numbers the floor's INBOX plate and the Workflow panel header show
   ("watch your factory work", line watch 2026-09-23), folded from the durable run rows. Server truth only:

     • runs     — run rows stamped with this line (runstore `lineId`, set by the host that dispatched the run: hub
                  entry/hop, routine entry/hop, step test) that FINISHED since the caller's `since` (its local
                  midnight — the same window the station's SHIPPED TODAY counter polls /api/runs with).
     • shipped  — JOBS that left through the line's OUTBOX (2026-09-24): of those runs, reason 'done' with PROVEN
                  work (≥1 successful tool result or ≥1 artifact — the station SHIPPED predicate) AND run at a dock
                  whose outbound lane reaches the OUTBOX (the injected shipsToOutbox(agentId, dockId) — the router's
                  chainShipsToOutbox). A mid-line stage finishing is a RUN, not a shipment: counting every done
                  stage made a 3-stage line claim 3 shipped for one job. No reader = nothing is claimed shipped.
     • failed   — reason error / refusal / max_iters / budget (the same dead-run set the floor turns into slag).
     • medianMs — the median recorded durationMs of those runs (null with no timed run).
     • tests    — step-through test / try-this-step hops (run rows the host stamped stepTest). A test is NOT a job:
                  it is counted here and never in runs / shipped / failed / medianMs (sweep 2026-09-25). Its $ is in
                  usdToday — tests are real runs that count against the LINE BUDGET.
     • usdToday / capUsdPerDay — the LINE BUDGET ledger (line-spend.js, the $ the daily cap is enforced against)
                  and the line's clamped maxUsdPerDay (null = no daily cap set). The ledger's day is the UTC day
                  index it enforces by; `spendDay: 'utc'` says so rather than pretending it is the local day — on the
                  answer AND on every line entry, so a consumer holding one line still knows which day its $ is.
   Plus `docks`: each bay's LAST recorded outcome (newest row stamped with that dockId, any day), which is what a
   bay lamp reads after a reload to stay FAILED until the next success.

   PURE (sidecar determinism law): no clock, no I/O — the route passes rows (newest-first), the plan's lines and
   the ledger/limits readers. Never throws on a malformed row; a row it cannot read is skipped, never guessed. */
'use strict';

const FAILED_REASONS = ['error', 'refusal', 'max_iters', 'budget'];
const FAILED = new Set(FAILED_REASONS);

const provenWork = r => (((r && r.toolsOk) | 0) > 0) || (Array.isArray(r && r.artifacts) && r.artifacts.length > 0);
const shippedRow = r => !!r && r.reason === 'done' && provenWork(r);
const failedRow = r => !!r && FAILED.has(r.reason);
const fin = v => (typeof v === 'number' && isFinite(v)) ? v : null;

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/* lineStats({ rows, lines, since, spentToday(lineId)->$, capOf(lineId)->$|null, shipsToOutbox(agentId, dockId)->bool })
     rows  — run rows NEWEST-FIRST (runStore.list order); may span more than `since` (older rows only feed `docks`)
     lines — the compiled plan's line list ([{ lineId, propIds? }]); a line with no runs still answers zeros
   -> { since, spendDay: 'utc', lines: [{ lineId, runs, shipped, failed, tests, medianMs, usdToday, capUsdPerDay, spendDay }], docks } */
function lineStats(o) {
  o = o || {};
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const since = fin(o.since) || 0;
  const spentToday = typeof o.spentToday === 'function' ? o.spentToday : () => 0;
  const capOf = typeof o.capOf === 'function' ? o.capOf : () => null;
  const shipsToOutbox = typeof o.shipsToOutbox === 'function' ? o.shipsToOutbox : () => false;
  const ships = r => { try { return !!shipsToOutbox(r.agentId || null, r.dockId || null); } catch (e) { void e; return false; } };   // cannot prove -> not shipped
  const byLine = new Map();
  for (const l of (Array.isArray(o.lines) ? o.lines : [])) {
    const id = l && l.lineId != null ? String(l.lineId) : '';
    if (id && !byLine.has(id)) byLine.set(id, { lineId: id, runs: 0, shipped: 0, failed: 0, tests: 0, _ms: [] });
  }
  const docks = {};
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    // the bay's LAST outcome: rows are newest-first, so the first row stamped with a dock is its latest run
    if (r.dockId && !docks[r.dockId] && r.runId) {
      docks[r.dockId] = { runId: String(r.runId), agentId: r.agentId || null, reason: r.reason || null, failed: failedRow(r), ts: fin(r.ts) };
    }
    const ts = fin(r.ts);
    if (!r.lineId || ts == null || ts <= since) continue;
    const L = byLine.get(String(r.lineId));
    if (!L) continue;   // a line that is no longer on the floor has no plate to feed
    if (r.stepTest === true) { L.tests++; continue; }   // a test hop is not a job the line ran, shipped or failed
    L.runs++;
    if (shippedRow(r) && ships(r)) L.shipped++;
    if (failedRow(r)) L.failed++;
    const ms = fin(r.durationMs);
    if (ms != null && ms > 0) L._ms.push(ms);
  }
  const lines = [];
  for (const L of byLine.values()) {
    let usd = 0, cap = null;
    try { usd = fin(spentToday(L.lineId)) || 0; } catch (_) { usd = 0; }
    try { const c = fin(capOf(L.lineId)); cap = (c != null && c > 0) ? c : null; } catch (_) { cap = null; }
    lines.push({ lineId: L.lineId, runs: L.runs, shipped: L.shipped, failed: L.failed, tests: L.tests, medianMs: median(L._ms), usdToday: Math.round(usd * 1e6) / 1e6, capUsdPerDay: cap, spendDay: 'utc' });
  }
  return { since, spendDay: 'utc', lines, docks };
}

module.exports = { lineStats, median, shippedRow, failedRow, FAILED_REASONS };
