# StarNet v0.12.5

Workflow lines you can step-test and start from a folder or webhook, Google Workspace early access, steadier long runs, and a large security update. Heads-up: metered runs now stop once spend in the last 24 hours reaches $25, until you press RESUME in Budget (editable; 0 turns it off). Some plugins, chat-channel bots and code.run ask for approval or pairing again. The heads-up items at the end list what to check.

## Highlights

- **Workflow studio.** Each line gets one docked Workflow panel. You can step-test a line one stage at a time (pause, continue, edit the hand-off, re-run or rewind), one agent can crew several bays, and a line's INBOX can work in a trusted project folder (#25).
- **Lines that start themselves.** A file dropped in a watched folder, or a call to the line's webhook, starts one run of that line. Bay lamps, crate cards, INBOX plates and a TODAY row show what each line did.
- **Google Workspace early access.** Gmail (full or send-only), Calendar, Docs, Sheets and Drive can be connected before Google finishes verifying StarNet.
- **Reasoning levels that match the model.** Grok (xAI), DeepSeek and known OpenAI API models offer the levels each model accepts, and StarNet Managed models that support reasoning offer levels too. DeepSeek thinking mode works with tools, and setup errors say what is actually missing.
- **Steadier long runs.** Conversations are saved turn by turn, and interrupted runs show up in history and can be continued. Recovery from outages, stalled models, context overflow and cut-off tool calls is better, and COMMS shows when a model is slow or retrying.
- **Spend safety.** Metered runs stop once spend in the last 24 hours reaches $25. Loops that change nothing pause, and runaway unattended runs stop and say why. Conversation summaries no longer send screenshots as text, which could cost hundreds of thousands of tokens per summary.
- **BYOK stations are no longer refused with "Out of managed credit" (#24).** A specialist set to Follow station default runs on the Overseer's model and provider in COMMS, workflow-line hand-offs, RUN A SAMPLE JOB and chat channels.
- **Windows commands report real results.** Commands report their real exit code (0.12.4 reported exit code 0 for most commands that failed), and a `cd` carries over to the next command.
- **A large security update.** It covers network pinning, removing the API token from URLs, a locked-down desktop window, owner pairing for every chat channel, untrusted-content tracking through helpers, resumed conversations and hand-offs, value-based secret redaction and keychain storage for Slack and Matrix tokens.
- **Desktop and station.** The Windows installer is about 40% smaller (382 MB, down from 640 MB). The app no longer draws the station while minimized or in the tray on Windows, recovers from WebView2 crashes, and has a new icon. There are fourteen new agent skins and smoother agent motion.

## New

### Workflow lines & routines

- **Workflow panel.** Clicking a line's INBOX or a BAY opens one panel for the whole line, docked beside the live station, in place of the separate INBOX and BAY cards. It shows an editable line name, a plain "how it runs" sentence, a readiness pill and the cost of tested steps.
- The panel's flow strip follows the line's real run order, with loop back-arcs, and **+** inserts a real BAY between two stages as one undo step. Bays the INBOX never reaches are set apart as not connected (grouped under NOT CONNECTED when there are several). Each BAY reads as GETS → DOES → HANDS OFF → TO, with role starters, an agent picker, RECRUIT and ⊕ ADD A WORKSTATION HERE, and what you write under HANDS OFF is added to the brief that bay's agent receives.
- Agents appear as their own skin portraits throughout the panel. Clicking part of a line on the floor selects it in the panel, and selecting it in the panel highlights it and pans the floor to it. Opening the panel minimizes the Build Library, which comes back when the panel closes.
- **Step test.** ▶ START STEP TEST walks a line one stage at a time. With PAUSE AT EVERY HANDOFF you can CONTINUE, or CONTINUE WITH MY EDIT to change the exact text the next bay receives (UNDO MY EDIT takes it back). You can also ↻ RE-RUN STEP, ↺ RE-RUN FROM an earlier agent, or ▶▶ RUN TO END. Try this step (▶ RUN THIS STEP) runs a single bay with a test input, and E-STOP stops test runs.
- A paused step test follows floor edits, so a BAY added mid-test is used when you continue, once it has an agent. It previews the exact text the next bay will get, and says where and why a test stopped short of the OUTBOX. Test runs count as TESTS rather than jobs, and their spend counts toward the line's LINE BUDGET. If StarNet restarts mid-step, a cost the step already recorded still counts; otherwise the test says its spend is unknown.
- **One agent, several bays.** The same agent can now crew more than one bay; the old DUP AGENT fault is retired. Each bay gets its own brief, and work addressed to one bay rides past the agent's other bays. An agent without a desk uses the tools of the room its current bay is in; an agent with a desk keeps its desk room's tools at every bay.
- A multi-bay agent stands at its home bay, the bay with its current work glows, and its other bays read "NAME ↔ home". The agent picker marks an agent that already crews another bay and names that bay. If a desk-less agent's bays sit in different rooms, the floor suggests PLACE A DESK — TOOLS FOLLOW THE DOCK.
- **Working folder (#25).** A line's INBOX can pick a trusted project folder, and every stage of the line works in it, including chat-channel runs, RUN A SAMPLE JOB, scheduled routines and Run Now. Each stage re-checks that the folder is still trusted before calling a model. Changing the folder is one undo step, and the choice survives restarts.
- **Line triggers.** A line's INBOX offers ⊕ WATCH A FOLDER and ⊕ ADD A WEBHOOK. A file dropped in the folder, or a POST to the line's webhook, starts one run of the line. The file's text or the request body, up to 32 KB, becomes the job. For a binary file (such as a PDF, Office document, image or archive) only its path and size are sent, and webhook bodies over 256 KB are refused.
- Each trigger allows 20 fires an hour by default (up to 120), and queues up to five items behind the one running. Before each fire, and again when a queued item starts, it checks the line's daily spend cap, the station E-STOP and that the line is still on the floor.
- A watched folder must be in your home folder or a trusted project. It can never be a system folder, a drive root, StarNet's own data or a folder inside a line's working folder. A file fires once its writes settle, and temporary files and dot-files are ignored. A file that has fired does not fire again while its name, size and modified time are unchanged, even if it is moved away and back; an edited or renamed file fires again. Unreadable files are retried with growing waits, and a vanished folder shows as blocked until it can be read again.
- A webhook's key is shown once (COPY KEY, then I SAVED IT), stored only as a hash, and replaced with NEW KEY; COPY URL copies the webhook's address. The webhook listens on 127.0.0.1, so calling it from outside your computer needs a tunnel you set up yourself; email triggers are not offered yet. Each trigger row shows its fire count, last fire, last outcome and last error, with PAUSE, EDIT and DELETE.
- **Line watch.** Every crewed bay wears a status lamp with a hover plate: IDLE, WORKING, WAITING, FAILED or PAUSED (step test). FAILED stays lit until the next success or until you acknowledge it, even after a reload.
- Clicking a crate riding the belt opens a card with its job, line and route. It shows the run working on it (with live cost) or its outcome and failure reason, with a link to the agent's logbook (and, for a step-test crate, to the Workflow panel).
- Each line's INBOX carries a one-line plate of today's runs; hover for spend against the daily cap and the median run time. The Workflow panel header shows a TODAY row: runs, shipped (reached the OUTBOX with proven work), failed, tests and median run time since local midnight, and $ today (a UTC day).
- **Routines.** ✎ EDIT TASK in AUTOMATION → ACTIVE ROUTINES renames a routine or changes what it should do (✓ SAVE CHANGES). Only the fields you changed are sent, so an agent's newer edit to the other field is not undone. Routines on a clock-time schedule show their time zone, and a routine with results waiting to be delivered shows how many and when the next retry is.

### Models & providers

- **Reasoning levels for Grok (xAI), OpenAI API and DeepSeek.** The model dock offers the levels each model accepts, instead of showing OFF while the model ran at its own default. Grok and DeepSeek levels come from xAI's and DeepSeek's model lists, and OpenAI API levels from a table built into StarNet (models not in the table show AUTO). A model with no reasoning setting is labelled AUTO, or OFF if its provider lists it as not reasoning.
- StarNet Managed models that support reasoning offer reasoning levels too.
- When OpenAI refuses a reasoning level StarNet sent, StarNet reads the accepted levels from OpenAI's error message, resends with one of them, and shows the corrected list in the model dock until StarNet restarts. A level a model does not list is replaced by its default or the nearest weaker level it offers.
- The model dock lists each provider's models from the same address its runs use. When StarNet runs a model with reasoning fixed, such as GPT-5.6 through the OpenAI API, the dock says why.

### Connectors & integrations

- **Google Workspace early access.** Gmail, Gmail (send only), Calendar, Docs, Sheets and Drive can be connected before Google finishes verifying StarNet. Google shows an unverified-app warning at sign-in, and each card explains how to continue: choose Advanced, then Go to StarNet. Google limits unverified apps to 100 users.
- Full Gmail and whole-Drive tool results are not sent to StarNet Managed models. On those models the two tools are not offered, and their earlier results in a conversation are replaced with a notice before a request is sent to StarNet's servers; your local history keeps them. Text an agent writes from that data (a reply, a note, a file) is not filtered, and Calendar, Docs and Sheets results are not withheld.
- **Seven hosted MCP connectors** join the catalog: Corpus (US law), Financial Datasets (prices, filings, insider trades and a screener), You.com (search, extraction and cited research), XMemo (cloud memory; what the agent saves is sent to xmemo.dev), Replaid (social inbox triage and replies), Markifact (Google Ads, Meta Ads, GA4, Shopify, HubSpot and more; it can edit live campaigns) and Adspirer (ad campaigns that spend real ad budget).
- **DaVinci Resolve edit bay** on the STUDIO prop. Agents can build a timeline file (FCPXML, with in and out points, lanes and markers) from your clips for the free DaVinci Resolve to import, and can check and control a running DaVinci Resolve Studio; live control needs Resolve Studio and Python 3. The STUDIO prop pulses while Resolve tools run.

### Agents, tools & memory

- **Edit a crew member's Dossier from chat (#28, in part).** A lead agent can read and change another agent's Dossier documents from chat. Each change asks for your approval (unless the agent has Full Access or you approved this tool for always), is scanned for prompt injection, and is read back before it counts as saved. If you have that document open in the Dossier editor, SAVE warns you instead of silently overwriting the agent's change; a second SAVE overwrites it on purpose.
- **Project memory.** Lessons and facts learned inside a project are recalled only in that project.
- **Optional meaning-based recall.** Memory recall can also match by meaning, using the embedding service of a provider you already use (OpenAI-compatible providers or Gemini). It is off unless an embedding model is configured, which is an advanced setting with no UI yet. Its cost is recorded like any other call, and pausing personalization turns it off.
- **Wait on background commands.** Agents can wait for a background command they started (shell.bg.wait), and an agent that is still running is told when one of its background commands exits.

### Station & art

- **Fourteen new agent skins** (51 in all), each with the full animation set: eight facings, eight-direction walking, sitting and typing.

### Desktop app

- A new circular StarNet app icon.

### For developers (source checkouts)

- **Headless CLI.** From a source checkout, `starnet run "<prompt>"` (or `starnet -p`) runs one agent task and streams the answer to the terminal, and `starnet status`, `starnet doctor` and `starnet init` check on or set up a station. It attaches to a running station (the desktop app's or `npm start`'s), or starts its own and shuts it down gracefully afterwards. It is not part of the desktop app.

## Improved

### Workflow lines & routines

- **Build mode (REFIT) conveyors.** The Conveyors tab has a MACHINES shelf listing every workflow machine with its purpose, and the decor tray is renamed MAIL TRAY so only one piece is called INBOX. A placement, stamp or move that would hook machines already on the floor turns amber and says WILL CONNECT TO with the machine's name, and existing hookups show a tap arrow and a hover explanation.
- The REFIT guide and the Field Manual's LINES chapter use the live tab, tool and button names, and explain PREVIEW FLOW versus STEP TEST; BRANCHES lists every junction. Floor messages are calmer: long warnings are short with the full sentence on hover, only the hovered target says CLICK TO CONNECT, and moving a machine away from its belts tells you the belts stay behind.
- **Routine delivery.** Undelivered routine results are retried while scheduling is on, with waits growing from 1 to 15 minutes, instead of only at the next launch. Pending results survive later runs and remember which destinations already got them, so a partial send is not repeated. At 100 pending results, new runs of that routine wait until the destination recovers. Pending deliveries are shown in AUTOMATION. While one is waiting and scheduling is on, closing the window keeps StarNet running in the tray to deliver it; otherwise, and with Quit StarNet in the tray, StarNet quits and keeps the result for a later launch.
- While you edit a line's triggers, the panel's background refresh updates only the rows that changed and keeps the schedule you picked. EDIT TASK refuses, with a reason, an edit too large to save.

### Spend safety

- **Default spend limit.** Metered runs (API keys and StarNet credits) stop once spend in the last 24 hours reaches $25. RESUME in the Budget settings adds headroom for the session, the limit is editable, and 0 turns it off. Subscription sign-ins (ChatGPT, Grok, Kimi) and Ollama are not counted; a local server added as a Custom OpenAI-compatible endpoint is treated as metered, so its runs also stop once the limit is reached. See the heads-up below.
- If StarNet cannot be sure of past spend (for example after a crash left a run unsettled), the default limit lets paid runs continue and reports the spend as unknown. A limit you set yourself still blocks paid runs until the spend is known.
- **Loops that change nothing pause.** A pass in ACTIVE LOOPS changes nothing if, in a loop with a project folder, it changes no file, lands no commit and files no findings, or, in a loop without a folder, it files no findings and repeats the previous report. The loop gets a nudge after the first such pass and pauses after three in a row, with the reason in words. Its history marks those passes "— changed nothing".
- **Runaway unattended runs stop,** and each stop says why. Any run ends after three turns in a row that call only tools that do not exist. An unattended run also stops when one tool keeps failing across eight turns (after a warning at three), or when the same call returns the same result five turns running. When a model calls a tool that does not exist, the reply names up to three real tools it can call instead.

### Models & providers

- **Setup errors say what is missing,** instead of the catch-all "No model is connected yet". They name the problem:
  - Grok or Kimi isn't signed in, with the way to SETTINGS → PROVIDERS → GROK (XAI) or KIMI FOR CODING.
  - A provider's API key is missing, or no model is selected; PICK A MODEL opens the picker.
  - A custom endpoint has no base URL.
  - The provider rejected the key, or the account has no credits (including xAI's no-credit error).
- **Outage recovery.** A request that fails before any reply streams (overloaded, server error, timeout or a plain rate limit) keeps retrying up to six times with about 105 seconds of backoff (plus any wait the provider asks for), instead of ending the run. Retries are spread out so agents sharing a key do not retry in lockstep. Sign-in, billing, quota, policy, format, certificate and local errors still stop at once.
- A request the provider refuses because it asks for more output than the model allows is retried once with the output cap the provider names, instead of being treated as a context overflow. Context-overflow messages from Anthropic, Bedrock and llama.cpp, and a bare 413, now trigger compaction.
- A model that goes silent ends the turn after two stalls in a row, or switches to your configured fallback. Before, it could retry silently for up to about 37 minutes.
- Errors are classified from the provider's own error code. An OpenRouter "insufficient quota" error counts as billing, with no pointless waiting. An Anthropic "overloaded" stream error is retried, a bare 529 counts as overloaded, and a Gemini "resource exhausted" error mid-stream is retried as a rate limit instead of being read as billing. A spent ChatGPT plan quota fails fast or falls over to your fallback, and xAI's "does not support parameter reasoningEffort" error corrects itself automatically.

### Conversations & COMMS

- **Live model status.** COMMS shows when a model call is slow or retrying, and why, using the engine's own events. It shows the retry step, countdown and reason, or how long it has waited on the model. The line clears on the first token and wraps on narrow panels.
- StarNet's local OpenAI-compatible API (/v1) keeps long streaming replies alive with keep-alive comments while a model is slow to start or retrying.
- Plain multi-paragraph replies use the same paragraph spacing as formatted ones, and bold list labels stand out from their descriptions.

### Agents, tools & memory

- **File edits.** Ambiguous edits are refused instead of guessed. The edit tool (fs.edit) refuses a "find" that matches more than one place, unless the agent asks for every occurrence or states the expected count, and it requires reading the file earlier in the same run.
- **File reads, search and commands.** File reads can return numbered lines with a line-based offset and limit. File search respects .gitignore, uses ripgrep when it is installed, matches file patterns the same way with either engine, and scans up to 20,000 files by default (was 4,000; an agent can raise the limit for a big project). Commands may run for up to 10 minutes (was 2).
- **Turn-by-turn saving.** A run's conversation is saved at each tool step, not only at the end, so a crash or forced quit no longer loses turns that already had side effects. Interrupted runs appear in run history as a single row and can be continued, and their unsettled spend is left out of dollar totals instead of being counted as $0.
- **Smaller recovery records.** A long run's crash-recovery record stores only what changed, so it is dozens of times smaller (80 turns: 134 MB down to 3.4 MB). Startup reads large old records without stalling.
- **Context compaction.** Size is checked before every model call, including the first, and again after a fallback, using the provider's last real token count plus what was added since. The recent history kept after a summary is sized in tokens, so a summary frees real space on small-window models. Your own messages and steering notes from the summarized part are carried into the summary within a budget shared fairly between them, and anything trimmed or left out is marked. If three summaries cannot fix a context overflow, the run ends and says so.
- **Tool output that fits the model.** Output limits scale with the model's context window: 15% per result and 30% per turn, unchanged for large or unknown windows. As before, a result that is cut is saved whole to a file the note names.
- Only the two newest turns with screenshots are sent as images. Older ones become a one-line placeholder, and your own attachments are never dropped.
- **Smaller requests.** Installed skill recipes and the station manual's reference sections load on demand, through skill.view and the new manual.read, while rules stay inline. A default station's system prompt drops from about 37,000 to about 23,000 characters. Once a run's connector tools pass 8 KB or 12 tools, the largest connectors also load on demand through tool search, each replaced by a one-line index of the server and its tool count.
- **Tools that cannot work are no longer advertised.** Examples: image generation with no image connection, voice with no voice route, Spotify when it is not connected, an interactive terminal that is not installed, and routine-only tools outside a routine. If the model looks for one, it is told why and how to enable it, and the agent's own capability summary no longer claims it.
- **Stale helpers.** A helper that makes no progress for 7.5 minutes (20 minutes while a tool is running) is stopped as stale, with a reason. A helper whose model is thinking or retrying is not mistaken for stuck.
- **Background commands.** Kills are verified and report anything that survived; Docker and SSH kills say they are unverified. Records of finished commands are capped. On Windows, leftovers of background commands from a force-closed StarNet are cleaned up at the next start, and only processes StarNet provably started are touched.

### Station & art

- **Smoother motion.** Agents arc through corners instead of stopping and pivoting, and pose changes fade into each other instead of cutting. Walking frames blend together, and facing no longer flickers. Reduced motion keeps the hard cuts.

### Desktop app

- **Smaller install (#26).** Media ships once instead of twice. The Windows installer is about 40% smaller (382 MB, down from 640 MB), and the installed app executable shrinks from 274 MB to about 10 MB.
- **Slow starts.** StarNet waits up to 60 seconds for its local engine (was 25), because starts under memory pressure can take over 30 seconds.
- **Startup notices.** On macOS, StarNet shows a notice if the local engine cannot start or the window does not appear within 45 seconds. On Windows, a window that does not finish loading within 45 seconds shows a diagnostic naming the startup log (related to #31).

## Fixed

### Agents & runs

- **Windows exit codes.** Shell commands an agent runs on Windows report their real exit code; 0.12.4 reported 0 for most commands that failed. A `cd` now carries over to the next command.
- **Costly summaries.** Conversation summaries no longer receive screenshots as text: images are named, never sent as data, and an oversized turn is bounded. In 0.12.4, a conversation with screenshots could send hundreds of thousands of tokens to the summarizer in a single summary.
- Images are costed realistically when StarNet sizes the context. In 0.12.4 a screenshot counted as about a dozen tokens, while the context-overflow check counted its raw data as text, so a run that started with images attached could treat an unrelated request error, such as an invalid image, as a context overflow and force a needless summary.
- On small-window models, a summary that freed almost nothing could end the run with a context overflow, and a conversation already larger than the model's window was sent as-is. Both are fixed; an oversized conversation is summarized before the first request.
- When a provider error ends a reply mid-stream, the text already shown in COMMS is kept in the conversation and marked incomplete, so history and continued runs match what you saw.
- A crash while a conversation row was being saved no longer merges it with the next row and hides both from history.
- A tool call whose arguments were cut off inside a text value is no longer run. The model is told to send it again in full.
- A failing test or verify step no longer counts as the check a run owes after changing code. A run that tries to finish right after a failing check is sent back once and told the check did not pass.
- The last turn allowed past the step limit no longer runs tools; the run ends with the model's text.
- Two identical calls in one turn, such as the same channel message twice, run once, and the model is told copies were merged. Repeated keystrokes and clicks in StarNet's own browser, terminal and desktop tools are kept. A call id reused within a turn no longer marks a real result as interrupted.
- A command killed by its timeout or by Stop now reads as an error, with the partial output kept. A timed-out tool that may have changed something says its effect is unknown. Stop no longer waits for a tool that ignores cancellation to finish: after 3 seconds the call is reported as cancelled, not confirmed stopped.
- Stop now also stops the helpers a run started; before, a cancelled lead left its background helpers running. Stopped helpers are marked interrupted and can be resumed, and a run that ends normally leaves its helpers alone.
- A summary that was cut off or refused is rejected instead of replacing history; after two failures, StarNet falls back to a plain summary note. Quick trimming of old tool output no longer saves the shortened copies as the permanent record; the full output is saved first.
- When several helpers report back at once (team.dispatch), a long combined result no longer drops a helper's row. Every helper keeps its status, and long results are shortened fairly and saved whole per helper.
- Restoring a checkpoint of a local workspace no longer destroys hand edits and untracked files. The current files are saved first as an undo point, and the restore is refused if that fails.
- A command or routine that runs a script is no longer refused as a desktop-app launch because the script's text contains a word like write or calc. The check now looks at the programs a command runs and at program names quoted as launch targets, not at ordinary words (#50).
- The end-of-run reflection no longer learns about you while personalization is paused.

### Conversations & COMMS

- Numbered replies no longer split into separate lists with large gaps between items.
- A steering note sent while the agent is writing its final answer is folded in, giving the agent one more turn, instead of being dropped. A /steer note that arrives after the run has ended is queued for the next run instead of being reported as applied, and the transcript says how many notes could not be applied.
- In the browser view, switching quickly between deliverable previews no longer lets an older file's preview replace the one you selected.

### Workflow lines, routines & scheduling

- E-STOP now stops a running RUN A SAMPLE JOB, which used to keep spending. StarNet's own fault shutdown stops it too.
- On a busy station, RUN A SAMPLE JOB now reads back every run of the sample. It used to look only at the station's newest 50 runs, so a finished sample could be missing stages and cost, or fail with "sample job produced no durable run outcome".
- When a scheduled routine fails, its next run is now set in your local time zone instead of UTC. This affected repeating clock-time routines with no saved time zone, such as ones an agent created.
- A routine's undelivered result is no longer overwritten by its next run.
- Routine changes are no longer written while another StarNet process holds the routines lock. The change reports an error and leaves the saved routines untouched.
- A Run Now run that finishes after StarNet reclaimed it can no longer replace the outcome already recorded for it. Recovering a routine script's delivery no longer adds a second copy of its transcript.
- Rescheduling a routine keeps its saved time zone. It used to switch the routine to your computer's current time zone, which moved its run time when the two differed.
- The schedule preview for creating or rescheduling a routine no longer shows an answer for older input. If the check fails, it now says "Could not check the next run" instead of staying on "Checking next run…".

### Station, build mode & rendering

- A false graphics check could keep a session on the slow CPU rendering path; it now stays on the GPU (26 to 60 fps in a GPU browser benchmark on an affected machine).
- When the BELT tool connects a splitter to two bays placed touching each other, each lane now ends on a tile that touches only its own bay whenever one is free, so the bays no longer compile as an accidental hand-off chain.
- ESC in select mode no longer pops a minimized Build Library back open.

### Desktop app (Windows / macOS)

- On Windows, StarNet stops drawing the station while it is minimized or in the tray. A v0.12.4 window in the tray kept using about two CPU cores; now it uses close to none.
- On Windows, a WebView2 crash no longer leaves a white window. A renderer crash reloads the page, and a browser-process crash rebuilds the window at the same size, position, maximized state and tray visibility. Recovery is attempted at most three times in ten minutes.
- Opening StarNet again while it is still starting no longer quits it.
- On Windows, Retry after a slow startup no longer leaves a stray engine process behind, and Cancel on the startup dialog now stops the engine and quits StarNet. Before, StarNet opened anyway while the engine kept retrying (related to #31).
- A failure to create the main window now stops the engine, shows a diagnostic that points to startup.log, and exits cleanly instead of crashing.

### Providers & models

- Opus 5.5 no longer fails with a saved OFF thinking setting, since it does not accept "thinking disabled". It now runs adaptive thinking at LOW effort (#32).
- Gemini shows its full model list, because model discovery used to stop after the first page, so models such as Gemini 3.1 Pro can be picked. Gemini 3.1 Pro offers LOW, MEDIUM and HIGH thinking, and 2.5 Pro is never sent a zero thinking budget (#19).
- Choosing Follow station default in a specialist's Dossier (SAVE MODEL) now clears its old model pin. The choice survives reloads instead of turning back into a copy of the Overseer's model (#24).
- An agent with no pin of its own follows the station default (the Overseer's model and provider), not the last pinned agent you focused. A save that recorded a focused specialist's provider as the station's provider now loads with the Overseer's own provider (#24).
- A specialist set to Follow station default runs on the Overseer's model and provider in COMMS, in hand-offs along workflow lines (scheduled and Run Now), in RUN A SAMPLE JOB and in chat channels, so BYOK stations are no longer refused there with "Out of managed credit" (#24). Routines are not covered yet; see Known issues.
- Choosing a provider in SETTINGS → PROVIDERS now also moves the Overseer's own provider, so agents without their own pin follow. Before, focusing the Overseer again could put the station back on the provider it had left (#24).
- DeepSeek models in thinking mode no longer fail on their second request. Their reasoning is passed back the way DeepSeek requires when tools are present.
- GPT-5.6 on the OpenAI API provider runs with reasoning off, because OpenAI's Chat Completions API, which that provider uses, cannot combine the model's reasoning with tools; it failed even with no level sent.
- Connector tools with property names like "account id" no longer make Anthropic-family APIs reject the whole request; names are made safe for the request and mapped back. Kimi routes get tool definitions in the format Moonshot expects.
- Anthropic and Gemini requests no longer fail on a tool call left unanswered when a run ended at a tool step, and Anthropic requests no longer fail on a call id created by another provider after a fallback. Tool calls and results are now paired before every request.

### Connectors & chat channels

- Slow connector calls are no longer cut off at 30 seconds; the default is now 120 seconds. A longer timeout set for a connector is honoured, up to 10 minutes, and Stop cancels an in-flight connector call right away.
- If a connector write timed out or was cancelled after it was sent, an identical retry in the same run is held until the agent makes a successful read on that connector, so the write is not blindly sent a second time.

### Onboarding & saves

- Resuming a saved station keeps the provider you picked and validated on the resume screen, including ChatGPT sign-in for the OpenAI card, instead of switching back to the old one (#6).
- Autonomy changes no longer show as saved before the engine confirms them. This covers initiative, reach and pace in SETTINGS → AUTONOMY, onboarding quick setup and the WHILE YOU'RE AWAY level in SETTINGS → PERMISSIONS. The panel says "Confirming autonomy settings…" or shows the error so you can retry, and a reload no longer pushes an old cached value over the engine's.
- Importing a backup restores its autonomy setting through the same confirmed path, and reports a partial restore if that step fails.

### Other

- For contributors who run the test suite from a source checkout: the macOS notarization receipt check reports a clean skip when Python is missing (#40), and the voice cool-off check no longer flakes under load (#38; change from PR #52 by @oodadoudou).

## Security

### Network, web tools and connectors

- Web tools and StarNet's own browser connect only to the address that passed the safety check, for every redirect and page resource, so a DNS-rebinding site cannot point them at your local network. This does not cover your own Chrome when an agent attaches to it.
- Connector sign-ins (OAuth discovery, registration, token exchange and refresh) are pinned the same way. The sign-in server is refused if its metadata names a different issuer or lists PKCE methods without S256 (StarNet always sends S256), and its endpoints must be public https without embedded credentials.
- Connector (MCP) tool descriptions, and the description and title text in their schemas, are treated as the server's words, not instructions. Control, zero-width and bidirectional-text characters are stripped, fence markers, chat-template tokens and role tags are neutralized, length is capped, and each tool description is labelled with the connector it came from.
- Documents (.docx and .xlsx) an agent reads are capped when inflated, at 32 MB per entry and 64 MB per document, so a compressed zip bomb can no longer balloon into gigabytes.
- Importing agents from another harness refuses network (UNC) and device paths before touching the disk, because a network path could leak your Windows credentials.

### Local server, API token and desktop window

- Links, file URLs, event streams and the save beacon use short-lived, single-purpose tickets instead of the API token: file links last 5 minutes, workshop pages 10, and event streams and saves 2 (single use).
- The API token placed in a URL is refused on every route. File and workshop pages send no referrer, and the desktop app will not open an external link that carries the token.
- The local server checks the Host header on every path, not only the API, so a DNS-rebinding page cannot read the page that carries the token; only the line-trigger webhook accepts a tunnelled Host, and it has its own key and returns no token. Other sites cannot frame StarNet's pages, and the app's pages, file links and workshop pages opt out of content sniffing.
- The desktop window navigates only within the app itself, so a link dragged onto the window no longer loads that page inside StarNet. The token is injected only into the app's own pages, including after a crash recovery, and the content security policy now allows only the engine's own local port (it used to allow any local port) and no inline scripts.

### Agents, workspaces, tools and plugins

- The file tools can no longer be tricked by symlinks, including dangling ones, into reading or writing outside an agent's workspace or an approved project folder. An agent id that matches one of StarNet's own folders (where credentials and plugin code live) can no longer be used as an agent's workspace; see the heads-up below.
- code.run runs model code in a separate locked-down process that only plain text crosses into. Node's permission model blocks processes, workers, add-ons and file access, code built from strings is switched off, and code.run refuses to run without that isolation. It asks for approval like a shell command. Once a run reads untrusted content, unattended runs lose it and watched runs must approve each further call; Full Access lifts this only for runs you started.
- team.configure (editing a crew member's Dossier) has its own approval, so an "always" given to another orchestration tool does not cover it. After a run reads untrusted content, unattended runs lose it and watched runs must approve each call (Full Access skips this for runs you started), and its text passes the same injection scan as routine instructions.
- When an agent rewrites the instructions of a routine you granted unattended powers, those grants are dropped.
- Git hooks, helper processes and agent commands no longer inherit StarNet's own keys and tokens; agent commands still get the service keys you saved in KEYS.
- Plugin approval covers every file in the plugin's folder, and is re-checked while the plugin runs.
- An imported config file can no longer grant access to project folders. Those grants are dropped, so approve the folders again on the new station.
- Save-conflict snapshots are limited to the newest 20 per agent.
- The progress (journey) store refuses crafted agent ids such as `__proto__`, closing an object-pollution hole in the engine.

### Untrusted content

- Webhook payloads, watched-folder files, and Telegram attachments and forwarded Telegram messages start their runs as untrusted content. For runs started this way, Full Access no longer lifts the untrusted-content lock on the terminal, credentialed web requests and connector tools, on any stage of the line or in the helpers those runs start.
- Forwarded Telegram messages, including replies that quote a forward, are treated as third-party text: their runs start with the untrusted-content lock, and built-in commands in them are ignored.
- Untrusted-content marking now follows work from helpers back to the lead, and through replayed conversation history and resumed runs. Oversized tool output StarNet parks from untrusted content is saved as untrusted, and a later run that opens it with the file tools is marked too.
- Later stages of a routine's work line start marked as having read upstream agent output.
- Work-line hand-off history is kept per chat and per line, so hand-off text from one chat cannot replay into another chat with the same agent. Old hand-off turns are no longer replayed into an agent's direct chat, and are archived once.

### Chat channels

- Discord, Slack, Matrix and Signal bots require the same one-time owner pairing code as Telegram before anyone can take control. The code lasts 10 minutes and works once. Each CHANNELS card has a PAIR OWNER control, "pair CODE" works where a leading slash is intercepted, and status no longer claims that an unpaired bot accepts DMs.
- Only the owner can use control commands: /stop, /new, /talk, /usage, /routine, /away and your own custom commands. Anyone can see the /model, /approvals and /mention readouts, but only the owner can change them. Full Access applies only to the owner's direct messages (on Matrix, the owner's messages in any room).
- A relayed message must pass the bot's own admission check (the paired owner for a DM, the allowlist for a group), and a relay can never claim an unpaired bot.

### Secrets and credential files

- Keys and tokens StarNet holds (service keys, bot tokens, connector tokens and headers, OAuth tokens and client secrets, and provider keys you save) are now scrubbed by their actual value from run streams, transcripts, diagnostics and command output. Redaction also recognizes more token formats: Discord, Slack app tokens, Matrix, Google refresh tokens, Groq, Perplexity, Notion, Linear and SendGrid.
- Masked key fragments that providers echo in errors (a key's first and last characters with the middle starred out) are scrubbed whole, and the saved error log is redacted again when loaded.
- Crash text served by the health check and written to the crash ledger is redacted first.
- On macOS and Linux, the engine writes credential files and saved diagnostics readable only by your user, and a startup pass tightens credential files and the error log that older versions left readable.
- Pre-update backups no longer include quarantined copies of credential stores, and backup snapshots are now readable only by your user (macOS and Linux).
- On desktop, Slack and Matrix bot tokens move into the OS keychain, like Telegram and Discord. The move never deletes the last copy of a token.
- Signing out of ChatGPT survives a restart; before, a restart could restore an older sign-in.

## Heads-up: changes when you update

- **$25 spend limit.** Metered runs (API keys and StarNet credits) now stop once spend in the last 24 hours reaches $25, including on stations that never set a limit. Press RESUME in the Budget settings (SETTINGS → SPENDING LIMITS) to add headroom for the session. If your metered spend runs higher, raise the limit, or set it to 0 to turn it off. A routine run the limit stops counts as a failed run, and five in a row pause the routine; re-enable it from AUTOMATION → ACTIVE ROUTINES after raising the limit.
- **code.run approval.** code.run now asks for approval like a shell command. Unattended runs can use it only on a Full Access agent.
- **Routine work lines.** Stages after the first in a routine's work line now start as having read another agent's output, so a stage agent without Full Access can no longer send credentialed web requests (web_request) with a KEYS key allowed for unattended use. The call is blocked and the stage carries on without it; give that agent Full Access if it needs them.
- **Reserved agent ids.** An agent whose name gave it the same id as one of StarNet's own folders can no longer use its own workspace or run commands (project folders you approved stay reachable). The affected names are Codex, Grok, Kimi, Channels, Connectors, Plugins, Skill-Packages, Transcript-History-V2, _archive, and Windows device names such as CON or NUL. The agent still loads and chats, its refusal explains how to recover, and you can still delete it. Recruit a replacement, which gets a safe id such as codex-2; the old agent's routines and notes do not move over automatically.
- **Plugins.** Installed plugins ask for approval once more, because approval now covers every file in the plugin's folder. A plugin with links inside its folder, or over the size limits, is refused, and one whose files change while it runs is turned off until you approve it again.
- **Chat channels.** A Discord, Slack, Matrix or Signal bot with no owner needs the pairing code from its CHANNELS card. A bot that recorded an owner before this update keeps that owner; in 0.12.4 that was the first account that messaged it. Only the owner can use control commands, and Full Access applies only to the owner's direct messages. On Telegram, messages with attachments or forwarded text keep the untrusted-content lock even under Full Access.
- **Windows.** Commands now report failures that earlier versions hid, so routines and checks that looked green may show real failures. A routine that now fails five times in a row pauses; re-enable it from AUTOMATION → ACTIVE ROUTINES once it is fixed. A `cd` in one command now carries over to the next.
- **Reasoning levels.** 0.12.4 showed OpenAI API, xAI and DeepSeek models as OFF but sent no reasoning setting, so they reasoned at their default. An upgraded station keeps them reasoning, now at MEDIUM or the nearest level the model offers, and keeps StarNet Managed models off. Providers that already had real reasoning settings in 0.12.4, such as Anthropic and OpenRouter, keep every stored value. Pick a level in the model dock to change it; a higher level uses more tokens or credits.
- **New stations on StarNet Managed.** A newly set-up station starts at the onboarding's MEDIUM reasoning level, and on StarNet Managed models that support reasoning the app now sends it, so they reason and use more credits than in 0.12.4, whose model dock kept them at OFF. Lower it in the model dock if you prefer.
- **If you were hit by "Out of managed credit" (#24).** 0.12.5 cannot clean up a pin that 0.12.4 already saved. After updating, open each affected specialist's Dossier, pick the model you want (or Follow station default) and press SAVE MODEL once; a specialist that runs routines needs its own model for now (see Known issues). If you had moved from StarNet credits to your own key in SETTINGS → PROVIDERS and 0.12.5 shows StarNet Managed again, pick your provider there once more.
- **Workflow panel.** Clicking an INBOX or a BAY now opens the docked Workflow panel instead of the old INBOX and BAY cards.
- **Build mode ESC.** A single ESC now shows PRESS ESC AGAIN TO SAVE & EXIT; press it a second time to leave.
- **Links and the API token.** File links StarNet opens in your browser now expire after 5 minutes, and workshop pages after 10; open them again from the app. A link or script that puts the API token in the URL is refused; send the token in a request header instead.
- **Source checkouts.** If you run StarNet from a source checkout (`npm start` or the CLI), run `npm install` after updating, because this release adds a dependency.
- **Rolling back.** Rolling back to 0.12.4 means entering Slack and Matrix bot tokens again.

## Known issues

- **Routines on Follow station default.** A routine whose agent is set to Follow station default is refused with "no model is configured" (on Run Now, "choose a model for this routine agent first"), because routines do not fall back to the station default yet. Until this is fixed, pick a model for that agent in its Dossier and press SAVE MODEL.
- **macOS build mode.** When TEXT SIZE is above 100%, clicks in build mode land below and to the right of the cursor. AUTO picks 115% on screens up to 1470 points wide (such as a 13-inch MacBook Air) and 110% up to 1740 points. Workaround: SETTINGS → APPEARANCE → TEXT SIZE → STANDARD (100%). A fix is planned for the next release.
- **Stale token after an engine restart outside the desktop app (#39).** If StarNet's engine restarts outside the desktop app (for example a self-hosted or `npm start` engine after START FRESH), an open page keeps its old access token. Buttons can stay greyed out, and requests fail as "catalog offline" or "Failed to fetch", until you reload the page.
- **Local models (#20).** Runs on Ollama and other local models may finish without making tool calls.
- **Unpaired bots.** A Discord, Slack, Matrix or Signal bot with no paired owner silently ignores direct messages until it is paired.
- **Plugins.** A plugin that writes files inside its own folder turns itself off until you approve it again.
- **Configuring bays from chat (#28).** Agents can edit a crew member's Dossier from chat, but cannot yet set up or rewire bays and lines. Use build mode and the Workflow panel.

## Validation

Release validation: the release candidate passed the full automated suite (952 fast and 155 HTTP steps), the adversarial API sweep, UI screenshot and golden-frame checks, the behavioral truth audit, interactive and customer journeys, the first-run check and the desktop shell’s Rust tests, plus the Linux release gate in CI. Signed Windows and notarized macOS (Apple Silicon and Intel) builds passed; an Intel Mac installed and restarted the app, and a hosted Windows machine installed the signed candidate on a clean system and over a populated v0.12.4 station with its data preserved. Real-account sign-in and a 48-hour installed soak were not performed; the owner waived the soak for this release. After publication, the public update feed and its signed downloads were verified for all three platforms, and an installed v0.12.4 on Windows updated itself to 0.12.5 through the Update Center.
