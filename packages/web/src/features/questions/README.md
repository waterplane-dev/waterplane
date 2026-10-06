# questions — every open question, in one sheet

A session parked on a choice box, an unreadable dialog or a question asked in prose is listed here,
answerable with no link at all. The sheet is the flat `QuestionsSheet.tsx` (its reasoning is in its
header comment), wrapped by `OpenQuestionsSheet.tsx`; the card it draws is `PromptAnswer.tsx`, whose
rules are in the `web-term` skill.

**Owns**: no state. Everything rendered is already on the device — the session list (snapshotted by
App on every update) and the send queue — so the sheet paints identically online and off, and says
how old what it shows is (`SNAP_AT_KEY`). `actions.ts`: `ackAsking` (retire a prose question
without typing anything).

**Sheet**: `questions` (not persisted). **Messages**: none. Opened by App's launcher chip and the
toolbar (`setOverlay("questions")`), unchanged.

**Reads from core**: `world.sessions`, `useQueueEntries()` (so an already-answered question says so
rather than inviting a duplicate keystroke), `queue.answerPrompt`, `conn.status/liveSend`,
`nav.attach/close`.

**Rules that apply**: an answer goes through `queue.answerPrompt` ONLY — durable, fingerprinted,
refused host-side once the box is gone; there is no second answer path. `session.ackAsking` is
live-only and never queued: an acknowledgement delivered when the tunnel returns speaks for a
screen nobody is looking at any more.

**Exports for App**: none — the manifest only.

**Tests**: pure logic lives in `QuestionsSheet`/`PromptAnswer`; e2e: `scripts/e2e-answer.mjs`,
`scripts/e2e-askbox.mjs`.
