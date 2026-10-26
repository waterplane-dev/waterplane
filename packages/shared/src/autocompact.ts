/**
 * The CLI's `autoCompactWindow` as the repo-setup checklist reads it: which
 * value a session the daemon spawns in a repo would see, where it came from, and what
 * that means for how large one conversation's window can grow.
 *
 * Why a row at all: a subagent in one repo ran 819 requests averaging 484k of
 * context and peaking at 967k of a 1M window — about a quarter of a week's
 * usage — because `auto` compacts near the MODEL's own window, and on a 1M
 * model that is ~1M re-read on every step. A size here caps it.
 *
 * **Precedence.** The environment variable beats every settings file — verified
 * in the installed CLI bundle (2026-09): the resolver checks
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` first and returns `source:"env"` unless the
 * value is invalid, and only then falls through to the merged settings value.
 * Between the settings files this uses Claude Code's DOCUMENTED merge order,
 * local (`.claude/settings.local.json`) > project (`.claude/settings.json`) >
 * user (`~/.claude/settings.json`); the merge itself is generic in the bundle
 * and was not re-derived for this key. Managed/policy settings and a
 * `--settings` flag are not read: the daemon's own `--settings` carries hooks only.
 *
 * Pure: the host reads the files and hands their text in, so every rule here is
 * pinned in `packages/shared/test/autocompact.test.mjs` with no disk.
 */
import { BRAND } from "./brand.js";

/** Where the effective value came from. `unset` = nobody said, which the CLI
 *  treats as `auto`. */
export type AutoCompactSource = "env" | "local" | "project" | "user" | "unset";

export type AutoCompactValue =
  | { kind: "auto" }
  | { kind: "size"; tokens: number }
  /** Present but not a size the rule can read — never guessed into a number. */
  | { kind: "unparseable"; raw: string };

/** At or under this, the row passes. Above it, one conversation may still grow
 *  to half a 1M window before it compacts. */
export const AUTO_COMPACT_OK_MAX = 500_000;

/** What the checklist's write offers when nobody chose otherwise. */
export const AUTO_COMPACT_SUGGESTED = "400k";

/** The windows Settings offers as the one the checklist writes. */
export const AUTO_COMPACT_CHOICES: readonly string[] = ["200k", "300k", "400k", "500k", "700k"];

/** The range a chosen default may take. Under 100k a long tool result alone
 *  can fill the window; at or past 1M the choice caps nothing on a 1M model. */
export const AUTO_COMPACT_MIN = 100_000;
export const AUTO_COMPACT_MAX = 900_000;

/**
 * A chosen default as it will be written, or an error in words. Refuses rather
 * than clamps: a stored repaired value is a number the person did not choose,
 * quoted back to them in a sentence that says they did.
 */
export function cleanAutoCompactDefault(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = parseAutoCompactWindow(raw);
  if (v.kind !== "size") return { ok: false, error: `${JSON.stringify(raw)} is not a window size (expected e.g. "400k")` };
  if (v.tokens < AUTO_COMPACT_MIN || v.tokens > AUTO_COMPACT_MAX) {
    return { ok: false, error: `${formatTokenWindow(v.tokens)} is outside ${formatTokenWindow(AUTO_COMPACT_MIN)}–${formatTokenWindow(AUTO_COMPACT_MAX)}` };
  }
  return { ok: true, value: formatTokenWindow(v.tokens) };
}

/**
 * Checklist fix ids that CHOOSE a setting rather than repair a convention.
 * They are never in "Fix all", never counted as "one-tap fixable", and the
 * phone draws them behind a two-tap confirm. One list, read by both ends.
 */
export const CONFIRM_GATED_FIXES: readonly string[] = ["auto-compact", "android-toolchain", "signing-key", "protect-main", "era-seen"];

/**
 * The `android-toolchain` fix installs a JDK and the Android SDK and accepts the SDK licence on
 * the person's behalf, so its confirm text IS the consent text: what, how big, where, and the
 * licence link. Shared so the phone's armed button and the host's log quote one sentence.
 *
 * The SIZE is never a constant here: what is downloaded depends on what this desktop already has
 * (a JDK alone is ~200 MB, everything ~500 MB). `androidToolchainConsent(bytes)` puts in the
 * figure the host derived (`toolchain.ts` `planToolchain().installBytes`, served by
 * `GET /api/onboard/plan`); the bare constant is that sentence for a caller that has no figure,
 * and says so instead of guessing one.
 */
