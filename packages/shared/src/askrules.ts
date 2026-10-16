/**
 * Ask rules — the irreversible-action tap (docs/plans/agent-authority.md §2).
 *
 * One desktop-wide list of Claude Code permission-rule strings (`Bash(git push * main)`),
 * each with an optional per-repo "off here". The host injects the list into every
 * CLAUDE launch as `permissions.ask` in the `--settings` blob it already passes; the CLI
 * itself then draws a box naming the exact command, and `answergate.isBlocked` keeps tool
 * boxes person-only. Nothing here applies anything: the suggested list is OFFERED, never
 * switched on, and a change reaches only sessions launched after it.
 *
 * Honest reach: it stops the accident, not the adversary — a wrapper script, an alias or a
 * subprocess running the same command is not seen by the rule.
 */

export interface AskRule {
  /** Stable id the phone toggles by. */
  id: string;
  /** A Claude Code permission rule: `Tool(spec)` or a bare tool name. */
  rule: string;
  /** Repo REALPATHS where this rule is switched off. Absent/empty ⇒ on everywhere. */
  offIn?: string[];
}

export interface AskRulesDoc {
  rules: AskRule[];
}

/** `GET /api/askrules` and a successful `PUT`'s answer. */
export interface AskRulesReply {
  ok: true;
  doc: AskRulesDoc;
  /** Offered as one tap; never applied by the host. */
  suggested: readonly string[];
  /** Backend ids whose sessions take these rules; every other backend runs without them. */
  honouredBy: readonly string[];
  /** PUT only: how many sent rows were dropped as not a permission rule, a repeat or past the cap. */
  dropped?: number;
  /**
   * Set when the list on disk could not be read at boot, so the host started with NO rules:
   * where the unreadable bytes went (null when they could not be moved aside) and why. An
   * empty list must not read as "nothing was ever asked for" — every launch since boot ran
   * without the rules the person set. Cleared by the next save that lands.
   */
  lost?: { movedTo: string | null; error: string };
  /**
   * A short hash of the stored list this reply describes. A PUT names it back, so a phone
   * holding an older copy (a second phone saved in between) is refused rather than
   * overwriting a list it never saw.
   */
  rev: string;
  /**
   * The one-shot confirm a PUT must carry (`confirmgate.ts` (b)), bound to `rev`. A
   * successful PUT answers with a fresh one, so the phone can save again without a re-read.
   * Absent where the host keeps no rules it can change (the demo).
   */
  confirm?: string;
}

/** The PUT body: the whole next list, plus the `rev` and `confirm` of the reply it was edited from. */
export interface AskRulesPut {
  rules: AskRule[];
  rev: string;
  confirm: string;
}

/** The host's refusal when the list changed since the phone read it — nothing was written. */
export const ASK_RULES_STALE = "the ask rules changed elsewhere — reopen to see them; nothing was changed";

export const ASK_RULES_MAX = 64;
export const ASK_RULE_MAX_CHARS = 200;
const OFF_IN_MAX = 256;
const PATH_MAX_CHARS = 4096;

/**
 * The suggested list, verbatim from the plan, spelled as permission rules. `*` matches
 * anywhere in the command (measured: `Bash(echo wpauth * main)` matched
 * `echo wpauth origin main` and a compound `cd /tmp && echo wpauth origin main`).
 */
export const SUGGESTED_ASK_RULES: readonly string[] = [
  "Bash(git push --force*)",
  "Bash(git push -f*)",
  "Bash(git push * --force*)",
  "Bash(git push * -f*)",
  "Bash(git push * main)",
  "Bash(git push * main *)",
  "Bash(git push * master)",
  "Bash(git push * master *)",
  "Bash(gcloud run deploy *)",
  "Bash(gcloud app deploy *)",
  "Bash(vercel --prod*)",
  "Bash(vercel * --prod*)",
  "Bash(fly deploy*)",
  "Bash(gh release create*)",
  "Bash(gh pr merge*)",
  "Bash(npm publish*)",
  "Bash(terraform apply*)",
  "Bash(kubectl apply*)",
];

/**
 * The backends whose sessions take `permissions.ask` — the claude CLI under its three
 * launch shapes. Another backend, a shell, anything else: no such rule, and the phone says so
 * rather than implying cover.
 */
export const ASK_RULE_BACKENDS: readonly string[] = ["claude", "claude-local", "claude-endpoint"];

/** Does a session on this backend (absent ⇒ claude) take ask rules? */
export function askRulesHonoured(backendId?: string | null): boolean {
  return !backendId || ASK_RULE_BACKENDS.includes(backendId);
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const RULE_RE = /^[A-Za-z][A-Za-z0-9_-]*(?:\(.+\))?$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A permission-rule string as typed, trimmed; `null` when it does not look like one. */
export function cleanAskRule(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > ASK_RULE_MAX_CHARS || CONTROL_RE.test(s)) return null;
  if (!RULE_RE.test(s)) return null;
  return s;
}

/** A stable id derived from the rule's words (FNV-1a), for a row that came without one. */
export function askRuleId(rule: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < rule.length; i++) {
    h ^= rule.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `r${h.toString(36)}`;
}

/** A repo path with its trailing slashes off (`/` stays `/`). */
export function trimPathSlash(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t || "/";
}

function cleanOffIn(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const raw1 of raw) {
    if (typeof raw1 !== "string" || !raw1.startsWith("/") || raw1.length > PATH_MAX_CHARS || CONTROL_RE.test(raw1)) continue;
    const p = trimPathSlash(raw1);
    if (!out.includes(p)) out.push(p);
    if (out.length >= OFF_IN_MAX) break;
  }
  return out;
}

/**
 * Strict: an entry whose rule does not look like a permission rule is DROPPED, never
 * repaired; a repeated rule or id keeps its first row; past `ASK_RULES_MAX` the rest go.
 * A bare string is accepted as a rule with a derived id.
 */
export function cleanAskRules(raw: unknown): AskRulesDoc {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as { rules?: unknown }).rules : null;
  const rules: AskRule[] = [];
  if (!Array.isArray(list)) return { rules };
  const seenRule = new Set<string>();
  const seenId = new Set<string>();
  for (const e of list) {
    if (rules.length >= ASK_RULES_MAX) break;
    const obj = typeof e === "string" ? { rule: e } : e && typeof e === "object" ? (e as Record<string, unknown>) : null;
    if (!obj) continue;
    const rule = cleanAskRule(obj.rule);
    if (!rule || seenRule.has(rule)) continue;
    const id = typeof obj.id === "string" && ID_RE.test(obj.id) ? obj.id : askRuleId(rule);
    if (seenId.has(id)) continue;
    seenRule.add(rule);
    seenId.add(id);
    const offIn = cleanOffIn(obj.offIn);
    rules.push(offIn.length ? { id, rule, offIn } : { id, rule });
  }
  return { rules };
}

/** The rule strings that apply to a launch in this repo (by its realpath). */
export function askRulesFor(doc: AskRulesDoc, repoRealpath: string): string[] {
  return doc.rules.filter((r) => !r.offIn?.includes(repoRealpath)).map((r) => r.rule);
}
