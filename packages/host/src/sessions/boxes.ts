/**
 * The choice box, ANSWERED: the one answer dispatcher (`answerBox`), the two
 * walks that place a selection before pressing Return (`choosePromptBox`,
 * `chooseClaudeNavBox`) and the checkbox Submit row (`submitPromptBox`).
 * Reading and publishing the box is `boxread.ts`. Stateless — every per-session
 * fact lives on the `Session` record.
 */
import { answerTextProblem, type PluginScreenBox, type SourceKeys, type SourceQuestion, type SourceTyped } from "@waterplane/shared";
import { answerSourcePlan, applySourceReply, type SourceReplyDeps } from "../sourceanswer.js";
import { screenReaderFor } from "../backends/readers.js";
import { derive } from "../backends/derive.js";
import { navToSubmit, readNavBox } from "../prompt.js";
import { rememberRule, sessionAskRules } from "../answergate.js";
import type { SessionCore } from "./core.js";
import { healthTail, pause, safe } from "../boxkit.js";
import { SUBMIT_NAV_TRIES, SUBMIT_NAV_MAX_KEYS, SUBMIT_NAV_LINES, SUBMIT_NAV_SETTLE_MS, CHOOSE_NAV_TRIES, CHOOSE_NAV_SETTLE_MS, PROMPT_CELL_ROWS, HEALTH_SAMPLE_ROWS } from "./knobs.js";

/**
 * Answer an unnumbered box by placing the selection on the option the user
 * named, and only then pressing Return.
 *
 * The claude path sends the option's digit, which is a complete answer in one
 * keystroke. There are no digits here: the options are three words on a row
 * and the only thing that decides what Return does is which one is armed. So
 * this is `submitPromptBox()`'s loop with a different target — walk, RE-READ,
 * walk again — and the same reason for re-reading rather than counting: how
 * many options there are, whether the ends wrap and whether a keystroke was
 * swallowed by a repaint are all upstream details, and the screen is the only
 * thing that knows.
 *
 * **It refuses rather than guessing.** If the box stops being readable, or the
 * armed option never becomes the one that was asked for, no Return is pressed
 * and the receipt says so. A Return on the wrong row here is "Allow always" on
 * a command nobody approved — this is the failure the capability was false for
 * three months to avoid, and the walk existing does not make it acceptable to
 * fall back to a bare Return the way a checkbox box can.
 */
export async function choosePromptBox(core: SessionCore, id: string, choice: number): Promise<{ ok: boolean; reason?: string }> {
  const s = core.sessions.get(id);
  if (!s || !s.info.running) return { ok: false, reason: "session not available" };
  const reader = screenReaderFor(s.backend);
  if (!reader) {
    if (derive(s.backend).screen("dialogs") === "claude-numbered" && s.info.prompt?.nav) return chooseClaudeNavBox(core, id, choice);
    return { ok: false, reason: "this backend's boxes are answered with a keystroke, not a selection" };
  }
  let box: PluginScreenBox | null = null;
  for (let i = 0; i < CHOOSE_NAV_TRIES; i++) {
    const rows = await core.screenCells(id, PROMPT_CELL_ROWS);
    box = safe(() => reader.read(rows), null);
    if (!box) return { ok: false, reason: "that question is no longer readable on screen" };
    if (box.armed === choice) break;
    const b = box;
    const nav = safe(() => reader.navTo(b, choice), null);
    if (!nav) return { ok: false, reason: `this box has ${box.options.length} options, not ${choice}` };
    // One key per pass. Overshooting is not self-correcting the way a
    // checkbox walk is — the list WRAPS, so a repaint that swallowed a
    // keystroke and one that did not are two different rings — and a single
    // step re-read is cheap next to pressing Return on the wrong option.
    if (!core.input(id, nav.dir === "right" ? "\x1b[C" : "\x1b[D")) {
      return { ok: false, reason: "session not available" };
    }
    await pause(CHOOSE_NAV_SETTLE_MS);
  }
  if (!box || box.armed !== choice) {
    return { ok: false, reason: "could not place the selection on that option — answer it in the terminal" };
  }
  // Nothing is written to the audit log here, for the same reason the claude
  // answer path writes nothing: `sentlog.ts` records SENDS, and an answer to a
  // box is a keystroke aimed at a question the session already published. The
  // one exception in this file stays the exception — the usage-limit menu is
  // answered on the user's behalf and never shown, so the log is the only
  // place it is visible at all.
  return { ok: core.input(id, "\r") };
}

