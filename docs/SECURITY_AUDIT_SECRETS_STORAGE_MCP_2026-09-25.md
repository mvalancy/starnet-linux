# Security audit: secrets, storage and MCP (2026-09-25)

The 09-23 trust-boundary audit stopped before its secrets, storage and MCP pass, so that area had never been audited. This report covers it.

- **Base:** trunk `87a617d70`.
- **Branch:** `agent/sec-secrets` (worktree `gen-trees/sec-secrets`), not merged.
- **Method:** three parallel read-only mapping passes (secrets and redaction, storage and import, MCP), then my own review of every item I acted on.
- **Proof standard:** each fixed item has a focused test. Where a probe was cheap, I also ran it against trunk code to show the bug was real. Probes ran from a scratch directory on scratch workspaces. No real station data, keychain or `HERMES_HOME` was touched.

Out of scope, because other lanes own these areas: code.run, channel owner gates, token-in-URL and CSP, and taint propagation. Anything I saw there is listed under "For other lanes".

## Summary

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | Agent ids could name station credential/code directories (`codex/`, `channels/`, `connectors/`, `plugins/` …), so an agent or `/api/file` could read OAuth tokens and bot tokens, and write plugin code | Fixed |
| 2 | Medium | Shapeless secrets (service keys, custom connector tokens, prefix-less provider keys) reached the run stream, transcripts, the bus and diagnostics verbatim. JSON-quoted `"refresh_token": "…"` also got past redaction | Fixed |
| 3 | Medium | Pre-update backups captured quarantined `channels/secrets.json.corrupt-*` and `connectors/servicekeys.json.corrupt-*` raw, and the snapshot files were world-readable (0444) | Fixed |
| 4 | Medium | Credential stores were written 0644 on Linux/macOS (no file mode set) | Fixed |
| 5 | Medium | ChatGPT logout was undone by a restart (a legacy token was migrated back in) | Fixed |
| 6 | Medium | Global prototype pollution via `POST /api/journey` `agentId:"__proto__"` | Fixed |
| 7 | Medium | Config import unioned `path:<root>` grants verbatim, so a file could bless `C:\` | Fixed |
| 8 | Medium | Connector-OAuth legs vulnerable to DNS rebinding (validated once, resolved again at connect) | Fixed |
| 9 | Medium | Zip bomb in `.docx`/`.xlsx` extraction (`inflateRawSync` with no output cap) | Fixed |
| 10 | Low-Med | Uncaught-fault text went unredacted to the unauthenticated `/api/health`, the crash ledger and the log | Fixed |
| 13 | Low-Med | Helper processes (git in user repos, shell hooks, PowerShell helpers, Chrome, PTY fallback, loop checks) inherited the sidecar's whole env: API/IPC tokens, desktop-injected keys, exported service keys | Fixed on `agent/sec-env` |
| 17 | Low | Plugin approval hashed only `main`; helper files could change without re-approval, and links were followed | Fixed on `agent/sec-env` |
| 18 | Low | `save-conflict-<client>.json` files grew without limit | Fixed on `agent/sec-env` (notebook-restore count cap still open) |
| 19 | Low | `/api/harness/scan` accepted UNC and device-namespace roots | Fixed on `agent/sec-env` |
| 21 | Low | Connector-OAuth discovery ignored the advertised PKCE methods and `issuer`; the catalog `authorization_endpoint` was not URL-checked | Fixed on `agent/sec-env` |
| 11, 12, 14–16, 20, 22 | Low / Med | See "Open" below | Open |

## Fixed

### 1. HIGH: station-owned directories could become an agent's workspace

Every agent's file jail is `WORKSPACES/<agentId>/` (`tools/builtin/fs.js` `workspaceRoot`, `environment.js` `workspaceRoot`, `pathtrust.js`, and `/api/file` through `fsJail.resolveInside`). The only check was `^[A-Za-z0-9_-]{1,40}$`. That keeps `.secrets/` out, but these directories under the same root all pass it:

- `codex/`, `grok/`, `kimi/`: the `tokens.json` OAuth files
- `channels/`: `secrets.json`, the bot tokens on a bare sidecar
- `connectors/`: `servicekeys.json`, and the vault when no OS key exists
- `plugins/`: code the sidecar `require()`s
- `skill-packages/`, `_archive/`, `transcript-history-v2/`

These ids are reachable in practice. A custom agent named "Codex" slugs to exactly `codex` (`frontend/app/agentid.js` `alloc`, used by `team.summon` and the Recruitment Bay). `/api/roster` and config import accept any id. `/api/agent/delete {agentId:"connectors"}` would move the connector vault into `_archive`.

**Probes on trunk:**

- `makeFsTools(...).readTool.run({path:'tokens.json'}, {agentId:'codex'})` returned `{"refresh_token":"CANARY-TRUNK"}`.
- A real trunk sidecar answered `GET /api/file?agent=codex&path=tokens.json` with **200 and the refresh token**. The branch answers **403**.

**Fix:**

- `sidecar/workspace-reserved.js` is the reserved list. Matching is case-insensitive and includes Windows device names.
- `fs.js` and `environment.js` (`safeAgentId`) refuse these ids as jails.
- `pathtrust.js` never treats them as the caller's own workspace, even under Full Access.
- Agent delete refuses them.
- `frontend/app/agentid.js` allocates around them (`Codex` becomes `codex-2`) and mirrors the list.

**Test:** `test/workspace-reserved.test.js` (72). It works on a real temp directory with a canary, covers every jail surface, and checks that the frontend and sidecar lists stay equal.

### 2. MEDIUM: redaction missed shapeless secrets and JSON-quoted fields

`context.js redact()` only knew vendor shapes. A service key (whose `servicekeys.js` contract says "the value itself never rides the prompt, the bus…"), a custom connector token or header, or a Mistral-style key passed through untouched whenever something printed it. Two examples: `echo $ACME_API_KEY` in `shell.exec`, or a server echoing the key back in an error body. From there it reached tool results, the NDJSON run stream, `chanEmit`, transcripts and diagnostics.

The assignment rule also failed on JSON. In `"refresh_token": "…"` there is a quote between the key and the colon, so `cat codex/tokens.json` reached the model verbatim.

**Probe on trunk:** a real trunk sidecar with a mock model that echoed a stored service key and the provider key streamed **both keys** in `/api/run`. `test/secret-redaction.e2e.test.js` fails 3/10 on trunk and passes on the branch.

**Fix:**

- **Known-value layer.** `context.setKnownSecretSource()`: every `redact()` call scrubs the exact values the sidecar currently holds (at least 8 characters, longest first) before running the shape patterns.
- **Wiring.** `index.js` registers the source over:
  - provider keys and key pools
  - channel runtime tokens and `secrets.json`
  - codex, grok and kimi tokens
  - connector OAuth tokens and client secrets
  - connector tokens, headers and env
  - service keys
  - the credits token
  - the relay webhook secret

  The collector is `sidecar/secret-values.js`. The per-launch API and IPC tokens are deliberately left out, because a few local surfaces still carry the API token in a URL the frontend must open (that belongs to the token-in-URL lane).
- **Assignment rule.** It now matches JSON and quoted forms, and adds `id_token`, `private_key`, `secret_key`, `bot_token` and `webhook_secret`.
- **New shapes.** Discord bot tokens, Slack `xapp-`/`xoxe-`, Matrix `syt_`, Google refresh `1//0`, Groq `gsk_`, Perplexity, Notion `ntn_`, Linear, SendGrid, and StarNet's `whk_`.
- **Object copies.** Redacted copies now use own keys only and never re-create `__proto__`.