export function androidToolchainConsent(bytes?: number | null): string {
  const size = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0
    ? `about ${fmtDownload(bytes)} to download`
    : "the download size depends on what is already installed";
  return `Install a JDK and the Android SDK into your home directory (${size}, no sudo) and accept the Android SDK licence: https://developer.android.com/studio/terms`;
}
export const ANDROID_TOOLCHAIN_CONSENT = androidToolchainConsent(null);

/** "160 MB" / "1.2 GB", rounded to tens of MB: an estimate, shown as one. */
function fmtDownload(bytes: number): string {
  const mb = Math.max(10, Math.round(bytes / 1048576 / 10) * 10);
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** What the phone says before the `signing-key` fix runs: where it goes, its mode, why it matters. */
export const SIGNING_KEY_CONSENT =
  "Creates an Android signing key on this desktop in <config dir>/keys/ (readable only by you, mode 600) and points this repo's gitignored keystore.properties at it. " +
  "Back it up: lose it and installed apps can no longer be updated.";

/** The env var the CLI reads, ahead of every settings file. */
export const AUTO_COMPACT_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/**
 * Read one value as the CLI's setting is written: `"auto"`, a size with a `k`/`M`
 * suffix (`"400k"`, `"1M"`, `"1.5M"`), a bare integer string, or a JSON number.
 * Anything else is `unparseable` carrying what was there — a row that quoted
 * a guessed number for `"lots"` would be a wrong number, and heuristics here
 * degrade to absent, never to wrong.
 */
export function parseAutoCompactWindow(raw: unknown): AutoCompactValue {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? { kind: "size", tokens: Math.round(raw) } : { kind: "unparseable", raw: String(raw) };
  }
  if (typeof raw !== "string") return { kind: "unparseable", raw: JSON.stringify(raw) ?? String(raw) };
  const s = raw.trim();
  if (/^auto$/i.test(s)) return { kind: "auto" };
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(s);
  if (!m) return { kind: "unparseable", raw };
  const mult = m[2] === "" ? 1 : /k/i.test(m[2]) ? 1_000 : 1_000_000;
  const tokens = Math.round(Number(m[1]) * mult);
  return tokens > 0 ? { kind: "size", tokens } : { kind: "unparseable", raw };
}

/** One settings file as the host read it. `text: null` = the file is absent. */
export interface SettingsLayer {
  path: string;
  text: string | null;
}

export interface AutoCompactInputs {
  /** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the environment a spawned session gets. */
  env?: string;
  local: SettingsLayer;
  project: SettingsLayer;
  user: SettingsLayer;
}

export interface AutoCompactResolution {
  source: AutoCompactSource;
  /** The value exactly as written at that source; absent when unset. */
  raw?: string;
  value: AutoCompactValue;
  /** Where the winning value lives (the file, or the env var's name). */
  where?: string;
  /** Settings files that exist but are not a JSON object — the CLI cannot
   *  read them either, so a key in one decides nothing. Named, never skipped
   *  in silence. */
  unreadable: string[];
}

/** The key out of one settings file: `undefined` when absent, `null` when the
 *  file itself cannot be read as an object. */
function keyOf(text: string | null): unknown | null | undefined {
  if (text == null) return undefined;
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return (obj as Record<string, unknown>).autoCompactWindow;
}

/** env > local > project > user > unset (see the header for how much of that
 *  was verified). */
