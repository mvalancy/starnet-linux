/* sidecar/spotify/store.js — durable Spotify token store + auto-refreshing access-token provider.

   Persists { clientId, accessToken, refreshToken, expiresAt, scope } to <dir>/spotify.json (atomic write:
   tmp + rename), so a connected Spotify survives a sidecar restart. getAccessToken() transparently refreshes
   an expired token via the PKCE refresh grant (client_id only — no secret) and re-persists. A dead refresh
   token (invalid_grant) clears the session and asks the user to reconnect.

   All ambient edges are injected so the store is unit-testable offline:
     makeSpotifyStore({ fsp, pathMod, dir, fetchImpl, now, redact? })
   See test/spotify.store.test.js. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./pkce.js'));
  else { root.SK = root.SK || {}; (root.SK.spotify = root.SK.spotify || {}).store = factory(root.SK.spotify.pkce); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pkce) {
  'use strict';

  const EMPTY = { clientId: '', accessToken: '', refreshToken: '', expiresAt: 0, scope: '' };

  function makeSpotifyStore(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, DIR = deps.dir;
    if (!fsp || !P || !DIR) throw new Error('spotify store requires { fsp, pathMod, dir }');
    const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const now = deps.now || (() => { throw new Error('spotify store requires an injected now()'); });
    const file = P.join(DIR, 'spotify.json');
    let state = null;          // lazily loaded cache
    let refreshing = null;     // single in-flight refresh promise (coalesce concurrent callers)

    async function load() {
      if (state) return state;
      try {
        const raw = await fsp.readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        state = Object.assign({}, EMPTY, parsed);
      } catch (e) { state = Object.assign({}, EMPTY); }
      return state;
    }

    async function persist() {
      await fsp.mkdir(DIR, { recursive: true });
      const tmp = file + '.tmp';
      let lastError;
      // A refresh response may rotate and immediately invalidate the old refresh token. One transient EBUSY /
      // antivirus race on the atomic replace must not strand that only-live token in memory while restart keeps
      // the dead predecessor. Match the other credential stores' bounded durability posture: retry once, then
      // reject honestly so clear()/refresh() callers never claim a write that still did not land.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // 0o600: this file holds the Spotify refresh token — never world-readable on Linux/macOS.
          await fsp.writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
          await fsp.rename(tmp, file);
          return;
        } catch (e) { lastError = e; }
      }
      throw lastError || new Error('Spotify state could not be persisted');
    }

    async function setClientId(id) {
      await load();
      state.clientId = String(id || '').trim();
      await persist();
      return state.clientId;
    }

    async function setTokens(t) {
      await load();
      t = t || {};
      state.accessToken = t.accessToken || '';
      state.refreshToken = t.refreshToken || state.refreshToken || '';   // keep prior refresh if omitted
      state.expiresAt = t.expiresAt || 0;
      if (t.scope) state.scope = t.scope;
      await persist();
      return status();
    }

    async function clear() {
      await load();
      const prior = state;
      const clientId = prior.clientId;   // keep the app's clientId for an easy reconnect
      state = Object.assign({}, EMPTY, { clientId });
      try { await persist(); }
      catch (e) {
        // A failed durable clear did not disconnect anything. Restore the live view so the status route and
        // tools keep reporting the credential that will still exist after restart, then let the caller fail.
        state = prior;
        throw e;
      }
      return status();
    }

    function status() {
      const s = state || EMPTY;
      return {
        connected: !!s.refreshToken,
        hasClientId: !!s.clientId,
        scope: s.scope || '',
        expiresAt: s.expiresAt || 0
      };
    }
    async function statusAsync() { await load(); return status(); }
    async function getClientId() { await load(); return state.clientId; }

    // Refresh the access token using the stored refresh token. Coalesces concurrent calls.
    async function refresh() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        await load();
        if (!state.refreshToken) throw new Error('Spotify is not connected — connect it in TOOLSETS first.');
        if (!doFetch) throw new Error('spotify store requires fetch');
        const fetchedAt = now();
        const res = await doFetch(pkce.TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: pkce.refreshBody({ refreshToken: state.refreshToken, clientId: state.clientId })
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json || !json.access_token) {
          // The OAuth error code is a STRING per RFC 6749 §5.2. Read it defensively (never assume `json` parsed).
          const code = json && typeof json.error === 'string' ? json.error : '';
          // LAW (never destroy the last copy of a credential without proof it is truly dead): clear() PERMANENTLY
          // wipes the refresh token, so it fires ONLY on an explicit, well-formed `invalid_grant` — the one answer
          // that means Spotify itself revoked the token. A transient 5xx, a 400 with a DIFFERENT error
          // (invalid_request / temporarily_unavailable / rate-limit), or an unparseable body proves NOTHING about
          // the token's validity, so we throw a RETRYABLE error and LEAVE the live refresh token on disk. A bare
          // 400 status is NOT sufficient (that was the bug: a malformed 400 wiped a working session).
          if (code === 'invalid_grant') { await clear(); throw new Error('Spotify session expired — please reconnect in TOOLSETS.'); }
          throw new Error('Spotify token refresh failed (' + res.status + (code ? ': ' + code : '') + ') — retry later');
        }
        await setTokens(pkce.tokensFromResponse(json, fetchedAt, state.refreshToken));
        return state.accessToken;
      })().finally(() => { refreshing = null; });
      return refreshing;
    }

    // The one method the tools call: always returns a currently-valid access token (refreshing if needed).
    async function getAccessToken() {
      await load();
      if (!state.refreshToken && !state.accessToken) throw new Error('Spotify is not connected — connect it in TOOLSETS first.');
      if (state.accessToken && !pkce.needsRefresh(state.expiresAt, now())) return state.accessToken;
      return refresh();
    }

    return {
      load, status: statusAsync, getClientId, setClientId, setTokens, clear, refresh, getAccessToken,
      _internals: { file, raw: () => state }
    };
  }

  return { makeSpotifyStore };
});
