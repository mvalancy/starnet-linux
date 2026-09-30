/* node test/openai-waiting-keepalive.test.js — /v1 chat-completions streaming turns the loop's agent.waiting
   heartbeat into an SSE COMMENT line (2026-09-23, live-events lane).

   A slow first byte or a retry backoff used to leave a streaming /v1 client's socket byte-silent for minutes (the
   chat stream has no keepalive of its own). Each agent.waiting now writes ": waiting <phase> <seconds>s" — ignored by
   every SSE client, so the OpenAI wire contract is untouched: the content deltas, the final chunk and [DONE] are
   exactly as before, and a waiting beat never becomes a data: line. The sync (non-stream) response is unchanged.

   In-process: the production HTTP adapter over a fake runOnce with deterministic events; no provider, no sidecar. */
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeOpenAiCompat } = require('../sidecar/openai-compat');

(async () => {
  let serial = 0;
  const api = makeOpenAiCompat({ now: () => 1000, newId: () => String(++serial),
    apiKey: () => 'waiting-test-key-1234567', readBody: async req => { let s = ''; for await (const c of req) s += c; return s; },
    runOnce: o => {
      o.emit('agent.run.start', { runId: o.runId });
      o.emit('agent.waiting', { agentId: 'a', runId: o.runId, phase: 'first_byte', sinceMs: 15000, model: 'm' });
      o.emit('provider.retry', { agentId: 'a', runId: o.runId, attempt: 1, reason: 'overloaded', delayMs: 400 });
      o.emit('agent.waiting', { agentId: 'a', runId: o.runId, phase: 'retry_backoff', sinceMs: 14600, model: 'm' });
      // a hostile/garbled phase can never break out of the comment line into a data: field
      o.emit('agent.waiting', { agentId: 'a', runId: o.runId, phase: 'first_byte\n\ndata: {"x":1}', sinceMs: 30499 });
      o.emit('agent.token', { delta: 'hello' });
      o.emit('agent.cost', { tokensIn: 7, tokensOut: 3 });
      o.emit('agent.run.end', { reason: 'done' });
    }
  });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer waiting-test-key-1234567', 'Content-Type': 'application/json' };
  const post = body => fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  let n = 0;
  try {
    const raw = await (await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
    const comments = raw.split('\n').filter(l => l.startsWith(': '));
    assert.deepEqual(comments, [': waiting first_byte 15s', ': waiting retry_backoff 15s', ': waiting other 30s'], 'one comment per heartbeat, phase + whole seconds (an unknown phase reads other)'); n++;
    assert.ok(!/data: \{"x":1\}/.test(raw), 'a garbled phase cannot inject a data: line'); n++;
    const data = raw.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
    assert.equal(data.map(c => (c.choices[0].delta || {}).content || '').join(''), 'hello', 'content deltas are exactly the tokens'); n++;
    assert.equal(data.at(-1).choices[0].finish_reason, 'stop', 'final chunk unchanged'); n++;
    assert.ok(raw.endsWith('data: [DONE]\n\n'), '[DONE] still closes the stream'); n++;
    assert.ok(!/overloaded|"attempt"/.test(raw), 'provider.retry itself is not written to the chat stream'); n++;
    const sync = await (await post({ stream: false, messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(sync.choices[0].message.content, 'hello', 'the sync response is unaffected'); n++;
    console.log('openai-waiting-keepalive: OK (' + n + ' assertions)');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
