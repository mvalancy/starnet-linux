/* node test/compaction.images.test.js — Step 2 wave 2, audit F4: pixels never reach the summarizer as text, and one
   oversized message cannot force a pile of summarizer calls.

   The bug (audit probe 09-22): messages were rendered with JSON.stringify, so each screenshot's `image_url` part
   went to the summarizer as its base64 data URL (~300k chars), and a turn-group bigger than a chunk was never split:
   three screenshots = six paid summarizer calls carrying 900,000 base64 chars. Now an image part renders as
   "[image ...]" (naming the tool that captured it when known), inline data URLs / long base64 runs become sized
   markers, and an oversized turn-group is bounded to one chunk with an explicit marker (reported in truncatedChars).

   Real makeSummarizer (chunked) with a recording stream; plus the loop's fallback digest. Deterministic. */
'use strict';
const A = require('./_assert.js');
const { makeSummarizer, partition, renderMessage } = require('../sidecar/compaction-summarizer.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext, RUN_CONTEXT_DEFAULTS, compactionSummaryPrompt } = require('../sidecar/context.js');
const { makeCostEngine } = require('../sidecar/cost.js');

const B64 = Buffer.alloc(225000, 7).toString('base64');   // ~300k chars: a modest full-page PNG
const B64_RUN = /[A-Za-z0-9+/]{200,}/;
function recorder() {
  const inputs = [];
  const streamFn = async function* (req) { inputs.push(req.messages[1].content); yield { type: 'text', delta: '## Completed\n- summarized' }; yield { type: 'done', finishReason: 'stop' }; };
  return { inputs, streamFn };
}
function shotGroup(i) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id: 's' + i, type: 'function', function: { name: 'browser_screenshot', arguments: '{"url":"https://example.test/p' + i + '"}' } }] },
    { role: 'tool', tool_call_id: 's' + i, content: 'screenshot ' + i + ' saved' },
    { role: 'user', content: [{ type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE — the actual pixel output of the tool call above.]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + B64 } }] }
  ];
}

