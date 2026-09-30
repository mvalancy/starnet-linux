/* node test/context.image-estimate.test.js — an IMAGE costs what the provider bills, not what String() says.

   context.js estimated a message as estimateTokens(m.content), and a multimodal content is an ARRAY:
   String([{…},{…}]) is "[object Object],[object Object]", so a 300k-character screenshot counted ~12 tokens
   (probed on 29bb21d80) against the ~1,500 a vision API bills. Compaction thresholds and the overflow classifier
   were measuring screenshot-heavy prompts as nearly empty. Now every image part is costed from its pixel
   dimensions when the data carries them (PNG/GIF/WebP/JPEG headers, or explicit width/height) with the
   documented resize-then-(w*h)/750 rule, else a flat 1,500; text parts keep the text estimator. */
'use strict';
const A = require('./_assert.js');
const { makeContext, imageTokens, estimateContentTokens, IMAGE_TOKENS_DEFAULT } = require('../sidecar/context.js');

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const ascii = (s) => Array.from(s).map(c => c.charCodeAt(0));
const b64 = (bytes, padTo) => {
  let s = Buffer.from(bytes).toString('base64');
  while (padTo && s.length < padTo) s += 'AAAA';   // a realistically large payload: the pixels past the header
  return s;
};
const png = (w, h, padTo) => b64([0x89].concat(ascii('PNG'), [13, 10, 26, 10], u32(13), ascii('IHDR'), u32(w), u32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]), padTo);
const gif = (w, h) => b64(ascii('GIF89a').concat([w & 255, w >> 8, h & 255, h >> 8], [0, 0, 0]));
const webpVP8X = (w, h) => b64(ascii('RIFF').concat([0, 0, 0, 0], ascii('WEBP'), ascii('VP8X'), [10, 0, 0, 0], [0, 0, 0, 0],
  [(w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]));
// a JPEG whose SOF0 sits AFTER an APP1 (EXIF-style) segment, like a camera/screenshot tool writes it
const jpeg = (w, h) => b64([0xff, 0xd8, 0xff, 0xe1].concat(u16(16), new Array(14).fill(0x45), [0xff, 0xc0], u16(17), [8], u16(h), u16(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9]));
const part = (mime, data) => ({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + data } });

// ---- 1. DIMENSIONS DRIVE THE COST ----
{
  A.eq(imageTokens(part('image/png', png(1280, 800))), Math.ceil(1280 * 800 / 750), 'a 1280x800 PNG costs (w*h)/750 = 1366 tokens (header read from the data URL)');
  const fullHd = imageTokens(part('image/png', png(1920, 1080)));
  A.ok(fullHd >= 1530 && fullHd <= 1540, 'a 1920x1080 capture is resized to the ~1.15 MP ceiling first: ~1534 tokens (got ' + fullHd + ')');
  A.eq(imageTokens(part('image/jpeg', jpeg(800, 600))), 640, 'a JPEG is sized from its SOF marker, found past an APP1 segment (800x600 -> 640)');
  A.eq(imageTokens(part('image/gif', gif(100, 50))), 85, 'a tiny GIF still costs the fixed minimum (85), never ~0');
  const wide = imageTokens(part('image/webp', webpVP8X(2000, 1000)));
  A.ok(wide >= 1530 && wide <= 1540, 'a WebP (VP8X) is sized and capped the same way (got ' + wide + ')');
  A.eq(imageTokens({ type: 'image_url', image_url: { url: 'https://example.com/x.png' }, width: 750, height: 1000 }), 1000, 'explicit width/height on the part win');
  A.eq(imageTokens({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(1500, 500) } }), 1000, 'the Anthropic-native base64 shape is read too');
}

// ---- 2. NO DIMENSIONS -> THE DOCUMENTED FLAT CHARGE ----
{
  A.eq(IMAGE_TOKENS_DEFAULT, 1500, 'the flat per-image charge is 1,500 tokens (the reference harness\'s constant)');
  A.eq(imageTokens(part('image/png', 'Zm9vYmFyYmF6' + 'A'.repeat(4000))), 1500, 'unreadable image bytes cost the flat 1,500');
  A.eq(imageTokens({ type: 'image_url', image_url: { url: 'https://example.com/shot.png' } }), 1500, 'a remote URL costs the flat 1,500');
  A.eq(imageTokens({ type: 'image_url', image_url: 'data:image/png;base64,' + png(1280, 800) }), 1366, 'a bare-string image_url is read as well');
  A.eq(imageTokens({ type: 'text', text: 'hi' }), 0, 'a text part is not an image');
}

// ---- 3. THE MESSAGE ESTIMATE USES IT (the actual bug) ----
{
  const ctx = makeContext({ contextLimit: 32768 });
  const label = '[BEGIN EXTERNAL SCREEN CAPTURE — the actual pixel output of the tool call above.]';
  const shot = { role: 'user', content: [{ type: 'text', text: label }, part('image/png', png(1280, 800, 300000))] };
  A.ok(shot.content[1].image_url.url.length > 300000, 'fixture: a 300k-character screenshot data URL');
  const est = ctx.estimateMessages([shot]);
  A.eq(est, Math.ceil(label.length / 4) + 1366 + 4, 'the screenshot turn costs label + 1,366 image tokens + framing (' + est + ')');
  A.ok(est > 1000, 'it no longer counts as ~12 tokens (String(array)/4 was ' + Math.ceil(String(shot.content).length / 4) + ')');
  A.ok(est < 5000, 'nor as its base64 length (~75k tokens) — pixels are not text');
  const two = { role: 'user', content: [{ type: 'text', text: 'a' }, part('image/png', png(1280, 800)), part('image/png', 'garbage!!')] };
  A.eq(ctx.estimateMessages([two]), 1 + 1366 + 1500 + 4, 'each image in a turn is charged on its own');
  // text-only messages are byte-identical to before
  const plain = [{ role: 'system', content: 'x'.repeat(401) }, { role: 'user', content: 'hello' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'fs_read', arguments: '{"p":"a"}' } }] }];
  A.eq(ctx.estimateMessages(plain), (Math.ceil(401 / 4) + 4) + (Math.ceil(5 / 4) + 4) + (0 + 4 + Math.ceil(7 / 4) + Math.ceil(9 / 4) + 4), 'string content is estimated exactly as before');
  A.eq(estimateContentTokens([{ type: 'text', text: 'abcd' }, { type: 'input_audio', input_audio: { data: 'xx' } }]), 1 + Math.ceil(JSON.stringify({ type: 'input_audio', input_audio: { data: 'xx' } }).length / 4), 'any other part is measured as its JSON');
}

// ---- 4. fit() keeps a turn it can afford and drops one it cannot, by the IMAGE cost ----
{
  const ctx = makeContext({ contextLimit: 8000 });
  const shotTurn = (w, h) => ({ role: 'user', content: [{ type: 'text', text: 'shot' }, part('image/png', png(w, h))] });
  const msgs = [{ role: 'system', content: 'sys' }, shotTurn(1920, 1080), { role: 'user', content: 'newest' }];
  const fitted = ctx.fit(msgs, { maxTokens: 1000 });
  A.eq(fitted.length, 2, 'a 1,534-token screenshot does not fit a 1,000-token budget, so fit() drops it (it used to count ~5 tokens and stay)');
}

A.report('context.image-estimate.test');
