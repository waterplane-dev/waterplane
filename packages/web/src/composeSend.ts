/**
 * **What the compose bar's Send button does, in words.**
 *
 * The 90% case of this whole app is one line: type, tap Send, now. That control
 * had accumulated five answers — three MODES on a split button (`now`, `when
 * it's free`, `queue here`) and two ERRANDS that opened the Send sheet (`at a
 * time…`, `somewhere else…`) — and the three modes were not three decisions.
 * Two of them were the SAME decision with different holders: `when it's free`
 * parked the message on the phone (`holdUntilIdle`) and `queue here` handed it
 * to the desktop as a pinned work item. A person reading the strip had no way
 * to tell which one they had picked, because the difference was not about them:
 * it was about which machine remembered.
 *
 * So there are two modes and one errand now, and the words answer the one
 * sentence this app's vocabulary is built on — *some words, run in a place, at
 * a time*:
 *
 *  - **`Send`** — this session, now.
 *  - **`When free`** — this session, when it can take it. Held by the DESKTOP
 *    (a pinned item), so the phone may sleep, be reloaded, or lose the tunnel
 *    and the prompt still goes in. The cost is a tick's latency on a session
 *    that was already idle; that was weighed and accepted, because the phone
 *    holding it meant a locked screen never delivered anything.
 *  - **`keep it on the pad`** — the answer that is NOT a send. The words go to
 *    the prompt pad and NOTHING runs them: no trigger, no target, nothing
 *    `auto` can reach. This exists because the other two answers
 *    and the sheet all end in something that fires itself eventually — a
 *    backlog row is work somebody has decided to do, and an idea to reconsider
 *    or a bug to check once more by hand is not that yet. Filing it onto a
 *    backlog later is one tap in `PadSheet` (*file it*), made by a person.
 *  - **`elsewhere or later…`** — one errand, opening the one send surface with
 *    *To* and *When* pre-filled to what the button would have done. `at a
 *    time…` and `somewhere else…` were two doors into the same sheet differing
 *    only in which row they pre-expanded, which is not a choice worth a row in
 *    a menu this size.
 *
 * ── Why these strings live in a file of their own ───────────────────────────
 *
 * They were inline in `App.tsx`, which has no test, and they are the labels on
 * the control almost every send in this app goes through. A mode whose button
 * says one thing and whose toast claims another is not a type error and does
 * not throw — it is simply a lie about where somebody's words went, found weeks
 * later. `composeSend.test.mjs` pins every one of them.
 *
 * This is the ONLY extraction out of `App.tsx` made for this change.
 * `dispatchIntent` and `openSend` close over twenty of App's refs, so moving
 * them would be motion rather than grooming.
 */

/**
 * What the button will do with the next message.
 *
 * Remembered per repo (`sendMemory.ts`) — a run of prompts all aimed *when it's
 * free* is one decision, not one per message. The `waterplane.sendMode` that WAS
 * persisted turned Send into a schedule editor days after anybody chose that,
 * and the only way to find out was to tap it; what makes the memory safe is
 * that these are the only two answers it can hold, and `sendModeLabel` spells
 * both out on the button face. A clock is recalled onto the SEND SHEET, which
 * draws the rule, and never onto this control.
 */
export type SendMode = "now" | "idle";

/** What the button SAYS. One wording per mode, used on the button and in its
 *  title, so the armed choice is never only a highlighted menu row. */
export function sendModeLabel(m: SendMode): string {
  return m === "idle" ? "When free" : "Send";
}

export function sendModeTitle(m: SendMode): string {
  return m === "idle"
    ? "Hand it to the desktop and let it go in when this session is free — turn ended, no question open, no usage-limit block"
    : "Send to this session";
}

/**
 * What to say once it has gone, or null when the screen already says it.
 *
 * `now` says nothing: the composer emptying is the receipt, and the queue bar
 * underneath reports the delivery. `idle` must say something, because nothing
 * visible happens for as long as the turn runs — and it has to name the HOLDER,
 * since that is the whole difference between the two shapes a wait can take
 * here and the one fact a person needs in order to know whether closing the app
 * is safe.
 */