/**
 * The same walk for claude's own UNNUMBERED box (2.1.293's first-launch trust
 * box, `prompt.ts`'s `readNavBox`): the rows are a vertical list, so Up/Down
 * rather than Left/Right, one key per pass and a RE-READ between, and Return
 * only once the "❯" is on the option asked for.
 *
 * Not a digit, though the old numbered trust box took one: nothing measured
 * says a digit answers this box, and a digit that does not is a stray
 * character in the composer of the session it lets in. The arrows are what
 * the box's own footer offers.
 *
 * Refuses rather than guessing, as the reader's walk does — and also when the
 * box on screen no longer carries the label that was tapped at that index:
 * that is a different box, and "Yes" by position on it is a guess.
 */
async function chooseClaudeNavBox(core: SessionCore, id: string, choice: number): Promise<{ ok: boolean; reason?: string }> {
  const want = core.sessions.get(id)?.info.prompt?.options.find((o) => o.index === choice)?.label;
  let cursor = 0;
  for (let i = 0; i < CHOOSE_NAV_TRIES; i++) {
    const read = readNavBox(await core.screenText(id, 60));
    if (!read) return { ok: false, reason: "that question is no longer readable on screen" };
    const target = read.prompt.options.find((o) => o.index === choice);
    if (!target) return { ok: false, reason: `this box has ${read.prompt.options.length} options, not ${choice}` };
    if (want !== undefined && target.label !== want) {
      return { ok: false, reason: "the box on screen is not the one that was answered — answer it in the terminal" };
    }
    cursor = read.cursor;
    if (cursor === choice) break;
    if (!core.input(id, choice > cursor ? "\x1b[B" : "\x1b[A")) return { ok: false, reason: "session not available" };
    await pause(CHOOSE_NAV_SETTLE_MS);
  }
  if (cursor !== choice) {
    return { ok: false, reason: "could not place the selection on that option — answer it in the terminal" };
  }
  return core.input(id, "\r") ? { ok: true } : { ok: false, reason: "session not available" };
}


/**
 * **The one answer dispatcher** — every answer to a choice box goes through
 * here: the phone's tap (`routes/session.ts`, a digit, a `promptChoice`, typed
 * `promptText`) and anything the answer gate let through (`answergate.ts`, a
 * choice only — the gate never carries words). Three rungs, in order:
 *
 *  1. the box is a dialog, QUESTION or PLAN the CLI posed on its OWN channel ⇒
 *     answered there (`SourceDialog.answer(choice, {text})` — `text` only on a
 *     `takesText` row; `SourceQuestion.answer({choice, text})`; a plan's verb, a
 *     person's tap only, at most once), nothing typed into the PTY — unless the
 *     source hands back `{ keys }` or, for a question, `{ typed }`: then exactly
 *     that, bounded and typed by `sourceanswer.ts` into this session through
 *     `core.input`, the path a digit tap takes, only while it is still open;
 *  2. the box has no numbers (`nav`), or the caller asked for a walk ⇒
 *     `choosePromptBox`, which refuses rather than pressing a blind Return;
 *  3. otherwise the digit and a Return, which is what a tap always sent.
 *
 * Typed words reach only rung 1: a box the screen read takes none (refused in
 * words — the composer is `deliver.ts`'s, never this). `choice` is `NaN` for a
 * question answered with words alone.
 *
 * **While the channel owns the dialogs, a box it does not know is not answered
 * by guessing.** A dialog the channel resolved a moment ago (answered at the
 * desk, withdrawn) leaves nothing to type at — the screen walk would read a box
 * that is gone and the digit would land in the composer — so it refuses in
 * words, as the gate refuses, with nothing written.
 *
 * Without `sources` none of rung 1 or the refusal can apply (`s.channel` is
 * absent) and this is exactly the two calls the route and the gate made before.
 */