**Tests:** `test/redact.known-values.test.js` (56) and `test/secret-redaction.e2e.test.js` (11, live sidecar). The e2e covers the run stream, the transcript surface, diagnostics and the key list.

### 3. MEDIUM: backups captured quarantined credential stores, and snapshots were world-readable

`quarantineCorrupt` (index.js) renames a torn store to `<file>.corrupt-<pid>-<seq>`. The backup skip rule in `station-recovery.js classifyPolicy` only matched `/\.corrupt-\d+$/`, so a quarantined `channels/secrets.json` or `connectors/servicekeys.json` was classified `include` and copied **raw** into every `update-snapshots/*.starnet-backup.json`. `update-preparation.js` then chmod-ed those files **0444**, which is world-readable on POSIX.

The existing test could not have noticed, because it searched the base64 bundle envelope rather than the decoded file bytes.

**Fix:**

- The skip rule now matches the real quarantine name (`[\d-]+`).
- Any other derivative of a credential store (`<store>.json.<anything>`) is skipped.
- The snapshot and its receipt are chmod 0400.

**Test:** `test/station-recovery.test.js` (79) now checks decoded payloads. The same test run against trunk code fails 6 assertions.

### 4. MEDIUM: credential files were created 0644

`durable-write.js` opened its temp file with no mode, so the file got `0666 & ~umask` (typically 0644), and the rename carried that mode onto the store. This covers `codex/grok/kimi tokens.json`, `channels/secrets.json`, `connectors/servicekeys.json`, and the connector vault on a keyless sidecar. `spotify/store.js` had the same problem with its own writer.

