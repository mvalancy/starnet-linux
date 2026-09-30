/* sidecar/channels/store.js — durable per-chat memory for the messaging ingress (C4).

   The run host (index.js /api/run) is STATELESS: the caller supplies the full `messages` array each call, and
   browser history lives only in localStorage. A messaging chat has no browser holding its transcript, so the
   adapter must own its own durable per-chat memory. This module is that store:

     makeChannelStore({ fs, pathMod, root, clock, limits? }) -> {
       loadHistory(agentId)            -> [{role,content,ts}]     // [] on missing/corrupt (fail-closed)
       appendTurn(agentId, role, text) -> messages[]             // appends + trims tail, persists atomically
       loadChatMap()                   -> { version, chats }
       getChatRecord(chatId)           -> record | undefined
       saveChatRecord(chatId, patch)   -> record                 // merge-and-persist one chat's mapping/config
       loadOutbox(channel?)            -> [{id,channel,chatId,text,runId,agentId,reason,ts,tries}]
       pushOutbox(entry)               -> item                   // queue an UNDELIVERED reply (bounded, full refuses loss)
       removeOutbox(id)                -> bool                   // delivered (or given up) — drop it
       bumpOutboxTry(id)               -> item | undefined       // count one failed redelivery attempt
       loadInbox(channel?)             -> [{id,channel,message,ts}] // admitted work not yet completed/queued
       pushInbox(entry)                -> item                   // idempotent durable intake receipt
       removeInbox(id)                 -> bool                   // completed (or durably queued)
     }

   Files live under WORKSPACES/channels/ — SIBLINGS of the notebook store, OUTSIDE the agent's fs jail
   (WORKSPACES/<agentId>/), so the agent's own fs.* tools can neither read nor corrupt its conversation history
   or the chat→agent map (the same containment the notebook already has):
     • <root>/<agentId>.history.json  = { version:1, messages:[{role,content,ts}] }
     • <root>/chatmap.json            = { version:1, chats:{ "<chatId>": { agentId, model, persona, ... } } }

   Save-safe: versioned; atomic temp+rename; a missing/corrupt file loads as empty and NEVER throws. History is
   trimmed (lossy) on write to a bounded tail so the file and the replayed prompt stay within budget. Pure +
   deterministic: all I/O is the injected `fs` (sync), time is the injected `clock` — no Date.now/rng. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.store = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;            // same agentId grammar as the notebook/fs jail
  const DEFAULTS = { maxTurns: 40, maxChars: 24000 };  // bound the on-disk + replayed transcript
  // outbox bounds: a small, bounded queue of UNDELIVERED replies (durable send-retry, not a message archive).
  // Oldest drops first past maxOutbox; a single reply's stored text is capped so the file can't balloon.
  const OUTBOX_DEFAULTS = { maxOutbox: 50, maxOutboxChars: 16000 };
  const INBOX_DEFAULTS = { maxInbox: 200 };

  // A Set, not an object literal: `({user:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key. A hand-corrupted history claiming role:'constructor' or
  // role:'toString' therefore survived the "keep only well-formed turns" filter (while a plausible-looking
  // role:'tool' was correctly dropped) and went to the provider as an invalid role — a 400 that wedges the
  // channel agent, which is exactly what this filter exists to prevent.
  const ROLES = new Set(['user', 'assistant', 'system']);

  /* LEGACY HOP TURNS IN A PER-AGENT HISTORY (sec-taint2 09-25). Before hop history was keyed per chat lineage (hub.js
     hopHistoryKey, commit d37b81a57), a downstream work-line hop appended its handoff turn (the upstream stage's
     OUTPUT — possibly text that stage read from a hostile page) and its own reply under the BARE agentId, i.e. into
     the very file that agent's direct chat replays. Those turns survive on disk in existing stations. They are
     recognised by the exact head chain.js/pipeline.js handoffPrompt has always written, and are dropped from what is
     REPLAYED: the handoff user turn plus the hop's reply straight after it. Hop-keyed histories (hop_<32 hex>) are
     where handoffs legitimately live and are never filtered. Non-destructive: loadHistory only filters; the first
     appendTurn that would rewrite such a file first archives the untouched envelope beside it
     (<agentId>.history.legacy-hops.json, written once, never overwritten), and only then drops the turns. */
  const HOP_KEY_RE = /^hop_[0-9a-f]{32}$/;
  const LEGACY_HOP_TURN = /^PIPELINE HANDOFF — you are stage \d+ of a work line on this station\.\n\nThe original request was:\n/;
  function withoutLegacyHops(msgs) {
    const kept = [];
    let dropped = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m && m.role === 'user' && LEGACY_HOP_TURN.test(m.content)) {
        dropped++;
        if (msgs[i + 1] && msgs[i + 1].role === 'assistant') { dropped++; i++; }   // the hop's own reply to that handoff
        continue;
      }
      kept.push(m);
    }
    return { kept, dropped };
  }

  function trimTail(messages, maxTurns, maxChars) {
    let m = messages.slice(-maxTurns);
    let total = 0;
    for (const x of m) total += (x && typeof x.content === 'string') ? x.content.length : 0;
    while (m.length > 1 && total > maxChars) {
      total -= (m[0] && typeof m[0].content === 'string') ? m[0].content.length : 0;
      m = m.slice(1);
    }
    return m;
  }

  function makeChannelStore(deps) {
    const d = deps || {};
    const fs = d.fs;
    const pathMod = d.pathMod;
    const root = d.root;
    const clock = d.clock;
    if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function')
      throw new Error('makeChannelStore: an injected fs (readFileSync/writeFileSync/renameSync[/mkdirSync]) is required');
    if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeChannelStore: an injected pathMod is required');
    if (!root) throw new Error('makeChannelStore: a root dir is required');
    if (!clock || typeof clock.now !== 'function') throw new Error('makeChannelStore: an injected clock is required');
    const limits = Object.assign({}, DEFAULTS, d.limits || {});

    let tmpSeq = 0;   // deterministic, process-unique tmp suffix (no pid/rng needed for a single host)
    // P2: when the host injects writeDurable (writeFileDurable — fsync-before-rename), every write is power-loss
    // durable; standalone (browser/tests) it degrades to the atomic temp+rename below. onRecover (optional) is
    // called when a torn/corrupt main was recovered from its .bak last-known-good.
    const writeDurable = (typeof d.writeDurable === 'function') ? d.writeDurable : null;
    const onRecover = (typeof d.onRecover === 'function') ? d.onRecover : function () {};

    function ensureRoot() { try { if (fs.mkdirSync) fs.mkdirSync(root, { recursive: true }); } catch (_) {} }
    function historyFile(agentId) {
      if (!AID_RE.test(String(agentId))) throw new Error('bad channel agentId: ' + agentId);
      return pathMod.join(root, agentId + '.history.json');
    }
    const chatMapFile = () => pathMod.join(root, 'chatmap.json');
    const outboxFile = () => pathMod.join(root, 'outbox.json');
    const inboxFile = () => pathMod.join(root, 'inbox.json');
    const outboxLimits = Object.assign({}, OUTBOX_DEFAULTS, d.outboxLimits || {});
    const inboxLimits = Object.assign({}, INBOX_DEFAULTS, d.inboxLimits || {});
    let outboxSeq = 0;   // deterministic per-process id tail (clock.now() alone can collide within one ms)

    function readRaw(file) {   // parse-or-undefined for ONE file (missing / zero-length / corrupt -> undefined)
      try { const raw = fs.readFileSync(file, 'utf8'); if (raw == null || String(raw).length === 0) return undefined; return JSON.parse(raw); }
      catch (_) { return undefined; }
    }
    function readJson(file) {   // recovery-aware: try the main file, then the <file>.bak last-known-good
      const m = readRaw(file);
      if (m !== undefined) return m;
      const b = readRaw(file + '.bak');
      if (b !== undefined) { try { onRecover(file); } catch (_) {} return b; }   // a torn/corrupt main recovered from .bak
      return undefined;   // genuinely absent OR unrecoverable -> caller treats as empty (channels is fail-closed)
    }
    function writeRaw(file, value) {
      ensureRoot();
      if (writeDurable) { writeDurable({ fs: fs, path: pathMod }, file, JSON.stringify(value)); return; }
      const tmp = file + '.' + (++tmpSeq) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, file);   // atomic replace
    }
    function writeJsonAtomic(file, value) {
      // snapshot the current GOOD main to <file>.bak BEFORE overwriting it, so a torn replace can be recovered.
      // A corrupt current main is NOT copied (never clobber a possibly-good .bak with garbage). The read-modify-
      // write in appendTurn/saveChatRecord is fully SYNCHRONOUS (no await between readJson and writeJsonAtomic),
      // so it is inherently serialized per file by the event loop — concurrent in-process writers cannot lose an
      // update — and now it is durable + recoverable too.
      const prev = readRaw(file);
      if (prev !== undefined) { try { writeRaw(file + '.bak', prev); } catch (e) { failNote('channels.store.bak', e); } }
      writeRaw(file, value);
    }

    return {
      loadHistory(agentId) {
        const raw = readJson(historyFile(agentId));
        const msgs = raw && Array.isArray(raw.messages) ? raw.messages : [];
        // defend against a hand-corrupted file: keep only well-formed {role,content} turns
        const wellFormed = msgs.filter(m => m && ROLES.has(m.role) && typeof m.content === 'string');
        // a per-agent history never replays a legacy work-line hop exchange (see LEGACY HOP TURNS above)
        return HOP_KEY_RE.test(String(agentId)) ? wellFormed : withoutLegacyHops(wellFormed).kept;
      },

      /* clearHistory — drop this agent's messaging transcript and start fresh. A browser chat can hit /new
         because its history lives in localStorage; a messaging chat has no browser, so THIS file is the only
         copy and the only way to start over. Writes an empty envelope through the same atomic path (keeping
         the .bak the writer makes) rather than unlinking, so a reader mid-flight never sees a missing file.
         Returns the number of turns discarded, so the caller can report what actually happened. */
      clearHistory(agentId) {
        const file = historyFile(agentId);
        const raw = readJson(file);
        const had = (raw && Array.isArray(raw.messages)) ? raw.messages.length : 0;
        if (!had) return 0;                                    // nothing stored -> no write, no .bak churn
        writeJsonAtomic(file, { version: 1, messages: [] });
        return had;
      },

      appendTurn(agentId, role, text) {
        if (!ROLES.has(role)) throw new Error('bad role: ' + role);
        const file = historyFile(agentId);
        const raw = readJson(file);
        let prev = raw && Array.isArray(raw.messages) ? raw.messages.filter(m => m && ROLES.has(m.role) && typeof m.content === 'string') : [];
        if (!HOP_KEY_RE.test(String(agentId))) {
          const clean = withoutLegacyHops(prev);
          if (clean.dropped) {
            // ONE-TIME, NON-DESTRUCTIVE: keep the untouched envelope before this rewrite drops the legacy hop turns.
            // If the archive cannot be written, keep the turns on disk (loadHistory still never replays them).
            const archive = pathMod.join(root, agentId + '.history.legacy-hops.json');
            let archived = readRaw(archive) !== undefined;
            if (!archived) {
              try { writeRaw(archive, raw); archived = true; }
              catch (e) { failNote('channels.store.legacyHopArchive', e); }
            }
            if (archived) prev = clean.kept;
          }
        }
        prev.push({ role: role, content: String(text == null ? '' : text), ts: clock.now() });
        const next = trimTail(prev, limits.maxTurns, limits.maxChars);
        writeJsonAtomic(file, { version: 1, messages: next });
        return next;
      },

      loadChatMap() {
        const raw = readJson(chatMapFile());
        return { version: 1, chats: (raw && raw.chats && typeof raw.chats === 'object') ? raw.chats : {} };
      },

      getChatRecord(chatId) {
        const map = this.loadChatMap();
        return map.chats[String(chatId)];
      },

      saveChatRecord(chatId, patch) {
        const id = String(chatId);
        const map = this.loadChatMap();
        const merged = Object.assign({}, map.chats[id], patch || {}, { lastSeen: clock.now() });
        map.chats[id] = merged;
        writeJsonAtomic(chatMapFile(), { version: 1, chats: map.chats });
        return merged;
      },

      // ---- durable outbox: replies that FAILED to send, kept for redelivery when the transport is back ----
      // Same save-safety as everything here (versioned, atomic, .bak-recovered, fail-closed on corrupt). One
      // file for ALL channels — each item carries its channel; hubs flush only their own.
      loadOutbox(channel) {
        const raw = readJson(outboxFile());
        const items = raw && Array.isArray(raw.items) ? raw.items : [];
        const good = items.filter(it => it && typeof it.id === 'string' && typeof it.chatId === 'string' && typeof it.text === 'string');
        return channel ? good.filter(it => it.channel === String(channel)) : good;
      },

      pushOutbox(entry) {
        const e = entry || {};
        let text = String(e.text == null ? '' : e.text);
        if (text.length > outboxLimits.maxOutboxChars) text = text.slice(0, outboxLimits.maxOutboxChars) + '\n… (reply truncated for redelivery)';
        const items = this.loadOutbox();
        let id;
        // The queue survives process restarts, but outboxSeq does not. A restart in the same clock tick (or
        // after a clock rollback) must not reuse a durable item's id: remove/bump operate by id and would
        // otherwise affect multiple replies. Walk the tiny bounded queue until this process owns a free id.
        do { id = String(clock.now()) + '-' + (++outboxSeq); }
        while (items.some(it => it.id === id));
        const item = {
          id: id,
          channel: String(e.channel || ''), chatId: String(e.chatId || ''), text: text,
          runId: String(e.runId || ''), agentId: String(e.agentId || ''), reason: String(e.reason || ''),
          ts: clock.now(), tries: 0
        };
        // Never evict somebody else's undelivered answer to make room. The hub leaves the corresponding durable
        // inbox receipt pending when this throws, so intake backpressures and retries after the outbox drains.
        if (items.length >= outboxLimits.maxOutbox) throw new Error('channel outbox is full; refusing to discard an undelivered reply');
        items.push(item);
        writeJsonAtomic(outboxFile(), { version: 1, items: items });
        return item;
      },

      removeOutbox(id) {
        const items = this.loadOutbox();
        const next = items.filter(it => it.id !== String(id));
        if (next.length === items.length) return false;
        writeJsonAtomic(outboxFile(), { version: 1, items: next });
        return true;
      },

      bumpOutboxTry(id) {
        const items = this.loadOutbox();
        const it = items.find(x => x.id === String(id));
        if (!it) return undefined;
        it.tries = Math.min(1000000, Math.max(0, Number(it.tries) || 0) + 1);
        writeJsonAtomic(outboxFile(), { version: 1, items: items });
        return it;
      },

      // Persist redelivery PROGRESS: after a partial flush (chunks 1..k delivered, k+1 failed) the item
      // keeps only the UNDELIVERED remainder, so the next pass never re-sends text the member already read.
      replaceOutboxText(id, text) {
        const items = this.loadOutbox();
        const it = items.find(x => x.id === String(id));
        if (!it) return undefined;
        it.text = String(text == null ? '' : text);
        writeJsonAtomic(outboxFile(), { version: 1, items: items });
        return it;
      },

      // ---- durable inbox: admitted messages survive a crash between offset confirmation and reply ----
      loadInbox(channel) {
        const raw = readJson(inboxFile());
        const items = raw && Array.isArray(raw.items) ? raw.items : [];
        const good = items.filter(it => it && typeof it.id === 'string' && typeof it.channel === 'string'
          && it.message && typeof it.message === 'object' && typeof it.message.chatId === 'string');
        return channel ? good.filter(it => it.channel === String(channel)) : good;
      },

      pushInbox(entry) {
        const e = entry || {};
        const id = String(e.id || '');
        if (!id || !e.message || typeof e.message !== 'object') throw new Error('bad channel inbox entry');
        const items = this.loadInbox();
        const existing = items.find(it => it.id === id);
        if (existing) return existing;   // Telegram redelivery/recovery is idempotent at the durable intake edge
        if (items.length >= inboxLimits.maxInbox) throw new Error('channel inbox is full; refusing to acknowledge more work');
        const item = { id: id, channel: String(e.channel || ''), message: JSON.parse(JSON.stringify(e.message)), ts: clock.now() };
        items.push(item);
        writeJsonAtomic(inboxFile(), { version: 1, items: items });
        return item;
      },

      removeInbox(id) {
        const items = this.loadInbox();
        const next = items.filter(it => it.id !== String(id));
        if (next.length === items.length) return false;
        writeJsonAtomic(inboxFile(), { version: 1, items: next });
        return true;
      },

      _internals: { trimTail, historyFile, chatMapFile, outboxFile, inboxFile, AID_RE, limits, outboxLimits, inboxLimits }
    };
  }

  return { makeChannelStore, trimTail, _internals: { AID_RE, DEFAULTS, OUTBOX_DEFAULTS, INBOX_DEFAULTS } };
});
