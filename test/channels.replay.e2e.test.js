'use strict';
const assert = require('node:assert/strict');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const fixture = SidecarFixture.create({ prefix: 'starnet-replay-', env: { SKYNET_DEV: '1', SKYNET_QUEST_REFRESH: '0' } });
async function open(cursor) {
  const abort = new AbortController();
  const response = await fixture.request('/api/channels/events?' + require('./_httpToken.js').sseQuery(fixture.token) + '&cursor=' + encodeURIComponent(cursor || ''), { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); let pending = '';
  return { close() { abort.abort(); }, async ready() {
    const frames = [];
    for (;;) {
      const { value, done } = await reader.read(); assert.equal(done, false);
      pending += new TextDecoder().decode(value);
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split('\n').find(l => l.startsWith('data: '));
        if (!data) continue;
        const message = JSON.parse(data.slice(6)); frames.push(message);
        if (message.stream === 'ready') return frames;
      }
    }
  } };
}
(async () => {
  let stream;
  try {
    await fixture.start();
    stream = await open();
    const first = (await stream.ready()).at(-1); stream.close();
    assert.equal(first.reset, true);
    const inbound = await fixture.json('POST', '/api/dev/inbound', { text: '/help', chatId: 'replayproof' });
    assert.equal(inbound.status, 200);
    stream = await open(first.cursor);
    const replay = await stream.ready(); stream.close();
    assert.equal(replay.at(-1).reset, false);
    assert.ok(replay.some(m => m.name), 'real channel events emitted while disconnected are replayed');
    const cursor = replay.at(-1).cursor;
    stream = await open(cursor); assert.equal((await stream.ready()).length, 1); stream.close();
    await fixture.stop(); await fixture.start();
    stream = await open(cursor);
    assert.equal((await stream.ready()).at(-1).reset, true, 'a real sidecar restart invalidates the old epoch');
    console.log('channels.replay.e2e: real offline channel events, no duplicate replay, and restart reset passed');
  } finally { if (stream) stream.close(); await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
