/**
 * What a backend's OWN channel may ask the host to type, after `boxes.ts`'s `answerBox` put a
 * person's (or a gated plugin's) answer to it — and the typing itself.
 *
 * Two shapes, both answers to a box the source posed and still holds open, never a prompt:
 *
 *  - `SourceKeys` — its dialog moved into its TUI and is answered by at most `SOURCE_KEYS_MAX`
 *    keystrokes (a digit, an arrow, Return, Escape; 2.2: Tab, Shift+Tab);
 *  - `SourceTyped` (contract 2.0) — its QUESTION is a form in its TUI and the answer is words
 *    typed into that form (Copilot's `ask_user`): at most `SOURCE_TYPED_MAX` characters, no
 *    control character at all, then optionally ONE Return as a second write (text and Return
 *    together read as a paste). The one place words reach a session outside `deliver.ts` —
 *    bounded here, typed only while the source still holds the question open, and every one a
 *    `sent.json` row (`source: "phone"` for a person, `"plugin"` for a gated answer). It is not
 *    a delivery: no echo is proven, no Return re-pressed. What it CAN check is the source
 *    closing the question: no `closed` within `TYPED_CLOSE_MS` is said on the box.
 *  - both at once, `{keys, typed, then?}` (2.1, `supports.dialogKeysThenTyped`) — a dialog row
 *    whose key OPENS a reason field (Copilot's "No, and tell the agent why" past its hook
 *    hold: `3` opens the field). Each half bounded as above; the keys, a `TYPED_AFTER_KEYS_MS`
 *    pause for the field to draw, then the typed half exactly as a question's. `boxes.ts` lets
 *    it through only for the words a PERSON typed on a `takesText` row.
 *
 * A PLAN the CLI posed on its own channel (`sources.plan`) is answered here too
 * (`answerSourcePlan`): a person's tap calls ONE of its two verbs, at most once per plan, and
 * its reply is `{ok}` or keys — never words.
 *
 * `deliver.ts` is not forked: nothing here finds a composer, proves an echo or retries.
 */
import { SOURCE_KEYS_MAX, SOURCE_TYPED_MAX, type SourceKeys, type SourcePlan, type SourceTyped, type SentSource } from "@waterplane/shared";
import { recordSent } from "./sentlog.js";

/**
 * The control keys a source may ask for — the ones a box walk presses, plus (2.2) Tab and
 * Shift+Tab, which a mode cycle presses. Longest first: Shift+Tab is one key, not an Escape.
 */
const SOURCE_CONTROL_KEYS = ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[Z", "\r", "\t", "\x1b"] as const;

/** How long a typed answer waits for the source to say its question closed. */
export const TYPED_CLOSE_MS = 5000;
/** Between the words and their Return: two writes, or the TUI reads one paste. */
export const TYPED_RETURN_PAUSE_MS = 60;
/** Between a dialog's keys and the words they open a field for: the field must be drawn first. */
export const TYPED_AFTER_KEYS_MS = 500;

const isControl = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp < 0xa0);

/**
 * Why `keys` is not something a source may have typed, or null when it may.
 *
 * At most `SOURCE_KEYS_MAX` keys, each a printable character or one of
 * `SOURCE_CONTROL_KEYS` (longest first, so an arrow or Shift+Tab is one key and
 * not an Escape plus two characters). Anything else — a control character, a
 * bracketed paste, a prompt's worth of text — is not an answer to a box.
 */
