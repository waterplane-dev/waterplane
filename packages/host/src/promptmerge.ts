/** Box identity and merge of two passes over the same box; re-exported by `prompt.ts`. */
// ── Keeping one box ONE box while the TUI repaints under it ───────────────
import type { DetectedPrompt } from "@waterplane/shared";
import { MAX_BOX_OPTIONS, PLACEHOLDER_QUESTION } from "./promptbase.js";

/**
 * Two strict parses that are the same box on screen, seen at two moments.
 *
 * The strict pass runs about twice a second while a dialog is up, and what it
 * reads is not stable: this CLI scrolls rather than repainting an alt screen,
 * so panning the console, a repaint the phone's own answer card provoked, or a
 * box taller than the terminal all change WHICH rows are legible from one pass
 * to the next. Each of those re-published a different `DetectedPrompt` for a
 * question nobody had touched — and because `promptFingerprint` is built from
 * the question and the option rows, a re-publish is not cosmetic:
 *
 *   • the phone's card is keyed on the fingerprint, so collapsing it or hiding
 *     it (the two ways to answer at the DESK instead) was undone on the next
 *     repaint — the complaint this exists for;
 *   • an answer already queued against the old fingerprint goes `stale`;
 *   • `applyPrompt` fires a push per change.
 *
 * **Where the CLI will say which box this is, that is the answer.** `askId`
 * (host `askbox.ts`) is the pending tool call's own id plus the question index
 * inside it: minted by the CLI, written to the log before anybody answers, and
 * untouched by any repaint. Two `AskUserQuestion` boxes in a row have different
 * ones, so nothing here has to guess.
 *
 * The rest is the fallback, for a tool approval or a trust dialog — which carry
 * no such call. Identity is then asked of the parts that cannot move: the kind,
 * the shape (`multi`/`nav`), and the option rows at the indices the two passes
 * SHARE. A label is compared by prefix in either direction, because the terminal
 * cuts one and the log's enrichment does not. There the question IS compared
 * whenever both passes read a real one, deliberately strictly: without an id
 * there is nothing else standing between "this box again" and "the next box,
 * whose buttons mean something else", and a wrong question over live buttons is
 * the one mistake this must not make. Those boxes are three rows tall and do
 * not truncate, so the strictness costs nothing they suffer from.
 *
 * Measured on a live shell: one box published its question three different ways
 * inside four seconds — the detector joins up to four lines above option 1, and
 * on a scrolling screen those lines are whatever is there.
 */
export function sameBox(a: DetectedPrompt, b: DetectedPrompt): boolean {
  if (!!a.multi !== !!b.multi) return false;
  if (!!a.nav !== !!b.nav) return false;
  // Two ids that disagree is the cheapest NO there is.
  if (a.askId && b.askId && a.askId !== b.askId) return false;
  const named = !!a.askId && a.askId === b.askId;
  // `kind` is DERIVED from the question and the labels, so a truncated pass
  // that lost the question flips an ask containing "proceed"/"plan"/"approve"
  // from `tool` to `select` — and `kind` is in the fingerprint, so testing it
  // first made that class of box alternate between two identities on every
  // pan, which is the complaint. Where the CLI has named the box, its own id
  // outranks a reading of words that are not on screen.
  if (!named && a.kind !== b.kind) return false;
  if (!named) {
    const qa = realQuestion(a);
    const qb = realQuestion(b);
    if (qa && qb && qa !== qb) return false;
  }
  // The rows still have to agree, NAMED OR NOT. The id says which question the
  // log holds; it does not say the screen is still showing that question, and
  // the matcher that produced it works on a handful of labels. Requiring the
  // shared indices to line up costs nothing on a real repaint (they do) and is
  // the difference between a card whose buttons answer this box and one whose
  // buttons answer the last one.
  const byIndex = new Map(a.options.map((o) => [o.index, o.label]));
  let shared = 0;
  let own = 0;
  for (const o of b.options) {
    const mine = byIndex.get(o.index);
    if (mine === undefined) continue;
    if (!labelsAgree(mine, o.label)) return false;
    shared++;
    // …and at least one agreement has to be about THIS box. The TUI appends
    // its own rows to every question it draws ("Other", "Chat about this",
    // "Type something"), so a new box whose top has scrolled away can present
    // nothing but those — two generic rows agreeing with the previous box's
    // two generic rows, which is no evidence at all. Measured as the path that
    // glued a dead box's question and labels onto a live one.
    if (!GENERIC_ROW_RE.test(mine.trim())) own++;
  }
  return shared > 0 && own > 0;
}

/**
 * Rows the TUI draws on EVERY question of its own accord, after the tool's
 * options. They are numbered like options and they say nothing about which box
 * is on screen.
 */
const GENERIC_ROW_RE = /^(other|chat about this|type something\.?|none of these)$/i;

/**
 * Do two published boxes say the same thing? Field by field, because
 * `JSON.stringify` also compares KEY ORDER — and the merge builds its object in
 * its own order, so a byte comparison reported a change on the pass after every
 * merge: one more broadcast, push and plugin event per box, for a card that had not
 * moved. `ticks: "ignore"` asks "same apart from checkbox ticks" (a toggle: no push).
 */
