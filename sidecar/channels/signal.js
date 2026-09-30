/* sidecar/channels/signal.js — the Signal platform binding for the generic channel adapter.

   The analogue of telegram.js/discord.js: it supplies ONLY the wire translation (normalize) + the limit and
   hands the rest to the transport-agnostic adapter (owner/DM admission, resend, status). Raw updates are
   signal-cli REST envelopes (see signal.transport.js).

   DM-only first cut: group messages (envelope…dataMessage.groupInfo) deliver nothing — same shape the Telegram
   MVP shipped with. The owner trust-on-first-use gate applies to every DM, exactly like the other channels.

   normalize(envelope) -> { message } | null
     - null                : not a data message (receipt/typing/sync/own echo/group) — deliver nothing
     - { message: {...} }  : a real other-user DM, in the adapter's neutral InboundMessage shape */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./adapter.js'), require('./signal.transport.js'));
  } else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.signal = factory(root.SK.channels.adapter, root.SK.channels.signalTransport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapterMod, transportMod) {
  'use strict';
  const { makeChannelAdapter } = adapterMod;
  const { makeSignalTransport } = transportMod;

  const MAX_MESSAGE_LENGTH = 4096;   // Signal accepts long texts; chat-sized chunks read better

  function normalize(raw) {
    const env = raw && raw.envelope;
    if (!env) return null;
    const dm = env.dataMessage;
    if (!dm || typeof dm.message !== 'string' || !dm.message) return null;   // receipts/typing/sync -> nothing
    if (dm.groupInfo) return null;                                            // DM-only first cut
    const source = env.sourceNumber || env.source || env.sourceUuid || '';
    if (!source) return null;
    return {
      message: {
        chatId: String(source),                       // replies go straight back to the sender's number
        chatType: 'dm',
        userId: String(source),
        userName: String(env.sourceName || source),
        text: dm.message,
        messageId: String(dm.timestamp != null ? dm.timestamp : (env.timestamp != null ? env.timestamp : ''))
      }
    };
  }

  function makeSignalAdapter(opts) {
    const o = opts || {};
    const transport = o.transport || makeSignalTransport({ fetch: o.fetch, endpoint: o.endpoint, account: o.account });
    return makeChannelAdapter({
      transport,
      normalize,
      name: 'signal',
      maxMessageLength: MAX_MESSAGE_LENGTH,
      allowedChats: o.allowedChats,
      ownerUserId: o.ownerUserId,
      onOwnerClaim: o.onOwnerClaim,
      ownerAdmission: o.ownerAdmission,   // one-time pairing code (index.js channelOwnerAdmission)
      onInbound: o.onInbound,
      onCallback: o.onCallback,
      onStatus: o.onStatus,
      clock: o.clock,
      sleep: o.sleep,
      pollTimeoutSec: o.pollTimeoutSec != null ? o.pollTimeoutSec : 30,   // signal-cli receive ?timeout= window
      startOffset: o.startOffset
      // dropPendingOnConnect stays OFF: signal-cli's receive drains a bounded local queue, and there is no
      // offset:-1 style confirm-and-discard on this API — replay of a short offline queue is the honest behavior.
    });
  }

  return { makeSignalAdapter, normalize, MAX_MESSAGE_LENGTH };
});
