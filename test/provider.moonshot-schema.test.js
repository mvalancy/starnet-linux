/* node test/provider.moonshot-schema.test.js — the Kimi / Moonshot tool-schema dialect (Hermes audit Step 2,
   2026-09-22). Moonshot answers an off-dialect schema with HTTP 400 "tools.function.parameters is not a valid
   moonshot flavored json schema" on the whole request. The rules (ported from the reference harness'
   moonshot_schema.py + its tests): every property carries a `type`; no `type` beside `anyOf`, null branches
   dropped; no null/"" inside a scalar enum; every object schema carries `required`; no `nullable` keyword.
   Applied ONLY on Kimi/Moonshot routes — every other route's tools stay byte-identical. Injected fetch only. */
'use strict';
const A = require('./_assert.js');
const toolschema = require('../sidecar/providers/toolschema.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');

const forMoonshot = toolschema.forMoonshot;
const sse = lines => new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const DONE = () => sse(['data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]']);

// A realistic zod/Pydantic-authored connector schema carrying every shape Moonshot refuses.
const HOSTILE = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['fast', 'slow', null, ''] },
    note: { description: 'no type at all' },
    count: { enum: [1, 2, 3] },
    from_format: { type: 'string', anyOf: [{ type: 'string' }, { type: 'null' }] },
    either: { type: 'string', anyOf: [{ type: 'string' }, { type: 'integer' }] },
    db_type: { anyOf: [{ enum: ['mysql', 'postgresql', ''] }, { type: 'null' }] },
    filter: { type: 'object', properties: { field: { description: 'untyped' } } },
    tags: { type: 'array', items: { enum: ['a', 'b'] } },
    maybe: { type: 'string', nullable: true },
    payload: { $ref: '#/$defs/Payload' }
  },
  required: ['mode', 'ghost'],
  $defs: { Payload: { type: 'object', properties: {} } }
};