**Fix:** durable writes default to 0600, which also tightens a legacy 0644 store on its next write. An explicit `mode` option remains. The Spotify store now writes 0600.

**Test:** `test/durable-write.mode.test.js` (6). It uses a spy on every platform and checks the real `stat` mode on POSIX. Windows only honours the read-only bit, so the spy is the proof there.

### 5. MEDIUM: ChatGPT logout was resurrected by a restart

`codex-token-store.loadCodexTokensWithMigration` copies `codex/tokens.json` in from a known legacy workspace root whenever the current file is absent, and never deletes the legacy copy. `clearCodexTokens` sanitized the current file and then **unlinked** it, so the next boot migrated the legacy refresh token back in.

**Fix:** logout verifies a credential-free `{ signedOut: true }` tombstone into both copies and keeps it. Migration never runs over a tombstone.

**Tests:**

- `test/provider.codex-auth.test.js` (75): the migration-over-tombstone case.
- `test/codex-status.e2e.test.js` (14, live): checks both copies are credential-free tombstones, and that the station stays signed out across a real restart.

### 6. MEDIUM: prototype pollution through the journey store

`journey-store.js setSuppressed`: `rec.suppressed[aid] = rec.suppressed[aid] || {}; rec.suppressed[aid][dom] = stamp(now)`. `__proto__` passes `AGENT_RE`, so `POST /api/journey {op:'adaptation.suppress', agentId:'__proto__', domain:'building'}` set `Object.prototype.building` for the whole process.

**Probe on trunk:** `({}).building === 123`.

**Fix:** `__proto__`, `constructor` and `prototype` are refused as agent ids, both on writes and when normalizing a stored record.

**Test:** `test/journey-store.test.js` (81).

### 7. MEDIUM: config import granted project-folder authority

