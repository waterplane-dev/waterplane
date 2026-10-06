/**
 * Which slash commands `claude` handles entirely inside its own TUI — a view, a
 * picker, a settings toggle.
 *
 * **Why this is in `shared` and not in the host.** Both ends need the same
 * answer for opposite reasons, and while only the host had it the phone could
 * not ask the one question that mattered: *is this a command, or is this a
 * view?*
 *
 *  - the HOST needs it because these never submit a prompt, so `UserPromptSubmit`
 *    never fires and no turn ever starts: `deliver.ts` must not wait for (or
 *    hammer Return trying to produce) a turn-start proof that cannot arrive.
 *    The extra Returns land in the view the command just opened and dismiss it.
 *  - the PHONE needs it because a view is not an interjection. Prose typed at a
 *    working agent is a deliberate interjection and goes in at once, which is
 *    exactly right for prose and exactly wrong for this: a local command opens a
 *    MODAL over a session that is mid-turn, contests the composer that turn is
 *    using, and is then dismissed by the next thing that touches the screen.
 *    Reported from a phone as `/usage` followed by the CLI's own
 *    *"Settings dialog dismissed"*, with the session 22 minutes into a turn —
 *    and, from the other side, as a delivery that sat at "Sending… 10s" holding
 *    the composer while the agent streamed underneath it.
 *
 * Positive list on purpose. Anything not named here — `/init`, `/compact`,
 * `/review`, every custom `.md` command — really does start a turn and keeps the
 * normal delivery contract.
 */
const LOCAL_ONLY = new Set([
  // `usage` is the command; `cost` and `stats` are aliases the CLI still
  // answers to (its own table reads `{ name: "usage", aliases: ["cost",
  // "stats"] }`), which is why its menu entry draws as "/usage (cost)".
  "/usage", "/cost", "/stats",
  "/context", "/status", "/todos", "/help", "/release-notes",
  "/config", "/model", "/output-style", "/statusline", "/vim", "/terminal-setup",
  "/agents", "/mcp", "/hooks", "/permissions", "/sandbox", "/add-dir",
  "/resume", "/rewind", "/clear", "/export", "/memory", "/bashes",
  "/remote-control", "/ide", "/upgrade", "/bug", "/feedback",
  "/privacy-settings", "/login", "/logout",
]);

/** True when `text` is one of the TUI-local commands above (args ignored).
 *  **Not the same question as "does this start a turn"** — see `startsNoTurn`. */
export function isLocalCommand(text: string): boolean {
  return LOCAL_ONLY.has(text.trim().split(/\s+/)[0] ?? "");
}

/**
 * Commands that SUBMIT and still start no turn.
 *
 * **A third category, and `/btw` is the whole of it so far.** The set above is
 * "this opens a view"; an ordinary prompt is "this starts a turn". `/btw` is
 * neither: it takes the composer's words, files them as a note for the agent to
 * read at the end of the turn, clears the box — and never fires
 * `UserPromptSubmit`. Every proof `deliver.ts` rests on for a prompt is
 * therefore unavailable, and the failure is not subtle: the submit loop pressed
 * Return five times waiting for a turn that cannot start, asked the conversation
 * log (silent for a slash command by construction — `transcript.ts` measured
 * `/btw` as writing NOTHING at all, not even an envelope), and filed the note as
 * `unsubmitted`. Reported from a phone as a red row reading "it is sitting in
 * the composer, unsent — do not retype it", about a note that had been filed
 * perfectly.
 *
 * **Why it is not simply added to `LOCAL_ONLY`.** That list is also what the
 * PHONE reads to decide a command is a view and must be held until the turn
 * ends — and `/btw` exists precisely to be said to a working agent without
 * interrupting it. Holding it until idle would defeat the only thing it is for.
 * So the host's question ("what proves this landed?") and the phone's question
 * ("is this an interjection or a modal?") stop being the same question here,
 * and each asks its own.
 */
const NO_TURN_ONLY = new Set(["/btw"]);

