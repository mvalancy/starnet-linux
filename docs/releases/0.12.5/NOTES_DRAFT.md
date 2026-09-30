> Historical working draft, superseded by the final v0.12.5 RELEASE_NOTES.md (the owner chose 0.12.5 over the 0.13.0 suggested below).
> The notes audit, heads-up list and validation record are in PREPARATION.md beside this file.

# StarNet — next release (draft)

DRAFT started 2026-09-24 from every trunk merge since v0.12.4 (`f00aa04df`). Not a release. `release:bump`
overwrites `RELEASE_NOTES.md` with a scaffold — paste the final text from here. Pick the version at the cut
(this is a large feature set; 0.13.0 fits better than 0.12.5).

## User-facing

- **Workflow studio.** The Workflow panel docks beside the station instead of opening INBOX/BAY cards. Lines can
  be step-tested (pause, continue, edit the hand-off, rerun, rewind). One agent may crew several bays; routing is
  keyed by bay.
- **Line triggers.** A file dropped in a watched folder, or a call to a line's webhook, starts one run of that
  line. Bay status lamps, a crate inspect card, per-line INBOX plates and a TODAY row show what each line did.
- **Routines** can be renamed and have their instructions edited in Automation. Scheduled deliveries recover
  after a restart and no longer overwrite each other's receipts.
- **Google Workspace early access.** Calendar, Docs, Sheets, Drive and Gmail connect now as early access. Google
  shows an "unverified app" warning at sign-in and caps use at 100 users until verification completes. Gmail
  and Drive data never goes to StarNet Managed models.
- **Live model status.** COMMS shows when a model call is slow or retrying, and why, from the engine's own
  events. Long streaming replies from the local `/v1` endpoint keep the connection alive.
- **Spend safety.** A $25/day soft spend rail on metered runs (one-click RESUME, editable, 0 turns it off). Runs
  that keep making the same failing calls or change nothing are parked instead of spending.
- **Agent reliability.** Transcripts are saved turn by turn, so interrupted runs appear in history and can be
  continued. Better recovery from provider outages, context overflow and cut-off tool calls; compaction keeps
  your instructions word for word. Stop reaches background workers.
- **Coding tools.** `fs.edit` refuses ambiguous edits, `fs.read` can number lines, search respects
  `.gitignore` and uses ripgrep when installed, and `shell.exec` accepts timeouts up to 10 minutes.
- **Windows command exit codes are reported correctly.** Before this, a failing command could report exit 0.
- **Headless CLI.** `starnet run | status | doctor | init` drives a station from a terminal.
- **Memory.** Lessons and facts can be scoped to a project, and recall can use embeddings from a configured
  provider.
- **DaVinci Resolve edit bay** on the STUDIO prop (live control needs Resolve Studio). Seven hosted MCP
  connectors were added to the catalog.
- **Fourteen new agent skins** (roster 51). Agents move more fluidly: they arc through corners, and poses and
  walk frames blend into each other.
- **Desktop.** A new app icon. The app recovers from a WebView2 renderer crash without a white screen, and
  double-clicking while it is still starting no longer kills it. Startup offers Retry/Cancel if the local engine
  does not come up. Media ships as one copy, so installs are smaller.
- **Performance.** Sessions that were wrongly pinned to the slow CPU warp path now render on the GPU
  (about 26 → 60 fps on affected machines).
- **Providers.** Opus 5.5 thinking, an updated Gemini catalog, and resume keeps the provider you selected.
- **Crew configuration** saves are read back before they are reported as saved.

## Security

- Web tools pin the DNS-validated address per hop (DNS-rebinding guard), and dangling-symlink workspace
  escapes are blocked.
- `team.configure` requires consent, is refused in tainted runs, and scans the instructions it writes.
- `code.run` runs model code in an isolated worker under Node's permission model (no processes, files, workers or
  code-from-strings) and still asks for consent like `shell.exec`.
- Chat channels: only the paired owner can change settings, switch agents, start routines or use the new-chat
  command, and an agent's Full Access applies only to the owner's direct messages.
- The API token no longer appears in any link, file URL or event stream (short-lived per-file tickets instead), and
  the desktop app's content security policy allows only its own engine port and no inline scripts.
- Untrusted content stays marked through helper agents, resumed conversations and work-line hand-offs.
- An agent can no longer be named into a station credential folder, secrets the engine holds are redacted from
  logs and streams, credential files are private to your user on macOS/Linux, and signing out of ChatGPT survives a
  restart. Document imports and connector sign-ins got size caps and DNS-rebinding protection.
- Slack and Matrix bot tokens are kept in the OS keychain on desktop, like Telegram and Discord.
- Webhook, watched-folder, forwarded and attached content never gets an agent's Full Access (also after a crash
  and resume). Connector tool descriptions are shown to the model as the server's words, not instructions.
- Commands and helpers StarNet starts no longer inherit its stored keys and tokens.
- **Heads-up:** installed plugins ask for approval once more, because approval now covers every file in the
  plugin's folder and is re-checked while it runs.
- Discord, Slack, Matrix and Signal bots need the same one-time owner pairing code as Telegram before they take
  orders. Owners already paired keep working.
- Forwarded Telegram messages, webhook payloads and watched-folder files start runs as untrusted text.
- An agent that rewrites a granted routine's instructions drops that routine's unattended grants.
- The local server pins its Host on every path and refuses to be framed by other sites; a saved agent colour can
  no longer inject markup.
- The desktop window only ever navigates within the app itself (including after a crash recovery), and the API
  token is injected only into the app's own pages.

## Before the cut — owed

- Polish pass (d5b9a6288), security audit (62f53ce31) and security hardening (04dcb93fd) are merged and folded in
  above, as are the follow-ups (a4d4734c7). Verify in an INSTALLED build: code.run's isolated worker starts from
  the bundled resources path, the pinned CSP inside real WebView2, and the Slack/Matrix keychain migration.
- Verify this list against the exact cut head (`git merge-base --is-ancestor <sha> <tag>` for each item).
