/* sidecar/tools/tool.js — a tool definition (normalized).
   makeTool({ name, description, schema, scope, readOnly, capability, requiresConsent, timeoutMs, provenance, preconditions, run })
     schema         : JSON-schema-lite for the arguments (validated host-side before run)
     scope          : 'read' | 'write' | 'execute'
     readOnly       : defaults true when scope==='read'
     provenance     : host registration boundary; 'host' or 'connector'
     capability     : the capId this tool belongs to (object=capability mapping; M1.3)
     requiresConsent: prompt before running (write/execute/network; M1.4)
     timeoutMs      : per-tool execution bound (0 = none)
     preconditions  : machine-readable state requirements; strict identifiers only
     run(args, ctx) : async; returns a string or { content, summary }; THROWS on error. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.tools = root.SK.tools || {}).tool = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function identifier(value, max) {
    const s = String(value == null ? '' : value).trim();
    return s && s.length <= (max || 100) && /^[A-Za-z0-9_.:-]+$/.test(s) ? s : '';
  }

  // Preconditions can originate in an MCP structuredContent payload. Keep only inert identifiers: arbitrary
  // connector prose must remain inside the external-content fence and must never become host instructions.
  function normalizePrecondition(value) {
    if (!value || typeof value !== 'object') return null;
    const code = identifier(value.code, 80);
    if (!code) return null;
    const out = { code: code };
    const requiredTool = identifier(value.requiredTool || value.required_tool, 120);
    const requiredAction = identifier(value.requiredAction || value.required_action, 120);
    const requiredState = identifier(value.requiredState || value.required_state, 120);
    if (requiredTool) out.requiredTool = requiredTool;
    if (requiredAction) out.requiredAction = requiredAction;
    if (requiredState) out.requiredState = requiredState;
    out.retrySameCall = false;
    out.onFailure = 'replan_once';
    return out;
  }

  function normalizePreconditions(values) {
    const src = Array.isArray(values) ? values : (values ? [values] : []);
    return src.map(normalizePrecondition).filter(Boolean).slice(0, 8);
  }

  function makeTool(def) {
    def = def || {};
    return {
      name: def.name,
      description: def.description || '',
      schema: def.schema || { type: 'object', properties: {} },
      scope: def.scope || 'read',
      readOnly: def.readOnly != null ? def.readOnly : (def.scope === 'read' || def.scope == null),
      provenance: def.provenance === 'connector' ? 'connector' : 'host',
      capability: def.capability || null,
      impact: def.impact || null,
      requiresConsent: !!def.requiresConsent,
      // its OWN consent class (permissions.js dangerKey) — a cached "always" on a sibling tool of the same
      // capability must never pre-approve this one. Dropped here before 2026-09-23, silently disabling it.
      consentKey: typeof def.consentKey === 'string' && def.consentKey ? def.consentKey : null,
      // revoked once the run has read untrusted content (taint.js) — for tools that PERSIST text another run obeys
      taintLocked: def.taintLocked === true,
      timeoutMs: def.timeoutMs || 0,
      preconditions: normalizePreconditions(def.preconditions),
      run: def.run || (async () => { throw new Error('tool "' + def.name + '" has no run()'); })
    };
  }

  return { makeTool, normalizePrecondition, normalizePreconditions };
});
