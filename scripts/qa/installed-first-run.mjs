#!/usr/bin/env node
/*
 * W1 installed first-value journey.
 *
 * This is deliberately stricter than Beginner Run. It attaches to an already-running,
 * genuinely installed Tauri desktop through CDP and proves one fresh-user result:
 *
 *   visible provider failure -> attended recovery -> Overseer creation -> the tutorial's
 *   real fs.write/fs.read hello.txt task -> independently hashed file -> real OPEN click.
 *
 * A provider reply is never a deliverable. Browser/dev, existing-user, unattested isolation,
 * mismatched candidate/artifact, missing credentials, synthetic files, and an unobserved OPEN
 * all fail closed. Credential bytes are accepted only as an attended runtime input and are
 * never copied into logs or evidence.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectCDP, evalJS, sleep } from '../lib/cdp.mjs';
import { KINDS } from './product-perfect/provenance.mjs';

export const MAX_JOURNEY_MS = 10 * 60 * 1000;
export const RECEIPT_SCHEMA = 1;
export const LINK_RECEIPT_SCHEMA = 1;
export const RESULTS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED' });
export const FIRST_TASK_ID = 'tutorial-hello-file-v1';
export const FIRST_TASK_PATH = 'hello.txt';
export const FIRST_TASK_CONTENT = 'starnet online';
export const TAURI_ORIGINS = new Set([
  'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'app://localhost'
]);

const RESULT_SET = new Set(Object.values(RESULTS));
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;
const ISOLATION_AUTHORITIES = new Set(['separate-windows-user', 'virtual-machine', 'clean-machine']);
const BYOK_PROVIDERS = new Set([
  'openrouter', 'openai', 'anthropic', 'gemini', 'xai', 'groq', 'mistral',
  'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras'
]);

const str = value => value == null ? '' : String(value);
const lower = value => str(value).trim().toLowerCase();
const basename = value => str(value).replace(/\\/g, '/').split('/').pop();
const sha256Text = value => crypto.createHash('sha256').update(str(value), 'utf8').digest('hex');

function normalizedArtifact(value) {
  if (!value || typeof value !== 'object') return null;
  const sha256 = lower(value.sha256);
  const size = Number(value.size);
  const file = str(value.path).trim();
  if (!file || !SHA256.test(sha256) || !Number.isSafeInteger(size) || size <= 0) return null;
  return { path: file, sha256, size };
}

function normalizedEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  const file = str(value.path).trim().replace(/\\/g, '/');
  const sha256 = lower(value.sha256);
  const size = Number(value.size);
  if (!file || !SHA256.test(sha256) || !Number.isSafeInteger(size) || size <= 0) return null;
  return { path: file, sha256, size };
}

export function containsSecretMaterial(text, secrets = []) {
  const body = str(text);
  for (const secret of secrets) {
    const s = str(secret);
    if (s.length >= 6 && body.includes(s)) return true;
  }
  return /(?:sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_\-]{12,}/i.test(body)
    || /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*["'=:\s]+(?:bearer\s+)?[A-Za-z0-9._\-]{12,}/i.test(body)
    || /[?&](?:token|key|secret)=[^\s&#]+/i.test(body);
}

export function validateInstalledIdentity(observed, expected) {
  observed = observed || {}; expected = expected || {};
  const errors = [];
  const candidateCommit = lower(expected.candidateCommit);
  const candidateTree = lower(expected.candidateTree);
  const artifact = normalizedArtifact(expected.artifact);
  const shell = observed.shell && typeof observed.shell === 'object' ? observed.shell : {};
  const version = observed.version && typeof observed.version === 'object' ? observed.version : {};
  const origin = str(observed.origin).trim();
  const mode = str(observed.mode).trim();
  const buildCommit = lower(shell.sha || shell.fullCommit);
  const sourceTree = lower(shell.sourceTree);
  const buildKind = lower(shell.provenanceKind);
  const runtimeSha256 = lower(shell.executableSha256);
  const runtimeSize = Number(shell.executableSize);

  if (!SHA40.test(candidateCommit)) errors.push('candidate-commit-missing');
  if (!SHA40.test(candidateTree)) errors.push('candidate-tree-missing');
  if (!artifact) errors.push('candidate-artifact-missing');
  if (!TAURI_ORIGINS.has(origin) || mode !== 'desktop') errors.push('not-installed-desktop');
  if (!SHA40.test(buildCommit) || buildCommit !== candidateCommit) errors.push('build-commit-mismatch');
  if (!SHA40.test(sourceTree) || sourceTree !== candidateTree) errors.push('source-tree-mismatch');
  if (shell.dirty !== false || version.buildDirty !== false) errors.push('dirty-or-unknown-build');
  if (![KINDS.REPRODUCIBLE_SOURCE, KINDS.CUSTOM].includes(buildKind)) errors.push('untrusted-build-kind');
  if (!artifact || runtimeSha256 !== artifact.sha256 || runtimeSize !== artifact.size) errors.push('runtime-artifact-mismatch');
  if (lower(version.buildSha) !== candidateCommit) errors.push('sidecar-commit-mismatch');
  if (!str(version.app).trim() || str(shell.version).trim() !== str(version.app).trim()) errors.push('app-version-mismatch');
  if (!str(shell.describe).trim() || str(shell.describe).trim() !== str(version.harness).trim()) errors.push('build-description-mismatch');
  return { ok: errors.length === 0, errors };
}

export function validateFreshPrecondition(observed, isolation, providerId) {
  observed = observed || {}; isolation = isolation || {};
  const errors = [];
  if (isolation.attended !== true) errors.push('attended-operator-unproven');
  if (isolation.freshProfile !== true) errors.push('fresh-profile-unattested');
  if (!SAFE_ID.test(str(isolation.id).trim())) errors.push('isolation-id-invalid');
  if (!ISOLATION_AUTHORITIES.has(str(isolation.authority))) errors.push('fresh-profile-authority-invalid');
  if (isolation.machineVerified !== true || !SHA256.test(lower(isolation.principalSha256)) ||
      !SHA256.test(lower(isolation.profileSha256)) || !SHA256.test(lower(isolation.runtimeOwnerSha256)) || !str(isolation.proof).trim() ||
      str(isolation.id) !== str(isolation.authority) + '-' + lower(isolation.principalSha256).slice(0, 12)) {
    errors.push('fresh-profile-machine-unverified');
  }
  if (!['screen-splash', 'screen-connect'].includes(str(observed.activeScreen))) errors.push('fresh-screen-not-visible');
  if (observed.saveStatus !== 'none' || observed.savePresent !== false) errors.push('existing-save-present');
  if (observed.currentAgentPresent !== false || Number(observed.rosterCount) !== 0) errors.push('existing-agent-present');
  if (observed.recoveryVisible !== false) errors.push('recovery-mode-present');
  if (observed.providerConfigured !== false) errors.push('provider-already-configured');
  if (lower(observed.providerChecked) !== lower(providerId)) errors.push('provider-precondition-unchecked');
  if (observed.backendSavePresent !== false || observed.backendRecoveryPresent !== false ||
      Number(observed.backendRunCount) !== 0 || Number(observed.backendAgentCount) !== 0 ||
      observed.backendLastRunPresent !== false || observed.backendWorkspaceDegraded !== false) {
    errors.push('existing-sidecar-state-present');
  }
  return { ok: errors.length === 0, errors };
}

function validateLinkObservation(doc, expected) {
  doc = doc || {}; expected = expected || {};
  const errors = [];
  const artifact = normalizedArtifact(expected.artifact);
  const observations = Array.isArray(doc.observations) ? doc.observations : [];
  const sessionId = str(doc.sessionId).trim();
  if (doc.schemaVersion !== LINK_RECEIPT_SCHEMA || doc.producer !== 'installed-link-observation-v1') errors.push('link-observation-schema-mismatch');
  if (!str(expected.challenge) || doc.challenge !== expected.challenge) errors.push('link-challenge-mismatch');
  if (lower(doc.candidateCommit) !== lower(expected.candidateCommit)) errors.push('link-candidate-mismatch');
  if (lower(doc.candidateTree) !== lower(expected.candidateTree)) errors.push('link-tree-mismatch');
  if (!artifact || lower(doc.artifact && doc.artifact.sha256) !== artifact.sha256 || Number(doc.artifact && doc.artifact.size) !== artifact.size) errors.push('link-artifact-mismatch');
  if (doc.mode !== 'desktop' || !TAURI_ORIGINS.has(str(doc.origin))) errors.push('link-not-installed-desktop');
  if (!Number.isInteger(Number(expected.cdpPort)) || Number(doc.cdpPort) !== Number(expected.cdpPort)) errors.push('link-cdp-port-mismatch');
  if (!SAFE_ID.test(sessionId)) errors.push('link-session-invalid');
  const elapsedMs = Number(doc.elapsedMs);
  const wallElapsedMs = Number(expected.wallElapsedMs);
  const startedAt = Date.parse(str(doc.startedIso));
  const endedAt = Date.parse(str(doc.endedIso));
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 40000 || !Number.isFinite(wallElapsedMs) || wallElapsedMs <= 40000 || elapsedMs > wallElapsedMs + 2000) {
    errors.push('link-elapsed-time-invalid');
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt ||
      Math.abs((endedAt - startedAt) - elapsedMs) > 2000 ||
      (Number.isFinite(Number(expected.gateStartedAt)) && startedAt < Number(expected.gateStartedAt) - 2000) ||
      (Number.isFinite(Number(expected.gateEndedAt)) && endedAt > Number(expected.gateEndedAt) + 2000)) errors.push('link-observation-time-invalid');
  let prior = -1;
  let malformed = false;
  for (const item of observations) {
    const at = Number(item && item.atMs);
    if (!item || !Number.isFinite(at) || at < prior || at < 0 || at > elapsedMs + 1000 || str(item.sessionId) !== sessionId) malformed = true;
    prior = at;
  }
  if (!observations.length || malformed) errors.push('link-observations-invalid');
  const data = observations.filter(item => item && item.kind === 'transport-data' && item.source === 'message');
  const up = observations.filter(item => item && item.kind === 'link-state' && item.state === 'UP');
  const firstUp = up[0] || null;
  const lastData = data[data.length - 1] || null;
  const sidecar = observations.find(item => item && item.kind === 'sidecar-process' && Number.isInteger(Number(item.pid)) && Number(item.pid) > 0 && lower(item.candidateCommit) === lower(expected.candidateCommit)) || null;
  const loss = sidecar ? observations.find(item => item && item.kind === 'sidecar-exit' && item.observed === true && Number(item.pid) === Number(sidecar.pid) && Number(item.atMs) > Number(sidecar.atMs)) : null;
  const down = loss ? observations.find(item => item && item.kind === 'link-state' && item.state === 'DOWN' && item.cause === 'eventsource-error' && Number(item.atMs) > Number(loss.atMs)) : null;
  const downBeforeLoss = loss ? observations.some(item => item && item.kind === 'link-state' && item.state === 'DOWN' && Number(item.atMs) < Number(loss.atMs)) : true;
  if (!firstUp || !lastData || data.length < 2 || Number(lastData.atMs) - Number(firstUp.atMs) <= 40000 ||
      (loss && Number(lastData.atMs) >= Number(loss.atMs)) || downBeforeLoss) errors.push('healthy-idle-up-unproven');
  if (!loss || !down) errors.push('actual-loss-down-unproven');
  if (containsSecretMaterial(JSON.stringify(doc))) errors.push('link-evidence-secret-bearing');
  return { ok: errors.length === 0, errors };
}

export function validateLinkReceipt(receipt, expected, rawEvidence = []) {
  receipt = receipt || {}; expected = expected || {};
  const errors = [];
  const artifact = normalizedArtifact(expected.artifact);
  const evidence = Array.isArray(receipt.evidence) ? receipt.evidence.map(normalizedEvidence).filter(Boolean) : [];
  if (receipt.schemaVersion !== LINK_RECEIPT_SCHEMA) errors.push('link-schema-mismatch');
  if (receipt.producer !== 'installed-link-transport-v2') errors.push('link-producer-mismatch');
  if (!str(expected.challenge) || receipt.challenge !== expected.challenge) errors.push('link-challenge-mismatch');
  if (!expected.probe || !receipt.probe || str(receipt.probe.path) !== str(expected.probe.path) ||
      lower(receipt.probe.sha256) !== lower(expected.probe.sha256)) errors.push('link-probe-mismatch');
  if (lower(receipt.candidateCommit) !== lower(expected.candidateCommit)) errors.push('link-candidate-mismatch');
  if (lower(receipt.candidateTree) !== lower(expected.candidateTree)) errors.push('link-tree-mismatch');
  if (!artifact || lower(receipt.artifact && receipt.artifact.sha256) !== artifact.sha256 || Number(receipt.artifact && receipt.artifact.size) !== artifact.size)
    errors.push('link-artifact-mismatch');
  if (receipt.mode !== 'desktop' || !TAURI_ORIGINS.has(str(receipt.origin))) errors.push('link-not-installed-desktop');
  if (!Number.isInteger(Number(expected.cdpPort)) || Number(receipt.cdpPort) !== Number(expected.cdpPort)) errors.push('link-cdp-port-mismatch');
  const stampMs = Date.parse(str(receipt.stampIso));
  if (!Number.isFinite(stampMs) ||
      (Number.isFinite(Number(expected.gateStartedAt)) && stampMs < Number(expected.gateStartedAt) - 2000) ||
      (Number.isFinite(Number(expected.gateEndedAt)) && stampMs > Number(expected.gateEndedAt) + 2000)) errors.push('link-stamp-invalid');
  if (!Array.isArray(receipt.evidence) || evidence.length !== receipt.evidence.length || evidence.length === 0) errors.push('link-evidence-invalid');
  if (containsSecretMaterial(JSON.stringify(receipt))) errors.push('link-evidence-secret-bearing');
  if (!Array.isArray(rawEvidence) || rawEvidence.length !== evidence.length || rawEvidence.length === 0) {
    errors.push('link-raw-evidence-missing');
  } else {
    for (const doc of rawEvidence) {
      const verdict = validateLinkObservation(doc, expected);
      for (const error of verdict.errors) if (!errors.includes(error)) errors.push(error);
    }
  }
  return { ok: errors.length === 0, errors, evidence };
}

class JourneyFault extends Error {
  constructor(code, result = RESULTS.FAIL) {
    super(code); this.name = 'JourneyFault'; this.code = code; this.result = result;
  }
}

function requireCondition(condition, code, result) {
  if (!condition) throw new JourneyFault(code, result);
}

function publicIdentity(observed) {
  const shell = observed && observed.shell || {};
  const version = observed && observed.version || {};
  return {
    origin: str(observed && observed.origin), mode: str(observed && observed.mode),
    appVersion: str(version.app), buildCommit: lower(shell.sha || shell.fullCommit),
    sourceTree: lower(shell.sourceTree), buildDescribe: str(shell.describe),
    buildDirty: shell.dirty === true, buildKind: lower(shell.provenanceKind),
    sidecarCommit: lower(version.buildSha), sidecarDirty: version.buildDirty === true,
    sidecarDescribe: str(version.harness),
    runtimeExecutable: { sha256: lower(shell.executableSha256), size: Number(shell.executableSize) || 0 }
  };
}

function makeReceipt(state) {
  const task = state.task || {};
  const deliverable = task.deliverable || {};
  const opened = state.opened || {};
  return {
    schemaVersion: RECEIPT_SCHEMA,
    stampIso: str(state.stampIso),
    result: RESULT_SET.has(state.result) ? state.result : RESULTS.BLOCKED,
    reasonCode: str(state.reasonCode || 'unclassified'),
    candidateCommit: lower(state.candidateCommit),
    candidateTree: lower(state.candidateTree),
    artifact: normalizedArtifact(state.artifact),
    installed: state.identity ? publicIdentity(state.identity) : null,
    isolation: {
      id: str(state.isolation && state.isolation.id), attended: state.isolation && state.isolation.attended === true,
      authority: str(state.isolation && state.isolation.authority),
      freshProfile: state.isolation && state.isolation.freshProfile === true,
      machineVerified: state.isolation && state.isolation.machineVerified === true,
      proof: str(state.isolation && state.isolation.proof),
      principalSha256: lower(state.isolation && state.isolation.principalSha256),
      profileSha256: lower(state.isolation && state.isolation.profileSha256),
      runtimeOwnerSha256: lower(state.isolation && state.isolation.runtimeOwnerSha256),
      repositoryOwnerSha256: lower(state.isolation && state.isolation.repositoryOwnerSha256),
      observedFresh: state.fresh?.ok === true,
      sidecarStorageFresh: state.fresh?.sidecarStorageFresh === true
    },
    provider: {
      id: lower(state.provider && state.provider.id), model: str(state.provider && state.provider.model),
      failureStateObserved: state.providerFailure?.visible === true,
      failureKind: str(state.providerFailure && state.providerFailure.kind),
      recovered: state.created?.providerConnected === true
    },
    overseer: {
      created: state.created?.overseerCreated === true,
      id: str(state.created && state.created.agentId), role: str(state.created && state.created.role)
    },
    task: {
      contract: FIRST_TASK_ID,
      started: task.started === true, completed: task.completed === true, reason: str(task.reason),
      runIdSha256: task.runId ? sha256Text(task.runId) : '',
      realProvider: task.realProvider === true,
      permissionPromptObserved: task.permissionPromptObserved === true,
      approvedOnce: task.approvedOnce === true,
      baselineAbsent: task.baselineAbsent === true,
      fsWriteObserved: task.fsWriteObserved === true,
      fsReadObserved: task.fsReadObserved === true,
      toolsBoundToRun: task.toolsBoundToRun === true
    },
    deliverable: {
      eventObserved: deliverable.eventObserved === true,
      path: str(deliverable.path), sha256: lower(deliverable.sha256), size: Number(deliverable.size) || 0,
      contentVerified: deliverable.contentVerified === true,
      opened: opened.opened === true, pointerClick: opened.pointerClick === true,
      mechanism: str(opened.mechanism), targetScheme: str(opened.targetScheme),
      openedSha256: lower(opened.deliverableSha256), openedSize: Number(opened.deliverableSize) || 0,
      targetUrlSha256: lower(opened.targetUrlSha256), targetBoundToBytes: opened.targetBoundToBytes === true
    },
    timing: {
      maxMs: MAX_JOURNEY_MS, totalMs: Number(state.totalMs) || 0,
      underTenMinutes: Number(state.totalMs) < MAX_JOURNEY_MS,
      steps: (state.steps || []).map(step => ({ id: str(step.id), ok: step.ok === true, ms: Number(step.ms) || 0, code: str(step.code) }))
    }
  };
}

export function validateJourneyReceipt(receipt) {
  receipt = receipt || {};
  const errors = [];
  if (receipt.schemaVersion !== RECEIPT_SCHEMA) errors.push('receipt-schema-mismatch');
  if (!RESULT_SET.has(receipt.result)) errors.push('receipt-result-invalid');
  if (!str(receipt.stampIso) || !Number.isFinite(Date.parse(receipt.stampIso))) errors.push('receipt-time-invalid');
  if (containsSecretMaterial(JSON.stringify(receipt))) errors.push('receipt-secret-bearing');
  if (receipt.result !== RESULTS.BLOCKED) {
    if (!SHA40.test(lower(receipt.candidateCommit)) || !SHA40.test(lower(receipt.candidateTree))) errors.push('receipt-candidate-invalid');
    if (!normalizedArtifact(receipt.artifact)) errors.push('receipt-artifact-invalid');
  }
  if (receipt.result === RESULTS.PASS) {
    const artifact = normalizedArtifact(receipt.artifact);
    const installed = receipt.installed || {};
    if (installed.mode !== 'desktop' || !TAURI_ORIGINS.has(installed.origin)) errors.push('receipt-installed-unproven');
    if (!artifact || lower(installed.buildCommit) !== lower(receipt.candidateCommit) ||
        lower(installed.sourceTree) !== lower(receipt.candidateTree) || installed.buildDirty !== false ||
        ![KINDS.REPRODUCIBLE_SOURCE, KINDS.CUSTOM].includes(lower(installed.buildKind)) ||
        lower(installed.sidecarCommit) !== lower(receipt.candidateCommit) || installed.sidecarDirty !== false ||
        !installed.runtimeExecutable || lower(installed.runtimeExecutable.sha256) !== artifact.sha256 ||
        Number(installed.runtimeExecutable.size) !== artifact.size) errors.push('receipt-installed-candidate-mismatch');
    if (!receipt.isolation || !receipt.isolation.attended || !receipt.isolation.freshProfile || !receipt.isolation.observedFresh ||
        !receipt.isolation.machineVerified || !receipt.isolation.sidecarStorageFresh ||
        !SHA256.test(lower(receipt.isolation.principalSha256)) || !SHA256.test(lower(receipt.isolation.profileSha256)) || !SHA256.test(lower(receipt.isolation.runtimeOwnerSha256)) ||
        (receipt.isolation.authority === 'separate-windows-user' && !SHA256.test(lower(receipt.isolation.repositoryOwnerSha256))) ||
        str(receipt.isolation.id) !== str(receipt.isolation.authority) + '-' + lower(receipt.isolation.principalSha256).slice(0, 12) ||
        !ISOLATION_AUTHORITIES.has(receipt.isolation.authority)) errors.push('receipt-fresh-unproven');
    if (!receipt.provider || !receipt.provider.failureStateObserved || !receipt.provider.recovered) errors.push('receipt-provider-recovery-unproven');
    if (!receipt.overseer || !receipt.overseer.created || receipt.overseer.role !== 'orchestrator') errors.push('receipt-overseer-unproven');
    if (!receipt.task || !receipt.task.started || !receipt.task.completed || receipt.task.reason !== 'done' || !receipt.task.realProvider ||
        !receipt.task.permissionPromptObserved || !receipt.task.approvedOnce || !receipt.task.baselineAbsent ||
        !receipt.task.fsWriteObserved || !receipt.task.fsReadObserved || !receipt.task.toolsBoundToRun ||
        !SHA256.test(lower(receipt.task.runIdSha256))) errors.push('receipt-real-task-unproven');
    if (!receipt.deliverable || !receipt.deliverable.eventObserved || basename(receipt.deliverable.path).toLowerCase() !== FIRST_TASK_PATH ||
        !SHA256.test(lower(receipt.deliverable.sha256)) || Number(receipt.deliverable.size) <= 0 || !receipt.deliverable.contentVerified ||
        !receipt.deliverable.opened || !receipt.deliverable.pointerClick || !receipt.deliverable.targetBoundToBytes ||
        receipt.deliverable.openedSha256 !== receipt.deliverable.sha256 || Number(receipt.deliverable.openedSize) !== Number(receipt.deliverable.size) ||
        !SHA256.test(lower(receipt.deliverable.targetUrlSha256)) ||
        !['target-created', 'window-open-accepted', 'native-open-accepted'].includes(receipt.deliverable.mechanism)) errors.push('receipt-open-deliverable-unproven');
    if (!receipt.timing || !receipt.timing.underTenMinutes || Number(receipt.timing.totalMs) >= MAX_JOURNEY_MS) errors.push('receipt-ten-minute-bar-failed');
  }
  return { ok: errors.length === 0, errors };
}

/* Injectable orchestration core. The driver owns CDP/user actions; the core owns the
 * no-fake-green classification and the secret-free, candidate-bound receipt. */