(async () => {
  // ---- 1. the rules, node by node ----
  {
    const snapshot = JSON.stringify(HOSTILE);
    const out = forMoonshot(HOSTILE);
    const p = out.properties;
    A.eq(p.mode, { type: 'string', enum: ['fast', 'slow'] }, 'null and "" are dropped from a scalar enum');
    A.eq(p.note, { description: 'no type at all', type: 'string' }, 'a property with no type gets one (string)');
    A.eq(p.count.type, 'integer', 'an untyped enum takes its first value\'s type');
    A.eq(p.from_format, { type: 'string' }, 'anyOf [string, null] collapses to the single non-null branch');
    A.eq(p.either, { anyOf: [{ type: 'string' }, { type: 'integer' }] }, 'a genuine union keeps anyOf but loses the parent type');
    A.eq(p.db_type, { enum: ['mysql', 'postgresql'], type: 'string' }, 'a nullable enum union becomes a typed enum without null or ""');
    A.eq(p.filter, { type: 'object', properties: { field: { description: 'untyped', type: 'string' } }, required: [] }, 'nested nodes are repaired and every object carries required');
    A.eq(p.tags.items, { enum: ['a', 'b'], type: 'string' }, 'array items are repaired');
    A.eq(p.maybe, { type: 'string' }, 'the non-standard nullable keyword is dropped (and NOT re-expressed)');
    A.eq(p.payload, { $ref: '#/$defs/Payload' }, 'a $ref node takes its type from its target — no synthetic type');
    A.eq(out.$defs.Payload, { type: 'object', properties: {}, required: [] }, 'definitions are repaired too');
    A.eq(out.required, ['mode'], 'required is pruned to names that exist');
    A.eq(out.type, 'object', 'the top level is an object schema');
    A.eq(JSON.stringify(HOSTILE), snapshot, 'the input schema is not mutated');

    A.eq(forMoonshot(null), { type: 'object', properties: {}, required: [] }, 'no schema -> the minimal valid object');
    A.eq(forMoonshot({ type: 'string' }), { type: 'object', properties: {}, required: [] }, 'a non-object top level is coerced to an object');
    const cond = forMoonshot({ allOf: [{ if: { required: ['goal'] }, then: { properties: { mode: { enum: ['build', 'edit'] } } } }] });
    A.ok(!('type' in cond.allOf[0]), 'a bare if/then conditional is not given a synthetic type');
    A.eq(cond.allOf[0].then.properties.mode.type, 'string', '…but the schemas under it are repaired');
  }

  // ---- 2. which routes are Kimi/Moonshot ----
  {
    for (const m of ['kimi-k2.6', 'kimi-k2-thinking', 'k3', 'K3', 'k3.1-preview', 'k3-turbo', 'moonshotai/k3', 'moonshotai/Kimi-K2.6',
      'nous/moonshotai/kimi-k2.6', 'openrouter/moonshotai/kimi-k2-thinking', 'kimi-for-coding', 'kimi-for-coding-highspeed']) {
      A.ok(toolschema.isMoonshotRoute(m, ''), m + ' is a Moonshot model');
    }
    for (const m of ['', null, 'anthropic/claude-sonnet-4.6', 'openai/gpt-5.4', 'google/gemini-3-flash-preview', 'deepseek-chat', 'claude-k3']) {
      A.ok(!toolschema.isMoonshotRoute(m, 'https://api.openai.com/v1'), String(m) + ' is not');
    }
    A.ok(toolschema.isMoonshotRoute('custom-model', 'https://api.moonshot.ai/v1'), 'Moonshot\'s own endpoint is a Moonshot route whatever the model');
    A.ok(toolschema.isMoonshotRoute('custom-model', 'https://api.kimi.com/coding/v1'), 'the Kimi for Coding endpoint is too');
    A.ok(!toolschema.isMoonshotRoute('custom-model', 'https://evilmoonshot.ai/v1'), 'a look-alike host is not');
    A.ok(!toolschema.isMoonshotRoute('custom-model', 'https://api.moonshot.ai.example.com/v1'), 'a moonshot.ai prefix on another domain is not');
  }

  // ---- 3. on the wire: Kimi routes get the dialect, every other route is byte-identical ----
  {
    const tools = [
      { type: 'function', function: { name: 'connector_call', description: 'MCP', parameters: HOSTILE } },
      { type: 'function', function: { name: 'web_search', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
      { type: 'function', function: { name: 'ping' } }
    ];
    const snapshot = JSON.stringify(tools);
    async function compatBody(model, baseUrl) {
      let body = null;
      const p = makeOpenAICompatibleProvider({ key: 'k', baseUrl, fetch: async (url, init) => {
        if (!init || !init.body) return new Response('{"data":[]}', { status: 200 });
        body = JSON.parse(init.body); return DONE();
      } });
      for await (const _ of p.stream({ model, messages: [{ role: 'user', content: 'hi' }], tools })) { /* drain */ }
      return body;
    }
    const kimi = await compatBody('kimi-for-coding', 'https://api.kimi.com/coding/v1');
    A.eq(kimi.tools[0].function.parameters, forMoonshot(HOSTILE), 'Kimi OAuth route: the connector schema is sent in the Moonshot dialect');
    A.eq(kimi.tools[1].function.parameters, { type: 'object', properties: { q: { type: 'string' } }, required: [] }, 'Kimi: a well-formed tool gains the required array the dialect demands');
    A.eq(kimi.tools[2].function.parameters, { type: 'object', properties: {}, required: [] }, 'Kimi: a parameterless tool gets the minimal object schema');
    A.eq(kimi.tools[0].function.name, 'connector_call', 'Kimi: the tool identity is untouched');

    const openai = await compatBody('gpt-5.4', 'https://api.openai.com/v1');
    A.eq(JSON.stringify(openai.tools), snapshot, 'any other route: the tool list is byte-identical (null enum and all)');

    async function orBody(model) {
      let body = null;
      const p = makeOpenRouterProvider({ key: 'k', fetch: async (url, init) => {
        if (!init || !init.body) return new Response('{"data":[]}', { status: 200 });
        body = JSON.parse(init.body); return DONE();
      } });
      for await (const _ of p.stream({ model, messages: [{ role: 'user', content: 'hi' }], tools })) { /* drain */ }
      return body;
    }
    const orKimi = await orBody('moonshotai/kimi-k2');
    A.eq(orKimi.tools[0].function.parameters, forMoonshot(HOSTILE), 'OpenRouter moonshotai/* model: the dialect is applied');
    const orClaude = await orBody('anthropic/claude-sonnet-4.6');
    A.eq(JSON.stringify(orClaude.tools), snapshot, 'OpenRouter any other model: byte-identical');
    A.eq(JSON.stringify(tools), snapshot, 'the shared tool defs are never mutated');
  }

  A.report('provider.moonshot-schema.test');
})().catch(e => { console.log('FAIL: provider.moonshot-schema.test threw -- ' + (e && e.stack || e)); process.exit(1); });
