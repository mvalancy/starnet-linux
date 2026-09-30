/* Isolated child for code.run. This process has no tool implementations or credentials.
 * The only authority crossing the IPC boundary is a bounded `tool(name,args)` request;
 * the parent re-validates and dispatches every request through the ordinary run gates.
 *
 * ISOLATION (2026-09-25, replaces the 09-23 stopgap's reliance on node:vm alone). node:vm is NOT a security
 * boundary on its own: any HOST-realm object handed into the context (a function, a Promise, a resolved value)
 * leads back to the host's Function constructor. So:
 *   1. Nothing host-realm is reachable from model code. `tool`, `print`, `console` and every Promise the model
 *      sees are created INSIDE the context by the setup script below. The single host function (`bridge`) is
 *      captured in the setup script's closure and deleted from the global before model code runs, and it only
 *      ever receives and passes PRIMITIVE strings.
 *   2. Defence in depth — the parent starts this process under Node's permission model (`--permission`, one
 *      fs-read grant for this file) with `--disallow-code-generation-from-strings`: even a host Function reached
 *      by some future bug cannot compile code, spawn processes, start workers, load addons, or touch the disk.
 *      This file refuses to run model code at all unless the permission model is provably active.
 *   Node 22's permission model does not cover the network, so no network API is exposed into the context and
 *   the host globals are dropped below as a further layer. */
'use strict';

const vm = require('node:vm');

// Fail CLOSED: model code runs only inside an active permission model that denies child processes.
function permissionModelActive() {
  try {
    const p = process.permission;
    return !!(p && typeof p.has === 'function' && p.has('child') === false && p.has('worker') === false && p.has('fs.write') === false);
  } catch (e) {
    return false;
  }
}
const ISOLATED = permissionModelActive();

for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response', 'Headers', 'FormData']) {
  try { delete globalThis[name]; } catch (e) { void e; }
}

const pending = new Map();
let nextId = 1;
let active = null;   // { report } for the one run this child serves

function send(payload) {
  if (typeof process.send === 'function') process.send(payload);
}

// The ONE host function the context can reach, and only via the setup closure. Primitive strings in, primitive
// strings out (through the context-realm callback). Null prototype + frozen: no .constructor, .call, .bind.
function bridge(kind, a, b, cb) {
  kind = String(kind);
  if (kind === 'tool') {
    if (typeof cb !== 'function') return;
    const id = String(nextId++);
    pending.set(id, cb);
    send({ type: 'tool', id, name: String(a), argsJson: String(b) });
    return;
  }
  if (!active) return;
  if (kind === 'done') active.report({ type: 'done', resultJson: String(a), printed: String(b) });
  else if (kind === 'error') active.report({ type: 'error', error: String(a) });
}
Object.setPrototypeOf(bridge, null);
Object.freeze(bridge);

// Runs INSIDE the context. Everything it defines is context-realm; `bridge` lives only in this closure.
const SETUP = `(() => {
  "use strict";
  const bridge = globalThis.__starnetBridge;
  delete globalThis.__starnetBridge;
  const out = [];
  const fmt = v => typeof v === 'string' ? v : JSON.stringify(v);
  const print = (...vs) => { out.push(vs.map(fmt).join(' ')); };
  const tool = (name, args) => new Promise((resolve, reject) => {
    const json = JSON.stringify(args === undefined ? {} : args);
    bridge('tool', String(name || ''), json === undefined ? '{}' : json, (err, resultJson) => {
      if (err) reject(new Error(err));
      else resolve(resultJson === '' ? null : JSON.parse(resultJson));
    });
  });
  const cons = Object.freeze({ log: print, info: print, warn: print, error: print });
  Object.defineProperty(globalThis, 'tool', { value: tool, enumerable: true });
  Object.defineProperty(globalThis, 'print', { value: print, enumerable: true });
  Object.defineProperty(globalThis, 'console', { value: cons, enumerable: true });
  const finish = (v) => {
    let json;
    try { json = JSON.stringify(v === undefined ? out.join('\\n') : v); }
    catch (e) { return bridge('error', 'result is not JSON-serializable: ' + String(e && e.message || e)); }
    bridge('done', json === undefined ? 'null' : json, out.join('\\n'));
  };
  const fail = (e) => bridge('error', String((e && e.message) || e));
  Object.defineProperty(globalThis, '__starnetRun', { configurable: true, value: () => {
    const fn = globalThis.__starnetUserFn;
    delete globalThis.__starnetRun;
    delete globalThis.__starnetUserFn;
    let p;
    try { p = fn(); } catch (e) { return fail(e); }
    p.then(finish, fail);
  } });
})()`;

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'tool_result') {
    const cb = pending.get(String(msg.id));
    if (!cb) return;
    pending.delete(String(msg.id));
    // Only primitives cross into the context: an error string, or the JSON text of the result.
    if (msg.ok) {
      let json;
      try { json = JSON.stringify(msg.result === undefined ? null : msg.result); } catch (e) { json = 'null'; }
      cb('', json === undefined ? 'null' : json);
    } else {
      cb(String(msg.error || 'nested tool failed') || 'nested tool failed', '');
    }
    return;
  }
  if (msg.type !== 'run' || active) return;

  let reported = false;
  active = { report: (payload) => { if (reported) return; reported = true; send(payload); } };
  if (!ISOLATED) {
    active.report({ type: 'error', error: 'code.run isolation unavailable: this Node runtime did not start under the permission model' });
    return;
  }
  const syncTimeout = Number(msg.syncTimeoutMs) || 1000;
  try {
    const sandbox = Object.create(null);
    sandbox.__starnetBridge = bridge;
    const context = vm.createContext(sandbox, {
      name: 'starnet-code-mode',
      codeGeneration: { strings: false, wasm: false }
    });
    new vm.Script(SETUP, { filename: 'code-mode-setup.js' }).runInContext(context, { timeout: syncTimeout });
    // The context assigns its own function; the host never holds or calls a context object.
    new vm.Script('globalThis.__starnetUserFn = (async () => {\n"use strict";\n' + String(msg.code || '') + '\n});', { filename: 'model-code.js' })
      .runInContext(context, { timeout: syncTimeout });
    // The synchronous part of the model's code runs here, under the vm timeout; the rest is bounded by the
    // parent's wall clock, which kills this whole process.
    new vm.Script('__starnetRun();', { filename: 'code-mode-run.js' }).runInContext(context, { timeout: syncTimeout });
  } catch (e) {
    active.report({ type: 'error', error: String((e && e.message) || e) });
  }
});
