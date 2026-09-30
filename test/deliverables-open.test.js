/* node test/deliverables-open.test.js — the DELIVERABLES library OPEN control must
 * use the same proven desktop artifact bridge as COMMS, and browser previews must
 * render inside the row the Commander clicked instead of below the whole library. */
'use strict';

const A = require('./_assert.js');
const D = require('../frontend/app/deliverables.js');
const fs = require('fs');
const path = require('path');

const frontendSource = fs.readFileSync(path.join(__dirname, '../frontend/app/deliverables.js'), 'utf8');
const websiteSource = fs.readFileSync(path.join(__dirname, '../website/app/app/deliverables.js'), 'utf8');
A.eq(websiteSource, frontendSource, 'the generated website Deliverables surface stays byte-identical');
A.ok(/\(r\.files \|\| \[\]\)\.map\(\(f, fi\) => f\.openUrl/.test(frontendSource),
  'OPEN data-file indices remain aligned with the original backend file array');
A.ok(/data-preview aria-live="polite"><\/div><\/article>/.test(frontendSource),
  'every deliverable row owns the preview region its OPEN control paints');
A.ok(frontendSource.indexOf('window.open(') < 0,
  'the Deliverables panel no longer relies on the desktop-blocked window.open path');

A.ok(typeof D.handleOpenClick === 'function', 'the production delegated OPEN handler is testable');
if (typeof D.handleOpenClick !== 'function') A.report('deliverables-open.test');

function clickFor(row, preview) {
  const card = {
    dataset: { i: '0' },
    querySelector(selector) { return selector === '[data-preview]' ? preview : null; }
  };
  const link = {
    dataset: { file: '0' },
    closest(selector) {
      if (selector === 'a[data-file]') return link;
      if (selector === '[data-i]') return card;
      return null;
    }
  };
  const event = {
    target: link,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  };
  return { event, rows: [row], preview };
}

(async () => {
  const oldWindow = global.window;
  const oldFetch = global.fetch;
  try {
    const calls = [];
    global.window = {
      __STARNET_API__: 'http://127.0.0.1:61661',
      __STARNET_API_TOKEN__: 'launch-token',
      __TAURI__: { core: { invoke: async (name, args) => { calls.push({ name, args }); } } },
      getSelection: () => '',
      crypto: require('node:crypto').webcrypto
    };
    global.ApiTicket = require('../frontend/app/apiticket.js');   // the page loads app/apiticket.js first

    const run = clickFor({
      id: 'run:agent:run-1', agentId: 'agent', runId: 'run-1', source: 'run',
      files: [{ path: 'reports/final.md', preview: 'markdown', sandboxed: false,
        openUrl: '/api/file?agent=agent&path=reports%2Ffinal.md' }]
    }, { innerHTML: 'untouched' });
    await D.handleOpenClick(run.event, run.rows);
    A.eq(calls, [{
      name: 'starnet_open_artifact',
      args: { path: 'reports/final.md', agentId: 'agent' }
    }], 'one library click hands the exact run artifact identity to the native host');
    A.ok(run.event.prevented && run.event.stopped, 'desktop OPEN cannot fall through into a second navigation');
    A.eq(run.preview.innerHTML, 'untouched', 'desktop OPEN does not also paint a hidden inline preview');

    calls.length = 0;
    const workshop = clickFor({
      id: 'workshop:agent:run-2', agentId: 'agent', runId: 'run-2', source: 'workshop',
      files: [{ path: 'brief.md', preview: 'markdown', sandboxed: false,
        openUrl: '/api/file?agent=agent&path=workshop%2Frun-2%2Fbrief.md' }]
    }, { innerHTML: '' });
    await D.handleOpenClick(workshop.event, workshop.rows);
    A.eq(calls[0] && calls[0].args.path, 'workshop/run-2/brief.md',
      'Workshop OPEN preserves the backend-proven jailed path instead of guessing from the display name');

    delete global.window.__TAURI__;
    let fetched = '';
    global.fetch = async url => {
      fetched = String(url);
      return { ok: true, text: async () => '# Visible beside this row' };
    };
    const browserPreview = { innerHTML: '', querySelector: () => null };
    const browser = clickFor({
      id: 'run:agent:run-3', agentId: 'agent', runId: 'run-3', source: 'run',
      files: [{ path: 'notes.md', preview: 'markdown', sandboxed: false,
        openUrl: '/api/file?agent=agent&path=notes.md' }]
    }, browserPreview);
    await D.handleOpenClick(browser.event, browser.rows);
    A.ok(browserPreview.innerHTML.indexOf('SAFE PREVIEW') >= 0 && browserPreview.innerHTML.indexOf('Visible beside this row') >= 0,
      'browser preview paints inside the clicked card');
    A.ok(fetched.indexOf('http://127.0.0.1:61661/api/file?') === 0 && /[?&]ticket=st1\./.test(fetched) && fetched.indexOf('launch-token') < 0,
      'browser preview uses the real desktop API base and a scoped ticket — never the launch token in the URL');
    const state = {};
    let releaseOld;
    global.fetch = () => new Promise(resolve => { releaseOld = resolve; });
    const stale = D.handleOpenClick(browser.event, browser.rows, state);
    global.fetch = async () => ({ ok: true, text: async () => 'Newest selection' });
    await D.handleOpenClick(browser.event, browser.rows, state);
    releaseOld({ ok: true, text: async () => 'Obsolete selection' }); await stale;
    A.ok(browserPreview.innerHTML.includes('Newest selection') && !browserPreview.innerHTML.includes('Obsolete'), 'a late response cannot replace the newest preview');
    let releaseBody;
    global.fetch = async () => ({ ok: true, text: () => new Promise(resolve => { releaseBody = resolve; }) });
    const staleBody = D.handleOpenClick(browser.event, browser.rows, state);
    await new Promise(resolve => setImmediate(resolve));
    global.fetch = async () => ({ ok: true, text: async () => 'Latest body' });
    await D.handleOpenClick(browser.event, browser.rows, state);
    releaseBody('Obsolete body'); await staleBody;
    A.ok(browserPreview.innerHTML.includes('Latest body') && !browserPreview.innerHTML.includes('Obsolete'), 'the race guard covers response bodies too');
    let failOld; const notices = [];
    global.fetch = () => new Promise((_, reject) => { failOld = reject; });
    const failedOld = D.handleOpenClick(browser.event, browser.rows, state, text => notices.push(text));
    global.fetch = async () => ({ ok: true, text: async () => 'Still current' });
    await D.handleOpenClick(browser.event, browser.rows, state);
    failOld(new Error('old outage')); await failedOld;
    A.eq(notices, [], 'stale failures do not clear the current preview or display unrelated errors');
    A.ok(browserPreview.innerHTML.includes('Still current'), 'latest preview survives stale failure');
  } finally {
    global.window = oldWindow;
    global.fetch = oldFetch;
  }

  A.report('deliverables-open.test');
})().catch(error => { console.error(error); process.exit(1); });
