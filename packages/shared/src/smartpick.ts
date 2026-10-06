/**
 * The look a repo takes over its own waiting items before one of them fires.
 *
 * ── The three verbs, and nothing else ──────────────────────────────────────
 *
 * When a repo's *smart pick* tick is on, the moment its next automatic backlog
 * item would fire the host first buys one cheap unattended completion over that
 * repo's remaining items, and the answer may do exactly three things: **pick**
 * which one runs next, **merge** items that are one job into a single item, and
 * **sort** the rest. Not "drop what is already done", not "split what is too
 * big" — those were asked for and declined, and a fourth verb added here is a
 * fourth way for a model to rewrite somebody's list.
 *
 * ── What is in this file, and what is deliberately not ─────────────────────
 *
 * Everything here is pure: `cleanSmartPick` reads what the model wrote,
 * `applySmartPick` turns a surviving proposal into a PLAN, `smartpickFingerprint`
 * says whether anything has changed since the last look, and
 * `smartpickOutcomeText` says what happened in the words the strip shows. No
 * filesystem, no `Date.now()`, no host imports — `assess.ts`'s posture, for
 * `assess.ts`'s reason: the whole rule set is then pinnable from literals by
 * `packages/shared/test/smartpick.test.mjs` in milliseconds, with nothing
 * spawned and no daemon booted, which is what lets the rules be settled before
 * there is anything that can run them.
 *
 * **A pass produces a plan and never a mutation.** CLAUDE.md's *nothing applies
 * itself* is knowingly excepted for this feature — the user chose, with the
 * trade-off spelled out, that all three verbs apply with no approval step — but
 * the SPLIT still belongs in the code: this module decides, the host writes. A
 * proposal that never reaches the host changes nothing, and there is exactly one
 * function that turns a proposal into work.
 *
 * ── The two rules that are not negotiable ──────────────────────────────────
 *
 * **Nothing here invents an item, and nothing here loses one.** Every id the
 * model names is checked against the candidates it was given; an id that is not
 * there is DROPPED with a note, never spawned as a row. An item the model failed
 * to mention keeps its place rather than vanishing. And a merged text has to
 * name every transport path (`.claude/inbox/…`, `.claude/outbox/…`) and every
 * image path that any member named — a merged prompt that silently loses
 * `.claude/inbox/foo.png` is a prompt that will tell an agent to look at a file
 * it was never handed, so the group is dropped rather than repaired.
 *
 * **A hand-placed row is never moved.** `SmartPickCandidate.handOrdered` marks a
 * position a PERSON set by dragging. A drag is the one explicit act in the
 * backlog sheet and the whole of this feature is otherwise automatic; the sort
 * therefore places the machine's rows AROUND the hand-placed ones and never
 * through them (see `applySmartPick`).
 *
 * **A row with a CLOCK is pinned like a hand-placed one, is never the pick, and
 * merges only with a row on the IDENTICAL clock.** `SmartPickCandidate.atKey`
 * marks a row whose WHEN a person set as an instant — a one-off schedule, which
 * is an ordinary backlog row since recurrence and not trigger kind decides which
 * list a row lives in (`isTimedWorkRow`). A clock is a STRONGER statement than a
 * drag: a drag says where in the queue the work goes, a clock says when it may
 * run at all. So each verb meets it differently and each refusal is a sentence:
 *
 *  • **sort** — the GROUP's slots are its clock's. A timed row never moves past
 *    an item with a different clock or with none, which is the part pinned by
 *    exactly the mechanism `handOrdered` is pinned by. **Inside one clock the
 *    pass may sequence freely**: a person who queues seven items on one instant
 *    has said when they may run and nothing at all about which goes first, and
 *    on this desktop that was twelve live one-offs on one reset — seven in a
 *    single repo — running in the order they happened to be typed. A
 *    `handOrdered` member keeps its seat inside the group too: a drag is the
 *    stronger statement in there as well as out here.
 *  • **pick** — never. A timed row is not "next" because a model said so; its
 *    clock says when. A pick naming one is corrected to the first entity without
 *    a clock, and the note says that is what happened.
 *  • **merge** — only when every member carries the same `atKey` (all untimed,
 *    or all on the identical rule, grace and hold). Mixed, or two different
 *    clocks, is REFUSED: which of two times the merged row should carry is a
 *    guess, and CLAUDE.md's rule is that an ambiguous heuristic answers nothing
 *    rather than a wrong number. Twins on one clock merge into a row that
 *    CARRIES it (`SmartPickMergePlan.atKey`, which the host turns back into the
 *    trigger). The host-wide HOLD is asked separately and on the same terms
 *    (`holdForHost`), because the key only carries it for a row that has a
 *    clock and *drop the clock* leaves the hold behind on a row that has not.
 */

export { SMARTPICK_OUTCOMES } from "./smartpick/ssptypes.js";
export type { SmartPickCandidate, SmartPickMerge, SmartPickProposal, SmartPickOrder, SmartPickMergePlan, SmartPickPlan, SmartPickOutcome, SmartPickOutcomeFacts } from "./smartpick/ssptypes.js";
export { SMARTPICK_MAX_ITEMS, SMARTPICK_MAX_CHARS, MAX_SMARTPICK_MERGES, SMARTPICK_MAX_NOTES, SMARTPICK_MAX_WHY_CHARS, SMARTPICK_FIRED_AS_WAS, SMARTPICK_UNREADABLE, SMARTPICK_NOOP_TEXT, IMG_RE, TRANSPORT_RE, imagePaths, transportPaths } from "./smartpick/sspconst.js";
export { fingerprint, smartpickFingerprint } from "./smartpick/sspfinger.js";
export type { SmartPickFacts } from "./smartpick/sspfinger.js";
export { mergeKey, smartpickName, cleanSmartPick } from "./smartpick/sspclean.js";
export { applySmartPick } from "./smartpick/sspapply.js";
export { smartpickOutcomeText } from "./smartpick/sspwords.js";
