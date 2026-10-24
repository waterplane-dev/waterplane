/**
 * The ask-rule list (docs/plans/agent-authority.md §2): `<STATE_DIR>/askrules.json`.
 *
 * Same shape as `notifyprefs.ts`: tmp+rename, corrupt or unreadable ⇒ an EMPTY list (no
 * rule active is the shipped default). Unlike a preference, that empty list is NOT silent:
 * the person set these rules, every launch since boot runs without them, so `lost()` keeps
 * what `readJsonGuardedDetail` reported and the phone says it until a save lands.
 * Cleaned on the way in AND out by `shared/askrules.ts`, so a hand-edit cannot put an
 * unreadable rule into a launch.
 *
 * A settable singleton (as `setupprefs.ts`) because the reader is `SessionManager.create`,
 * which builds the launch request; with no store installed (a test, `--doctor`) every
 * launch gets no rules — byte-identical to before this existed.
 *
 * Read per LAUNCH: a change reaches sessions started after it; a running session keeps
 * the rules it was launched with.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { askRulesFor, cleanAskRules, trimPathSlash, type AskRule, type AskRulesDoc } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";

export class AskRulesStore {
  private path: string;
  private doc: AskRulesDoc = { rules: [] };
  private lostAtBoot: { movedTo: string | null; error: string } | null = null;

  constructor(root: string) {
    const dir = hostStateDir(root);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "askrules.json");
    try {
      if (existsSync(this.path)) {
        const read = readJsonGuardedDetail<unknown>(this.path, null);
        if (read.corrupt) this.lostAtBoot = read.corrupt;
        this.doc = cleanAskRules(read.value);
      }
    } catch (e) {
      // Never throw on boot — but a list that could not be read is a lost list, said.
      this.lostAtBoot = { movedTo: null, error: String((e as Error)?.message ?? e) };
    }
  }

  /** Why the stored list could not be read at boot (the host then runs with none); null when it was. */
  lost(): { movedTo: string | null; error: string } | null {
    return this.lostAtBoot;
  }

  get(): AskRulesDoc {
    return cleanAskRules(this.doc);
  }

  /**
   * Replace the whole list (the phone sends what it shows). Returns what was kept.
   * THROWS when the file cannot be written, and then changes nothing in memory either —
   * a list the next boot would not find must not be reported as saved.
   */
  set(raw: unknown): AskRulesDoc {
    const cleaned = cleanAskRules(raw);
    const next: AskRulesDoc = { rules: cleaned.rules.map(dedupeOffIn) };
    writeJsonAtomic(this.path, next, { space: 2 });
    this.doc = next;
    this.lostAtBoot = null;
    return this.get();
  }

  /** The rule strings a launch in `cwd` is given; realpath-keyed like every per-repo store. */
  rulesFor(cwd: string): string[] {
    let real = cwd;
    try { real = realpathSync(cwd); } catch { /* a cwd that cannot be resolved keeps its own spelling */ }
    return askRulesFor({ rules: this.doc.rules.map(resolvedOffIn) }, trimPathSlash(real));
  }

  /** A short hash of the stored list — what a PUT's confirm is bound to. */
  rev(): string {
    return createHash("sha256").update(JSON.stringify(this.get())).digest("hex").slice(0, 12);
  }
}

/** A path resolved through symlinks, slash-trimmed; its own spelling when it cannot be (a repo gone). */
function realOf(p: string): string {
  try { return trimPathSlash(realpathSync(p)); } catch { return trimPathSlash(p); }
}

function resolvedOffIn(r: AskRule): AskRule {
  return r.offIn?.length ? { ...r, offIn: r.offIn.map(realOf) } : r;
}

/** One entry per repo: a second spelling of a path already listed (same realpath) is dropped. */
function dedupeOffIn(r: AskRule): AskRule {
  if (!r.offIn?.length) return r;
  const seen = new Set<string>();
  const offIn = r.offIn.filter((p) => { const k = realOf(p); if (seen.has(k)) return false; seen.add(k); return true; });
  return { ...r, offIn };
}

let current: AskRulesStore | null = null;

export function setAskRulesStore(store: AskRulesStore | null): void {
  current = store;
}

export function askRulesStore(): AskRulesStore | null {
  return current;
}

/** The ask rules a launch in `cwd` is given (claude: `permissions.ask`; a gate backend: the gate's); empty with no store. */
export function askRulesForCwd(cwd: string | undefined): string[] {
  if (!current || !cwd) return [];
  try { return current.rulesFor(cwd); } catch { return []; }
}

/**
 * Does an ask rule match this text? For the answer GATE (`answergate.ts`, `askRulesVia: "gate"`),
 * where the command sits inside a dialog's prose rather than being the whole line, so the rule's
 * pattern is looked for ANYWHERE: `Bash(git push*)` → `git push` followed by anything. The tool
 * name is dropped (a dialog names its tool in its own words), `*` is any run, case and whitespace
 * runs are ignored. Matching too much refuses an automatic answer — a person then taps it — which
 * is the safe direction; a bare tool rule (`Bash`) or a pattern of only `*` matches nothing here.
 */
export function askRuleMatches(rule: string, text: string): boolean {
  const m = /^[A-Za-z][A-Za-z0-9_-]*\((.+)\)$/.exec(rule.trim());
  const pat = m?.[1]?.trim();
  if (!pat || !pat.replace(/\*/g, "").trim()) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const re = norm(pat).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*")).join(".*");
  return new RegExp(re).test(norm(text));
}

/** The first ask rule the text matches, or null. */
export function askRuleHit(rules: readonly string[], text: string): string | null {
  return rules.find((r) => askRuleMatches(r, text)) ?? null;
}
