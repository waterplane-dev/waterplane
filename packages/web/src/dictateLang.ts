import { DICTATE_AUTO, dictateLangOffered, parseDictateTerms, whisperLang, type DictateTerm } from "@waterplane/shared";
import { LS, lsGet, lsJson, lsSet, lsSetJson } from "./storage";

/**
 * Which language the microphone is read as, on this phone.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The phone used to hand every clip `navigator.language`, which is the phone's
 * SYSTEM language and has nothing to do with the sentence being spoken into it.
 * Told a language, whisper does not transcribe a different one — it TRANSLATES
 * it. So English dictated into a German phone came back as German prose: the
 * reported bug, and the worst shape a failure can take here, because what lands
 * in the box is fluent, plausible and not what anybody said. (`shared/dictate.ts`'s
 * `dictateLangChoices` carries the rest of that reasoning.)
 *
 * ── Read at the two moments that matter, never snapshotted ──────────────────
 *
 * A module-level value with subscribers rather than component state, for the
 * same reason `dictateQueue.ts` is one: there are TWO microphones over one
 * implementation (the compose bar's and `PromptComposer`'s), both can be
 * mounted at once, and a language picked at one of them that the other did not
 * hear about is a control that lies. The value is read when a recording STOPS
 * (it travels with the clip, so a held recording keeps the language it was made
 * in, whatever the pill says days later) and when the browser engine starts.
 *
 * Everything stored here goes through `whisperLang`, so a hand-edited or
 * stale-build value degrades to `auto` — which transcribes — rather than to a
 * code the transcriber refuses, which transcribes NOTHING.
 */

const listeners = new Set<() => void>();

/** The language a recording stopped now would be read as. Always a tag whisper
 *  accepts, `auto` included. */
export function dictateLang(): string {
  return whisperLang(lsGet(LS.dictateLang) || DICTATE_AUTO);
}

/** Pick one. Normalised on the way in, so what is stored is what will be sent. */
export function setDictateLang(code: string): void {
  lsSet(LS.dictateLang, whisperLang(code));
  for (const fn of listeners) fn();
}

/**
 * Which languages the pill LISTS, as Settings holds it.
 *
 * Stored raw — the rules about an empty pick, an unknown code and the language
 * currently in use are `dictateLangOffered`'s, applied at read time, because a
 * list written by an older build must still produce a working microphone.
 */
export function offeredLangCodes(): string[] {
  const raw = lsJson<unknown>(LS.dictateLangs, []);
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
}

/** The list to draw, already filtered, ordered and guaranteed non-empty. */
export function offeredLangs(): { code: string; label: string }[] {
  return dictateLangOffered(offeredLangCodes(), dictateLang(), deviceLangTag());
}

/** Settings writes the whole pick at once — a chip toggled is a new list. */
export function setOfferedLangs(codes: string[]): void {
  lsSetJson(LS.dictateLangs, codes);
  for (const fn of listeners) fn();
}

/** Every pill on screen follows the one that was tapped. */
export function subscribeDictateLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The tag for the BROWSER engine, which is a different question.
 *
 * Web Speech has no auto-detect: it is given one BCP-47 tag and recognises in
 * it. So `auto` there can only mean the device's own language — the old
 * behaviour, kept exactly where it was already the only thing available, and
 * overridden the moment a language is pinned.
 */
export function speechLang(): string {
  const picked = dictateLang();
  if (picked !== DICTATE_AUTO) return picked;
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

/** What the device says it is set to — the one thing the picker adds to its
 *  curated list, so no phone is offered a list without its language in it. */
export function deviceLangTag(): string | undefined {
  return (typeof navigator !== "undefined" && navigator.language) || undefined;
}

/**
 * The person's dictation vocabulary, as typed in Settings (`shared/dictateterms.ts`
 * holds the format and every rule). Synced, unlike the language: a word the
 * transcriber mishears is misheard on every device. Read when a clip is SENT,
 * not when it was recorded — a term added while a clip waited on the link is
 * one the person wants applied to it.
 */
export function dictateTermsText(): string {
  return lsGet(LS.dictateTerms) || "";
}

export function dictateTerms(): DictateTerm[] {
  return parseDictateTerms(dictateTermsText());
}

export function setDictateTermsText(text: string): void {
  lsSet(LS.dictateTerms, text);
  for (const fn of listeners) fn();
}
