/* Run-origin authority: which runs may inherit the Commander's standing Full Power.

   Full Access (per-agent approvalMode:'full') and the station-wide master bypass are the OWNER's authority.
   A run that a chat-channel sender started carries two host-minted fields set by sidecar/channels/hub.js:
     channelSender: true           — a person on a messaging channel originated this run
     channelSenderOwner: boolean   — that person is the bound owner, in a direct chat
   Only the second case inherits Full Power. A group member, an allowed non-owner, or anyone else who can reach
   the bot runs at the ordinary unattended floor even when the agent is set to Full Access.

   The restriction also rides into delegated workers through the host-context connectorAuthority
   (`withholdHostPower`), so a non-owner cannot reach Full Power by asking the lead to delegate to a Full Access
   specialist. Tool arguments can never set it: connectorAuthority is built by the host, never by a model.

   Every other origin (the app, routines/loops/cron, line triggers, the local dev/sample hubs) omits
   channelSender and is unchanged — DECISIONS.md "FULL POWER MEANS THE WHOLE LOCAL COMPUTER", and the tested
   "Full Access follows the agent to its own routine" (test/e2e.mcp-connector.test.js). */
'use strict';

function hostPowerWithheldFor(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.channelSender === true && o.channelSenderOwner !== true) return true;
  const inherited = o.connectorAuthority;
  return !!(inherited && typeof inherited === 'object' && inherited.withholdHostPower === true);
}

/* UNTRUSTED ENTRY (sec-taint2 09-25): was this run STARTED by third-party content rather than by the Commander?
   Host-minted untrustedEntry:true is set by the channel hub for a line-trigger fire (webhook body / watched file,
   entryTaint), a forwarded message and a chat attachment — on the entry run AND on every hop of its line — and it
   rides into delegated workers through connectorAuthority.untrustedEntry. Such a run's taint lock is NOT lifted by
   Full Access (taint.js postTaintBoundary): the owner decision is that Full Access means zero prompts for work the
   Commander asked for, never for work a payload's author asked for. Only ever narrows authority, so a caller
   that sets it spuriously can only lose power. */
function entryUntrusted(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.untrustedEntry === true) return true;
  const inherited = o.connectorAuthority;
  return !!(inherited && typeof inherited === 'object' && inherited.untrustedEntry === true);
}

module.exports = { hostPowerWithheldFor, entryUntrusted };