export function sendModeToast(
  m: SendMode,
  o: {
    online: boolean;
    holder: "desktop" | "phone";
    /**
     * WHY the phone is holding it, when it is. Two different cases with two
     * different promises, and telling them apart matters because one of them
     * ends with "leave the app open" and the other does not: a prompt behind a
     * session that has not opened yet goes in as soon as that create acks,
     * while a TUI-local command has to be typed by this tab at the end of the
     * turn. Ignored when the holder is the desktop.
     */
    phoneHold?: "session-not-open" | "opens-a-view";
  },
): string | null {
  if (m === "now") return null;
  if (o.holder === "phone") {
    // A command that opens a VIEW starts no turn, so there is nothing for a
    // host-side work item to settle on. This tab keeps that one wait.
    if (o.phoneHold === "opens-a-view") {
      return o.online
        ? "held on this phone — it opens a view rather than starting a turn, so it goes in when this turn ends. Leave the app open"
        : "held on this phone — it goes in when the link is back and this turn has ended. Leave the app open";
    }
    // The other case the desktop cannot hold: a prompt chained behind a session
    // that does not exist yet. There is no session id for a pinned item to name
    // until the create is acked, so the create's own lane is the queue.
    return o.online
      ? "queued — it runs in this session when it opens"
      : "queued — the session opens and runs this when the link is back";
  }
  return o.online
    ? "queued on the desktop — it goes in when this session is free"
    : "queued — it reaches the desktop when the link is back, and goes in when this session is free";
}

/**
 * What to say when words go to the pad instead of anywhere that runs them.
 *
 * It has to name the two facts a person cannot see from the composer emptying:
 * that nothing will fire it, and where it went — the pad has no strip on this
 * screen, so a note that lands silently is a note nobody finds again.
 */
export const PAD_KEPT_TOAST =
  "kept on the pad — nothing runs it; open the pad to send it or file it onto a backlog";

/** Tapped with an empty box. A sentence, not a dimmed row (`Unavailable.tsx`):
 *  the pad keeps words and there are none. */
export const PAD_EMPTY_TOAST = "nothing in the box to keep — the pad holds words, and there are none yet";

/** Which lucide icon a menu row draws. A key, not a component: this file is
 *  pure and node-tested, and importing React into it would end that. */
export type ComposeMenuIcon = "send" | "hourglass" | "elsewhere" | "pad";

export interface ComposeMenuEntry {
  key: "now" | "idle" | "pad" | "elsewhere";
  label: string;
  title: string;
  icon: ComposeMenuIcon;
  /**
   * The mode this row ARMS, or null for a row that does something instead of
   * arming the button. Two rows are null now, so the caller switches on `key`:
   * `pad` keeps the words, `elsewhere` opens the send sheet.
   */
  mode: SendMode | null;
}

/**
 * The chevron's menu: two modes, one place to keep words, and one errand.
 *
 * Deliberately a function returning a fresh array rather than a constant — the
 * component maps it to JSX on every render and a frozen module-level array
 * shared across renders is the kind of thing that grows a mutation later.
 */
export function composeMenu(): ComposeMenuEntry[] {
  return [
    {
      key: "now", label: "now", icon: "send", mode: "now",
      title: "type it into this session straight away",
    },
    {
      key: "idle", label: "when it's free", icon: "hourglass", mode: "idle",
      title: "the desktop holds it and types it in when this session can take it — turn ended, no question open, no usage-limit block",
    },
    {
      key: "pad", label: "keep it on the pad", icon: "pad", mode: null,
      title: "park the words on the pad — nothing runs them, no backlog, no trigger; you decide later whether they go anywhere",
    },
    {
      key: "elsewhere", label: "elsewhere or later…", icon: "elsewhere", mode: null,
      title: "a different session, a new one, several repos — or at a time",
    },
  ];
}

// ── WHERE the next message runs ──────────────────────────────────────

