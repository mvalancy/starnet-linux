# Google verification review build

Prepared 2026-09-22 on `agent/google-per-service`. This is the private build used to **record Google's
data-access verification demo**. It never ships: public releases keep every broad Google service deferred in
source (`sidecar/mcp/google-client.js` `RELEASED`), and this build opens them only through a developer
preload that lives in `dev/` (not bundled) and refuses to load outside the review launcher.

> **Superseded for public builds (2026-09-23):** Google services were un-deferred as **public early access**
> (`EARLY_ACCESS = true` in `sidecar/mcp/google-client.js`) — every build now opens them with Google's
> unverified-app warning and the 100-user cap until verification lands. This review build is still how the
> verification demo gets recorded.

## Why two submissions, not one

Google reviews scopes by tier ([scope classes](https://developers.google.com/workspace/gmail/api/auth/scopes)):

| Submission | Services | Scopes | What Google requires |
| --- | --- | --- | --- |
| **A — sensitive** | Calendar, Docs, Sheets, **Gmail (send only)** | calendar.calendarlist.readonly, calendar.events.readonly, calendar.events.freebusy, documents, spreadsheets, gmail.send (+ drive.file, openid, userinfo.email) | App verification: scope justification + demo video. **No security assessment.** |
| **B — restricted** | Gmail (read/compose), Google Drive (whole-Drive read) | gmail.readonly, gmail.compose, drive.readonly | App verification **plus the CASA security assessment**, renewed every 12 months. |

StarNet now releases each service on its own tier, so submission A can ship Calendar/Docs/Sheets/send-only
Gmail without waiting on B. **In the Cloud console, the Data Access page must list only the scopes of the
submission being filed** — verification covers every scope configured on the project, so leaving the
restricted scopes configured drags submission A into the assessment. Confirm this against the console's own
guidance before submitting; add the restricted scopes back only when filing B.

## Launch

Prerequisites: Rust toolchain, Node 22, the StarNet **Desktop** OAuth client JSON for project
`starnet-505202` (the `installed` registration — never a Web client), a **dedicated test Google account**,
and a model key or sign-in so an agent can drive the tools.

```
cd src-tauri
cargo run --example google-review -- C:\path\to\installed-client.json 9498 --with-model
```

- Opens `http://127.0.0.1:9498` with a seeded, already-onboarded station.
- `--with-model` uses the model/key from `dev/.env.dev` (or your shell). Without it the station runs the
  offline replay model and no agent can call Google tools.
- State lives in `dev/.google-review-workspace` and is **kept between launches** (the demo shows restart
  continuity). Delete that folder to start clean.
- Connector credentials are encrypted with the OS-keychain key, exactly like the desktop app. Other
  Google-derived content (chat, memory, files) is not encrypted by this candidate — test data only.

## Prepare the test account (once, before recording)

- **Calendar**: create a calendar event named `StarNet review fixture` in a known date window (the connector
  is read-only, so it cannot create one itself).
- **Docs / Sheets**: create one existing document and one spreadsheet named `StarNet review fixture`.
- **Drive** (submission B): a folder with a fixture file to search and export.
- **Gmail** (B): one fixture message with a unique subject. **Send-only** (A): a second test inbox you control
  to receive the demo email.

## Recording — submission A (sensitive)

1. Show starnetos.com home and privacy pages, then StarNet's in-app Google disclosure: which model provider
   receives tool output, and the StarNet Credits gateway if used.
2. In **Connectors**, connect **Google Calendar**, **Google Docs**, **Google Sheets**, and **Gmail (send only)**
   one at a time. On each Google consent screen show the account, the app name, the address bar with the
   client ID, and the exact permissions.
3. Calendar: ask the agent to list calendars, read the fixture event in its date window, and check availability.
4. Docs: read the fixture document; create a new document, insert text, read it back; show it in Google Docs.
5. Sheets: read the fixture spreadsheet; create one, write a range, read it back, apply a formatting update;
   show it in Google Sheets.
6. Gmail (send only): ask the agent to email the second test inbox; show the approval before sending and
   the received message. Point out the connector cannot read or search mail.
7. Quit and relaunch the review build; show the services are still connected and working. Remove one
   connection in StarNet and show that Google access for it is gone from the station.
8. Upload as an **unlisted** YouTube video, confirm playback, paste the URL into the Data Access form, save,
   review the summary, submit.

## Recording — submission B (restricted, later)

Same flow for **Gmail** (search the fixture subject, read it, create a draft, send an approved draft) and
**Google Drive** (search, read metadata, export text, create and rename a fixture folder), after the
security-assessment scope has been settled. Keep submission A's approval separate.

## Submission B and the security assessment: the on-device position

Google requires CASA for restricted scopes when the data is accessed through **the developer's** servers, and
exempts apps whose restricted data stays on the device
([restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).
StarNet runs on the user's computer; the one StarNet-operated path model traffic can take is **StarNet Managed**
(the credits relay, provider `starnet`). Since 2026-09-22 (`sidecar/mcp/google-relay-guard.js`):

- a StarNet Managed run is **not offered** Gmail read/compose or whole-Drive tools;
- every request streamed to StarNet Managed (primary, fallback, auxiliary pass) has earlier Gmail/Drive tool
  results **replaced with a notice** — the user's local transcript is untouched;
- proven end to end by `test/google-relay-guard.e2e.test.js` (and shown to fail with either half removed).

Restricted Google data therefore reaches only Google and the model provider the user selected with their own key.
**Residual paths the guard does not cover** — decide before claiming the exemption: an assistant's own prose that
restates mail/Drive content in the same conversation, memory notes and files the agent writes from that content
(both can later be sent on a StarNet Managed run), and any future StarNet server feature. Whether the exemption
applies is Google's determination during review; this is a technical position, not a compliance claim.

## Early access is ON in source (2026-09-23)

Andrew chose to ship Google in every build before approval: `EARLY_ACCESS = true` in
`sidecar/mcp/google-client.js`. Every Google card tells users to choose **Advanced → Go to StarNet** at Google's
unverified-app screen. Google caps an unverified app at **100 users**; the fallback if that cap is hit is a Gmail
App Password (IMAP/SMTP) connector, not yet built. **When Google approves**: set `EARLY_ACCESS = false`, flip the
approved services in `RELEASED`, run the gates, and ship — the warning and the cap disappear.

## Early access builds (before approval)

For up to **100 users** before verification, build with the early-access flag:

- GitHub → Actions → **desktop-build** → Run workflow → `google_early_access: true` (optionally `publish-test: true`
  for a shareable pre-release link). The public **release-train never** stages it (a test enforces this).
- Locally: `STARNET_GOOGLE_EARLY_ACCESS=1 node scripts/stage-google-client.mjs` before packaging.

Every Google card in that build opens and says **"Early access — not yet verified by Google"**; Google shows its
unverified-app warning at sign-in. Keep the project's publishing status in mind: in **Testing** status only listed
test users can sign in and refresh tokens expire after 7 days; in **In production** (unverified) anyone can sign in
up to the 100-user cap. The relay guard applies in early access builds too.

## After approval

Flip only the approved services in `RELEASED` (google-client.js), in an isolated change with the full gates,
then earn signed-installer acceptance for exactly those services before the release train. Never widen a
service's scopes after approval without re-verification.