export function makeInstalledFirstRun(options = {}) {
  const driver = options.driver || {};
  const clock = options.clock || {};
  const now = typeof clock.now === 'function' ? clock.now : () => Date.now();
  const nowIso = typeof clock.nowIso === 'function' ? clock.nowIso : () => new Date().toISOString();
  const io = options.io || {};
  const log = typeof io.log === 'function' ? io.log : () => {};
  const candidateCommit = lower(options.candidateCommit);
  const candidateTree = lower(options.candidateTree);
  const artifact = normalizedArtifact(options.artifact);
  const isolation = options.isolation || {};
  const provider = options.provider || {};
  const credential = str(provider.credential);
  const providerId = lower(provider.id);
  const model = str(provider.model).trim();

  async function run() {
    const startedAt = now();
    const state = {
      stampIso: nowIso(), result: RESULTS.BLOCKED, reasonCode: 'prerequisites-unchecked',
      candidateCommit, candidateTree, artifact, isolation,
      provider: { id: providerId, model }, steps: []
    };
    let session = null;

    const elapsed = () => Math.max(0, now() - startedAt);
    const enforceBudget = () => requireCondition(elapsed() < MAX_JOURNEY_MS, 'ten-minute-budget-exceeded', RESULTS.FAIL);
    async function step(id, fn) {
      enforceBudget();
      const start = now();
      try {
        const value = await fn(startedAt + MAX_JOURNEY_MS);
        enforceBudget();
        state.steps.push({ id, ok: true, ms: Math.max(0, now() - start), code: '' });
        return value;
      } catch (error) {
        const fault = error instanceof JourneyFault
          ? error : new JourneyFault('driver-' + id + '-failed', RESULTS.FAIL);
        state.steps.push({ id, ok: false, ms: Math.max(0, now() - start), code: fault.code });
        throw fault;
      }
    }

    try {
      requireCondition(SHA40.test(candidateCommit), 'candidate-commit-missing', RESULTS.BLOCKED);
      requireCondition(SHA40.test(candidateTree), 'candidate-tree-missing', RESULTS.BLOCKED);
      requireCondition(!!artifact, 'candidate-artifact-missing', RESULTS.BLOCKED);
      requireCondition(isolation.attended === true && isolation.freshProfile === true && SAFE_ID.test(str(isolation.id)) &&
        ISOLATION_AUTHORITIES.has(str(isolation.authority)) && isolation.machineVerified === true &&
        SHA256.test(lower(isolation.principalSha256)) && SHA256.test(lower(isolation.profileSha256)) && SHA256.test(lower(isolation.runtimeOwnerSha256)) && str(isolation.proof).trim() &&
        (str(isolation.authority) !== 'separate-windows-user' || SHA256.test(lower(isolation.repositoryOwnerSha256))) &&
        str(isolation.id) === str(isolation.authority) + '-' + lower(isolation.principalSha256).slice(0, 12),
        'isolated-fresh-profile-unattested', RESULTS.BLOCKED);
      requireCondition(provider.attended === true, 'attended-provider-action-unproven', RESULTS.BLOCKED);
      requireCondition(providerId === 'codex' || BYOK_PROVIDERS.has(providerId), 'provider-unsupported', RESULTS.BLOCKED);
      requireCondition(!!model, 'provider-model-missing', RESULTS.BLOCKED);
      if (BYOK_PROVIDERS.has(providerId)) requireCondition(credential.length >= 6, 'attended-provider-credential-missing', RESULTS.BLOCKED);
      requireCondition(typeof driver.attach === 'function', 'cdp-driver-missing', RESULTS.BLOCKED);

      session = await step('attach-installed-desktop', async deadline => {
        try { return await driver.attach({ deadline }); }
        catch (_) { throw new JourneyFault('installed-cdp-unreachable', RESULTS.BLOCKED); }
      });
      requireCondition(session && typeof session.readIdentity === 'function', 'installed-cdp-session-invalid', RESULTS.BLOCKED);

      state.identity = await step('exact-installed-identity', async () => {
        const observed = await session.readIdentity();
        const verdict = validateInstalledIdentity(observed, { candidateCommit, candidateTree, artifact });
        requireCondition(verdict.ok, verdict.errors[0] || 'installed-identity-unproven', RESULTS.BLOCKED);
        return observed;
      });

      state.fresh = await step('isolated-fresh-user', async () => {
        requireCondition(typeof session.readFreshState === 'function', 'fresh-state-driver-missing', RESULTS.BLOCKED);
        const observed = await session.readFreshState(providerId);
        const verdict = validateFreshPrecondition(observed, isolation, providerId);
        requireCondition(verdict.ok, verdict.errors[0] || 'fresh-profile-unproven', RESULTS.BLOCKED);
        return { ok: true, sidecarStorageFresh: true };
      });

      state.providerFailure = await step('visible-provider-failure', async deadline => {
        requireCondition(typeof session.exerciseProviderFailure === 'function', 'provider-failure-driver-missing', RESULTS.BLOCKED);
        const observed = await session.exerciseProviderFailure({ id: providerId, model, deadline });
        requireCondition(observed && observed.visible === true, 'provider-failure-not-visible', RESULTS.FAIL);
        requireCondition(['credential-required', 'signin-required'].includes(str(observed.kind)), 'provider-failure-wrong-state', RESULTS.FAIL);
        return { visible: true, kind: str(observed.kind) };
      });

      state.created = await step('provider-recovery-and-overseer', async deadline => {
        requireCondition(typeof session.connectProviderAndCreate === 'function', 'provider-connect-driver-missing', RESULTS.BLOCKED);
        const observed = await session.connectProviderAndCreate({ id: providerId, model, credential, deadline });
        requireCondition(observed && observed.providerConnected === true, 'provider-recovery-failed', RESULTS.FAIL);
        requireCondition(observed.overseerCreated === true && observed.agentId === 'agent' && observed.role === 'orchestrator',
          'overseer-creation-failed', RESULTS.FAIL);
        return {
          providerConnected: true, overseerCreated: true, agentId: 'agent', role: 'orchestrator'
        };
      });

      state.task = await step('real-first-task-and-file', async deadline => {
        requireCondition(typeof session.completeFirstTask === 'function', 'first-task-driver-missing', RESULTS.BLOCKED);
        const observed = await session.completeFirstTask({ deadline, taskId: FIRST_TASK_ID, path: FIRST_TASK_PATH });
        const deliverable = observed && observed.deliverable || {};
        requireCondition(observed && observed.started === true, 'real-task-never-started', RESULTS.FAIL);
        requireCondition(observed.completed === true && observed.reason === 'done', 'real-task-did-not-complete', RESULTS.FAIL);
        requireCondition(observed.realProvider === true, 'real-provider-run-unproven', RESULTS.FAIL);
        requireCondition(observed.baselineAbsent === true, 'hello-file-preexisted', RESULTS.FAIL);
        requireCondition(observed.fsWriteObserved === true && observed.fsReadObserved === true && observed.toolsBoundToRun === true,
          'run-scoped-write-read-unproven', RESULTS.FAIL);
        requireCondition(observed.permissionPromptObserved === true && observed.approvedOnce === true,
          'real-consent-loop-unproven', RESULTS.FAIL);
        requireCondition(deliverable.eventObserved === true, 'assistant-reply-is-not-a-deliverable', RESULTS.FAIL);
        requireCondition(basename(deliverable.path).toLowerCase() === FIRST_TASK_PATH, 'hello-file-not-produced', RESULTS.FAIL);
        requireCondition(SHA256.test(lower(deliverable.sha256)) && Number(deliverable.size) > 0 && deliverable.contentVerified === true,
          'hello-file-bytes-unproven', RESULTS.FAIL);
        return {
          started: true, completed: true, reason: 'done', runId: str(observed.runId), realProvider: true,
          permissionPromptObserved: true, approvedOnce: true, baselineAbsent: true,
          fsWriteObserved: true, fsReadObserved: true, toolsBoundToRun: true,
          deliverable: {
            eventObserved: true, path: str(deliverable.path), sha256: lower(deliverable.sha256),
            size: Number(deliverable.size), contentVerified: true
          }
        };
      });

      state.opened = await step('open-real-deliverable', async deadline => {
        requireCondition(typeof session.openDeliverable === 'function', 'deliverable-open-driver-missing', RESULTS.BLOCKED);
        const observed = await session.openDeliverable({ deadline, deliverable: state.task.deliverable });
        requireCondition(observed && observed.pointerClick === true, 'deliverable-open-was-not-user-action', RESULTS.FAIL);
        requireCondition(observed.opened === true, 'deliverable-open-not-observed', RESULTS.FAIL);
        requireCondition(observed.deliverableSha256 === state.task.deliverable.sha256, 'opened-deliverable-mismatch', RESULTS.FAIL);
        requireCondition(Number(observed.deliverableSize) === Number(state.task.deliverable.size) && observed.targetBoundToBytes === true &&
          SHA256.test(lower(observed.targetUrlSha256)), 'opened-deliverable-bytes-unproven', RESULTS.FAIL);
        requireCondition(['target-created', 'window-open-accepted', 'native-open-accepted'].includes(str(observed.mechanism)),
          'deliverable-open-mechanism-unproven', RESULTS.FAIL);
        return {
          pointerClick: true, opened: true, mechanism: str(observed.mechanism),
          targetScheme: str(observed.targetScheme), deliverableSha256: str(observed.deliverableSha256),
          deliverableSize: Number(observed.deliverableSize), targetUrlSha256: lower(observed.targetUrlSha256), targetBoundToBytes: true
        };
      });

      state.totalMs = elapsed();
      requireCondition(state.totalMs < MAX_JOURNEY_MS, 'ten-minute-budget-exceeded', RESULTS.FAIL);
      state.result = RESULTS.PASS;
      state.reasonCode = 'installed-first-value-proven';
    } catch (error) {
      const fault = error instanceof JourneyFault
        ? error : new JourneyFault('unexpected-runner-failure', RESULTS.FAIL);
      state.totalMs = elapsed();
      state.result = fault.result;
      state.reasonCode = fault.code;
      log('result=' + state.result + ' reason=' + state.reasonCode);
    } finally {
      if (session && typeof session.close === 'function') {
        try { await session.close(); } catch (_) {}
      }
    }

    let receipt = makeReceipt(state);
    const secrets = credential ? [credential] : [];
    if (containsSecretMaterial(JSON.stringify(receipt), secrets)) {
      state.result = RESULTS.BLOCKED; state.reasonCode = 'secret-bearing-evidence-refused';
      receipt = makeReceipt(state);
    }

    const writeEvidence = typeof io.writeEvidence === 'function' ? io.writeEvidence : () => null;
    const writeStamp = typeof io.writeStamp === 'function' ? io.writeStamp : () => '';
    const readStamp = typeof io.readStamp === 'function' ? io.readStamp : () => null;
    let evidence = null;
    try { evidence = normalizedEvidence(writeEvidence(receipt)); } catch (_) { evidence = null; }
    if (!evidence) {
      state.result = RESULTS.BLOCKED; state.reasonCode = 'journey-evidence-write-failed';
      receipt = makeReceipt(state);
      return { result: state.result, receipt, evidence: null };
    }

    let stamp = Object.assign({}, receipt, { evidence: [evidence] });
    let stampPath = '';
    try { stampPath = str(writeStamp(stamp)); } catch (_) { stampPath = ''; }
    let persisted = null;
    try { persisted = readStamp(); } catch (_) {}
    const valid = validateJourneyReceipt(stamp);
    if (!stampPath || !valid.ok || JSON.stringify(persisted) !== JSON.stringify(stamp)) {
      state.result = RESULTS.BLOCKED; state.reasonCode = 'journey-receipt-readback-failed';
      receipt = makeReceipt(state);
      stamp = Object.assign({}, receipt, { evidence: [evidence] });
      try { stampPath = str(writeStamp(stamp)); } catch (_) {}
    }
    log('result=' + state.result + ' evidence=' + evidence.path + ' receipt=' + stampPath);
    return { result: state.result, receipt: stamp, evidence, stampPath };
  }

  return { run };
}