(async () => {
  // ---- 1. three screenshots: no base64 in any summarizer input; one call, not six ----
  {
    const rec = recorder();
    const older = [].concat(shotGroup(1), shotGroup(2), shotGroup(3));
    older.push({ role: 'user', content: [{ type: 'text', text: 'here is the mock I meant' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + B64 } }] });
    older.push({ role: 'tool', tool_call_id: 'x', content: 'inline preview: data:image/png;base64,' + B64.slice(0, 50000) + ' end' });
    older.push({ role: 'tool', tool_call_id: 'y', content: '{"b64_json":"' + Buffer.alloc(30000, 201).toString('base64') + '"}' });
    const r = await makeSummarizer({ model: 'm', provider: {}, streamFn: rec.streamFn, summaryPrompt: compactionSummaryPrompt })(older, '', {});
    const all = rec.inputs.join('\n');
    A.eq(rec.inputs.length, 1, 'one summarizer call for the whole slice (was 6 with the base64 inline)');
    A.eq(r.chunks, 1, 'chunks reported = 1');
    A.ok(all.indexOf('data:image') < 0 && all.indexOf(';base64,') < 0, 'no data URL reached the summarizer');
    A.ok(!B64_RUN.test(all), 'no base64 run of 200+ chars reached the summarizer');
    A.ok(all.length < 8000, 'the whole input is small (' + all.length + ' chars, was ~900k)');
    A.eq((all.match(/\[image: screen capture from browser_screenshot\]/g) || []).length, 3, 'each screenshot is named as an image from the tool that captured it');
    A.ok(all.indexOf('here is the mock I meant\n[image]') >= 0, 'a Commander attachment keeps its words and names its image');
    A.ok(/\[base64 data omitted: \d+ chars\]/.test(all), 'a raw base64 blob in a tool result is a sized marker');
    A.ok(all.indexOf('→ called browser_screenshot({"url":"https://example.test/p1"})') >= 0, 'the summarizer sees what was called');
  }

  // ---- 2. one oversized message is BOUNDED to one chunk with an explicit marker (not N calls / not a 500k input) ----
  {
    const rec = recorder();
    const prose = 'The deployment log line number NNN reports status ok for shard alpha. '.repeat(8000);   // ~560k chars of text
    const older = [{ role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_log', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'r1', content: 'HEAD-OF-LOG ' + prose + ' TAIL-OF-LOG' }];
    const r = await makeSummarizer({ model: 'm', provider: {}, streamFn: rec.streamFn, summaryPrompt: compactionSummaryPrompt })(older, '', {});
    A.eq(rec.inputs.length, 1, 'a single oversized message is one summarizer call');
    A.ok(rec.inputs[0].length <= 48000 + 2000, 'its input is bounded to about one chunk (' + rec.inputs[0].length + ' chars)');
    A.ok(/\[… \d+ chars of an oversized message omitted from the summarizer input …\]/.test(rec.inputs[0]), 'the cut is marked explicitly');
    A.ok(rec.inputs[0].indexOf('HEAD-OF-LOG') >= 0 && rec.inputs[0].indexOf('TAIL-OF-LOG') >= 0, 'head and tail of the message survive');
    A.ok(r.truncatedChars > 500000, 'truncatedChars reports the loss (' + r.truncatedChars + ') — a lossy fold says so in agent.compact');
    // a group of several big results shares the chunk: every result keeps a head
    const many = [{ role: 'assistant', content: '', tool_calls: [1, 2, 3].map(k => ({ id: 'm' + k, type: 'function', function: { name: 'read', arguments: '{}' } })) }];
    for (const k of [1, 2, 3]) many.push({ role: 'tool', tool_call_id: 'm' + k, content: 'RESULT-' + k + ' ' + prose.slice(0, 100000) });
    const chunks = partition(many, 48000);
    A.eq(chunks.length, 1, 'three big results in one turn-group stay one chunk');
    A.ok([1, 2, 3].every(k => chunks[0].indexOf('RESULT-' + k) >= 0), 'each result keeps its head inside the bounded group');
  }

  // ---- 3. rendering unchanged for plain text (the common case stays byte-identical) ----
  A.eq(renderMessage({ role: 'tool', content: 'plain text result' }), 'tool: plain text result', 'plain string content renders as before');
  A.eq(renderMessage({ role: 'user', content: 'x'.repeat(5000) }), 'user: ' + 'x'.repeat(5000), 'a long single-character run is not mistaken for base64');

  // ---- 4. the loop's no-LLM FALLBACK digest never copies image bytes into the prompt either ----
  {
    const ctx = makeContext(Object.assign({ contextLimit: 20000 }, RUN_CONTEXT_DEFAULTS));
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'directive' }];
    for (let i = 1; i <= 3; i++) {
      const g = shotGroup(i);
      // a short fence: the old digest (JSON.stringify(content).slice(0, 160)) reached into the data URL's bytes
      g[2] = { role: 'user', content: [{ type: 'text', text: '[BEGIN EXTERNAL SCREEN CAPTURE]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + B64.slice(0, 20000) } }] };
      messages.push(g[0], Object.assign({}, g[1], { content: 'r'.repeat(20000) }), g[2]);
    }
    messages.push({ role: 'user', content: 'continue' });
    const sent = [];
    const provider = { priceOf: () => null, contextLimit: () => 20000, stream: async function* (req) { sent.push(req.messages.slice()); yield { type: 'text', delta: 'ok' }; yield { type: 'done', finishReason: 'stop' }; } };
    const compacts = [];
    await runAgentLoop({ messages, provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx, emit: (n, p) => { if (n === 'agent.compact') compacts.push(p); },
      microCompaction: false, model: 'm', agentId: 'a', runId: 'r' });   // no summarizer -> the deterministic fallback digest
    A.ok(compacts.some(p => p.reason === 'fallback'), 'the fallback fold ran');
    const note = sent[0].find(m => m.role === 'system' && /^<conversation_summary>/.test(String(m.content)));
    A.ok(note && note.content.indexOf('base64') < 0 && !B64_RUN.test(note.content), 'the fallback note carries no image bytes');
  }

  A.report('compaction.images.test');
})().catch(e => { console.error(e); process.exit(1); });
