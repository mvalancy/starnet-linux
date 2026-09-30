---
fingerprint: a9862eb0
slug: chat-numbered-lists-have-excessive-vertical-spac
title: Chat numbered lists have excessive vertical spacing
surface: world
severity: P2
status: fixed
found: 2026-09-22
lane: agent/chat-spacing-0922
fix: 6fa1477db
origin: owner
report: Owner screenshot in Codex task, 2026-09-22
affected: Desktop screenshot, installed version unknown
family: chat-markdown-spacing
installer: unverified
recovery: unconfirmed
---

# Chat numbered lists have excessive vertical spacing

## Symptom

Numbered chat replies have several empty lines between short items, making a six-option response unnecessarily tall.

## Repro

Boot the seeded app and render a reply through Chat.renderProse with an introduction, six numbered items separated by blank lines, and concluding paragraphs. Inspect list count and adjacent item rectangles in the visible COMMS transcript.

## Evidence

Owner screenshot supplied 2026-09-22. Live seeded source reproduction on port 8972: six separate ordered lists, 76.5625px gaps, 780.53125px total height. After repair: one ordered list, six items, 4.125px gaps, 321.796875px total height at the same viewport. Local receipts: .dogfood/chat-spacing/before.json and after.json. Registered regression anchor: test/chat-code-copy.test.js.

## Verdict

The parser closed lists at blank lines and joined block HTML with literal newlines inside a pre-wrap container, combining whitespace rows with block margins. Repair groups loose lists and emits explicit paragraph blocks without synthetic boundary newlines. Installed desktop verification and owner recovery remain unconfirmed.

## Regression

test/chat-code-copy.test.js covers blank-separated ordered and nested lists, paragraph boundaries, mixed list types, CRLF, exact code whitespace, escaping and source-preserving copy. Before the repair, the loose-list scenario produces three lists and synthetic newline rows; after it produces one list and explicit paragraphs. Live nested-list, table, quote and code checks passed.

## Sibling coverage

{
  "adapters": [{"target":"provider-independent renderer","state":"covered","test":"test/chat-code-copy.test.js","scenario":"loose and nested Markdown list rendering","gate":"fast"}],
  "entrypoints": [{"target":"streamed and restored public prose renderer","state":"covered","test":"test/chat-code-copy.test.js","scenario":"public prose renderer list markers and source-preserving copy","gate":"fast"}],
  "displays": [{"target":"seeded desktop-width browser","state":"blocked","reason":"Live source DOM proof recorded locally; installed desktop bundle is not rebuilt or verified."},{"target":"website mirror","state":"blocked","reason":"Renderer and stylesheet synchronized; deployed website is outside this source repair."}],
  "lifecycle": [{"target":"source-copy fidelity","state":"covered","test":"test/chat-code-copy.test.js","scenario":"message copy retains original source and exact fenced whitespace","gate":"fast"},{"target":"installed history after restart","state":"blocked","reason":"Shared renderer is repaired; installed restart acceptance remains for the release lane."}]
}