/* ─────────────────────────────── REAL CDP DRIVER ─────────────────────────────── */

export const INSTALLED_IDENTITY_PROBE = `(async () => {
  const out = { origin: String(location.origin || ''), mode: '', shell: null, version: null };
  try {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') return out;
    out.shell = await core.invoke('starnet_build_info');
  } catch (_) {}
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    if (r && r.ok) out.version = await r.json();
  } catch (_) {}
  try {
    const r = await fetch('/api/diagnostics', { cache: 'no-store' });
    if (r && r.ok) {
      const j = await r.json(); const report = j && j.report ? j.report : j;
      out.mode = String(report && report.mode || '');
    }
  } catch (_) {}
  return out;
})()`;

const OBSERVER_INSTALL = `(() => {
  if (window.__STARNET_W1_OBS__) return true;
  if (typeof U === 'undefined' || !U.bus) return false;
  const out = window.__STARNET_W1_OBS__ = { seq: 0, starts: [], ends: [], calls: [], results: [], deliverables: [], permissions: [], responses: [] };
  const cap = (a, v) => { v.seq = ++out.seq; a.push(v); if (a.length > 40) a.shift(); };
  U.bus.on('agent.run.start', p => cap(out.starts, { runId: String(p && p.runId || ''), agentId: String(p && p.agentId || ''), model: String(p && p.model || '') }));
  U.bus.on('agent.run.end', p => cap(out.ends, { runId: String(p && p.runId || ''), agentId: String(p && p.agentId || ''), reason: String(p && p.reason || '') }));
  U.bus.on('agent.tool_call', p => cap(out.calls, { runId: String(p && p.runId || ''), agentId: String(p && p.agentId || ''), callId: String(p && p.callId || ''), name: String(p && p.name || ''), argsSummary: String(p && p.argsSummary || '') }));
  U.bus.on('agent.tool_result', p => cap(out.results, { runId: String(p && p.runId || ''), agentId: String(p && p.agentId || ''), callId: String(p && p.callId || ''), ok: p && p.ok === true, isError: p && p.isError === true }));
  U.bus.on('deliverable', p => cap(out.deliverables, { title: String(p && p.title || ''), kind: String(p && p.kind || ''), agentId: String(p && p.agentId || '') }));
  U.bus.on('permission.prompt', p => cap(out.permissions, { promptId: String(p && p.promptId || ''), agentId: String(p && p.agentId || ''), tool: String(p && p.tool || ''), argsSummary: String(p && p.argsSummary || '') }));
  U.bus.on('permission.response', p => cap(out.responses, { promptId: String(p && p.promptId || ''), decision: String(p && p.decision || '') }));
  return true;
})()`;

