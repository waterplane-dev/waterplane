/**
 * `<slug> setup-check [dir] [--json]` - the Setup check from a terminal, with the real file system
 * and no daemon, no network and no model call. The same collectors and rules the phone's sheet
 * uses (`setupcheck/`), minus the two sources that live in a running host (the session history and
 * the token ledger): their rules say "not checked", never pass. Exit 0 always: a reading, not a gate.
 */
import { resolve } from "node:path";
import { BRAND, checkedCountWords, clearRowWords, findingCut, groupCountWords, groupUnreadWords, repoRollupCut, notCheckedWords, passedWords, repoRollup, repoShown, savingWords, type Finding, type FindingsResult, type Rollup, type RollupInput } from "@waterplane/shared";
import { discoverTargets } from "../repos.js";
import { liveDeps } from "../setupcheck/store.js";
import { installChecklistStores } from "../setupprefs.js";
import { runSetupCheck, sweepRepos, type CollectDeps, type RepoOutcome, type SetupCheckDoc } from "../setupcheck/collect.js";

export interface SetupCheckArgs { dir: string | null; json: boolean; help: boolean; all: boolean }

export function parseSetupCheckArgs(args: string[]): SetupCheckArgs | { error: string } {
  const out: SetupCheckArgs = { dir: null, json: false, help: false, all: false };
  for (const a of args) {
    if (a === "--json") out.json = true;
    else if (a === "--all") out.all = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) return { error: `unknown option "${a}".` };
    else if (out.dir === null) out.dir = a;
    else return { error: "only one directory can be checked." };
  }
  return out;
}

export const SETUP_CHECK_HELP = `usage: ${BRAND.slug} setup-check [dir] [--json]
       ${BRAND.slug} setup-check --all [root] [--json]

  Read this folder's agent setup and this desktop's: ranked findings, what was checked and
  found fine, and what could not be checked. Reads files only. Always exits 0.

  --all   check every repo under root (default: the current folder): each repeated finding once
          with its repos, then the repos with nothing open and the repos not checked.
`;

const SCOPE_TITLE: Record<string, string> = { repo: "This repo", machine: "This desktop", account: "Account" };
const SCOPES = ["repo", "machine", "account"] as const;

/** The text report. Pure. */
export function setupCheckLines(doc: FindingsResult & { absent?: { what: string; why: string }[] }): string[] {
  const lines: string[] = [checkedCountWords(doc.findings.length, doc.passed.length, doc.notChecked.length), ""];
  for (const scope of SCOPES) {
    const rows = doc.findings.filter((f: Finding) => f.scope === scope);
    if (!rows.length) continue;
    lines.push(SCOPE_TITLE[scope]!);
    rows.forEach((f, i) => {
      lines.push(`  ${i + 1}. ${f.what}`);
      const s = f.saving ? savingWords(f.saving) : null;
      if (s) lines.push(`     ${s}`);
      if (f.backends.unread.length) lines.push(`     not read: ${f.backends.unread.map((u) => `${u.id} (${u.why})`).join("; ")}`);
    });
    lines.push("");
  }
  if (!doc.findings.length) lines.push("Nothing to fix.", "");
  if (doc.passed.length) {
    lines.push("Checked, nothing to fix");
    for (const p of doc.passed) lines.push(`  - ${passedWords(p)}`);
    lines.push("");
  }
  if (doc.notChecked.length) {
    lines.push("Not checked");
    for (const n of doc.notChecked) lines.push(`  - ${notCheckedWords(n)} [${n.rule}]`);
    lines.push("");
  }
  if (doc.absent?.length) {
    lines.push("Could not read");
    for (const a of doc.absent) lines.push(`  - ${a.what}: ${a.why}`);
    lines.push("");
  }
  return lines;
}

/** Sources that live in a running host are absent here: their rules say "not checked". */
export function cliDeps(root: string): CollectDeps {
  const d = liveDeps({
    root,
    tokenStats: { read: async () => { throw new Error("the token ledger is kept by the running host"); } },
    usage: () => null,
    billing: () => "unknown",
  });
  return { ...d, points: async () => { throw new Error("the session history is kept by the running host"); } };
}

