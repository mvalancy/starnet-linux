/* sidecar/channels/owner-pairing.js -- one-time local enrollment for an owner-only bot.

   A Telegram bot token is discoverable enough that "the first DM owns the bot" is not an
   identity check. This small pure module lets the local desktop issue a short-lived pairing
   code while persisting only a salted digest. The code is returned exactly once by the local
   API and is never included in channel status, logs, or the bot transcript. */
'use strict';

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_BYTES = 10;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function normalizeCode(value) {
  return String(value == null ? '' : value).trim().toUpperCase().replace(/[\s-]+/g, '');
}

function printableCode(compact) {
  return String(compact || '').replace(/(.{5})/g, '$1-').replace(/-$/, '');
}

function codeFromBytes(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  let out = '';
  // Rejection sampling keeps every symbol equally likely. A caller supplies more than enough
  // entropy, but cycling is still deterministic for a short fake buffer in unit tests.
  for (let i = 0, seen = 0; out.length < CODE_BYTES && seen < raw.length * 4; i++, seen++) {
    const n = raw.length ? raw[i % raw.length] : 0;
    if (n >= 248) continue; // 248 is divisible by the 32-symbol alphabet
    out += ALPHABET[n % ALPHABET.length];
  }
  if (out.length !== CODE_BYTES) throw new Error('pairing randomness did not yield a complete code');
  return out;
}

function digest(salt, compactCode) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(compactCode)).digest('hex');
}

function requireNow(value) {
  if (Number.isFinite(value)) return value;
  throw new Error('owner pairing needs an injected clock value');
}

function issue(opts) {
  opts = opts || {};
  const now = requireNow(opts.now);
  const ttlMs = Number.isFinite(opts.ttlMs) ? Math.max(1000, opts.ttlMs) : DEFAULT_TTL_MS;
  const randomBytes = typeof opts.randomBytes === 'function' ? opts.randomBytes : crypto.randomBytes;
  const salt = randomBytes(16).toString('base64url');
  const compact = codeFromBytes(randomBytes(24));
  return {
    code: printableCode(compact),
    state: { salt: salt, digest: digest(salt, compact), expiresAt: now + ttlMs }
  };
}

function verify(state, suppliedCode, now) {
  const s = state && typeof state === 'object' ? state : null;
  const at = requireNow(now);
  const compact = normalizeCode(suppliedCode);
  if (!s || !s.salt || !/^[a-f0-9]{64}$/i.test(String(s.digest || '')) || !Number.isFinite(Number(s.expiresAt))) return false;
  if (Number(s.expiresAt) <= at || compact.length !== CODE_BYTES) return false;
  const expected = Buffer.from(String(s.digest), 'hex');
  const actual = Buffer.from(digest(s.salt, compact), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function active(state, now) {
  const at = requireNow(now);
  return !!(state && typeof state === 'object' && state.salt && state.digest && Number(state.expiresAt) > at);
}

// The admission decision the channel adapters consult for an UNCLAIMED bot: "/pair CODE" or "pair CODE" (Slack and
// some Discord clients intercept a leading slash, so it is optional — the code is the proof, not the command word).
function admission(state, text, now, label) {
  const match = /^\/?pair\s+([^\s]+)\s*$/i.exec(String(text == null ? '' : text));
  if (!match || !verify(state, match[1], now)) return false;
  return { allow: true, consume: true, reply: 'Owner paired. This ' + (label || 'Telegram') + ' DM is now the trusted control channel.' };
}

module.exports = { issue, verify, active, admission, normalizeCode, printableCode, codeFromBytes, ALPHABET, CODE_BYTES, DEFAULT_TTL_MS };
