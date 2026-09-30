/* sidecar/workspace-reserved.js — agent ids that must NEVER become a private agent workspace.

   Every agent's file jail is WORKSPACES/<agentId>/ (tools/builtin/fs.js, environment.js, pathtrust.js, /api/file).
   The id grammar ^[A-Za-z0-9_-]{1,40}$ keeps dots out, which protects .secrets/ — but the station ALSO keeps
   credential and code directories at undotted names directly under WORKSPACES. An agent whose id equals one of
   them would own that directory as its "private workspace": fs.read codex/tokens.json (ChatGPT OAuth tokens),
   channels/secrets.json (bot tokens), connectors/servicekeys.json (service keys), fs.write into plugins/ (code the
   sidecar require()s), and agent delete would move the credential directory into _archive.

   A summoned custom agent named "Codex" slugs to exactly `codex`, so this is reachable from team.summon, the
   Recruitment Bay, /api/roster and config import — not only from a hand-crafted request.

   The comparison is case-insensitive because Windows and default macOS filesystems are: WORKSPACES/CODEX IS
   WORKSPACES/codex there. Windows device names are included because WORKSPACES/con is not a directory at all.
   The frontend allocator (frontend/app/agentid.js RESERVED) mirrors this list; test/workspace-reserved.test.js
   pins the two together. */
'use strict';

const STATION_DIRS = [
  '_archive',               // deleted agents' archived workspaces
  'channels',               // channels/secrets.json — bot tokens (bare sidecar) + channel config
  'codex',                  // codex/tokens.json — ChatGPT/Codex OAuth tokens
  'grok', 'kimi',           // <id>/tokens.json — device-OAuth provider tokens (OAUTH_PROVIDER_IDS)
  'connectors',             // connectors/state.json (vault), servicekeys.json, schemas/
  'plugins',                // in-process plugins the sidecar require()s
  'skill-packages',         // installed skill package generations
  'transcript-history-v2'   // durable transcript history
];
const WINDOWS_DEVICES = ['con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'];
const RESERVED = new Set(STATION_DIRS.concat(WINDOWS_DEVICES));

function isReservedWorkspaceId(id) {
  return RESERVED.has(String(id == null ? '' : id).toLowerCase());
}

// Throws with a message that still matches the existing /bad agentId/ handlers (e.g. /api/file answers 403).
function assertWorkspaceId(id) {
  if (isReservedWorkspaceId(id)) throw new Error('bad agentId: "' + id + '" is a reserved station directory and cannot be an agent workspace — this agent was named before that rule existed; delete it and recruit it again (it gets a safe id like "' + String(id).toLowerCase() + '-2")');
  return id;
}

module.exports = { STATION_DIRS, WINDOWS_DEVICES, RESERVED, isReservedWorkspaceId, assertWorkspaceId };