export function sourceKeysProblem(keys: unknown): string | null {
  if (typeof keys !== "string" || keys.length === 0) return "it asked for no keystrokes";
  let n = 0;
  for (let i = 0; i < keys.length; n++) {
    const ctl = SOURCE_CONTROL_KEYS.find((k) => keys.startsWith(k, i));
    if (ctl) { i += ctl.length; continue; }
    const cp = keys.codePointAt(i)!;
    if (isControl(cp)) {
      return `it asked for a control character (0x${cp.toString(16).padStart(2, "0")}) that is not Return, Escape, Tab, Shift+Tab or an arrow`;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  if (n > SOURCE_KEYS_MAX) return `it asked for ${n} keystrokes, and a box is answered with at most ${SOURCE_KEYS_MAX}`;
  return null;
}

/** Why a `SourceTyped` is not something the host will type, or null when it will. */
export function sourceTypedProblem(t: unknown): string | null {
  const o = t as Partial<SourceTyped> | null;
  if (!o || typeof o.typed !== "string" || !o.typed.length) return "it handed over nothing to type";
  if (o.then !== undefined && o.then !== "\r") return "it asked to end the words with a key that is not Return — only Return may follow them";
  if (o.typed.length > SOURCE_TYPED_MAX) return `it asked to type ${o.typed.length} characters, and an answer is typed with at most ${SOURCE_TYPED_MAX}`;
  for (let i = 0; i < o.typed.length; i++) {
    const c = o.typed.charCodeAt(i);
    if (isControl(c)) return `the words hold a control character (0x${c.toString(16).padStart(2, "0")}) — typed words are one line, and Return comes only as \`then\``;
  }
  return null;
}

export interface SourceReplyDeps {
  /** The core's raw-input path into THIS session (`core.input`), the one a digit tap takes. */
  input(data: string): boolean;
  /** The dialog or question that was answered is still one the channel holds open. */
  stillOpen(): boolean;
  /** A typed answer the source has not closed after `closeWaitMs`: the sentence for the box. */
  onUnclosed?(sentence: string): void;
  /** The backend's label, for the sentences. */
  label?: string;
  /** For the `sent.json` row of a typed answer. */
  log?: { sessionId: string; source: Extract<SentSource, "phone" | "plugin"> };
  closeWaitMs?: number;
  pauseMs?: number;
  /** Keys-then-words: the pause after the keys (default `TYPED_AFTER_KEYS_MS`). */
  keysPauseMs?: number;
}

const refusedKeys = (why: string) => ({ ok: false, reason: `the CLI's own channel answered with keystrokes this host will not type — ${why}` });
const refusedTyped = (why: string) => ({ ok: false, reason: `the CLI's own channel asked for words this host will not type — ${why}` });
const gone = { ok: false, reason: "that question is no longer open — it was answered or withdrawn" } as const;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * What became of a source's reply to an answer: `{ok, reason}` as it said, or the keys /
 * typed words it handed back, typed here — once, into this session, only while the thing
 * answered is still open. Anything else is refused in words, nothing typed.
 */
export async function applySourceReply(
  r: { ok: boolean; reason?: string } | SourceKeys | SourceTyped | (SourceKeys & SourceTyped) | null | undefined,
  deps: SourceReplyDeps,
): Promise<{ ok: boolean; reason?: string }> {
  if (r && typeof r === "object" && "keys" in r) {
    const why = sourceKeysProblem(r.keys);
    if (why) return refusedKeys(why);
    const words = "typed" in r ? (r as SourceKeys & SourceTyped) : null;
    if (words) {
      const wwhy = sourceTypedProblem(words);
      if (wwhy) return refusedTyped(wwhy);
    }
    if (!deps.stillOpen()) return { ...gone };
    if (!deps.input(r.keys)) return { ok: false, reason: "session not available" };
    if (!words) return { ok: true };
    await pause(deps.keysPauseMs ?? TYPED_AFTER_KEYS_MS);
    if (!deps.stillOpen()) return { ok: false, reason: "the dialog closed after its keys — the keys were typed, the words were not" };
    return typeWords(words, deps, r.keys);
  }
  if (r && typeof r === "object" && "typed" in r) {
    const why = sourceTypedProblem(r);
    if (why) return refusedTyped(why);
    if (!deps.stillOpen()) return { ...gone };
    return typeWords(r, deps);
  }
  return r?.ok ? { ok: true } : { ok: false, reason: r?.reason || "the CLI's own channel did not take that answer" };
}

/** The typed half, validated and with its thing still open: words, pause, Return as its own write, the row, the close watch. */
async function typeWords(r: SourceTyped, deps: SourceReplyDeps, keys?: string): Promise<{ ok: boolean; reason?: string }> {
  if (!deps.input(r.typed)) return { ok: false, reason: "session not available" };
  if (r.then === "\r") {
    await pause(deps.pauseMs ?? TYPED_RETURN_PAUSE_MS);
    // Closed in the pause (the form took the words alone): nothing left to press Return at.
    if (deps.stillOpen() && !deps.input("\r")) return { ok: false, reason: "session not available — the words were typed, the Return was not" };
  }
  if (deps.log) {
    recordSent({
      sessionId: deps.log.sessionId, actor: deps.log.source === "phone" ? "user" : "auto", source: deps.log.source,
      kind: "answer", text: r.typed, result: "written",
      detail: keys !== undefined
        ? `typed into the reason field ${JSON.stringify(keys)} opened on ${deps.label ?? "the CLI"}'s own dialog${r.then ? ", then Return" : ""}`
        : `typed into ${deps.label ?? "the CLI"}'s own question form${r.then ? ", then Return" : ""}`,
    });
  }
  const wait = deps.closeWaitMs ?? TYPED_CLOSE_MS;
  const t = setTimeout(() => {
    if (!deps.stillOpen()) return;
    deps.onUnclosed?.(`your answer was typed into ${deps.label ?? "the CLI"}'s own question, but it has not closed `
      + `${Math.round(wait / 1000) || 1} s later — look at the terminal before answering again`);
  }, wait);
  t.unref?.();
  return { ok: true };
}

/** The plan box's two rows, as `sidechannel.ts`'s `planToPrompt` publishes them. */
export const PLAN_APPROVE = 1;
export const PLAN_KEEP = 2;

/**
 * A plan the CLI posed on its own channel, as the channel holds it until `closed`. `answering`
 * is the at-most-once latch: set before a verb is called, released only when the answer provably
 * did nothing (the source said no, threw, or its keys were refused or could not be typed). A
 * second tap — another phone, a double tap under two ackIds — while it is set calls nothing.
 */
export interface PlanEntry { plan: SourcePlan; answering: boolean }

/**
 * Rung 1 of `boxes.ts`'s `answerBox` for a PLAN: row 1 calls `approve()`, row 2 `keepPlanning()`.
 * Only a person's tap (`byPerson`; the answer gate refuses a plan before it gets here, and this
 * refuses again), never typed words. The verb's reply goes through `applySourceReply` — `{ok}`,
 * or keys typed while the plan is still open; a reply carrying words is refused, nothing typed.
 */
export async function answerSourcePlan(
  e: PlanEntry, choice: number, opts: { byPerson: boolean; text?: string }, deps: SourceReplyDeps,
): Promise<{ ok: boolean; reason?: string }> {
  if (!opts.byPerson) return { ok: false, reason: "a plan is always a person's call — only a tap on the phone or at the desk answers it" };
  if (opts.text !== undefined) return { ok: false, reason: "a plan is approved or sent back with a tap — it takes no typed words" };
  if (choice !== PLAN_APPROVE && choice !== PLAN_KEEP) return { ok: false, reason: `${choice} is not one of the box's options` };
  if (e.answering) return { ok: false, reason: `this plan was already answered — waiting for ${deps.label ?? "the CLI"} to close it` };
  e.answering = true;
  let r: { ok: boolean; reason?: string } | SourceKeys | SourceTyped | null | undefined;
  try {
    r = await (choice === PLAN_APPROVE ? e.plan.approve() : e.plan.keepPlanning());
  } catch (err) {
    e.answering = false;
    return { ok: false, reason: `the CLI's own channel did not take that answer (${(err as Error)?.message || String(err)})` };
  }
  if (r && typeof r === "object" && "typed" in r) {
    e.answering = false;
    return { ok: false, reason: "the CLI's own channel asked to type words into a plan — a plan is answered with a tap, so nothing was typed" };
  }
  const done = await applySourceReply(r, deps);
  if (!done.ok) e.answering = false;
  return done;
}
