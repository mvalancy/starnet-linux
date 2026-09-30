'use strict';
/* sidecar/mcp/google-relay-guard.js — RESTRICTED-tier Google data never reaches a StarNet-operated server.

   Google's security assessment (CASA) applies when restricted-scope data (Gmail read/compose, whole-Drive read)
   is stored on or transmitted through the DEVELOPER's servers. StarNet is local-first: the one StarNet-operated
   path model traffic can take is the StarNet Managed provider ('starnet', the credits relay). This guard keeps
   restricted Google content off that path in both directions it could travel:

     • LIVE  — a run on StarNet Managed is not offered restricted Google connector tools (projectable()).
     • REPLAY — every request streamed to StarNet Managed (primary, fallback, auxiliary pass) has the results of
                earlier restricted Google tool calls replaced by a notice (guardProvider()). The agent's LOCAL
                transcript is untouched; only the outgoing copy is filtered.

   Classification is by the connector's SAVED ENDPOINT (google-client.js serviceOf), never its id, so a custom
   id pointing at the Gmail adapter is still restricted. Tool names come from the local adapter's own tool list
   (transport.google.js TOOLS) through the same wire-name function the registry uses — exact names, no prefix
   guessing. Sensitive-tier services (Calendar, Docs, Sheets, send-only Gmail) are not affected.

   Not covered (derived content, see docs/GOOGLE_REVIEW_BUILD.md): an assistant's own prose that restates a
   message, memory notes or files the agent wrote from Google content. */
const WITHHELD = '[Withheld: this Gmail / Google Drive result stays on this computer and is never sent to StarNet Managed. '
  + 'Switch this agent to your own model provider to work with it.]';

function makeGoogleRelayGuard({ googleClient, tools, mcpToolName, configs }) {
  if (!googleClient || !tools || typeof mcpToolName !== 'function' || typeof configs !== 'function') {
    throw new Error('google-relay-guard requires { googleClient, tools, mcpToolName, configs }');
  }
  function restrictedService(cfg) {
    const svc = googleClient.serviceOf(cfg);
    return svc && googleClient.SERVICES[svc] && googleClient.SERVICES[svc].tier === 'restricted' ? svc : null;
  }
  // connector id -> restricted service, from the live saved configs (read at call time, never cached).
  function restrictedConnectors() {
    const out = new Map();
    for (const cfg of (configs() || [])) {
      const svc = cfg && cfg.id && restrictedService(cfg);
      if (svc) out.set(String(cfg.id), svc);
    }
    return out;
  }
  function restrictedToolNames() {
    const names = new Set();
    for (const [id, svc] of restrictedConnectors()) for (const t of (tools[svc] || [])) names.add(mcpToolName(id, t.name));
    return names;
  }
  // LIVE: may this room object's connector be projected into a run on this provider?
  function projectable(connectorId, providerId) {
    return providerId !== 'starnet' || !restrictedConnectors().has(String(connectorId || ''));
  }
  // REPLAY: the outgoing copy of a conversation with restricted Google tool results withheld.
  function scrub(messages) {
    if (!Array.isArray(messages)) return { messages, withheld: 0 };
    const names = restrictedToolNames();
    if (!names.size) return { messages, withheld: 0 };
    const callName = new Map();
    let withheld = 0;
    const out = messages.map(m => {
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) if (c && c.id) callName.set(c.id, c.function && c.function.name);
      }
      if (m && m.role === 'tool' && names.has(callName.get(m.tool_call_id))) {
        withheld++;
        return Object.assign({}, m, { content: WITHHELD });
      }
      return m;
    });
    return { messages: withheld ? out : messages, withheld };
  }
  // Wrap a provider so every request it streams is scrubbed. Own props are copied (callers may spread it).
  function guardProvider(provider) {
    if (!provider || typeof provider.stream !== 'function') return provider;
    return Object.assign({}, provider, {
      stream(req) {
        const scrubbed = req && Array.isArray(req.messages) ? Object.assign({}, req, { messages: scrub(req.messages).messages }) : req;
        return provider.stream(scrubbed);
      }
    });
  }
  return { restrictedConnectors, restrictedToolNames, projectable, scrub, guardProvider };
}

module.exports = { makeGoogleRelayGuard, WITHHELD };