`configexport.parseImport` passed `permissions.allow` through unfiltered, and `/api/config/import` unioned it into the live grants. A file carrying `path:C:\` therefore blessed the whole drive for agent reads through pathtrust, and for checkpoint restores. `station-recovery.js` already strips `path:` grants from backups for exactly this reason.

**Fix:** import drops `path:<root>` grants and names them in `notes`.

**Tests:** `test/configexport.test.js` (79), and `test/config-permissions-import.e2e.test.js` (16, live `/api/config/import`).

### 8. MEDIUM: DNS rebinding on the connector-OAuth legs

`connectorOauthFetch` ran `assertSafeUrl` and `assertResolvedSafe` (a single resolution), then a plain `fetch` that resolved the name **again** at connect time. The URLs come from an untrusted MCP server's metadata: PRM, AS metadata, the registration endpoint and the token endpoint. A rebinding authorization server could therefore point DCR, token exchange and refresh POSTs at 127.0.0.1, 10.x or 169.254.169.254.

**Fix:** `sidecar/mcp/oauth-fetch.js` builds a per-leg undici dispatcher whose `connect.lookup` returns only the validated address (the same pattern as web.js `fetchPinned`). It keeps manual redirects and closes gracefully. `globalThis.fetch` is still looked up per call, so the network-stubbing e2e preloads keep working.

**Tests:**

- `test/mcp.oauth-fetch.test.js` (13), including a real-socket proof that the pin decides the destination.
- The existing OAuth e2e suites still pass: refresh-race, connector-security, google-signin, oauth-status and github-device.

### 9. MEDIUM: zip bomb in document extraction

`index.js:61` wires `docextract` with `inflateRawSync` and no `maxOutputLength`. A small hostile `.docx`/`.xlsx` that an agent downloaded and `fs.read` it would inflate synchronously, freezing the whole sidecar or exhausting memory.

**Fix:** each entry is capped at 32 MiB and the whole document at 64 MiB. Past that, `extract()` throws and `fs.read` falls back to its plain bounded read.

**Test:** `test/docextract.test.js` (31) includes a real 33 MB bomb that is under 200 KB on disk.

### 10. LOW-MEDIUM: fault text leaked through `/api/health`, the crash ledger and the log

`process-fault.js` stored `summarize(err)`, which is clipped but not redacted. That string is served by the **unauthenticated** `/api/health` (`healthLine`), recorded in `.crash-ledger.json`, and logged.

**Fix:** the host `redact()` runs before truncation. A failing redactor withholds the text rather than leaking it.

**Test:** `test/process-fault.test.js` (78).

## Fixed afterwards on `agent/sec-env` (2026-09-25)

Base: trunk `95b4f4fa7`. Worktree `gen-trees/sec-env`, not merged. Each item was re-verified against that trunk before fixing.

### 13. Helper processes no longer inherit the station's secrets

**Re-verified on trunk:** `test/child-env.e2e.test.js` pointed at the trunk sidecar fails 3 of 9. A scratch repo's `core.fsmonitor` (code the user's repo runs whenever the project scan calls `git status`) received `STARNET_WORKSPACES`, the planted station secret and the exported service key.

**The rule** (`sidecar/child-env.js`, the one builder): strip what the station put there, keep what the user put there.

1. Every `STARNET_*` / `SKYNET_*` name. The desktop shell injects every secret it hands the sidecar under these names (API/IPC tokens, provider keys and pools, channel tokens, credits token, connector vault key), and the sidecar reads its own secrets only through them.
2. Every name the sidecar itself exported into `process.env` (the KEYS-tab service keys, tracked by `servicekeys.applyEnv`).
3. Any variable whose value is a secret the station currently holds (the same live collector as `redact()`'s known-value layer). `PATH`, `HOME` and the other runtime basics are never stripped by this rule.

A variable the user exported in their own shell (`NPM_TOKEN`, `GITHUB_TOKEN`, a bare `OPENAI_API_KEY`) stays visible to host helpers, unless its value is one the station holds. Agent-driven commands are stricter: `environment.sanitizeChildEnv` (shell.exec, background jobs, terminals) now runs this builder first and then strips every secret-shaped name as before. The service keys come back only through `mergeServiceEnv`, the one surface they were pasted for. MCP stdio, LSP, code.run and the computer-use runtime keep their own allowlist builders, which are stricter still.

**Wiring:** `guardChildProcess()` fills a missing `env` on every `spawn`/`execFile`/`exec`/`execSync`/`fork` call. An explicit `env` passes through untouched. `index.js` wraps its `child_process` once, which covers git (checkpoints, patch apply, project scan, build describe), shell hooks, loop checks, the folder picker, native STT, the process table and taskkill. These modules wrap their own: `inputguard`, `procledger`, `desktop`, `win32desktop` (whose PowerShell env is now built per call), `browser` (Chrome), and `mcp/transport.stdio` (its taskkill). The PTY fallback in `terminal-sessions` uses the builder too.

**Tests:**

- `test/child-env.test.js` (80): real children through `execFile`, `spawn` and `execSync` cannot see the planted secrets but still see `PATH`, `HOME` and the user's vars. It also pins that every sidecar `child_process` require is guarded or builds its own allowlist.
- `test/child-env.e2e.test.js` (9, live sidecar, `http.list`).
- Passing unchanged: environment, shell ×6, shell-bg, terminal-sessions, terminal-tools, procledger ×3, inputguard, desktop, win32desktop, mcp.stdio, servicekeys.env and `servicekeys.shell.e2e` (service keys still reach `shell.exec`).

### 17. Plugin approval covers every file in the folder

**Re-verified on trunk:** with the new cases run against trunk `plugins.js`, 10 assertions fail. An edited or added helper kept its approval, a lazily required helper edited after load ran, and a folder containing a link was offered for approval.

**Fix:**

- The digest walks the whole plugin folder with `lstat`, in sorted order and bounded (512 files, 16 MiB, depth 12).
- A link or junction anywhere in the folder, or a folder that is itself a link, is refused.
- The guard's findings now cover helper files, not only `main`.
- Exec-time re-verification: every handler call re-checks the folder digest (re-hashed at most every 2 s). A drift disables the whole plugin until the Commander re-approves it.

**Upgrade note:** approvals recorded under the old main-only digest ask once more after this lands.

**Test:** `test/plugins.test.js` (51 → 64).

### 18. Save-conflict snapshots are bounded

**Fix:** `savestore` keeps the newest 20 `<agent>.save-conflict-*.json` per agent (by mtime). The snapshot just written always survives, and other agents' files are untouched. A failed prune is noted and never fails the save response.

**Still open:** the notebook-restore count cap was not touched.

**Test:** `test/save-concurrency.test.js` (bounded-conflict case). Save, cloudsave-concurrency, upgrade-085-090, update-state-parity and the fail-open ratchet all pass.

### 19. The harness scan refuses network and device paths

**Fix:**

- `harness-import.nonLocalPathReason()` refuses UNC (`\\host\share`, `//host`), device-namespace (`\\?\`, `\\.\`, `\??\`) and NUL roots on the raw string, before any filesystem call.
- `/api/harness/scan` returns a named 400.
- `isHarnessDir` (also used by detect's per-agent probe from `openclaw.json`) never stats such a path.
- A local link whose realpath lands on a share is skipped.

**Tests:** `test/harness-import.test.js` (75), and `test/harness-scan-local.e2e.test.js` (13, live sidecar, `http.list`). The e2e shows each refusal arrives before any network lookup, and that a local workspace still scans.

### 21. Connector-OAuth metadata checks

**Fix:** `mcp/oauth.js discover()` now refuses:

- an `issuer` that differs from the authorization server the resource named (mix-up; a trailing slash is tolerated);
- a server that advertises `code_challenge_methods_supported` without `S256`;
- authorization, token or registration endpoints that are not https on a public host, or that carry embedded credentials;
- an authorization endpoint with a fragment.

This applies to catalog rows and custom servers alike. `buildAuthorizeUrl` applies the same check to every URL it hands the browser, including catalog `staticOauth` rows.

**Tolerated on purpose:** a missing `issuer` and a missing method list, because several hosted MCP servers omit them and refusing would break their sign-in.

**Tests:** `test/mcp.oauth.test.js` (69 → 85). The OAuth e2e suites still pass: connector-security, refresh-race, google-signin, oauth-status, github-device, and mcp.oauth-fetch.

## Open (not fixed here)

| # | Severity | Finding | Where | Suggested fix |
|---|---|---|---|---|
| 11 | Medium | On desktop, **Slack and Matrix tokens stay plaintext** in `channels/secrets.json`. `is_known_channel` / `SIDECAR_CHANNEL_TOKEN_ENVS` only cover telegram and discord, so the frontend falls back to the POST body | `src-tauri/src/credentials.rs:69,159`; `frontend/.../messaging.js` fallback | Add slack and matrix to the keychain envs, then push and strip (write and verify the keychain entry before removing the plaintext copy) |
| 12 | Medium | Server-supplied **MCP tool descriptions and schemas** reach the model unfenced and do not latch taint (tool poisoning). Tool *results* are fenced and taint-latched | `mcp/translate.js:119-122` | Fence and length-cap descriptions; treat a changed description as a re-consent event. Coordinate with the taint lane |
| 13 | Low-Med | Every process inherits the sidecar's full `process.env` (provider keys, channel tokens, `SKYNET_API_TOKEN`, `SKYNET_IPC_TOKEN`, service keys) when it is spawned with no `env`: `execFile('git')` (index.js ~3287/8357/14284, including the project scan in user repos, where hooks and fsmonitor run), `shellhooks.js:179`, `inputguard.js`, `procledger.js`, `desktop.js`, `native-stt.js`, `folderpick.js` | spawn sites | **Fixed on `agent/sec-env`** (see above) |
| 14 | Low | Connector vault is plaintext when there is no OS key (bare `npm start` sidecar). This is by design and is now 0600 | `connector-vault.js:40` | Document it; optionally derive a per-user key |
| 15 | Low | MCP HTTP transport has no private-IP or DNS guard (loopback is allowed on purpose, and the URL is user-set through the token-gated UI or config import) | `mcp/transport.http.js:39` | Warn in the UI for private ranges, or pin the resolution |
| 16 | Low | The stdio allowlist compares basenames only and includes `node`/`python` (so `-e`/`-c` run arbitrary code). Containment is the Safe Cell container only. `STARNET_MCP_STDIO_ALLOW='*'` disables the check | `mcp/transport.stdio.js:23-38` | Acceptable while stdio stays Safe-Cell-only |
| 17 | Low | Plugin approval hashes only `main`. Helper files `require`d by an approved plugin can change without re-approval, and plugin folders and main files are followed through symlinks | `plugins.js:72-77,197` | **Fixed on `agent/sec-env`** (see above) |
| 18 | Low | `save-conflict-<client>.json` files grow without limit, and notebook restore has no count cap (both token-gated) | `savestore.js:239`; `notebookrestore.js` | **save-conflict fixed on `agent/sec-env`**; notebook-restore cap still open |
| 19 | Low | `/api/harness/scan` accepts any absolute root, including UNC `\\host\share` (an SMB/NTLM touch on `stat`) | index.js `handleHarnessScan` | **Fixed on `agent/sec-env`** (see above) |
| 20 | Low | `live-doctor.js clean()` is a weaker, separate scrubber for probe `detail` (raw `e.message`); `GET /api/providers` returns `currentBaseUrl` raw (userinfo would show) | `live-doctor.js:18`; index.js `/api/providers` | Route both through `redact()` |
| 21 | Low | Connector-OAuth discovery ignores `code_challenge_methods_supported` and does not validate `issuer`. The catalog `authorization_endpoint` is not URL-checked before the UI opens it (custom targets are) | `mcp/oauth.js`; index.js ~12205 | **Fixed on `agent/sec-env`** (see above) |
| 22 | Low | `skills/package.js:191` calls `rmSync(visible, {recursive})` without the `insideRoot` guard. This is latent, because today's ids are slugged | `skills/package.js` | Add the guard |

## Verified good (no action)

- **Connector vault:** AES-256-GCM with AAD. The key comes from the keychain and is deleted from env after it is read. A missing or wrong key locks the vault and never overwrites. Migration writes and verifies both copies before unlinking the legacy file.
- **Rust keychain moves:** `set_password`, then an exact read-back, then the plaintext copy is stripped. Channel migration strips only when the env value is proven equal.
- **Webhook trigger secrets:** only the sha256 is stored, compared in constant time, and shown once.
- **Masked `/api` surfaces:** `/api/servicekeys` returns last4 only; `/api/connectors` returns `hasToken` plus redacted env, headers and URL; channel and auth status routes return booleans only.
- **OAuth flow:** PKCE is S256 with 48 random bytes; state is 128-bit and single-use; `redirect_uri` is fixed to loopback. Tokens never appear in `/api/connectors`.
- **stdio MCP registration:** there are no catalog stdio entries. Registration is only possible through token-gated `/api/connectors` or config import, and spawning requires a docker Safe Cell. No model tool or channel command can register a connector.
- **MCP tool results:** fenced (`fenceExternal`) and taint-latched (`capability mcp:*`).
- **Station-recovery restore:** path jail, lstat, symlinks skipped, and SHA-bound files. `workspace-recovery` stages under a jail.

## For other lanes (seen, not touched)

- **token-in-URL:** `apiauth.js:94` accepts `?token=` on GET. `/api/file` is one consumer; fix #1 closes the credential-directory read it enabled, but the master token in URLs remains.
- **taint:** see open #12 (tool descriptions). The previously reported taint loss across worker→lead and transcript replay was not re-examined.

## Commits (`agent/sec-secrets`)

| Commit | Change |
|---|---|
| `17d149c18` | station-owned directories can never be an agent's workspace |
| `957f23122` | journey agent ids can no longer pollute Object.prototype |
| `e3de2a7d6` | config import no longer grants project-folder authority |
| `bf6679fa7` | credential stores are written owner-only (0600) |
| `eae4248a8` | redact() scrubs the exact secrets the station holds |
| `ca55c928d` | pre-update backups no longer capture quarantined credential stores |
| `be543f2b2` | ChatGPT logout can no longer be undone by a restart |
| `ff00d7ccd` | uncaught-fault text is redacted |
| `9e55871fc` | fail-open ratchet: index.js 363→361 |
| `a58e8c48f` | cap document inflation (zip bomb) |
| `2ea9ed25e` | pin connector-OAuth connections |
| `0d9ecfa51` | qa(claims) re-lock (`frontend/app/agentid.js`) |
| `f9862b60e` | compact the delete guard (lifecycle-order test) and pin it |

## Tests

**New:**

- `workspace-reserved` (72)
- `redact.known-values` (56)
- `durable-write.mode` (6)
- `mcp.oauth-fetch` (13)
- `secret-redaction.e2e` (11, in `http.list`)

**Extended:**

- `journey-store` (81)
- `configexport` (79)
- `config-permissions-import.e2e` (16)
- `station-recovery` (79)
- `provider.codex-auth` (75)
- `codex-status.e2e` (14)
- `process-fault` (78)
- `docextract` (31)
- `failopen-ratchet` (155)

**Regression coverage:**

- All 59 unit tests that load a changed module pass.
- These integration suites pass: `sidecar.http` (504), roster-envelope, agent-lifecycle, the OAuth e2e suites, `qa-product-perfect-claims`, and claims `PASS`.

The full `npm run test:fast` gate was **not** run here because the machine was short on RAM. Run it before merging.
