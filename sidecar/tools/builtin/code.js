/* code.run — model-authored JavaScript composition over the current run's READ tools.
 *
 * The child is deliberately powerless: no require/process/filesystem/network and a secret-free
 * environment. Each tool() request returns to the parent, which owns the real authority boundary.
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const { fork: defaultFork } = require('node:child_process');

const DEFAULTS = Object.freeze({ timeoutMs: 30000, maxCalls: 50, maxOutputBytes: 32000, maxCodeBytes: 48000 });

// Node's permission model is the worker's second isolation layer (see code-worker.js). The stable `--permission`
// flag landed in Node 22.13 / 23.5; every desktop target bundles 22.23.x (scripts/prepare-node.mjs). On an older
// runtime code.run is REFUSED — it never falls back to the bare node:vm child.
function permissionFlagSupported(version) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
}

function workerExecArgv(workerPath) {
  return [
    '--permission', '--allow-fs-read=' + workerPath,
    '--disallow-code-generation-from-strings',
    '--max-old-space-size=96', '--disable-proto=throw'
  ];
}

function clampText(text, max) {
  text = String(text == null ? '' : text);
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  let note = '\n[code output truncated at ' + max + ' bytes]';
  if (Buffer.byteLength(note, 'utf8') > max) note = note.slice(0, max);
  const room = Math.max(0, max - Buffer.byteLength(note, 'utf8'));
  let out = text.slice(0, room);
  while (Buffer.byteLength(out, 'utf8') > room) out = out.slice(0, -1);
  return out + note;
}

function secretFreeEnv(platform) {
  const env = { STARNET_CODE_WORKER: '1', NODE_OPTIONS: '', PATH: '' };
  if (platform === 'win32') {
    // Node is already running; these values support ordinary runtime initialization only.
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  } else env.LANG = 'C';
  return env;
}

function refusalForNested(realName, tool, grantedSet) {
  if (!tool) return 'unknown tool: ' + realName;
  if (realName === 'code.run') return 'recursive code.run is prohibited';
  if (/^team\./.test(realName)) return 'team spawning and delegation are prohibited inside code.run';
  if (tool.scope !== 'read' || tool.requiresConsent) return 'code.run v1 may compose only consent-free read tools; refused ' + realName;
  if (/^mcp:/.test(String(tool.capability || ''))) return 'connector tools are not available inside code.run v1';
  if (!grantedSet || !grantedSet.has(realName)) return 'WITHHELD: "' + realName + '" is not granted to this run';
  return '';
}

function makeCodeTools(deps) {
  deps = deps || {};
  const fork = deps.fork || defaultFork;
  const workerPath = deps.workerPath || path.join(__dirname, '..', 'code-worker.js');
  const limits = Object.assign({}, DEFAULTS, deps.limits || {});
  const nodeVersion = deps.nodeVersion || process.version;

  const codeTool = {
    name: 'code.run',
    description: 'Run bounded JavaScript to loop, filter, branch, and aggregate across your currently granted READ tools. Use `await tool("tool.name", {args})`; return only the compact final value you want back. Nested writes, shell, code.run, and team tools are refused.',
    schema: {
      type: 'object', additionalProperties: false, required: ['code'],
      properties: { code: { type: 'string', minLength: 1, maxLength: limits.maxCodeBytes } }
    },
    // SECURITY (2026-09-23 audit stopgap, KEPT 2026-09-25): classified like shell.exec — execute scope (autonomous
    // exec lockout), consent on interactive surfaces, and workspace-process impact so an untrusted-content taint
    // revokes it for the rest of the run. The worker is now rebuilt on a primitive-only bridge under Node's
    // permission model (code-worker.js), but Node 22's permission model does not cover the NETWORK, so relaxing
    // this classification is an owner decision, not a default.
    scope: 'execute', capability: 'code', impact: 'workspace-process', requiresConsent: true, timeoutMs: limits.timeoutMs + 2000,
    async run(args, ctx) {
      if (!ctx || typeof ctx.composeDispatch !== 'function') throw new Error('code-mode parent dispatcher unavailable');
      const source = String(args && args.code || '');
      if (Buffer.byteLength(source, 'utf8') > limits.maxCodeBytes) throw new Error('code exceeds ' + limits.maxCodeBytes + ' bytes');

      if (!permissionFlagSupported(nodeVersion)) {
        throw new Error('code.run is unavailable on Node ' + nodeVersion + ': it needs the Node permission model (22.13+) to isolate model code');
      }
      const child = fork(workerPath, [], {
        cwd: os.tmpdir(), env: secretFreeEnv(process.platform), silent: true,
        execArgv: workerExecArgv(workerPath),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      let calls = 0, settled = false, stderr = '';
      const finishKill = () => { if (!child.killed) { try { child.kill(); } catch (_) {} } };
      const parentSignal = ctx.signal;
      const nestedController = new AbortController();

      return await new Promise((resolve, reject) => {
        let timer = null;
        const safeSend = payload => {
          if (!child.connected || child.killed) return false;
          try { child.send(payload, () => {}); return true; } catch (_) { return false; }
        };
        const done = (err, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (parentSignal) { try { parentSignal.removeEventListener('abort', onAbort); } catch (_) {} }
          if (!nestedController.signal.aborted) nestedController.abort();
          finishKill();
          if (err) reject(err); else resolve(value);
        };
        const onAbort = () => done(new Error('code execution cancelled'));
        if (parentSignal) {
          if (parentSignal.aborted) return onAbort();
          try { parentSignal.addEventListener('abort', onAbort, { once: true }); } catch (_) {}
        }
        if (child.stderr) child.stderr.on('data', b => { stderr = clampText(stderr + String(b), 4096); });
        timer = setTimeout(() => done(new Error('code execution timed out after ' + limits.timeoutMs + 'ms')), limits.timeoutMs);
        child.on('error', e => done(e));
        child.on('exit', (code) => {
          if (!settled) done(new Error('code worker exited before returning a result (exit ' + code + ')' + (stderr ? ': ' + stderr : '')));
        });
        child.on('message', async msg => {
          if (!msg || settled) return;
          if (msg.type === 'tool') {
            calls++;
            if (calls > limits.maxCalls) {
              safeSend({ type: 'tool_result', id: msg.id, ok: false, error: 'nested call limit exceeded (' + limits.maxCalls + ')' });
              return;
            }
            try {
              // Only JSON TEXT crosses from the worker; parse it here, in the parent's realm.
              let nestedArgs;
              try { nestedArgs = JSON.parse(String(msg.argsJson || '{}')); }
              catch (e) { throw new Error('nested tool arguments are not valid JSON'); }
              if (!nestedArgs || typeof nestedArgs !== 'object' || Array.isArray(nestedArgs)) nestedArgs = {};
              const result = await ctx.composeDispatch({ name: String(msg.name || ''), args: nestedArgs }, {
                parentCallId: ctx.callId, sequence: calls, signal: nestedController.signal
              });
              if (!settled) safeSend({ type: 'tool_result', id: msg.id, ok: true, result });
            } catch (e) {
              if (!settled) safeSend({ type: 'tool_result', id: msg.id, ok: false, error: String((e && e.message) || e) });
            }
            return;
          }
          if (msg.type === 'error') return done(new Error('code failed: ' + String(msg.error || 'unknown error')));
          if (msg.type === 'done') {
            // The worker sends the result as JSON TEXT (only primitives cross the boundary): a string result
            // renders bare, anything else as its JSON.
            let rendered = String(msg.resultJson == null ? 'null' : msg.resultJson);
            try { const v = JSON.parse(rendered); if (typeof v === 'string') rendered = v; }
            catch (e) { void e; }
            const full = rendered == null ? '' : rendered;
            const bounded = clampText(full, limits.maxOutputBytes);
            done(null, {
              content: bounded,
              fullContent: bounded === full ? undefined : full,
              summary: 'code composed ' + calls + ' read call' + (calls === 1 ? '' : 's')
            });
          }
        });
        safeSend({ type: 'run', code: source, syncTimeoutMs: Math.min(2000, limits.timeoutMs) });
      });
    }
  };

  return { codeTool, register(reg) { reg.register(codeTool); return reg; }, _internals: { clampText, secretFreeEnv, refusalForNested, permissionFlagSupported, workerExecArgv, DEFAULTS } };
}

module.exports = { makeCodeTools, _internals: { clampText, secretFreeEnv, refusalForNested, permissionFlagSupported, workerExecArgv, DEFAULTS } };
