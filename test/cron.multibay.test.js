/* test/cron.multibay.test.js — a routine may FIRE AT one bay of a multi-dock agent (multi-bay, 2026-09-22).

   cron-store keeps an optional `dockId` only when it is a safe id (additive: a job without one carries no key,
   so every existing record is byte-identical); updateJob sets or clears it. The cron driver hands the dock to
   the brief/station seams, the crate and the chain seed. */
'use strict';
const A = require('./_assert.js');
const cron = require('../sidecar/cron.js');
const store = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
{
  const mk = (extra) => store.createJob([], Object.assign({ id: 'j1', name: 'r', prompt: 'p', schedule: cron.parseSchedule('every 1h', T0), agentId: 'quill' }, extra), { now: T0 })[0];
  A.eq(mk({ dockId: 'p4' }).dockId, 'p4', 'a safe dockId is kept');
  A.ok(!('dockId' in mk({})), 'no dockId -> no key (existing records unchanged)');
  A.ok(!('dockId' in mk({ dockId: '../x' })), 'an unsafe dockId is dropped');
  let jobs = [mk({})];
  jobs = store.updateJob(jobs, 'j1', { dockId: 'p2' }, { now: T0 });
  A.eq(jobs[0].dockId, 'p2', 'updateJob sets the dock');
  jobs = store.updateJob(jobs, 'j1', { dockId: '' }, { now: T0 });
  A.ok(!('dockId' in jobs[0]), 'updateJob with an empty dock clears it (fires at the entry dock)');
}
A.eq(typeof makeCronDriver, 'function', 'the driver module loads');
A.report('cron.multibay');
