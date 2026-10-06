# sessionBudget

A cap on what ONE session may spend, subagents included — tokens, dollars, or a share of the
5-hour or weekly window. The sheet sets, changes and clears it and says what it is doing now; the
host computes the verdict and the phone only draws it. The wording is `@waterplane/shared`'s
`sessionbudget.ts` (`sessionBudgetText`, `sessionBudgetChip`, `sessionBudgetLabel`,
`sessionBudgetUnknownText`) and is never re-worded here. **Unknown never holds anything**: a chip that
says `budget ? — <why>` ends, in its sheet, on "nothing is held".

**Owns**

- `SessionBudgetSheet.tsx` — the sheet, `sessionBudget` (an Overlay literal in `routing.ts`, not persisted: its subject is held in memory), not persisted. Subject: the
  session the door was opened for, else the attached one, else null (the screen underneath paints).
- `actions.ts` — `setSessionBudget(sid, budget | null)`: `session.budget.set` through `conn.liveSend`
  (live only — idempotent and not durable; offline it is refused in words, never queued). Its toast
  says the desktop was ASKED; the sheet says "set"/"cleared" only when a `session.updated` carries
  the cap back (`budgetConfirmed`), and says so in text if none does — an older host ignores the frame.
- `logic.ts` — `budgetTagFacts` (the chip: ok / over / unknown), `budgetStateLine`, `budgetToast`,
  `shouldNoticeBudget` (one toast per session per crossing; leaving over re-arms), `budgetSubject`.
- Track ids: `overlay:sessionBudget`, `action:sessionBudget.set`, `action:sessionBudget.clear`.

**Lives top-level, deliberately** (a top-level module may not import a feature, and four callers that
are not this feature draw these):

- `BudgetField.tsx` + `budgetInput.ts` — the one field (unit `.segmented`, the number with its unit
  beside it, quick picks, `SetSwitch` for the interrupt) and `parseBudgetInput`; drawn here, and
  collapsed behind a `budget…` chip in the Send sheet and the launch ask. Given a live session's spark
  it says what was spent so far in the chosen unit, split by subagents (`budgetSpentLine`), and puts
  the typed cap against it (`budgetPreview`).
- `sessionBudgetDoor.ts` — `budgetSid` and `openSessionBudget(sid | null)`, called by the header chip,
  the row chip and the context sheet's panel.

**Where else it shows up**: `core/sessions/tags.tsx` `budgetTag` (header + launcher row),
`ContextSheet.tsx` (a panel after the cost panel), `core/queue` (`budgetHeldLanes` — a held lane waits;
armed sends, answers and uploads still go; the over → ok edge flushes), `core/session/useCostNotices.ts`
(the toast), `Backlog.tsx` (`budget ≤ $2` chip), `SendSheet.tsx`/`LaunchAskSheet.tsx` (the field).

**Reads from core**: `world.sessions/active/sessionRowTitle`, `conn.liveSend`, `nav.open/close`,
`say.track`.

**Tests**: `logic.test.mjs`, and `../../budgetInput.test.mjs` for the parse.