/**
 * **Which session the words go into — the decision the strip never asked.**
 *
 * The menu above answers WHEN (`now` / `when it's free`) and offers one errand
 * out to the send sheet. WHERE was not a question at all: every row in it aimed
 * at the session on screen, and the only route to a fresh one was *elsewhere or
 * later…*, a sheet with four rows and its own button. So "ask this in a clean
 * window" — the commonest reason to send anywhere else, and the one
 * `sessioncost.ts` exists to argue for — cost five taps and a screen change,
 * while "carry on here" cost none. A decision that expensive on one side is not
 * a decision people make; it is one they stop taking.
 *
 * Three answers, the same three the send sheet's *To* row offers minus the
 * sweep (which is not a thing the compose bar can be honest about in one line):
 *
 *  - **`this`** — the conversation on screen. The default, always.
 *  - **`new`** — a fresh session in this repo. Nothing of this conversation
 *    comes with it, which is the whole point: the window it would inherit is
 *    what every later turn pays for again.
 *  - **`other`** — one of the sessions already running. Needs a pick, and the
 *    strip draws the list; with nothing picked the send REFUSES in words rather
 *    than quietly falling back to the session on screen, which would be a
 *    different answer to the question somebody asked.
 *
 * ── Why this is allowed to be remembered, when a clock is not ───────────────
 *
 * `sendMemory.ts` recalls `this` and `new` per repo and never `other` (that one
 * names a per-boot session id — the same reason a chain is never recalled). The
 * rule that makes the memory safe is the one the deleted `waterplane.sendMode` broke:
 * an armed answer must SAY itself before it is tapped. A mode does that on the
 * button face; this one cannot fit there beside it, so it says itself on a line
 * of its own above the composer (`composeAimNote`), which is on screen for as
 * long as the aim is not the session you are looking at, and carries the one
 * tap that puts it back.
 */
export type SendWhere = "this" | "new" | "other";

export interface ComposeWhereEntry {
  key: SendWhere;
  label: string;
  title: string;
}

/** The lead above the three segments. Present tense and about the WORDS, not
 *  about the button: the toggle applies to every row under it, including the
 *  two that do not send now and the one that sends nothing at all. */
export const WHERE_LEAD = "Runs in";

export function composeWhere(): ComposeWhereEntry[] {
  return [
    {
      key: "this", label: "this session",
      title: "the conversation on screen — it already knows what you have said in it, and every turn pays for that whole window again",
    },
    {
      key: "new", label: "a new session",
      title: "open a fresh session in this repo and run it there — none of this conversation comes with it, which is what makes it cheaper",
    },
    {
      key: "other", label: "another open session",
      title: "one of the other sessions running right now — pick which one below",
    },
  ];
}

/** What one answer is called outside the toggle — a title, a toast, a hint. */
export function sendWhereLabel(w: SendWhere): string {
  return composeWhere().find((e) => e.key === w)?.label ?? "this session";
}

/**
 * **The line above the composer that stops a remembered aim being invisible.**
 *
 * Null for `this`, because the screen already says it: the session you are
 * looking at is the session it goes to. For the other two it is a whole
 * sentence, not a badge — the fact that matters is the NEGATIVE one ("not the
 * conversation on screen"), and a badge cannot say a negative.
 *
 * `sessionName` is the session `other` names, when one is picked. Absent, the
 * line says the aim is incomplete rather than naming a session at random; the
 * send refuses on the same fact.
 */
export function composeAimNote(
  w: SendWhere,
  o: { repoName: string; sessionName?: string | null },
): string | null {
  if (w === "this") return null;
  if (w === "new") {
    return `Send opens a NEW session in ${o.repoName || "this repo"} — not the conversation on screen.`;
  }
  const name = (o.sessionName ?? "").trim();
  return name
    ? `Send goes to ${name} — not the conversation on screen.`
    : "Send is aimed at another session and none is picked — choose one under the chevron, or aim it back here.";
}

/** The one tap that puts the aim back on the session you are looking at. */
export const AIM_HERE_LABEL = "aim it here";

/** Tapped with `other` armed and nothing picked. A sentence, never a dimmed
 *  Send: the words stay in the box and the reason is said out loud. */
export const WHERE_UNPICKED_TOAST =
  "no session picked — choose one under the chevron, or aim it back at this session";

/** The picked session has gone while it was armed. The aim falls back to the
 *  session on screen and SAYS so, rather than sending somewhere nobody chose. */
export function whereGoneToast(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return `${n ? `“${n}”` : "that session"} has closed — nothing was sent, and the aim is back on this session`;
}

/**
 * **The primary button's title, restating the WHOLE decision.**
 *
 * The face can only carry the mode (`sendModeLabel`), so the title is where the
 * two answers are put back together. It exists for the same reason the aim line
 * does: an armed answer that says nothing until it is tapped is the bug the
 * per-repo send mode was deleted for.
 *
 * *when it's free* over a fresh session is worded **when this repo is free** —
 * one clause for that wait, the same one the send sheet's button, its toast and
 * its hint use. A session is free when its turn ends; a repo is free when
 * nothing is running in it, and they are not the same wait.
 */
