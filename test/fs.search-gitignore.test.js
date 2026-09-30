/* node test/fs.search-gitignore.test.js — fs.search's .gitignore awareness, the max_files knob, and the
   optional ripgrep engine (2026-09-02, coding-tools lane).

   Two engines, one contract: the pure-JS walker is the guaranteed path; when `rg` is on PATH the same call
   goes through ripgrep and must produce the same rows. The walker assertions always run. The rg assertions
   run only when a real `rg` answers `--version` on this machine — and say so LOUDLY either way, so a skipped
   engine never reads as a proven one. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

const ROOT = path.join(os.tmpdir(), 'starnet-fs-gitignore-' + process.pid);
const WS = path.join(ROOT, 'gi');
const ctx = { agentId: 'gi' };
const lines = r => r.content.split('\n').filter(Boolean);

async function fixture() {
  await fsp.mkdir(path.join(WS, 'src', 'gen'), { recursive: true });
  await fsp.mkdir(path.join(WS, 'dist'), { recursive: true });
  await fsp.mkdir(path.join(WS, 'docs'), { recursive: true });
  await fsp.mkdir(path.join(WS, 'node_modules', 'dep'), { recursive: true });
  await fsp.mkdir(path.join(WS, 'vendor', 'keep'), { recursive: true });
  await fsp.writeFile(path.join(WS, '.gitignore'), [
    '# build output', 'dist/', '*.log', '/top-only.txt', 'docs/*.tmp', '**/gen/', 'vendor/*', '!vendor/keep', 'secret?.txt', ''
  ].join('\n'));
  await fsp.writeFile(path.join(WS, 'src', '.gitignore'), 'local-only.js\n');
  await fsp.writeFile(path.join(WS, 'src', 'app.js'), 'NEEDLE in app\n');
  await fsp.writeFile(path.join(WS, 'src', 'local-only.js'), 'NEEDLE nested-ignored\n');
  await fsp.writeFile(path.join(WS, 'src', 'gen', 'out.js'), 'NEEDLE generated\n');
  await fsp.writeFile(path.join(WS, 'dist', 'bundle.js'), 'NEEDLE bundled\n');
  await fsp.writeFile(path.join(WS, 'build.log'), 'NEEDLE logged\n');
  await fsp.writeFile(path.join(WS, 'top-only.txt'), 'NEEDLE top\n');
  await fsp.writeFile(path.join(WS, 'docs', 'top-only.txt'), 'NEEDLE nested top-only survives\n');
  await fsp.writeFile(path.join(WS, 'docs', 'scratch.tmp'), 'NEEDLE tmp\n');
  await fsp.writeFile(path.join(WS, 'docs', 'guide.md'), 'NEEDLE guide\n');
  await fsp.writeFile(path.join(WS, 'vendor', 'lib.js'), 'NEEDLE vendored\n');
  await fsp.writeFile(path.join(WS, 'vendor', 'keep', 'ok.js'), 'NEEDLE kept\n');
  await fsp.writeFile(path.join(WS, 'secret1.txt'), 'NEEDLE secret\n');
  await fsp.writeFile(path.join(WS, 'secret12.txt'), 'NEEDLE not-secret (two chars)\n');
  await fsp.writeFile(path.join(WS, 'node_modules', 'dep', 'x.js'), 'NEEDLE dep\n');
}

const EXPECTED_FILES = ['docs/guide.md', 'docs/top-only.txt', 'secret12.txt', 'src/app.js', 'vendor/keep/ok.js'];
const IGNORED_MARKERS = ['bundled', 'logged', 'NEEDLE top\n', 'tmp', 'generated', 'vendored', 'secret\n', 'nested-ignored', 'dep'];

async function contract(tools, label) {
  const fo = await tools.searchTool.run({ query: 'NEEDLE', output_mode: 'files_only', limit: 100 }, ctx);
  A.eq(lines(fo).sort(), EXPECTED_FILES, label + ': files_only lists exactly the non-ignored files');
  const c = await tools.searchTool.run({ query: 'NEEDLE', limit: 100 }, ctx);
  for (const m of IGNORED_MARKERS) A.ok(c.content.indexOf('NEEDLE ' + m.trim()) < 0 || (m === 'secret\n' && c.content.indexOf('NEEDLE secret\n') < 0), label + ': ignored content never surfaces (' + m.trim() + ')');
  A.ok(/5 matches in 5 file/.test(c.summary), label + ': summary counts only non-ignored matches — got ' + c.summary);
  const cnt = await tools.searchTool.run({ query: 'NEEDLE', output_mode: 'count', limit: 100 }, ctx);
  A.eq(lines(cnt).sort(), EXPECTED_FILES.map(f => f + ': 1'), label + ': count mode agrees');
  const files = await tools.searchTool.run({ query: '*.js', target: 'files', limit: 100 }, ctx);
  A.eq(lines(files).sort(), ['src/app.js', 'vendor/keep/ok.js'], label + ': target files honours .gitignore too');
  const scoped = await tools.searchTool.run({ query: 'NEEDLE', path: 'src', output_mode: 'files_only', limit: 100 }, ctx);
  A.eq(lines(scoped), ['src/app.js'], label + ': a scoped path still applies the ROOT .gitignore (**/gen/) and the nested one');
  const off = await tools.searchTool.run({ query: 'NEEDLE', output_mode: 'files_only', gitignore: false, limit: 100 }, ctx);
  A.ok(lines(off).indexOf('dist/bundle.js') >= 0 && lines(off).indexOf('src/gen/out.js') >= 0 && lines(off).indexOf('build.log') >= 0, label + ': gitignore:false searches the ignored files');
  A.ok(lines(off).indexOf('node_modules/dep/x.js') < 0, label + ': node_modules stays skipped even with gitignore:false');
  const cxr = await tools.searchTool.run({ query: 'NEEDLE', file_glob: '*.md', context: 1, limit: 100 }, ctx);
  A.ok(/^docs\/guide\.md$/m.test(cxr.content) && /^ {2}1: NEEDLE guide$/m.test(cxr.content), label + ': context/densified rendering is stable');
  // a PATH-shaped file_glob is workspace-relative on BOTH engines, with or without a scoped `path`
  const pg = await tools.searchTool.run({ query: 'NEEDLE', file_glob: 'src/*.js', output_mode: 'files_only', limit: 100 }, ctx);
  A.eq(lines(pg), ['src/app.js'], label + ': a path file_glob matches the workspace-relative path');
  const pgScoped = await tools.searchTool.run({ query: 'NEEDLE', path: 'src', file_glob: 'src/*.js', output_mode: 'files_only', limit: 100 }, ctx);
  A.eq(lines(pgScoped), ['src/app.js'], label + ': …and means the SAME thing when `path` is set (rg used to match it against the scoped dir)');
  const pgDeep = await tools.searchTool.run({ query: 'NEEDLE', path: 'docs', file_glob: 'docs/**', output_mode: 'files_only', limit: 100 }, ctx);
  A.eq(lines(pgDeep).sort(), ['docs/guide.md', 'docs/top-only.txt'], label + ': a scoped ** path glob');
  const pgMiss = await tools.searchTool.run({ query: 'NEEDLE', path: 'src', file_glob: '*/app.js', output_mode: 'files_only', limit: 100 }, ctx);
  A.eq(lines(pgMiss), ['src/app.js'], label + ': */app.js is relative to the workspace root, not the scoped dir');
  const logGlob = await tools.searchTool.run({ query: 'NEEDLE', file_glob: '*.log', output_mode: 'files_only', limit: 100 }, ctx);
  A.ok(lines(logGlob).indexOf('build.log') < 0, label + ': a file_glob never re-includes a .gitignored file (an rg -g glob overrides ignore rules)');
  const flat = await tools.searchTool.run({ query: 'guide', limit: 100 }, ctx);
  A.eq(flat.content, 'docs/guide.md:1: NEEDLE guide', label + ': the flat path:line: text row is byte-identical');
}

