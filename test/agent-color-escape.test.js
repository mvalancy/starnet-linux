/* node test/agent-color-escape.test.js — a saved agent suit colour can never break out of a style attribute
   (2026-09-23 security audit).

   A shared "station backup" is written verbatim into localStorage and rehydrated into the roster; the crew
   dossier, agent list and camera ticker concatenated `color` straight into style="color:…". A crafted colour
   such as `x" onmouseover="…` ran script in the app origin (which holds the API token). Two layers now:
   rehydrateRoster only accepts a hex colour, and every sink escapes. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const app = p => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', p), 'utf8');

// ---- 1. the load-time validator (evaluated from the shipped source, not a copy) ----
{
  const src = app('app.js');
  // rehydrateRoster is extracted and run standalone (here and by other tests): the validator is inline in it
  const restore = src.match(/function rehydrateRoster\(savedAgents\) \{[\s\S]*?\n  \}/)[0];
  A.ok(/color: \/\^#\[0-9a-f\]\{3,8\}\$\/i\.test\(String\(s\.color/.test(restore), 'rehydrateRoster validates the saved colour inline');
  const reload = (rows, SUITS) => {
    const agents = new Map();
    new Function('agents', 'agent', 'DATA', 'executionProfileOf', 'agentDocs', 'composeSystemPrompt', 'registerAgent', 'SUITS',
      restore + '; rehydrateRoster(' + JSON.stringify(rows) + ');')(agents, { model: 'm' }, { DEFAULT_SKIN: 'default' }, () => 'local', () => {}, () => '', () => {}, SUITS);
    return agents;
  };
  const got = reload([
    { id: 'evil', color: 'x" onmouseover="alert(1)' }, { id: 'css', color: 'red;background:url(//evil)' },
    { id: 'fine', color: '#cf7d96' }, { id: 'short', color: '#abc' }, { id: 'none' }
  ], ['#6fb3bf', '#7bc88a']);
  A.ok(/^#[0-9a-f]{6}$/i.test(got.get('evil').color), 'a markup-bearing saved colour is replaced by a palette hex on reload');
  A.ok(/^#[0-9a-f]{6}$/i.test(got.get('css').color), 'a CSS-injection colour is replaced too');
  A.eq(got.get('fine').color, '#cf7d96', 'a real saved colour round-trips through reload');
  A.eq(got.get('short').color, '#abc', 'short hex survives');
  A.ok(/^#[0-9a-f]{6}$/i.test(got.get('none').color), 'a missing colour gets a palette suit');
  A.ok(/^#[0-9a-f]{6}$/i.test(reload([{ id: 'evil', color: '"><img src=x>' }]).get('evil').color), 'still safe when SUITS is not in scope (extraction tests)');
  A.ok(/function rehydrateRoster[\s\S]{0,700}name:\s*s\.name/.test(src), 'the name field stays inside the window recruit-identity-ui.test pins');
}

// ---- 2. every style="color:…" sink escapes the value ----
{
  const ui = app('stationui.js');
  A.ok(!/style="color:' \+ a\.color \+/.test(ui), 'crew dossier name/rename never concatenates a raw colour');
  A.ok(!/style="color:' \+ x\.color \+/.test(ui), 'agent list dot never concatenates a raw colour');
  A.ok(/aria-label="Rename agent" style="color:' \+ esc\(a\.color\)/.test(ui), 'rename input escapes the colour');
  A.ok(/class="ag-name" style="color:' \+ esc\(a\.color\)/.test(ui), 'dossier name escapes the colour');
  A.ok(/class="ag-item-dot" style="color:' \+ esc\(x\.color\)/.test(ui), 'agent list dot escapes the colour');
  const world = app('world.js');
  A.ok(/style="color:' \+ esc\(suit\)/.test(world), 'camera ticker escapes the suit colour');
  const raw = [];
  for (const f of ['stationui.js', 'world.js', 'app.js']) {
    app(f).split('\n').forEach((l, i) => { if (/style="color:' \+ [a-z]+\.color \+/.test(l)) raw.push(f + ':' + (i + 1)); });
  }
  A.eq(raw, [], 'no remaining raw agent-colour sink in the roster surfaces');
}

A.report('agent-color-escape.test');