/** The all-repos text report. Pure: groups, then repos with nothing open, then repos not checked. */
export function allReposLines(r: Rollup, machine: number): string[] {
  const n = r.groups.length + r.clear.length + r.notChecked.length;
  const lines: string[] = [`${r.groups.length} ${r.groups.length === 1 ? "finding" : "findings"} across ${n ? "repos" : "no repos"} · ${r.clear.length} with nothing open · ${r.notChecked.length} not checked`, ""];
  for (const g of r.groups) {
    const cut = repoRollupCut(r, { rule: g.rule });
    lines.push(`${g.what}`, `  ${groupCountWords(cut.count, cut.of)}${cut.unread ? ` · ${groupUnreadWords(cut.unread)}` : ""}`);
    for (const x of g.repos) {
      const s = x.saving ? savingWords(x.saving) : null;
      lines.push(`  - ${x.name}${s ? ` (${s})` : ""}`);
    }
    lines.push("");
  }
  if (!r.groups.length && !r.notChecked.length && !r.clear.length) lines.push("No repos found.", "");
  if (machine > 0) lines.push(`This desktop: ${machine} ${machine === 1 ? "finding" : "findings"} (run \`${BRAND.slug} setup-check\` for them)`, "");
  lines.push("Session history is kept by the running host: no saving lines here.", "");
  if (r.clear.length) {
    lines.push("Nothing open");
    for (const c of r.clear) lines.push(`  - ${c.name} (${clearRowWords(c.passed, c.notChecked)})`);
    lines.push("");
  }
  if (r.notChecked.length) {
    lines.push("Not checked");
    for (const c of r.notChecked) lines.push(`  - ${c.name}: ${c.why}`);
    lines.push("");
  }
  return lines;
}

async function runAll(root: string, json: boolean, deps?: (root: string) => CollectDeps): Promise<number> {
  try {
    const targets = (await discoverTargets(root)).filter((t) => t.isPrimary);
    const outcomes = new Map<string, RepoOutcome>();
    await sweepRepos((deps ?? cliDeps)(root), targets.map((t) => ({ id: t.id, name: repoShown(t), worktree: t.worktreePath })), outcomes);
    const inputs: RollupInput[] = targets.map((t) => {
      const o = outcomes.get(t.id);
      const name = repoShown(t);
      return !o ? { repoId: t.id, name, notChecked: "the sweep did not reach this repo" }
        : "doc" in o ? { repoId: t.id, name, result: o.doc, at: o.doc.at } : { repoId: t.id, name, notChecked: o.why };
    });
    const rollup = repoRollup(inputs);
    const first = [...outcomes.values()].find((o): o is { doc: SetupCheckDoc } => "doc" in o);
    const machine = first ? findingCut(first.doc.findings, { scope: "machine" }).count : 0;
    if (json) console.log(JSON.stringify({ rollup, machine, total: targets.length }));
    else for (const l of allReposLines(rollup, machine)) console.log(l);
  } catch (e) {
    console.error(`${BRAND.slug}: setup-check: ${e instanceof Error ? e.message : String(e)}`);
  }
  return 0;
}

/**
 * `stateRoot` = the daemon root whose state dir holds what the person set on the phone (waivers, ignores,
 * per-repo context lines, the chosen auto-compact window). Without it the CLI reads the same root the daemon
 * would (loaded here, not at the top: `env.js` reads the .env files); injected deps read no stores.
 */
export async function run(args: string[], deps?: (root: string) => CollectDeps, stateRoot?: string): Promise<number> {
  const a = parseSetupCheckArgs(args);
  if ("error" in a) { console.error(`${BRAND.slug}: setup-check: ${a.error}\n\n${SETUP_CHECK_HELP}`); return 2; }
  if (a.help) { console.log(SETUP_CHECK_HELP); return 0; }
  const dir = resolve(a.dir ?? process.cwd());
  const stores = stateRoot ?? (deps ? null : (await import("../env.js")).ROOT);
  if (stores) installChecklistStores(stores);
  if (a.all) return runAll(dir, a.json, deps);
  let doc: SetupCheckDoc;
  try { doc = await runSetupCheck((deps ?? cliDeps)(dir), dir); } catch (e) {
    console.error(`${BRAND.slug}: setup-check: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  if (a.json) console.log(JSON.stringify(doc));
  else for (const l of setupCheckLines(doc)) console.log(l);
  return 0;
}