function cdpDeadline(deadline, capMs) {
  return Math.min(Number(deadline) || (Date.now() + capMs), Date.now() + capMs);
}


export function makeCdpInstalledDriver(options = {}) {
  const port = Number(options.port) || 9333;
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;

  return {
    async attach() {
      const cdp = await connectCDP(port);
      try { await cdp.send('Runtime.enable'); } catch (_) {}
      try { await cdp.send('Page.enable'); } catch (_) {}

      async function waitValue(read, deadline, interval = 250) {
        while (Date.now() < deadline) {
          let value = null;
          try { value = await read(); } catch (_) {}
          if (value) return value;
          await sleepFn(interval);
        }
        return null;
      }

      async function rectFor(selector, text) {
        const result = await evalJS(cdp, `(() => {
          const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
          const want = ${JSON.stringify(text || '')}.trim().toLowerCase();
          const el = nodes.find(n => {
            const r = n.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden';
            return visible && (!want || String(n.textContent || '').trim().toLowerCase() === want);
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
        })()`);
        return result && result.width > 0 && result.height > 0 ? result : null;
      }

      async function clickAt(x, y) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }

      async function clickSelector(selector, text) {
        const rect = await rectFor(selector, text);
        if (!rect) return false;
        await clickAt(rect.x, rect.y);
        return true;
      }

      async function pressEnter() {
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, key));
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
      }

      async function fill(selector, value) {
        const rect = await rectFor(selector);
        if (!rect) return false;
        await clickAt(rect.x, rect.y);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
        await cdp.send('Input.insertText', { text: str(value) });
        return true;
      }

      async function ensureConnect(deadline) {
        return !!(await waitValue(async () => {
          const screen = await evalJS(cdp, `((document.querySelector('.screen.active') || {}).id || '')`);
          if (screen === 'screen-splash') { await pressEnter(); return false; }
          if (screen !== 'screen-connect') return false;
          return await evalJS(cdp, `(() => {
            const ids = ['in-name','in-key','in-model','btn-wake'];
            return ids.every(id => { const e = document.getElementById(id); return !!(e && e.getBoundingClientRect().width); });
          })()`);
        }, cdpDeadline(deadline, 45000), 300));
      }

      async function pageState() {
        return await evalJS(cdp, `(() => {
          const visible = e => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
          const caps = (() => { try { return (World.heroCaps('agent') || []).map(c => typeof c === 'string' ? c : String(c && c.id || '')); } catch (_) { return []; } })();
          const obs = window.__STARNET_W1_OBS__ || { starts: [], ends: [], deliverables: [], permissions: [], responses: [] };
          const option = Array.from(document.querySelectorAll('#chat-panel .fnv-opts button.fnv-opt')).find(b => visible(b) && !b.classList.contains('skip') && !b.classList.contains('custom'));
          const consent = Array.from(document.querySelectorAll('.cmsg.consent .consent-btn')).find(b => visible(b) && String(b.textContent || '').trim() === 'Approve once');
          const link = Array.from(document.querySelectorAll('.cmsg.deliverable .deliverable-link, .cmsg.recap .deliverable-link')).find(a => visible(a) && /(^|[\\/])hello\.txt$/i.test(String(a.title || a.textContent || '').trim()));
          return {
            screen: String((document.querySelector('.screen.active') || {}).id || ''),
            dialogueOption: !!option, consent: !!consent, link: !!link,
            buildOpen: !!(typeof Build !== 'undefined' && Build.isOpen && Build.isOpen()),
            caps, observer: JSON.parse(JSON.stringify(obs)), busy: !!(typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy())
          };
        })()`);
      }

      let placementAttempt = 0;
      let connectedProviderId = '';
      let connectedModel = '';
      const placementPoints = [
        [0.50, 0.43], [0.60, 0.43], [0.40, 0.43], [0.70, 0.43], [0.30, 0.43],
        [0.50, 0.55], [0.60, 0.55], [0.40, 0.55], [0.70, 0.55], [0.30, 0.55],
        [0.50, 0.31], [0.60, 0.31], [0.40, 0.31], [0.70, 0.31], [0.30, 0.31]
      ];

      async function placeCabinetByPointer() {
        const rect = await rectFor('.refit-canvas');
        if (!rect) return false;
        const p = placementPoints[placementAttempt++ % placementPoints.length];
        const left = rect.x - rect.width / 2, top = rect.y - rect.height / 2;
        await clickAt(left + rect.width * p[0], top + rect.height * p[1]);
        return true;
      }

      async function fileProof() {
        return await evalJS(cdp, `(async () => {
          try {
            const r = (typeof Harness !== 'undefined' && Harness.apiFetch)
              ? await Harness.apiFetch('/api/file?agent=agent&path=' + encodeURIComponent('hello.txt'), { cache: 'no-store' })
              : await fetch('/api/file?agent=agent&path=' + encodeURIComponent('hello.txt'), { cache: 'no-store' });
            if (!r) return { known: false, exists: null };
            if (r.status === 404) return { known: true, exists: false };
            if (!r.ok) return { known: false, exists: null, status: Number(r.status) || 0 };
            const bytes = new Uint8Array(await r.arrayBuffer());
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
            const text = new TextDecoder().decode(bytes);
            return { known: true, exists: true, path: 'hello.txt', sha256: hash, size: bytes.byteLength, contentVerified: text.trim() === 'starnet online' };
          } catch (_) { return { known: false, exists: null }; }
        })()`);
      }

      return {
        async readIdentity() { return await evalJS(cdp, INSTALLED_IDENTITY_PROBE); },

        async readFreshState(providerId) {
          const ready = await waitValue(async () => {
            const screen = await evalJS(cdp, `((document.querySelector('.screen.active') || {}).id || '')`);
            return ['screen-splash', 'screen-connect'].includes(screen) ? screen : null;
          }, Date.now() + 45000, 300);
          if (!ready) throw new JourneyFault('fresh-screen-timeout', RESULTS.BLOCKED);
          return await evalJS(cdp, `(async () => {
            const provider = ${JSON.stringify(lower(providerId))};
            const activeScreen = String((document.querySelector('.screen.active') || {}).id || '');
            let status = 'error', present = true, current = true, count = -1, configured = true;
            try { const s = Save.loadStatus(); status = String(s && s.status || 'error'); present = !!Save.has(); } catch (_) {}
            try { current = !!App.currentAgent(); count = (App.agents() || []).length; } catch (_) {}
            try { configured = !!Harness.configured(provider); } catch (_) {}
            const recovery = document.getElementById('cc-recovery');
            const apiJson = async (url) => {
              try {
                const r = (typeof Harness !== 'undefined' && Harness.apiFetch) ? await Harness.apiFetch(url, { cache: 'no-store' }) : await fetch(url, { cache: 'no-store' });
                return r && r.ok ? await r.json() : null;
              } catch (_) { return null; }
            };
            const save = await apiJson('/api/save?agent=agent');
            const runs = await apiJson('/api/runs?agent=agent&limit=1');
            const diagnostics = await apiJson('/api/diagnostics');
            const report = diagnostics && diagnostics.report;
            return { activeScreen, saveStatus: status, savePresent: present, currentAgentPresent: current,
              rosterCount: count, recoveryVisible: !!(recovery && !recovery.classList.contains('hidden')),
              providerChecked: provider, providerConfigured: configured,
              backendSavePresent: save ? !!save.save : null,
              backendRecoveryPresent: save ? !!save.recovery : null,
              backendWorkspaceDegraded: save ? save.degraded === true : null,
              backendRunCount: runs && Array.isArray(runs.runs) ? runs.runs.length : -1,
              backendAgentCount: report && Number.isFinite(Number(report.agentCount)) ? Number(report.agentCount) : -1,
              backendLastRunPresent: report ? !!report.lastRun : null };
          })()`);
        },

        async exerciseProviderFailure({ id, model, deadline }) {
          if (!await ensureConnect(deadline)) throw new JourneyFault('connect-screen-timeout', RESULTS.FAIL);
          const stale = await evalJS(cdp, `(() => {
            const e = document.getElementById('connect-msg'); if (!e) return false;
            const r = e.getBoundingClientRect(), s = getComputedStyle(e), m = String(e.textContent || '').toLowerCase();
            const visible = r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
            return visible && /sign in.*chatgpt|sign in first|api key|enter your .* key/.test(m);
          })()`);
          if (stale) throw new JourneyFault('provider-failure-state-stale', RESULTS.FAIL);
          if (!await clickSelector('.prov[data-prov="' + lower(id) + '"]')) throw new JourneyFault('provider-control-missing', RESULTS.FAIL);
          if (!await fill('#in-name', 'W1 OVERSEER')) throw new JourneyFault('overseer-name-control-missing', RESULTS.FAIL);
          if (!await fill('#in-model', model)) throw new JourneyFault('provider-model-control-missing', RESULTS.FAIL);
          if (id !== 'codex') await fill('#in-key', '');
          if (!await clickSelector('#btn-wake')) throw new JourneyFault('wake-control-missing', RESULTS.FAIL);
          const kind = await waitValue(async () => {
            return await evalJS(cdp, `(() => {
              const e = document.getElementById('connect-msg'); if (!e) return '';
              const r = e.getBoundingClientRect(), s = getComputedStyle(e);
              if (!(r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0)) return '';
              const m = String(e.textContent || '').toLowerCase();
              if (/sign in.*chatgpt|sign in first/.test(m)) return 'signin-required';
              if (/api key|enter your .* key/.test(m)) return 'credential-required';
              return '';
            })()`);
          }, cdpDeadline(deadline, 15000), 250);
          return { visible: !!kind, kind: str(kind) };
        },

        async connectProviderAndCreate({ id, model, credential, deadline }) {
          if (id === 'codex') {
            if (!await clickSelector('#btn-codex-signin')) throw new JourneyFault('codex-signin-control-missing', RESULTS.FAIL);
            const connected = await waitValue(async () => await evalJS(cdp, `(() => {
              const e = document.getElementById('codex-status'); return !!(e && e.classList.contains('ok'));
            })()`), cdpDeadline(deadline, 5 * 60 * 1000), 1000);
            if (!connected) throw new JourneyFault('attended-codex-signin-timeout', RESULTS.FAIL);
            await fill('#in-model', model);
          } else {
            if (!await fill('#in-key', credential)) throw new JourneyFault('provider-credential-control-missing', RESULTS.FAIL);
          }
          if (!await clickSelector('#btn-wake')) throw new JourneyFault('wake-control-missing', RESULTS.FAIL);
          const created = await waitValue(async () => await evalJS(cdp, `(() => {
            const game = document.getElementById('screen-game');
            const a = (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null;
            if (!game || !game.classList.contains('active') || !a) return null;
            const provider = String(a.provider || (Harness.getProv && Harness.getProv()) || '').toLowerCase();
            return { providerConnected: provider === ${JSON.stringify(lower(id))}, overseerCreated: a.id === 'agent', agentId: String(a.id || ''), role: String(a.role || '') };
          })()`), cdpDeadline(deadline, 45000), 300);
          if (!created) throw new JourneyFault('overseer-create-timeout', RESULTS.FAIL);
          const observerReady = await evalJS(cdp, OBSERVER_INSTALL);
          if (!observerReady) throw new JourneyFault('journey-observer-unavailable', RESULTS.BLOCKED);
          connectedProviderId = lower(id);
          connectedModel = str(model);
          return created;
        },

        async completeFirstTask({ deadline }) {
          const baseline = await fileProof();
          if (!baseline || baseline.known !== true) throw new JourneyFault('hello-file-baseline-unreadable', RESULTS.BLOCKED);
          if (baseline.exists !== false) throw new JourneyFault('hello-file-preexisted', RESULTS.FAIL);
          while (Date.now() < deadline) {
            const state = await pageState();
            const starts = state.observer && state.observer.starts || [];
            const ends = state.observer && state.observer.ends || [];
            const calls = state.observer && state.observer.calls || [];
            const results = state.observer && state.observer.results || [];
            const deliverables = state.observer && state.observer.deliverables || [];
            const permissions = state.observer && state.observer.permissions || [];
            const responses = state.observer && state.observer.responses || [];
            const start = starts.find(x => x && x.agentId === 'agent') || null;
            const end = start ? [...ends].reverse().find(x => x && x.runId === start.runId) : null;
            const inRun = x => start && x && Number(x.seq) > Number(start.seq) && (!end || Number(x.seq) < Number(end.seq));
            const runCalls = start ? calls.filter(x => x && x.runId === start.runId && x.agentId === 'agent') : [];
            const helloArg = value => /(^|["'\\/])hello\.txt(["'\\/,}]|$)/i.test(value || '');
            const writeCall = runCalls.find(x => x.name === 'fs.write' && helloArg(x.argsSummary)) || null;
            const readCall = runCalls.find(x => x.name === 'fs.read' && helloArg(x.argsSummary)) || null;
            const resultOk = call => !!(call && results.find(x => x && x.runId === start.runId && x.callId === call.callId && x.ok === true && x.isError === false));
            const prompt = permissions.find(x => inRun(x) && x.agentId === 'agent' && x.tool === 'fs.write' && helloArg(x.argsSummary)) || null;
            const approval = prompt ? responses.find(x => inRun(x) && x.promptId === prompt.promptId && x.decision === 'once') : null;
            const event = [...deliverables].reverse().find(x => inRun(x) && x.agentId === 'agent' && basename(x.title).toLowerCase() === FIRST_TASK_PATH) || null;
            if (start && end && writeCall && readCall && resultOk(writeCall) && resultOk(readCall) && prompt && approval && event && state.link) {
              const proof = await fileProof();
              if (!proof || proof.known !== true || proof.exists !== true) throw new JourneyFault('hello-file-postrun-unreadable', RESULTS.FAIL);
              return {
                started: true, completed: end.reason === 'done', reason: end.reason, runId: start.runId,
                realProvider: !!connectedProviderId && connectedProviderId !== 'replay' && str(start.model) === connectedModel,
                permissionPromptObserved: true, approvedOnce: true, baselineAbsent: true,
                fsWriteObserved: true, fsReadObserved: true, toolsBoundToRun: true,
                deliverable: Object.assign({ eventObserved: true }, proof)
              };
            }

            if (state.consent) {
              await clickSelector('.cmsg.consent .consent-btn', 'Approve once');
              await sleepFn(350); continue;
            }

            const caps = new Set((state.caps || []).map(lower));
            const hasCabinet = caps.has('cabinet');
            const allCaps = ['cabinet', 'dish', 'workbench', 'notebook'].every(cap => caps.has(cap));
            if (state.buildOpen) {
              if (allCaps) { await clickSelector('#refit-done'); await sleepFn(400); continue; }
              if (hasCabinet) {
                const req = await clickSelector('.tut-coach .tut-coach-ok', '⚡ requisition the rest');
                if (req) { await sleepFn(1200); continue; }
              } else {
                const toolActive = await evalJS(cdp, `!!document.querySelector('.refit-tool[data-tool="prop"].active')`);
                if (!toolActive) { await clickSelector('.refit-tool[data-tool="prop"]'); await sleepFn(300); continue; }
                const tierActive = await evalJS(cdp, `!!document.querySelector('.refit-tier-functional.active')`);
                if (!tierActive) { await clickSelector('.refit-tier-functional'); await sleepFn(300); continue; }
                const catActive = await evalJS(cdp, `!!document.querySelector('.refit-propcat[data-cat="capability"].active')`);
                if (!catActive) { await clickSelector('.refit-propcat[data-cat="capability"]'); await sleepFn(300); continue; }
                const propActive = await evalJS(cdp, `!!document.querySelector('.refit-proptile[data-prop="war_intelcab"].active')`);
                if (!propActive) { await clickSelector('.refit-proptile[data-prop="war_intelcab"]'); await sleepFn(300); continue; }
                await placeCabinetByPointer(); await sleepFn(500); continue;
              }
            }

            if (state.dialogueOption) {
              await clickSelector('#chat-panel .fnv-opts button.fnv-opt:not(.skip):not(.custom)');
              await sleepFn(500); continue;
            }
            if (await clickSelector('#bb-build')) { await sleepFn(400); continue; }
            if (await clickSelector('.bb-group[data-group="build"] .bb-grp')) { await sleepFn(400); continue; }
            await sleepFn(300);
          }
          throw new JourneyFault('first-task-timeout', RESULTS.FAIL);
        },

        async openDeliverable({ deadline, deliverable }) {
          // The deliverable link is a REAL /api/file href (authed by a file-scoped, short-lived ?ticket= —
          // the sidecar's documented native-load escape hatch; never the master token). In the installed desktop build a _blank navigation is dead under the
          // Tauri window policy, so the click hands that URL to the OS browser via the open_external_url
          // command — instrument the invoke bridge to capture the handed URL, then bind that URL to the
          // exact task bytes by fetching it IN-PAGE (which also proves the ?ticket= auth the link relies on).
          await evalJS(cdp, `(() => {
            if (window.__STARNET_W1_OPEN_INSTRUMENTED__) return true;
            const core = window.__TAURI__ && window.__TAURI__.core;
            if (!core || typeof core.invoke !== 'function') return false;
            const original = core.invoke.bind(core);
            window.__STARNET_W1_INVOKE_ORIGINAL__ = core.invoke;
            window.__STARNET_W1_OPEN_CALLS__ = [];
            core.invoke = function(cmd, args) {
              if (String(cmd) !== 'open_external_url') return original(cmd, args);
              const url = String((args && args.url) || '');
              let scheme = ''; try { scheme = new URL(url, location.href).protocol; } catch (_) {}
              const rec = { accepted: false, scheme, url };
              window.__STARNET_W1_OPEN_CALLS__.push(rec);
              return original(cmd, args).then(v => { rec.accepted = true; return v; });
            };
            window.__STARNET_W1_OPEN_INSTRUMENTED__ = true;
            return true;
          })()`);
          const expectedSha256 = lower(deliverable && deliverable.sha256);
          const expectedSize = Number(deliverable && deliverable.size) || 0;
          const clicked = await clickSelector('.cmsg.deliverable .deliverable-link, .cmsg.recap .deliverable-link', 'hello.txt');
          if (!clicked) return { pointerClick: false, opened: false, deliverableSha256: '', deliverableSize: 0, targetBoundToBytes: false };
          const observed = await waitValue(async () => {
            const proof = await evalJS(cdp, `(async () => {
              const calls = window.__STARNET_W1_OPEN_CALLS__ || [];
              const call = calls.length ? calls[calls.length - 1] : null;
              if (!call || !call.url || call.accepted !== true) return null;
              const res = await fetch(call.url, { cache: 'no-store' });   // auth rides the URL itself — no header
              if (!res.ok) return null;
              const bytes = new Uint8Array(await res.arrayBuffer());
              const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value))).map(b => b.toString(16).padStart(2, '0')).join('');
              return {
                scheme: call.scheme,
                targetUrlSha256: await digest(new TextEncoder().encode(call.url)),
                deliverableSha256: await digest(bytes), deliverableSize: bytes.byteLength,
                contentVerified: new TextDecoder().decode(bytes).trim() === ${JSON.stringify(FIRST_TASK_CONTENT)}
              };
            })()`);
            if (!proof || proof.deliverableSha256 !== expectedSha256 ||
                Number(proof.deliverableSize) !== expectedSize || proof.contentVerified !== true) return null;
            return Object.assign({ mechanism: 'native-open-accepted', targetScheme: proof.scheme }, proof);
          }, cdpDeadline(deadline, 12000), 250);
          return {
            pointerClick: true, opened: !!observed,
            mechanism: observed ? observed.mechanism : '', targetScheme: observed ? observed.targetScheme : '',
            deliverableSha256: observed ? observed.deliverableSha256 : '',
            deliverableSize: observed ? Number(observed.deliverableSize) : 0,
            targetUrlSha256: observed ? observed.targetUrlSha256 : '', targetBoundToBytes: !!observed
          };
        },

        async close() {
          try {
            await evalJS(cdp, `(() => {
              if (window.__STARNET_W1_OPEN_INSTRUMENTED__ && window.__STARNET_W1_INVOKE_ORIGINAL__ && window.__TAURI__ && window.__TAURI__.core) window.__TAURI__.core.invoke = window.__STARNET_W1_INVOKE_ORIGINAL__;
              delete window.__STARNET_W1_INVOKE_ORIGINAL__;
              delete window.__STARNET_W1_OPEN_CALLS__; delete window.__STARNET_W1_OPEN_INSTRUMENTED__;
              return true;
            })()`);
          } catch (_) {}
          try { cdp.ws.close(); } catch (_) {}
        }
      };
    }
  };
}