export function resolveAutoCompact(inp: AutoCompactInputs): AutoCompactResolution {
  const unreadable: string[] = [];
  const layers: [Exclude<AutoCompactSource, "env" | "unset">, SettingsLayer][] =
    [["local", inp.local], ["project", inp.project], ["user", inp.user]];
  const found: { source: AutoCompactSource; raw: unknown; where: string }[] = [];
  if (inp.env != null && inp.env.trim() !== "") found.push({ source: "env", raw: inp.env, where: AUTO_COMPACT_ENV });
  for (const [source, l] of layers) {
    const v = keyOf(l.text);
    if (v === null) { unreadable.push(l.path); continue; }
    if (v !== undefined) found.push({ source, raw: v, where: l.path });
  }
  const win = found[0];
  if (!win) return { source: "unset", value: { kind: "auto" }, unreadable };
  const raw = typeof win.raw === "string" ? win.raw : JSON.stringify(win.raw) ?? String(win.raw);
  return { source: win.source, raw, value: parseAutoCompactWindow(win.raw), where: win.where, unreadable };
}

/** `400k`, `1M`, `1.5M` — the way the setting is written. */
export function formatTokenWindow(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const SOURCE_WORDS: Record<AutoCompactSource, string> = {
  env: `the ${AUTO_COMPACT_ENV} environment variable of the ${BRAND.displayName} daemon (it beats every settings file)`,
  local: "this repo's .claude/settings.local.json",
  project: "this repo's .claude/settings.json",
  user: "your user settings (~/.claude/settings.json)",
  unset: "nowhere — no settings file and no environment variable sets it",
};

export const AUTO_MEANS =
  "auto compacts near the model's own window — 1M on a 1M model, so one long agent can re-read ~1M on every step.";

/**
 * The row: its level and its sentence. Pass at a size ≤ 500k — or ≤ the
 * default the person chose in Settings, when that is larger, so the value the
 * checklist itself writes can never read as a warning; otherwise a WARN, never
 * a fail — nothing is broken, a conversation is only allowed to grow
 * expensive. That matches `context-weight`, the other row about what a repo
 * costs to run.
 */
export function autoCompactVerdict(r: AutoCompactResolution, chosen?: string): { status: "pass" | "warn"; detail: string } {
  const c = chosen ? parseAutoCompactWindow(chosen) : null;
  const okMax = Math.max(AUTO_COMPACT_OK_MAX, c?.kind === "size" ? c.tokens : 0);
  const from = `Set in ${SOURCE_WORDS[r.source]}.`;
  const broken = r.unreadable.length
    ? ` Not valid JSON (the CLI cannot read it either, so it decides nothing): ${r.unreadable.join(", ")}.`
    : "";
  const v = r.value;
  if (r.source === "unset") {
    return { status: "warn", detail: `autoCompactWindow is unset, so the CLI uses auto: ${AUTO_MEANS}${broken}` };
  }
  if (v.kind === "auto") {
    return { status: "warn", detail: `autoCompactWindow is "auto". ${from} ${cap(AUTO_MEANS)}${broken}` };
  }
  if (v.kind === "unparseable") {
    return {
      status: "warn",
      detail: `autoCompactWindow is ${JSON.stringify(v.raw)}, which is not a size this check can read (expected "auto", "400k", "1M"…). ${from}${broken}`,
    };
  }
  const size = formatTokenWindow(v.tokens);
  if (v.tokens <= okMax) {
    return { status: "pass", detail: `autoCompactWindow is ${size}: a conversation compacts before its window passes ~${size}. ${from}${broken}` };
  }
  return {
    status: "warn",
    detail: `autoCompactWindow is ${size}: a conversation can grow to ~${size} before it compacts, and every step re-reads that window. ${from}${broken}`,
  };
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * Set `autoCompactWindow` in a settings file's text, keeping every other key
 * and its order (an existing key keeps its place; a new one is appended), in the
 * CLI's own 2-space-indent + trailing-newline form. `text: null` = no file yet.
 *
 * Refuses — writes nothing — when the file is there but is not a JSON object:
 * rewriting it would delete whatever the person had in it.
 */
export function withAutoCompactWindow(
  text: string | null, value: string,
): { ok: true; text: string } | { ok: false; error: string } {
  let obj: Record<string, unknown> = {};
  if (text != null && text.trim() !== "") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) {
      return { ok: false, error: `not valid JSON, left as it is (${(e as Error).message})` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "not a JSON object, left as it is" };
    }
    obj = parsed as Record<string, unknown>;
  }
  obj.autoCompactWindow = value;
  return { ok: true, text: JSON.stringify(obj, null, 2) + "\n" };
}
