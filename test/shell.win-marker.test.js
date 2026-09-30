/* node test/shell.win-marker.test.js — WINDOWS shell.exec REPORTS THE REAL EXIT CODE AND KEEPS `cd` (h1 F5, 2026-09-22).

   Since e72ee0b00 (2026-06-23) the Windows marker was `& call echo __SK_CWD__%CD%__SK_EC__%ERRORLEVEL%__SK_END__`.
   cmd.exe expands %VAR% when it PARSES the whole line — before the user's command runs — so every Windows shell.exec
   reported the PRE-command errorlevel ([exit 0] even when the command failed) and the PRE-command cwd (a `cd` never
   persisted). The caret form (%^ERRORLEVEL% / %^CD%) survives the parse pass and `call` expands it at run time.

   Drives the REAL tool through the REAL registry with REAL cmd.exe children (Node's shell:true spawn — exactly the
   production spawn mode). Every child exits on its own and is awaited; nothing outlives the test. On a non-Windows
   host there is no cmd.exe marker to test: the file reports a clean skip. */
'use strict';
const A = require('./_assert.js');

if (process.platform !== 'win32') {
  console.log('shell.win-marker.test: SKIP (Windows-only — cmd.exe marker expansion)');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sh-win-'));
  try {
    const shell = makeShellTool({ spawn, fs, pathMod: path, root, clock: { now: () => 0 }, redact: (s) => s });
    const reg = makeRegistry();
    shell.register(reg);
    const ctx = { agentId: 'a1', runId: 'r1', callId: 'c', emit: () => {} };
    const run = (cmd, id) => reg.dispatch({ id: id || 'c', name: 'shell.exec', args: { cmd }, argsRaw: JSON.stringify({ cmd }) }, ctx);

    // ---- 1. a failing command whose failure the marker must SEE (the marker runs after it — unlike a bare `exit 3`,
    //         which ends cmd.exe before the marker and so hid the bug) ----
    const r1 = await run('cmd /c exit 3', 'c1');
    A.eq([r1.ok, r1.isError], [true, false], 'a non-zero exit is still an ordinary result');
    A.ok(/\n?\[exit 3\]$/.test(r1.content), 'the REAL exit code is reported: ' + JSON.stringify(r1.content));
    A.ok(/^exit 3 \(/.test(r1.summary), 'the summary carries exit 3: ' + r1.summary);
    const r1b = await run('type definitely-not-a-file.txt', 'c1b');
    A.ok(/\[exit 1\]$/.test(r1b.content) && /cannot find/i.test(r1b.content), 'a failing builtin reports exit 1 with its stderr: ' + JSON.stringify(r1b.content));
    const r1c = await run('echo fine', 'c1c');
    A.ok(/fine/.test(r1c.content) && /\[exit 0\]$/.test(r1c.content), 'a succeeding command still reports exit 0');
    A.ok(r1.content.indexOf('__SK_') < 0 && r1c.content.indexOf('__SK_') < 0, 'the marker is stripped from what the model sees');

    // ---- 2. `cd` into a subdirectory persists to the NEXT call ----
    const jail = path.join(root, 'a1');
    fs.mkdirSync(path.join(jail, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(jail, 'subdir', 'inside.txt'), 'found-me');
    const r2 = await run('cd subdir', 'c2');
    A.ok(/\[exit 0\]$/.test(r2.content), 'the cd itself succeeds');
    const r3 = await run('cd', 'c3');   // bare `cd` prints the current directory
    A.ok(new RegExp(path.join(jail, 'subdir').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '\\s*\\n\\[exit 0\\]$', 'i').test(r3.content),
      'the next call starts in the subdir the previous call cd-ed into: ' + JSON.stringify(r3.content));
    const r4 = await run('type inside.txt', 'c4');
    A.ok(/found-me/.test(r4.content) && /\[exit 0\]$/.test(r4.content), 'a relative path now resolves inside the persisted cwd');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('shell.win-marker.test');
})().catch(e => { console.log('FAIL: shell.win-marker.test threw — ' + (e && e.stack || e)); process.exit(1); });