/* ─────────────────────────────── CLI AMBIENT IO ─────────────────────────────── */

const INVOKED_DIRECTLY = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

function hashFile(file) {
  try {
    const resolved = path.resolve(file);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0) return null;
    const bytes = fs.readFileSync(resolved);
    return { path: resolved, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  } catch (_) { return null; }
}

function commandText(file, args) {
  try {
    const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return result.status === 0 ? str(result.stdout).trim() : '';
  } catch (_) { return ''; }
}

/* The installed WebView ignores process-local APPDATA redirection, so isolation cannot be an
 * operator-chosen label. Derive a pseudonymous principal/profile identity from this process and
 * require a machine fact appropriate to the selected authority. Raw user names, SIDs, host names,
 * and profile paths never enter evidence. */
export function runtimeIsolation(authority, cdpPort) {
  authority = str(authority).trim();
  let user = '', uid = '', profile = '', sid = '';
  try { const info = os.userInfo(); user = str(info.username); uid = str(info.uid); profile = str(info.homedir); } catch (_) {}
  profile = str(process.env.USERPROFILE || profile);
  if (process.platform === 'win32') {
    sid = (commandText('whoami.exe', ['/user', '/fo', 'csv', '/nh']).match(/S-1-[0-9-]+/i) || [])[0] || '';
  }
  const host = str(os.hostname()).toLowerCase();
  const principalSha256 = sha256Text([host, lower(user), sid || uid].join('\0'));
  const profileSha256 = sha256Text(path.resolve(profile || '.').toLowerCase());
  let runtimeOwnerSha256 = '';
  if (process.platform === 'win32' && sid && Number.isInteger(Number(cdpPort)) && Number(cdpPort) > 0) {
    const ownerSid = commandText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$p=(Get-NetTCPConnection -State Listen -LocalPort " + Number(cdpPort) + " -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if($p){$w=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p); (Invoke-CimMethod -InputObject $w -MethodName GetOwnerSid).Sid}"]);
    if (ownerSid) runtimeOwnerSha256 = sha256Text([host, lower(ownerSid)].join('\0'));
  }
  const currentOwnerSha256 = sid ? sha256Text([host, lower(sid)].join('\0')) : '';
  const runtimeOwnerMatches = SHA256.test(runtimeOwnerSha256) && runtimeOwnerSha256 === currentOwnerSha256;
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const quotedRepo = repo.replace(/'/g, "''");
  const repositoryOwnerSid = process.platform === 'win32' ? commandText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$o=(Get-Acl -LiteralPath '" + quotedRepo + "').Owner; ([System.Security.Principal.NTAccount]$o).Translate([System.Security.Principal.SecurityIdentifier]).Value"]) : '';
  const repositoryOwnerSha256 = repositoryOwnerSid ? sha256Text([host, lower(repositoryOwnerSid)].join('\0')) : '';
  let machineVerified = false, proof = '';
  if (authority === 'separate-windows-user') {
    machineVerified = process.platform === 'win32' && !!sid && runtimeOwnerMatches && SHA256.test(repositoryOwnerSha256) && repositoryOwnerSha256 !== currentOwnerSha256;
    proof = machineVerified ? 'distinct-repository-owner-principal' : '';
  } else if (authority === 'virtual-machine') {
    const system = process.platform === 'win32' ? commandText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$c=Get-CimInstance Win32_ComputerSystem; (($c.Manufacturer)+' '+($c.Model))"]) : '';
    machineVerified = runtimeOwnerMatches && /virtual|vmware|hyper-v|virtualbox|kvm|qemu|parallels|xen/i.test(system);
    proof = machineVerified ? 'hypervisor-detected' : '';
  } else if (authority === 'clean-machine') {
    // "Clean" is StarNet state, not Windows age. The CDP listener must belong to this principal here;
    // readFreshState then independently proves empty browser + sidecar stores before any mutation.
    machineVerified = runtimeOwnerMatches;
    proof = machineVerified ? 'runtime-owner-plus-empty-starnet-stores' : '';
  }
  return {
    id: authority + '-' + principalSha256.slice(0, 12), authority,
    freshProfile: process.env.STARNET_FIRST_RUN_FRESH_PROFILE === '1',
    attended: process.env.STARNET_FIRST_RUN_ATTENDED === '1',
    machineVerified, proof, principalSha256, profileSha256, runtimeOwnerSha256, repositoryOwnerSha256
  };
}

if (INVOKED_DIRECTLY) (async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, '..', '..');
  const candidateCommit = lower(process.env.STARNET_PRODUCT_PERFECT_CANDIDATE_SHA || process.env.STARNET_FIRST_RUN_EXPECTED_HEAD);
  const candidateTree = (() => {
    if (!SHA40.test(candidateCommit)) return '';
    const result = spawnSync('git', ['rev-parse', candidateCommit + '^{tree}'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    const value = lower(result.stdout);
    return result.status === 0 && SHA40.test(value) ? value : '';
  })();
  const artifactObserved = hashFile(process.env.STARNET_FIRST_RUN_ARTIFACT || process.env.STARNET_SMOKE_ARTIFACT || '');
  const expectedArtifactSha256 = lower(process.env.STARNET_FIRST_RUN_EXPECTED_ARTIFACT_SHA256);
  const expectedArtifactSize = Number(process.env.STARNET_FIRST_RUN_EXPECTED_ARTIFACT_SIZE);
  const artifact = artifactObserved && SHA256.test(expectedArtifactSha256) && Number.isSafeInteger(expectedArtifactSize) && expectedArtifactSize > 0 &&
    artifactObserved.sha256 === expectedArtifactSha256 && artifactObserved.size === expectedArtifactSize ? artifactObserved : null;
  const port = Number(process.env.STARNET_FIRST_RUN_CDP_PORT || process.env.STARNET_SMOKE_CDP_PORT) || 9333;
  const attended = process.env.STARNET_FIRST_RUN_ATTENDED === '1';
  const isolation = runtimeIsolation(process.env.STARNET_FIRST_RUN_ISOLATION_AUTHORITY, port);
  const provider = {
    id: lower(process.env.STARNET_FIRST_RUN_PROVIDER || 'openrouter'),
    model: str(process.env.STARNET_FIRST_RUN_MODEL).trim(),
    credential: str(process.env.STARNET_FIRST_RUN_PROVIDER_SECRET),
    attended
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(repo, 'qa', 'installed', 'smoke-' + stamp + '-first-run');
  const evidenceFile = path.join(runDir, 'journey.json');
  const receiptFile = path.join(runDir, 'receipt.json');
  const rel = file => path.relative(repo, file).replace(/\\/g, '/');

  const io = {
    log: (...parts) => console.log('[qa:first-run:installed]', ...parts),
    writeEvidence(receipt) {
      try {
        const text = JSON.stringify(receipt, null, 2) + '\n';
        if (containsSecretMaterial(text, provider.credential ? [provider.credential] : [])) return null;
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(evidenceFile, text, 'utf8');
        const bytes = fs.readFileSync(evidenceFile);
        return { path: rel(evidenceFile), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      } catch (_) { return null; }
    },
    writeStamp(receipt) {
      try {
        const text = JSON.stringify(receipt, null, 2) + '\n';
        if (containsSecretMaterial(text, provider.credential ? [provider.credential] : [])) return '';
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(receiptFile, text, 'utf8');
        return rel(receiptFile);
      } catch (_) { return ''; }
    },
    readStamp() {
      try { return JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
      catch (_) { return null; }
    }
  };

  io.log('candidate=' + (candidateCommit || '(missing)') + ' cdp=127.0.0.1:' + port +
    ' isolation=' + (isolation.authority || '(missing)') + '/' + (isolation.id || '(missing)') +
    ' provider=' + (provider.id || '(missing)'));
  if (!artifact) io.log('BLOCKED — artifact path bytes must match gate-minted STARNET_FIRST_RUN_EXPECTED_ARTIFACT_SHA256/SIZE');
  if (!ISOLATION_AUTHORITIES.has(isolation.authority)) {
    io.log('BLOCKED — isolation authority must be separate-windows-user, virtual-machine, or clean-machine; APPDATA/LOCALAPPDATA process redirection is not isolation');
  }
  if (ISOLATION_AUTHORITIES.has(isolation.authority) && !isolation.machineVerified) {
    io.log('BLOCKED — isolation authority was not machine-verified (the installed CDP listener must belong to this principal; separate-user mode also requires a different repository owner, VM mode requires detected virtualization)');
  }
  if (!provider.model) io.log('BLOCKED — set STARNET_FIRST_RUN_MODEL');
  if (BYOK_PROVIDERS.has(provider.id) && !provider.credential) io.log('BLOCKED — set STARNET_FIRST_RUN_PROVIDER_SECRET in the attended shell (its value is never logged or written)');

  const runner = makeInstalledFirstRun({
    driver: makeCdpInstalledDriver({ port }), candidateCommit, candidateTree, artifact,
    isolation, provider, io
  });
  const result = await runner.run();
  process.exit(result.result === RESULTS.PASS ? 0 : (result.result === RESULTS.FAIL ? 1 : 2));
})();