export async function answerBox(core: SessionCore, id: string, choice: number, opts: { walk?: boolean; byPerson?: boolean; text?: string } = {}): Promise<{ ok: boolean; reason?: string }> {
  const s = core.sessions.get(id);
  if (!s || !s.info.running) return { ok: false, reason: "session not available" };
  const p = s.info.prompt ?? null;
  const ch = s.channel && !s.channel.closed ? s.channel : null;
  const text = opts.text;
  const textWhy = text === undefined ? null : answerTextProblem(text);
  if (textWhy) return { ok: false, reason: textWhy };
  const sourceOwned = !!ch && !!p?.askId && p.askId === ch.published;
  // A screen-read box while the channel reports a dialog it cannot pose is the screen's to
  // answer (the walk below), never refused as "not the channel's".
  if (sourceOwned || (ch?.dialogsLive && !ch.unposed)) {
    const q = p?.askId ? ch!.questions.get(p.askId) : undefined;
    const d = p?.askId ? ch!.dialogs.get(p.askId) : undefined;
    const reply: SourceReplyDeps = {
      input: (data) => core.input(id, data), label: s.backend.label,
      stillOpen: () => !ch!.closed && s.channel === ch && !!p?.askId && (ch!.questions.has(p.askId) || ch!.dialogs.has(p.askId) || ch!.plans.has(p.askId)),
      log: { sessionId: id, source: opts.byPerson ? "phone" : "plugin" },
      onUnclosed: (note) => {
        if (s.info.prompt?.askId !== p?.askId) return;
        s.info.prompt = { ...s.info.prompt!, answerNote: note };
        core.emit("updated", s.info);
      },
    };
    if (p && q) return answerQuestion(q, choice, text, reply);
    if (p?.askId && ch!.plans.has(p.askId)) return answerSourcePlan(ch!.plans.get(p.askId)!, choice, { byPerson: !!opts.byPerson, text }, reply);
    if (!p || !d) return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    const option = Number.isInteger(choice) ? d.options.find((o) => o.index === choice) : undefined;
    if (!option) return { ok: false, reason: `${choice} is not one of the box's options` };
    if (text !== undefined && !option.takesText) return { ok: false, reason: `“${option.label}” takes no typed reason — tap it without one` };
    // Read BEFORE answering: a source may re-word its options once answered (they are its own).
    const remember = option.remember;
    const dialogWords = remember ? [d.question, ...d.options.map((o) => o.label)].join("\n") : "";
    let r: { ok: boolean; reason?: string } | SourceKeys | (SourceKeys & SourceTyped);
    try {
      r = await (text === undefined ? d.answer(choice) : d.answer(choice, { text }));
    } catch (e) {
      return { ok: false, reason: `the CLI's own channel did not take that answer (${(e as Error)?.message || String(e)})` };
    }
    // A dialog's reply is `{ok}` or `{keys}`: typed words are a question's (`SourceTyped`) —
    // except keys-then-words (2.1): the row's key opens a reason field, and the words are the
    // ones the PERSON typed on a `takesText` row (checked above), never the source's own.
    const done = r && typeof r === "object" && "typed" in r
      ? dialogWordsProblem(r, text) ?? await applySourceReply(r, reply)
      : await applySourceReply(r, reply);
    // A PERSON chose an option the source marked `remember`: the host keeps that standing rule
    // (`answergate.ts`), keyed by the plugin that registered this backend — the owner of the source.
    // Only the phone's route sets `byPerson` — a gated answer never makes one; a dialog an ask rule the gate holds names keeps none.
    if (done.ok && opts.byPerson && remember) rememberRule({ sessionId: id, plugin: s.backend.plugin, backend: s.backend.id, key: remember.key, label: remember.label, askRules: sessionAskRules(id, s.info), text: dialogWords });
    return done;
  }
  if (text !== undefined) return { ok: false, reason: "this box takes no typed answer — only a question the CLI posed on its own channel does" };
  if (opts.walk || p?.nav) return choosePromptBox(core, id, choice);
  const ok = core.input(id, `${choice}\r`);
  return ok ? { ok } : { ok, reason: "session not available" };
}

/**
 * Why a dialog's reply carrying `typed` is refused, or null when it is keys-then-words for the
 * person's own reason. `text` is only ever set on a `takesText` row (`answerBox` refused it
 * otherwise before the source was asked).
 */
function dialogWordsProblem(r: SourceKeys | SourceTyped | (SourceKeys & SourceTyped), text: string | undefined): { ok: false; reason: string } | null {
  if (text === undefined || !("keys" in r)) return { ok: false, reason: "the CLI's own channel asked to type words into a dialog — only a question's form takes them" };
  if ((r as SourceTyped).typed !== text) return { ok: false, reason: "the CLI's own channel asked to type a reason that is not the words you typed — nothing was typed" };
  return null;
}

