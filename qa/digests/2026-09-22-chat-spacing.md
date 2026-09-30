# Chat reply spacing — 2026-09-22

Source repair: `6fa1477db`; verification candidate: `a6d1b3023` on `agent/chat-spacing-0922`.

Owner reported oversized gaps in a six-item numbered chat response. The renderer split blank-separated items into separate lists and emitted literal boundary newlines under `white-space: pre-wrap`, adding empty line boxes to CSS margins.

The repair keeps loose lists together, preserves nested list ownership across blank lines, groups prose into explicit paragraphs, and gives headings and paragraphs controlled margins. Fenced whitespace, original-source copying and escaped rendering remain intact. The website source mirror matches. No provider, prompt, persistence or shared-contract changes.

## Live source evidence

Seeded app at port 8972, production `Chat.renderProse` mounted in COMMS, deterministic sample matching the reported structure:

| Measurement | Before | After |
| --- | --- | --- |
| Ordered lists / items | 6 / 6 | 1 / 6 |
| Empty gap between items | 76.5625 px | 4.125 px |
| Total sample height | 780.53125 px | 321.796875 px |

Incremental rendering at 420px and 1000px panel widths retained one list, six items, exact original source, and no horizontal overflow. Nested lists, tables, quotes and exact code indentation/blank lines passed. Local raw receipts and driver: `.dogfood/chat-spacing/{before.json,after.json,live.mjs}`. This exercises source rendering with fixture text, not a paid provider run or installed binary.

## Validation

- JavaScript syntax and diff whitespace checks passed.
- Focused renderer regression: 69 assertions passed.
- Customer journeys: 38/38 steps passed (`.dogfood/chat-spacing/journeys.log`).
- Initial fast run exposed the expected stale frontend byte lock; reviewed and refreshed only the source snapshot and two file hashes using the repository utility. Claim verdicts were preserved. Final full-gate result recorded below.
- Full `npm run test:fast` on committed candidate `a6d1b3023`: **844/844 steps passed** (`.dogfood/chat-spacing/fast-final.log`).

No integration merge, installer rebuild, deployment or customer-recovery claim. Owner report: `a9862eb0`; installer unverified, recovery unconfirmed.

## Output polish follow-up

The owner's preview review prompted a narrow follow-up: plain multi-paragraph replies now use the same explicit paragraph spacing as formatted replies, and bold list labels receive actual weight and a small gap before their descriptions. The existing Markdown block structure and copy behavior remain unchanged. Source commit `f6fe79d21`; source lock `c802381ea`.

The seeded local browser preview showed improved list-label hierarchy and compact plain paragraphs. The public renderer regression passed 75 assertions, including LF, CRLF and whitespace-only paragraph breaks. Final `npm run test:fast` passed **844/844** (`.dogfood/chat-spacing/fast-polish-final.log`); `npm run qa:customer-journeys` passed **38/38** (`.dogfood/chat-spacing/journeys-polish.log`). Temporary local preview pages were mirrored solely so the website-sync check could inspect the checkout. They are untracked development artifacts and are not part of the source commits.
