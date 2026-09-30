'use strict';
/* harness-import.test.js — pure-engine tests for the IMPORT-AN-AGENT read core. No IO — the module is dependency-
   free (index.js does the filesystem work + hands it plain strings). Proves:
     - detectCandidates builds the right base roots on win32 + posix, honoring HERMES_HOME / OPENCLAW_STATE_DIR;
     - openclaw.json JSON5 tolerance (line + block comments, trailing commas) parses, and "provider/model" splits;
     - Hermes config.yaml model extraction handles quoted + unquoted scalars (block and inline forms);
     - the SECRETS LAW: a config carrying api_key / an env block never leaks a value into the preview, and the
       "re-enter your key" warning appears EXACTLY once;
     - text clamps (persona clipped to 16000), name extraction variants, and empty-map -> ok:false. */
const assert = require('assert');
const H = require('../sidecar/harness-import.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ---- detectCandidates: win32 ----
const win = H.detectCandidates({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\andro', LOCALAPPDATA: 'C:\\Users\\andro\\AppData\\Local' } });
const winOc = win.find(c => c.harness === 'openclaw');
const winHm = win.find(c => c.harness === 'hermes');
eq(winOc.root, 'C:\\Users\\andro\\.openclaw', 'win32 openclaw state = %USERPROFILE%\\.openclaw');
eq(winOc.kind, 'state', 'openclaw candidate kind is state');
eq(winHm.root, 'C:\\Users\\andro\\AppData\\Local\\hermes', 'win32 hermes home = %LOCALAPPDATA%\\hermes');
eq(winHm.kind, 'home', 'hermes candidate kind is home');

// ---- detectCandidates: posix + overrides ----
const nix = H.detectCandidates({ platform: 'linux', env: { HOME: '/home/andro' } });
eq(nix.find(c => c.harness === 'openclaw').root, '/home/andro/.openclaw', 'posix openclaw state = ~/.openclaw');
eq(nix.find(c => c.harness === 'hermes').root, '/home/andro/.hermes', 'posix hermes home = ~/.hermes');

const over = H.detectCandidates({ platform: 'linux', env: { HOME: '/home/x', HERMES_HOME: '/custom/hermes', OPENCLAW_STATE_DIR: '/custom/oc' } });
eq(over.find(c => c.harness === 'hermes').root, '/custom/hermes', 'HERMES_HOME override wins');
eq(over.find(c => c.harness === 'openclaw').root, '/custom/oc', 'OPENCLAW_STATE_DIR override wins');

// a candidate with no env inputs is simply omitted (honest — nothing to point at)
const bare = H.detectCandidates({ platform: 'win32', env: {} });
eq(bare.length, 0, 'no env => no candidates (not a throw)');

// ---- filesWanted: base tagging ----
const ocWanted = H.filesWanted('openclaw');
eq(ocWanted.find(w => w.rel === 'openclaw.json').base, 'state', 'openclaw.json resolves against the STATE dir');
eq(ocWanted.find(w => w.rel === 'SOUL.md').base, 'root', 'SOUL.md resolves against the workspace root');
ok(H.filesWanted('hermes').every(w => w.base === 'root'), 'every hermes file resolves against the home root');

// ---- OpenClaw JSON5 tolerance + model split ----
const oc5 = `{
  // the default model chain
  "agents": {
    "defaults": { "model": { "primary": "anthropic/claude-3-5-sonnet", } },  /* trailing comma above */
    "list": [ { "id": "main", "default": true }, { "id": "scout", "workspace": "workspace-scout" }, ]
  },
}`;
const cfg = H.parseJson5(oc5);
ok(cfg && cfg.agents, 'JSON5 with // + block comments + trailing commas parses');
const ocm = H.openclawModel(cfg);
eq(ocm.provider, 'anthropic', 'openclaw model provider split from "provider/model"');
eq(ocm.model, 'claude-3-5-sonnet', 'openclaw model id split from "provider/model"');
eq(ocm.raw, 'anthropic/claude-3-5-sonnet', 'openclaw model raw kept');
const agents = H.openclawAgents(cfg);
eq(agents.length, 2, 'agents.list enumerated');
eq(agents[1].workspace, 'workspace-scout', 'explicit per-agent workspace carried');

// ---- JSON5 with UNQUOTED KEYS (the live-repro fixture: real OpenClaw configs use bare identifier keys) ----
const ocBare = `{
  // comment
  agents: {
    defaults: { model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.2",], }, },
    list: [ { id: "main", default: true, }, ],
  },
  env: { ANTHROPIC_API_KEY: "sk-ant-FAKE-1234", },
}`;
const bcfg = H.parseJson5(ocBare);
ok(bcfg && bcfg.agents, 'JSON5 with bare identifier keys parses (live-repro fixture)');
eq(H.openclawModel(bcfg).provider, 'anthropic', 'bare-key fixture: model provider split');
eq(H.openclawModel(bcfg).model, 'claude-sonnet-4-6', 'bare-key fixture: model id split');
eq(H.openclawAgents(bcfg)[0].id, 'main', 'bare-key fixture: agents.list yields id "main" (not the default fallback)');
const bareScan = H.scanProfile({ harness: 'openclaw', files: { 'openclaw.json': ocBare, 'SOUL.md': 'p' } });
ok(JSON.stringify(bareScan).indexOf('sk-ant-FAKE-1234') < 0, 'bare-key fixture: the env secret value NEVER appears in the preview');
ok(bareScan.warnings.filter(w => /never transfer/i.test(w)).length === 1, 'bare-key fixture: re-enter warning exactly once');
ok(!bareScan.warnings.some(w => /could not be parsed/.test(w)), 'bare-key fixture: no could-not-parse warning');

// ---- JSON5 single-quoted strings (also legal JSON5) ----
const sq = H.parseJson5("{ agents: { defaults: { model: { primary: 'openrouter/kimi-k2' } } }, note: 'it\\'s // \"fine\"' }");
ok(sq && sq.agents, 'single-quoted strings parse');
eq(H.openclawModel(sq).provider, 'openrouter', 'single-quoted model id splits');
eq(sq.note, 'it\'s // "fine"', 'escaped quote + // + inner double-quotes survive the rewrite');

// a "//" INSIDE a string is not mistaken for a comment
const strUrl = H.parseJson5('{ "agents": { "defaults": { "model": { "primary": "openrouter/x" } } }, "note": "see http://x.example" }');
eq(strUrl.note, 'see http://x.example', 'a // inside a string survives the comment scrubber');

// a ",]" or ",}" INSIDE a string is not mistaken for a trailing comma (the naive-regex bug: {a:"x,]"} -> {a:"x]"})
eq(H.parseJson5('{ a: "x,]" }').a, 'x,]', 'a comma before ] inside a string survives trailing-comma removal');
eq(H.parseJson5('{ a: "y,}", b: [1, 2,], }').a, 'y,}', 'a comma before } inside a string survives');
ok(Array.isArray(H.parseJson5('{ a: "y,}", b: [1, 2,], }').b) && H.parseJson5('{ a: "y,}", b: [1, 2,], }').b.length === 2, 'real trailing commas still removed alongside the string-guarded ones');

// ---- Hermes YAML model extraction (quoted + unquoted, block + inline) ----
eq(H.hermesModel('model:\n  default: "anthropic/claude-3"\n  provider: anthropic\n').provider, 'anthropic', 'hermes block: provider scalar read');
const hUq = H.hermesModel('model:\n  default: claude-3\n  provider: anthropic\n');
eq(hUq.model, 'claude-3', 'hermes block: unquoted default scalar read');
eq(hUq.provider, 'anthropic', 'hermes block: explicit provider kept verbatim (no re-split)');
eq(H.hermesModel('other: 1\nmodel:\n  model: gpt-4o # inline note\n').model, 'gpt-4o', 'hermes: `model:` key + trailing #comment stripped');
eq(H.hermesModel('model: kimi/k2\n').provider, 'kimi', 'hermes inline `model: id` splits provider when no provider key');
eq(H.hermesModel('nope: true\n').raw, null, 'hermes: no model block => null (not a throw)');

// ---- SECURITY LAW: secrets never travel; warning appears exactly once ----
const secretCfg = `{
  "agents": { "defaults": { "model": { "primary": "openai/gpt-4o" } } },
  "api_key": "sk-SUPER-SECRET-123",
  "env": { "OPENAI_API_KEY": "sk-ALSO-SECRET", "ANTHROPIC_AUTH_TOKEN": "bearer-SEKRET" }
}`;
const scan = H.scanProfile({ harness: 'openclaw', files: { 'openclaw.json': secretCfg, 'SOUL.md': 'You are Ada.' } });
ok(scan.ok, 'scanProfile succeeds with a config present');
const dump = JSON.stringify(scan);
ok(dump.indexOf('SUPER-SECRET') < 0 && dump.indexOf('ALSO-SECRET') < 0 && dump.indexOf('bearer-SEKRET') < 0, 'NO secret value appears anywhere in the preview');
ok(dump.indexOf('sk-') < 0, 'no key-shaped value leaks');
const warnHits = scan.warnings.filter(w => /never transfer/i.test(w));
eq(warnHits.length, 1, 'the re-enter-your-key warning appears exactly once');
eq(scan.model.model, 'gpt-4o', 'the (non-secret) model id is still extracted from a secret-bearing config');
eq(scan.model.provider, 'openai', 'the model provider is still extracted');

// hermes api_key in yaml also trips the warning
const hScan = H.scanProfile({ harness: 'hermes', files: { 'config.yaml': 'api_key: sk-HERMES-SECRET\nmodel:\n  default: x/y\n', 'SOUL.md': '# Nyx\nvibe' } });
ok(JSON.stringify(hScan).indexOf('HERMES-SECRET') < 0, 'hermes secret value never appears in the preview');
ok(hScan.warnings.some(w => /never transfer/i.test(w)), 'hermes api_key trips the re-enter warning');

// ---- clamping: an oversize persona is clipped to TEXT_MAX (16000) ----
eq(H.TEXT_MAX, 16000, 'TEXT_MAX is 16000');
const big = 'x'.repeat(20000);
const clamped = H.scanProfile({ harness: 'openclaw', files: { 'SOUL.md': big } });
eq(clamped.persona.length, 16000, 'persona clipped to 16000 chars');

// ---- name extraction variants ----
eq(H.scanProfile({ harness: 'openclaw', files: { 'IDENTITY.md': '# Ada Lovelace\nfoo' } }).name, 'Ada Lovelace', 'openclaw name from IDENTITY.md # heading');
eq(H.scanProfile({ harness: 'openclaw', files: { 'IDENTITY.md': 'Name: Turing\n' } }).name, 'Turing', 'openclaw name from a Name: line');
eq(H.scanProfile({ harness: 'hermes', files: { 'SOUL.md': '# Nyx\nA night owl.' } }).name, 'Nyx', 'hermes name from SOUL.md # heading');
eq(H.scanProfile({ harness: 'hermes', files: { 'SOUL.md': '## Nyx\nA night owl.' } }).name, 'Nyx', 'a ## (any-level) heading still yields the name');
eq(H.scanProfile({ harness: 'openclaw', files: { 'IDENTITY.md': '### Deep Thought\n' } }).name, 'Deep Thought', 'openclaw IDENTITY.md ### heading yields the name');
eq(H.scanProfile({ harness: 'openclaw', files: { 'SOUL.md': 'no heading here' } }).name, null, 'no name markers => null');

// ---- sources + dailyCount ----
const full = H.scanProfile({ harness: 'openclaw', files: { 'SOUL.md': 'p', 'AGENTS.md': 'i', 'USER.md': 'u', 'MEMORY.md': 'm' }, dailyCount: 5 });
eq(full.memory.dailyCount, 5, 'dailyCount passed through from index.js');
ok(full.sources.indexOf('SOUL.md') >= 0 && full.sources.indexOf('MEMORY.md') >= 0, 'contributing files listed in sources');
eq(full.memory.curated, 'm', 'MEMORY.md becomes memory.curated');

// dailyCount derived from files map when index.js does not pass a count
const derived = H.scanProfile({ harness: 'openclaw', files: { 'SOUL.md': 'p', 'memory/2026-01-01.md': 'd', 'memory/2026-01-02.md': 'd' } });
eq(derived.memory.dailyCount, 2, 'dailyCount derived from memory/*.md keys when no explicit count');

// ---- empty / nothing-found ----
eq(H.scanProfile({ harness: 'openclaw', files: {} }).ok, false, 'empty files map => ok:false');
eq(H.scanProfile({ harness: 'openclaw', files: {} }).reason, 'nothing-found', 'reason is nothing-found');
eq(H.scanProfile({ harness: 'bogus', files: { 'SOUL.md': 'x' } }).ok, false, 'unknown harness => ok:false');

// ---- network / device paths are never a local import root (audit 2026-09-25 #19) ----
for (const bad of ['\\\\server\\share\\agent', '//host/share/agent', '\\\\?\\C:\\Users\\a', '\\\\.\\C:\\x', '\\\\.\\pipe\\x', '\\??\\C:\\x', '\\/evil/share', 'C:\\ok\0bad']) {
  ok(H.nonLocalPathReason(bad) !== '', 'refused: ' + JSON.stringify(bad));
}
ok(/UNC/.test(H.nonLocalPathReason('\\\\server\\share')), 'a UNC root says it is a network path');
ok(/device/.test(H.nonLocalPathReason('\\\\?\\C:\\x')), 'a device path says it is a device path');
for (const good of ['C:\\Users\\andro\\.openclaw\\workspace', 'D:/agents/hermes', '/home/u/.hermes', '/Users/u/.openclaw/workspace']) {
  eq(H.nonLocalPathReason(good), '', 'accepted: ' + good);
}

console.log('harness-import.test.js OK —', n, 'assertions');