/** Rung 1 for a QUESTION: an option, typed words, or both — each only where it offers one. */
async function answerQuestion(q: SourceQuestion, choice: number, text: string | undefined, reply: SourceReplyDeps): Promise<{ ok: boolean; reason?: string }> {
  const picked = Number.isInteger(choice) ? choice : undefined;
  if (picked !== undefined && !(q.options ?? []).some((o) => o.index === picked)) return { ok: false, reason: `${picked} is not one of the question's options` };
  if (text !== undefined && q.freeText !== true) return { ok: false, reason: "this question takes one of its options, not typed words" };
  if (picked === undefined && text === undefined) return { ok: false, reason: "an answer to this question needs an option or typed words" };
  let r;
  try {
    r = await q.answer({ ...(picked !== undefined ? { choice: picked } : {}), ...(text !== undefined ? { text } : {}) });
  } catch (e) {
    return { ok: false, reason: `the CLI's own channel did not take that answer (${(e as Error)?.message || String(e)})` };
  }
  return applySourceReply(r, reply);
}


/**
 * Press Return on a checkbox box's **Submit row**, walking the selection
 * cursor there first.
 *
 * A multi-select `AskUserQuestion` is answered by toggling rows and then
 * confirming on a Submit row that carries no index — so the phone's Submit
 * button, which sent a bare Return, pressed it wherever the cursor happened to
 * be: on option 1, where the box starts, that RE-TOGGLES the option and leaves
 * the box open. The box is never answered and the row the user did pick is
 * silently un-picked.
 *
 * Driven off the RENDERED screen rather than a count of rows we believe are
 * there (`navToSubmit`), and re-read between moves: whether a digit key also
 * moves the cursor, and whether the ends of the list wrap, are both upstream
 * details we would otherwise be encoding a guess about. Overshooting is
 * self-correcting — the next pass just walks back — so the loop converges
 * where an open-loop "press Down N times" would land on the wrong row.
 *
 * Falls back to the bare Return whenever the screen shows no Submit row or no
 * cursor (a box taller than the terminal can have scrolled either off): that
 * is exactly what this call did before, and guessing a direction from half a
 * box would toggle a row nobody chose.
 */
export async function submitPromptBox(core: SessionCore, id: string): Promise<{ ok: boolean; placed: boolean }> {
  const s = core.sessions.get(id);
  if (!s || !s.info.running || !s.info.remoteControl) return { ok: false, placed: false };
  let placed = false;
  /** Did the screen ever yield a Submit row AND a cursor? The two failures are
   *  different facts: "the box is not readable at all" is the fallback this
   *  signal is named for, while "readable but the walk never converged" is a
   *  navigation miss. Collapsing them would report an unreadable screen as a
   *  broken walk. */
  let readable = false;
  /** Kept for the sample: the screen the last decision was taken on. */
  let seen = "";
  for (let i = 0; i < SUBMIT_NAV_TRIES; i++) {
    seen = await core.screenText(id, SUBMIT_NAV_LINES);
    const nav = navToSubmit(seen);
    if (!nav) break;
    readable = true;
    if (nav.steps === 0) { placed = true; break; }
    const key = nav.steps > 0 ? "\x1b[B" : "\x1b[A";
    if (!core.input(id, key.repeat(Math.min(Math.abs(nav.steps), SUBMIT_NAV_MAX_KEYS)))) {
      return { ok: false, placed: false };
    }
    await pause(SUBMIT_NAV_SETTLE_MS);
  }
  // One observation per answered box — this is a user's tap, not a poll.
  // `placed` is the only outcome in which the Return that follows means
  // "submit"; without it the keystroke toggles whatever row the cursor sat on,
  // which is the bug this whole method exists to fix.
  // Both words the commit row is drawn with — see `prompt.ts`'s
  // `SUBMIT_ROW_RE`. Anchored, so a sentence containing "next" is not a row.
  const tail = healthTail(seen, (l) => /^\s*\S?\s*(Submit|Next)\s*$/.test(l), HEALTH_SAMPLE_ROWS);
  if (placed) core.noteFor(s, "prompt.submit", "good", { fixture: () => seen });
  else if (readable) core.noteFor(s, "prompt.submit", "miss", { raw: tail });
  else core.noteFor(s, "prompt.submit", "fallback", { via: "a bare Return", raw: tail });
  return { ok: core.input(id, "\r"), placed };
}

export { sourceKeysProblem } from "../sourceanswer.js";
