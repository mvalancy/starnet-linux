/* test/_multibay-parity.js — the AGENT-VIEW answers a 1:1 floor must keep across the multi-bay migration.

   answersFor(P, geo) compiles `geo` with the given Pipeline module and returns every agent-keyed reading an
   older surface depends on: the plan itself (minus the additive dock maps), the hash, and the executor's
   answers per bound agent (chainNext/chainStep/fanSiblings/sourceFor/lineOriginOf), per junction resume,
   resolveTarget by tag, liveTiles and junctionLaneOwners. test/fixtures/multibay-parity.json holds these
   answers as produced by the PRE-migration compiler (trunk 86ce3b338) over every floor the routing tests
   compile; test/pipeline.multibay.test.js asserts the migrated compiler reproduces them exactly. */
'use strict';
// fields the migration ADDS to a plan — excluded so the comparison is "every old field, unchanged"
const DOCK_FIELDS = ['bayTileToDock', 'agentOfDock', 'docksOfAgent', 'dockChains', 'reachDock', 'gateDocks', 'lineOfDock', 'entryDock', 'homeDock'];
function stripDock(plan) {
  const out = {};
  for (const k of Object.keys(plan)) if (DOCK_FIELDS.indexOf(k) < 0) out[k] = plan[k];
  return JSON.parse(JSON.stringify(out));
}
function answersFor(P, geo) {
  const plan = P.compileRoutingPlan(geo);
  const agents = Object.keys(plan.reach || {}).sort();
  const zero = () => 0, one = () => 1;
  const per = {};
  for (const a of agents) {
    const own = { lineId: P.lineOf(plan, a) };
    const r = {};
    for (const tag of ['general', 'code', 'research']) {
      const ctx = Object.assign({ tag }, own);
      r['next.' + tag] = P.chainNext(plan, a, ctx, zero);
      r['next1.' + tag] = P.chainNext(plan, a, ctx, one);
      r['step.' + tag] = P.chainStep(plan, a, ctx, zero);
      r['step1.' + tag] = P.chainStep(plan, a, ctx, one);
    }
    r.stepNoLine = P.chainStep(plan, a, { tag: 'general' }, zero);
    r.fan = P.fanSiblings(plan, a);
    r.source = P.sourceFor(plan, a);
    r.origin = P.lineOriginOf(plan, a);
    r.lineOf = P.lineOf(plan, a);
    r.bound = P.resolveTarget(plan, { boundAgentId: a });
    for (const jk of Object.keys(plan.junctions || {})) {
      const p = jk.split(','), ft = { x: +p[0], y: +p[1] };
      r['from.' + jk] = P.chainStep(plan, a, Object.assign({ tag: 'general', fromTile: ft }, own), zero);
      r['back.' + jk] = P.chainStep(plan, a, Object.assign({ tag: 'general', fromTile: ft, via: 'back' }, own), zero);
    }
    per[a] = r;
  }
  const resolve = {};
  for (const tag of ['general', 'code', 'research']) { resolve[tag] = P.resolveTarget(plan, { tag }, zero); resolve[tag + '1'] = P.resolveTarget(plan, { tag }, one); }
  return JSON.parse(JSON.stringify({ hash: plan.hash, plan: stripDock(plan), per, resolve, live: P.liveTiles(plan), owners: P.junctionLaneOwners(plan) }));
}
module.exports = { answersFor, stripDock, DOCK_FIELDS };