(async () => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  await fixture();

  // ---- 1. the walker (no spawn injected == no rg, the historic construction) ----
  const walker = makeFsTools({ fsp, pathMod: path, root: ROOT });
  await contract(walker, 'walker');
  A.eq((await walker.searchTool.run({ query: 'guide' }, ctx)).engine, 'walk', 'without a spawn the walker answers (engine tag is a result-object field, not model-facing content)');

  // ---- 2. max_files is a real cap and a real knob ----
  {
    const capped = await walker.searchTool.run({ query: 'NEEDLE', output_mode: 'files_only', max_files: 2, limit: 100 }, ctx);
    A.ok(lines(capped).filter(l => l.indexOf('[') !== 0).length <= 2 && /\[truncated/.test(capped.content), 'max_files:2 scans at most two files and says it truncated');
    const wide = await walker.searchTool.run({ query: 'NEEDLE', output_mode: 'files_only', max_files: 50000, limit: 100 }, ctx);
    A.eq(lines(wide).sort(), EXPECTED_FILES, 'a large max_files scans the whole tree');
  }

  // ---- 3. the gitignore parser on its own: git's documented rules ----
  {
    const I = walker._internals;
    const rules = I.parseGitignore('# c\n\\#literal\nfoo \nbar/ \n!bar/keep\n/root.txt\nsub/*.tmp\n**/deep\n[abc].js\nq?.md\n');
    const stack = [{ baseRel: '', rules }];
    A.ok(I.gitignored(stack, '#literal', false), 'an escaped # is a literal pattern');
    A.ok(I.gitignored(stack, 'x/y/foo', false), 'a bare name matches at any depth');
    A.ok(I.gitignored(stack, 'bar', true) && !I.gitignored(stack, 'bar', false), 'a trailing slash means directories only');
    A.ok(I.gitignored(stack, 'root.txt', false) && !I.gitignored(stack, 'sub/root.txt', false), 'a leading slash anchors to the .gitignore dir');
    A.ok(I.gitignored(stack, 'sub/a.tmp', false) && !I.gitignored(stack, 'other/a.tmp', false), 'a middle slash anchors the whole relative path');
    A.ok(I.gitignored(stack, 'a/b/deep', false), '**/ matches at any depth');
    A.ok(I.gitignored(stack, 'a.js', false) && !I.gitignored(stack, 'd.js', false), 'character classes pass through');
    A.ok(I.gitignored(stack, 'q1.md', false) && !I.gitignored(stack, 'q12.md', false), '? is exactly one character');
    const nested = [{ baseRel: '', rules: I.parseGitignore('*.log\n') }, { baseRel: 'src', rules: I.parseGitignore('!keep.log\n') }];
    A.ok(I.gitignored(nested, 'src/a.log', false) && !I.gitignored(nested, 'src/keep.log', false), 'a nested negation re-includes within its own subtree (last match wins)');
    const deepPath = [{ baseRel: '', rules: I.parseGitignore('**/foo/bar' + String.fromCharCode(10)) }];
    A.ok(I.gitignored(deepPath, 'src/foo/bar', false), '**/foo/bar matches foo/bar under any directory (it was stripped to an anchored foo/bar)');
    A.ok(I.gitignored(deepPath, 'foo/bar', false) && I.gitignored(deepPath, 'a/b/foo/bar', false), '…including at the root and at depth');
    A.ok(!I.gitignored(deepPath, 'src/foo/baz', false) && !I.gitignored(deepPath, 'bar', false), '…and nothing else');
    const nestedDeep = [{ baseRel: 'pkg', rules: I.parseGitignore('**/foo/bar' + String.fromCharCode(10)) }];
    A.ok(I.gitignored(nestedDeep, 'pkg/x/foo/bar', false) && I.gitignored(nestedDeep, 'pkg/foo/bar', false), 'a nested **/foo/bar matches at any depth under its own directory');
  }

  // ---- 4. the rg engine: same rows, when the machine has ripgrep ----
  let rgHere = false;
  try { rgHere = spawnSync('rg', ['--version'], { windowsHide: true }).status === 0; } catch (_) {}
  if (rgHere) {
    const withRg = makeFsTools({ fsp, pathMod: path, root: ROOT, spawn });
    const probe = await withRg.searchTool.run({ query: 'guide' }, ctx);
    A.eq(probe.engine, 'rg', 'rg was detected and used (engine tag on the result object)');
    await contract(withRg, 'rg');
    // regex + ignoreCase go through rg's flags; a JS-only regex feature (lookahead) falls back to the walker
    const rx = await withRg.searchTool.run({ query: 'needle in|needle guide', regex: true, ignoreCase: true, output_mode: 'files_only' }, ctx);
    A.eq(lines(rx).sort(), ['docs/guide.md', 'src/app.js'], 'rg: regex + ignoreCase');
    const la = await withRg.searchTool.run({ query: 'NEEDLE (?=guide)', regex: true, output_mode: 'files_only' }, ctx);
    A.eq(la.engine, 'walk', 'a regex rg rejects (lookahead) falls back to the walker instead of failing');
    A.eq(lines(la), ['docs/guide.md'], 'and the walker answers it');
    const forced = makeFsTools({ fsp, pathMod: path, root: ROOT, spawn, rg: false });
    A.eq((await forced.searchTool.run({ query: 'guide' }, ctx)).engine, 'walk', 'rg:false forces the walker even with a spawn');
    console.log('rg engine: PROVEN on this machine (' + String(spawnSync('rg', ['--version']).stdout).split('\n')[0] + ')');
  } else {
    console.log('rg engine: NOT PROVEN — no `rg` on PATH here; only the walker assertions ran');
  }

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  A.report('fs.search-gitignore.test');
})().catch(e => { console.error(e); process.exit(1); });
