# questions — every open question, in one sheet

A session parked on a choice box, an unreadable dialog or a question asked in prose is listed here,
answerable with no link at all. The sheet is the flat `QuestionsSheet.tsx` (its reasoning is in its
header comment), wrapped by `OpenQuestionsSheet.tsx`; the card it draws is `PromptAnswer.tsx`, whose
rules are in the `web-term` skill.

**Owns**: no state. Everything rendered is already on the device — the session list (snapshotted by
App on every update) and the send queue — so the sheet paints identically online and off, and says
how old what it shows is (`SNAP_AT_KEY`). `actions.ts`: `ackAsking` (retire a prose question
without typing anything).

**Sheet**: `questions` (not persisted). **Messages**: none. Opened by the launcher's "N waiting" chip
and the toolbar (`setOverlay("questions")`). **Who is listed is not this sheet's call**: its rows are
`attentionCut(…, "wait", …)` (`src/attention.ts`) over every session and the launcher's visibility rule
— the call that chip counts with — so the chip's number and the cards are one array; `waitShapes`
only partitions them into the three card shapes. When it hides some (hidden or unfocused repos) it
says "n of N" above the cards, with *show all*.

**Reads from core**: `world.sessions`, `world.backends`, `world.cwdVisible`, `useQueueEntries()` (so an already-answered question says so
rather than inviting a duplicate keystroke), `queue.answerPrompt`, `conn.status/liveSend`,
`nav.attach/close`.

**Rules that apply**: an answer goes through `queue.answerPrompt` ONLY — durable, fingerprinted,
refused host-side once the box is gone; there is no second answer path. `session.ackAsking` is
live-only and never queued: an acknowledgement delivered when the tunnel returns speaks for a
screen nobody is looking at any more.

**Exports for App**: none — the manifest only.

**Tests**: `src/attention.test.mjs` (the bucket and the cut the chip and this sheet share); e2e: `scripts/e2e-answer.mjs`,
`scripts/e2e-askbox.mjs`.