/**
 * True when `text` starts no turn — a TUI-local view, or one of the commands
 * above that submits and files something instead. **This is the host's
 * question**: what `deliver.ts` may wait for as proof of delivery. The phone's
 * question is `isLocalCommand`, which is narrower on purpose.
 */
export function startsNoTurn(text: string): boolean {
  const head = text.trim().split(/\s+/)[0] ?? "";
  return LOCAL_ONLY.has(head) || NO_TURN_ONLY.has(head);
}

/**
 * Commands that SUBMIT, do REAL work for minutes, and announce NONE of it.
 *
 * **The fourth category, and `/compact` is the whole of it.** It is not a view
 * (`LOCAL_ONLY`) and it is not a filing clerk (`NO_TURN_ONLY`): the Return runs
 * a real, expensive operation — "Compacting conversation… (35s) 32%" for as
 * long as it takes — and fires neither `UserPromptSubmit` nor `Stop`. Every
 * rung of `deliver.ts`'s submit ladder is therefore unavailable: no turn-start
 * hook, no Stop counter moving, and nothing in the conversation log (the CLI
 * writes a slash command as an envelope the transcript reader drops).
 *
 * So a `/compact` that had provably started — the phone's own screenshot shows
 * "✳ Compacting conversation… 15%" in the terminal — came back as *"typed, but
 * Return was swallowed — open the session and press Return"*, the one sentence
 * this app writes to be acted on by hand. Pressing that Return again is at best
 * a no-op and at worst a second compaction of a conversation that just lost its
 * history.
 *
 * **The proof that fits is the one the host already takes for this command**:
 * the CLI's own working line, read off the screen (`shared/working.ts`, the one
 * matcher) and published as a turn marked `fromScreen`. `deliver.ts` refuses
 * that evidence for an ordinary prompt on purpose — a spinner the host inferred
 * says the CLI is busy and says nothing about a Return, because a `/compact`
 * started before the delivery paints exactly the same line. Here the command IS
 * the `/compact`, the session was idle before the keystroke, and the spinner
 * appearing is the only thing that could have produced it.
 *
 * Kept apart from the two sets above because the phone reads those for its own
 * question. A `/compact` is not a modal to be held until idle, and it is not a
 * note to be slipped into a live turn; it is an ordinary submit whose receipt
 * has to be read somewhere else.
 */
const NO_HOOK_WORK = new Set(["/compact"]);

/**
 * True when `text` submits and starts work that fires no hook — the HOST's
 * third question, asked only by the submit ladder. Neither `isLocalCommand`
 * (the phone's "is this a modal?") nor `startsNoTurn` (the host's "is there a
 * turn to wait for at all?") answers it: there IS a turn's worth of work here,
 * and nothing announces it.
 */
export function worksUnannounced(text: string): boolean {
  return NO_HOOK_WORK.has(text.trim().split(/\s+/)[0] ?? "");
}

/**
 * `/fork [title]` — the one command the HOST answers instead of the CLI.
 *
 * **The fifth category, and the only one that is never typed.** From 2.1.291 a
 * `/fork` typed into the TUI no longer forks in place: the CLI hands the branch
 * to its OWN background daemon (`~/.claude/daemon.log`: `bg claimed-spare …
 * (slash)`, a job under `~/.claude/jobs/`) and prints `⎿ session waiting ·
 * <title>`. That session runs in no tmux this host owns, so the phone never
 * lists it, and its `SessionStart` hook lands on `/api/hook` as an unknown
 * session and is dropped — a fork asked for from the phone that the phone can
 * never see. So the host intercepts it (`routes/session.ts`) and opens the fork
 * itself, as a tab, through the same `sessions.fork()` the toolbar's *fork*
 * button uses (`--resume <id> --fork-session`).
 *
 * Returns `null` when `text` is not a `/fork`, else the title argument — one
 * line, whitespace collapsed, capped — and `""` when there is none. A command
 * NAMED like it (`/forked`, `/fork-it`) is not it.
 */
export function slashForkTitle(text: string): string | null {
  const m = /^\/fork(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return (m[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}
