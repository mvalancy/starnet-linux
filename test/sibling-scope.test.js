/* node test/sibling-scope.test.js — NO FUNCTION MAY CALL ANOTHER FUNCTION'S LOCALS.

   WHY THIS EXISTS: the docked Workflow panel shipped a dead SAVE SCHEDULE button. `trgAgent` was a `const`
   declared inside paintTrigger(), but the click handler that used it lived in its sibling wireScheduleForm(),
   so every save threw `ReferenceError: trgAgent is not defined`, the key stuck on "saving…" and no routine was
   ever created. `node --check` cannot see it (an undeclared name is legal syntax), and a source-regex test even
   PINNED the broken call because it matched the text, not the scope.

   The check is deliberately dumb and byte-level, like module-scope-shadowing.test.js: the browser modules below
   are one IIFE whose functions sit at a two-space indent (house style). For each of those functions it collects
   the names declared inside it (const/let/var, params, arrow params, catch/for bindings). A function that USES a
   name some OTHER function declares locally — without declaring it itself, and with no module-scope declaration
   of that name — is the bug class. Pure + zero-dep: reads source text, executes nothing. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GUARDED = ['frontend/app/workflowpanel.js', 'frontend/app/workflowline.js', 'frontend/app/cratecard.js'];

// a `/` starts a regex literal (not a division) after an operator, an opening bracket or these keywords
const regexCanStart = out => { const t = out.replace(/\s+$/, ''); return !t || /[(,=:[!&|?{};+\-*%<>~^]$/.test(t) || /\b(?:return|typeof|case|of|in)$/.test(t); };
// comments, regex literals and string/template text out (template ${…} code is kept), so prose never counts as a use
function codeOnly(src) {
  let out = '', i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const seg = src.slice(i, e < 0 ? n : e + 2); out += seg.replace(/[^\n]/g, ' '); i += seg.length; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && regexCanStart(out)) {   // a regex literal: its body and flags are not identifiers
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
      j++; while (j < n && /[a-z]/.test(src[j])) j++;
      out += ' '.repeat(j - i); i = j; continue;
    }
    if (c === '\'' || c === '"') {
      out += ' '; i++;
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') { out += ' '; i++; } out += ' '; i++; }
      out += ' '; i++; continue;
    }
    if (c === '`') {
      out += ' '; i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {   // keep the embedded expression (one level deep is all house style uses)
          let depth = 0; out += '  '; i += 2;
          while (i < n && !(src[i] === '}' && depth === 0)) { if (src[i] === '{') depth++; if (src[i] === '}') depth--; out += src[i]; i++; }
          out += ' '; i++; continue;
        }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += ' '; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const ID = '[A-Za-z_$][A-Za-z0-9_$]*';
function declaredIn(text) {
  const names = new Set();
  const addList = s => { for (const m of s.matchAll(new RegExp(ID + '(?=\\s*(?:[,=})\\]]|$))', 'g'))) names.add(m[0]); for (const m of s.matchAll(new RegExp(':\\s*(' + ID + ')', 'g'))) names.add(m[1]); for (const m of s.matchAll(new RegExp(ID, 'g'))) names.add(m[0]); };
  // const/let/var — a plain name, or a destructuring pattern
  for (const m of text.matchAll(new RegExp('\\b(?:const|let|var)\\s+(' + ID + ')', 'g'))) names.add(m[1]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([{[][^=]*?[}\]])\s*=/g)) addList(m[1]);
  // multiple declarators on one statement: `const a = 1, b = 2`
  for (const m of text.matchAll(new RegExp(',\\s*(' + ID + ')\\s*=(?!=|>)', 'g'))) names.add(m[1]);
  // function declarations + their params, arrow params, catch / for bindings
  for (const m of text.matchAll(new RegExp('\\bfunction\\s*(' + ID + ')?\\s*\\(([^)]*)\\)', 'g'))) { if (m[1]) names.add(m[1]); addList(m[2]); }
  for (const m of text.matchAll(/\(([^()]*)\)\s*=>/g)) addList(m[1]);
  for (const m of text.matchAll(new RegExp('(' + ID + ')\\s*=>', 'g'))) names.add(m[1]);
  for (const m of text.matchAll(new RegExp('\\bcatch\\s*\\(\\s*(' + ID + ')', 'g'))) names.add(m[1]);
  return names;
}
function usedIn(text) {
  const used = new Set();
  // a bare identifier: not a property (`.x`), not an object key (`x:` outside a ternary is rare in calls)
  for (const m of text.matchAll(new RegExp('(?<![.$\\w])(' + ID + ')(?![\\w$])(?!\\s*:(?!:))', 'g'))) used.add(m[1]);
  return used;
}

// Split a module into its two-space-indent functions; everything else is module scope.
function siblings(src) {
  const code = codeOnly(src).split(/\r?\n/);
  const fns = [], modLines = [];
  for (let i = 0; i < code.length; i++) {
    const m = /^  (?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(code[i]);
    if (!m) { modLines.push(code[i]); continue; }
    let j = i;
    // a one-line function closes on its own line; otherwise the body ends at the next `  }` at the same indent
    if (!/^  (?:async\s+)?function[^{]*\{.*\}\s*$/.test(code[i])) { j = i + 1; while (j < code.length && !/^  \}/.test(code[j])) j++; }
    fns.push({ name: m[1], line: i + 1, text: code.slice(i, j + 1).join('\n') });
    i = j;
  }
  return { fns, moduleText: modLines.join('\n') };
}

function strayLocals(src) {
  const { fns, moduleText } = siblings(src);
  const moduleNames = declaredIn(moduleText);
  for (const f of fns) moduleNames.add(f.name);           // every sibling function is itself module-scope
  for (const f of fns) f.decl = declaredIn(f.text);
  const bad = [];
  for (const f of fns) {
    const used = usedIn(f.text);
    for (const g of fns) {
      if (g === f) continue;
      for (const name of g.decl) {
        if (!used.has(name) || f.decl.has(name) || moduleNames.has(name)) continue;
        bad.push(f.name + ' (line ' + f.line + ') uses `' + name + '`, a local of ' + g.name + ' (line ' + g.line + ')');
      }
    }
  }
  return [...new Set(bad)];
}

// the detector itself: the exact shape that shipped must be caught, and its fix must pass
const SHIPPED = [
  "const P = (() => {",
  "  function paint(docks) {",
  "    const pick = () => docks[0];",
  "    wire(docks);",
  "  }",
  "  function wire(docks) {",
  "    btn.onclick = () => post({ agentId: pick() });",
  "  }",
  "})();"].join('\n');
A.ok(strayLocals(SHIPPED).some(s => /wire .* uses `pick`, a local of paint/.test(s)), 'the detector catches a sibling calling another function\'s const');
A.ok(strayLocals(SHIPPED.replace('post({ agentId: pick() })', 'post({ agentId: docks[0] })')).length === 0, 'resolving from the function\'s own params passes');
A.ok(strayLocals("const P = (() => {\n  const shared = 1;\n  function a() { const shared = 2; return shared; }\n  function b() {\n    return shared;\n  }\n})();").length === 0, 'a module-scope name used by a sibling is fine even if another function shadows it');
A.ok(strayLocals("const P = (() => {\n  function a() {\n    const msg = 'uses trg';\n  }\n  function b() {\n    return 'msg in a string, // msg in prose';\n  }\n})();").length === 0, 'names inside strings and comments are not uses');

for (const rel of GUARDED) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const { fns } = siblings(src);
  A.ok(fns.length > 0 || rel !== 'frontend/app/workflowpanel.js', rel + ': the two-space function layout is still parseable (' + fns.length + ' functions)');
  const bad = strayLocals(src);
  A.ok(bad.length === 0, rel + ': no function reaches into a sibling\'s locals' + (bad.length ? ' — ' + bad.join('; ') : ''));
}

A.report('sibling-scope');