export function samePrompt(a: DetectedPrompt | null, b: DetectedPrompt | null, ticks?: "ignore"): boolean {
  if (!a || !b) return a === b || (!a && !b);
  if (a.kind !== b.kind || a.question !== b.question) return false;
  if (!!a.multi !== !!b.multi || !!a.nav !== !!b.nav || !!a.truncated !== !!b.truncated) return false;
  if ((a.ask ?? "") !== (b.ask ?? "")) return false;
  if ((a.askId ?? "") !== (b.askId ?? "")) return false;
  if ((a.submitLabel ?? "") !== (b.submitLabel ?? "")) return false;
  if ((a.plan?.text ?? "") !== (b.plan?.text ?? "") || !!a.plan?.cut !== !!b.plan?.cut) return false;
  if (a.options.length !== b.options.length) return false;
  return a.options.every((o, i) => o.index === b.options[i].index && o.label === b.options[i].label &&
    (o.desc ?? "") === (b.options[i].desc ?? "") && (ticks === "ignore" || o.checked === b.options[i].checked));
}

/**
 * Fold a fresh parse of the SAME box into what is already published.
 *
 * The published box wins every field it has, and the new one may only ADD: an
 * option index nobody had seen yet, a real question where the placeholder stood.
 * That is what makes a box whose top has scrolled away keep the options it was
 * published with — "the first options are scrolled away and therefore missing
 * from the selection dialogue" — without the card ever changing shape under a
 * thumb.
 *
 * Nothing here is invented: every option in the result was read off this
 * screen, for this box, at some point while it was up.
 */
export function mergeBox(published: DetectedPrompt, parsed: DetectedPrompt): DetectedPrompt {
  const byIndex = new Map(published.options.map((o) => [o.index, o]));
  for (const o of parsed.options) {
    // A published label is NEVER rewritten, not even by a longer reading of
    // itself. It was tried the other way — "the screen cut this one, so the
    // longer read is the truer one" — and it is the wrong trade twice over:
    // the labels ARE the fingerprint, so growing one restarts the card and
    // makes an answer queued against it stale, which is the whole thing this
    // merge exists to stop; and a garbled read that happens to be longer (a
    // panel border the side-panel cut missed) then wins permanently, since
    // the correct shorter read can never take it back (`desc`/`ask` carry the
    // full words). Ticks are the one row field where the FRESHEST read wins.
    const had = byIndex.get(o.index);
    if (!had) byIndex.set(o.index, o);
    else if (o.checked !== undefined) byIndex.set(o.index, { ...had, checked: o.checked });
  }
  // Lowest indices first and capped there: the head is the half that scrolled
  // away, so if anything has to go it is the tail — which is on screen.
  const options = [...byIndex.values()].sort((x, y) => x.index - y.index).slice(0, MAX_BOX_OPTIONS);
  const question = realQuestion(published) ? published.question : (realQuestion(parsed) ? parsed.question : published.question);
  const ask = published.ask ?? parsed.ask;
  const submitLabel = published.submitLabel ?? parsed.submitLabel;
  // The freshest reading wins here, not the oldest: this is the CLI's own
  // answer to "which box", and a pass that could not reach the log says
  // nothing rather than something older.
  const askId = parsed.askId ?? published.askId;
  // Freshest too: the plan is a FILE and can be edited while its box is up
  // (the box's own ctrl+g), so the newer read is the plan being approved.
  const plan = parsed.plan ?? published.plan;
  const truncated = options.length > 0 && options[0].index > 1;
  // `nav` boxes lose their options off the RIGHT EDGE, not off the top, so the
  // index-1 test says nothing about them: keep what the two passes agreed on.
  const navTruncated = !!published.truncated && !!parsed.truncated;
  const cut = published.nav ? navTruncated : truncated;
  // Field by field rather than a spread of `published`: `truncated` has to be
  // able to go AWAY (the head arrived, so nothing is unreachable any more), and
  // a spread would carry the old `true` straight past the line that computed it.
  return {
    kind: published.kind,
    question,
    options,
    ...(published.multi ? { multi: true as const } : {}),
    ...(published.nav ? { nav: true as const } : {}),
    ...(ask ? { ask } : {}),
    ...(askId ? { askId } : {}),
    ...(submitLabel ? { submitLabel } : {}),
    ...(plan ? { plan } : {}),
    ...(cut ? { truncated: true as const } : {}),
  };
}

/** The question a pass actually read, or "" for the placeholder a truncated box
 *  falls back to (`detectPrompt`). */
function realQuestion(p: DetectedPrompt): string {
  const q = p.question.replace(/\s+/g, " ").trim();
  return q === PLACEHOLDER_QUESTION ? "" : q;
}

/** Same label, allowing for the end the terminal cut off. */
function labelsAgree(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, " ").trim();
  const y = b.replace(/\s+/g, " ").trim();
  if (x === y) return true;
  const short = x.length < y.length ? x : y;
  const long = x.length < y.length ? y : x;
  return short.length >= 6 && long.startsWith(short);
}
