/* node test/desktop-csp-inline-scan.test.js -- the desktop CSP forbids inline code; no gate can see it.
   Since v0.12.5 the packaged app's script-src carries no 'unsafe-inline'/'unsafe-eval' (and Tauri hashes every
   bundled .js into script-src, so inline code was already inert). The sidecar's browser mirror sends no such
   policy, so every browser-driven gate (journeys, audit, golden) happily runs an innerHTML onclick="…" or an eval
   that is a DEAD button only in the installed app. This scan covers every script frontend/index.html loads and
   fails on the constructs that CSP blocks. The positive samples at the foot prove each rule still fires. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');

const RULES = [
  // markup built in a string that carries an inline handler: '<button onclick="…">', `<img onerror='…'>`
  ['inline handler in generated markup', /<[a-z][^<>]*?\son[a-z]{3,}\s*=\s*\\?["'{]/i],
  ['javascript: URL in generated markup', /\b(?:href|src|action|formaction)\s*=\s*\\?["']\s*javascript:/i],
  ['eval()', /(^|[^.\w$])eval\s*\(/],
  ['new Function()', /\bnew\s+Function\s*\(/],
  ['string timer', /\bset(?:Timeout|Interval)\s*\(\s*["'`]/]
];

// every script the desktop window loads: index.html's <script src> list (relative → frontend/, /shared → shared/)
const scripts = Array.from(indexHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g))
  .map(m => m[1].split('?')[0])
  .filter(src => !/^[a-z]+:/i.test(src));
A.ok(scripts.length > 100, 'index.html script list parsed (' + scripts.length + ' scripts)');

const hits = [];
for (const src of scripts) {
  const file = src.startsWith('/') ? path.join(root, src.slice(1)) : path.join(root, 'frontend', src.replace(/^\.\//, ''));
  A.ok(fs.existsSync(file), 'shipped script exists: ' + src);
  if (!fs.existsSync(file)) continue;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of RULES) if (re.test(line)) hits.push(name + ' — ' + src + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
  });
}
A.eq(hits.length, 0, 'no CSP-blocked inline construct in any shipped script' + (hits.length ? ':\n  ' + hits.join('\n  ') : ''));

// the rules are not vacuous: each fires on the construct it exists to catch, and stays quiet on the safe forms
const bad = [
  "el.innerHTML = '<button class=\"x\" onclick=\"go()\">GO</button>';",
  'row.innerHTML = `<img src="${u}" onerror=\'this.remove()\'>`;',
  "a.outerHTML = '<a href=\"javascript:void(0)\">x</a>';",
  'const v = eval(expr);',
  "const f = new Function('a', 'return a');",
  "setTimeout('tick()', 50);"
];
bad.forEach((line, i) => A.ok(RULES.some(([, re]) => re.test(line)), 'rule fires on bad sample #' + (i + 1)));
const safe = [
  "btn.addEventListener('click', go);",
  'img.onerror = () => img.remove();',
  "if (/^\\s*javascript:/i.test(url)) return '';",
  'Runtime.evaluate({ expression })',
  'setTimeout(() => tick(), 50);'
];
safe.forEach((line, i) => A.ok(!RULES.some(([, re]) => re.test(line)), 'rule stays quiet on safe sample #' + (i + 1)));

A.report('desktop-csp-inline-scan.test');