export function sendButtonTitle(m: SendMode, w: SendWhere, sessionName?: string | null): string {
  if (w === "this") return sendModeTitle(m);
  if (w === "new") {
    return m === "idle"
      ? "Open a fresh session in this repo and run it there when this repo is free — not the conversation on screen"
      : "Open a fresh session in this repo and run it there — not the conversation on screen";
  }
  const n = (sessionName ?? "").trim() || "another open session";
  return m === "idle"
    ? `Hand it to the desktop and let it go in when ${n} is free — not the conversation on screen`
    : `Send it to ${n} — not the conversation on screen`;
}

/**
 * **Send tapped while this session's turn is still running.**
 *
 * The split button's `When free` is the answer to that, and it was too often
 * missed: a plain Send mid-turn types the words into the running turn, which is
 * sometimes wanted (steering it) and often not (the next task, typed while
 * waiting). So the plain button ASKS — only then, only for the button's own
 * `now` (a one-tap verb that names its mode has already answered), only aimed
 * at this session, and never for a session that is still opening or a command
 * the phone holds for the turn's end anyway.
 *
 * `BusySend` is the remembered answer: `""` asks, `now`/`idle` is "don't ask
 * again" with that answer. Settings › Writing & reading puts it back.
 */
export type BusySend = "" | "now" | "idle";

export function busySendRoute(o: {
  how: SendMode;
  /** The caller named the mode for THIS send (not the button's armed one). */
  explicit: boolean;
  aimedHere: boolean;
  turnActive: boolean;
  pending: boolean;
  localCmd: boolean;
  pref: BusySend;
}): SendMode | "ask" {
  if (o.how !== "now" || o.explicit || !o.aimedHere || !o.turnActive || o.pending || o.localCmd) return o.how;
  return o.pref === "" ? "ask" : o.pref;
}

export const BUSY_SEND_ASK = {
  title: "This session is still working",
  lines: [
    "Send now: the words go into the running turn straight away.",
    "When it's free: the desktop holds them and sends them once this turn ends.",
    "Tap outside to keep the words in the box.",
  ],
  confirmLabel: "Send now",
  cancelLabel: "When it's free",
  rememberLabel: "don't ask again",
} as const;

/**
 * **The ask, with the usage budget's way past it — only while the budget is
 * holding automatic work.** *When it's free* is a desktop work item, and over
 * budget that item waits for the window to reset, not for this turn. The third
 * answer lets THIS prompt past the budget (the host's waiver, `pastBudget` on
 * `backlog.add`), never the budget for everything. Not drawn under the budget:
 * there is nothing to lift, and a button that would change nothing is noise.
 * "Don't ask again" ticked with it remembers *when it's free* alone — a waiver
 * is a decision about one prompt, never a standing one.
 */
export const BUSY_PAST_BUDGET_LABEL = "When it's free, past the budget";
export function busySendAsk(budgetNote: string | null): {
  title: string; lines: string[]; confirmLabel: string; cancelLabel: string; rememberLabel: string; altLabel?: string;
} {
  if (!budgetNote) return { ...BUSY_SEND_ASK, lines: [...BUSY_SEND_ASK.lines] };
  const [now, idle, outside] = BUSY_SEND_ASK.lines;
  return {
    ...BUSY_SEND_ASK,
    lines: [
      now,
      `${idle} The usage budget holds it after that: ${budgetNote}.`,
      "When it's free, past the budget: the same, but this prompt does not wait for the budget.",
      outside,
    ],
    altLabel: BUSY_PAST_BUDGET_LABEL,
  };
}
/** The receipt for the third answer — what it lifted and what it did not. */
export function busyPastBudgetToast(online: boolean): string {
  return online
    ? "queued past the budget — the desktop sends it once this turn ends"
    : "queued past the budget — it reaches the desktop when the link is back, then goes in once this session is free";
}

/** Said once, when "don't ask again" was ticked — names the way back. */
export function busySendRememberedToast(m: SendMode): string {
  return m === "idle"
    ? "won't ask again — Send on a working session now waits until it is free; Settings › Writing & reading › Send while it works changes it"
    : "won't ask again — Send on a working session now goes straight in; Settings › Writing & reading › Send while it works changes it";
}
