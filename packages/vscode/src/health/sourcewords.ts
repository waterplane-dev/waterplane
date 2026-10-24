/**
 * What the Health tab says about where the series it shows comes from. Pure and free of node
 * imports: the webview bundles it too.
 */
import { BRAND, REPOHEALTH_OWN_FILE } from "@waterplane/shared";
import type { RepoHealthPlot } from "@waterplane/shared";
import type { HealthDoc } from "../protocol.js";
import { NO_RUN } from "../shims/healthnorun.js";

type SourceFields = Pick<HealthDoc, "source" | "scope" | "repoFile" | "seriesFile"> & { series: { lastDay?: string | null } | null };

/** `.waterplane/repohealth.jsonl` out of an absolute path (either separator), for a sentence. */
const tail = (file: string): string => file.split(/[\\/]/).slice(-2).join("/");

/** One sentence: whose series this is, where it is, and that it is never written here. */
export function sourceWords(d: SourceFields): string {
  const last = d.series?.lastDay ? ` (last row ${d.series.lastDay})` : "";
  if (d.source === "repo") {
    const what = d.scope ? `the series for ${d.scope}` : "the series";
    return `Read from this folder's ${tail(d.seriesFile)}, ${what} measured by the ${BRAND.name} desktop app${last}. The extension never writes it.`;
  }
  const own = `The series is kept in this extension's own storage, at ${d.seriesFile}. It grows with the history.`;
  return d.repoFile
    ? `${own} It is newer than this folder's ${tail(d.repoFile)}, which the ${BRAND.name} desktop app measures and the extension only reads, never writes.`
    : own;
}

/** Said beside the measure button when the folder has a series of its own: where a measure goes. */
export function measureWords(d: Pick<HealthDoc, "repoFile">): string | null {
  return d.repoFile
    ? `Measure writes only this extension's own copy, never ${tail(d.repoFile)}. Whichever series has the newer last row is the one shown.`
    : null;
}

/**
 * The folder's series holds rows from more than one definition (or one that is not the engine's
 * current). It is the desktop app's file, so the remedy is named but no command is quoted: the
 * re-cut line deletes that file, and this extension never offers to run or print a deletion of it.
 */
export function repoMixedWords(
  versions: readonly { version: string; rows: number }[] | null | undefined, current?: string | null,
): string | null {
  const list = versions ?? [];
  const stale = list.length === 1 && !!current && list[0].version !== current;
  if (list.length < 2 && !stale) return null;
  const rows = (n: number): string => `${n} row${n === 1 ? "" : "s"}`;
  const what = stale
    ? `every row was measured under ${list[0].version} (${rows(list[0].rows)}), and the engine now measures under ${current}`
    : `the rows were measured under ${list.length} definitions of the same metric — ${list.map((v) => `${v.version}${v.version === current ? " (current)" : ""}: ${rows(v.rows)}`).join(", ")}`;
  return `The series read from this folder is the ${BRAND.name} desktop app's, and ${what}. Re-cut it from the ${BRAND.name} desktop app; the extension never rewrites it.`;
}

/**
 * The extension's OWN copy holds rows from an older definition (the bundled engine moved on with
 * an extension update). Unlike the desktop's file, this one is ours, so the remedy is the forget
 * button beside this sentence — never a command to type. Null when every row is current.
 */
export function ownMixedWords(
  versions: readonly { version: string; rows: number }[] | null | undefined, current?: string | null,
): string | null {
  const list = versions ?? [];
  const stale = list.length === 1 && !!current && list[0].version !== current;
  if (list.length < 2 && !stale) return null;
  const rows = (n: number): string => `${n} row${n === 1 ? "" : "s"}`;
  const what = stale
    ? `Every row in this extension's copy was measured under ${list[0].version} (${rows(list[0].rows)}), and the bundled engine now measures under ${current}`
    : `This extension's copy holds rows measured under ${list.length} definitions — ${list.map((v) => `${v.version}${v.version === current ? " (current)" : ""}: ${rows(v.rows)}`).join(", ")}`;
  return `${what}. The charts below still draw the rows as they are; a measure refuses to add to them rather than put two definitions on one plot. Forget this series and measure again to re-cut the whole history under the current one.`;
}

/** Every reading in a plot that is absent BECAUSE the extension would not run the repo's command. */
export function notRunHere(plot: RepoHealthPlot | null | undefined): { own: number; overrides: string[] } {
  const hit = (a: string | undefined): boolean => !!a && a.includes(NO_RUN);
  const own = (plot?.own?.series ?? []).filter((s) => hit(s.absent)).length;
  const overrides = (plot?.series ?? [])
    .filter((s) => s.variant?.kind === "override" && hit(s.variant.absent))
    .map((s) => s.label);
  return { own, overrides };
}

/**
 * One sentence, said once, when the folder's committed health.json asks for a command and the
 * extension did not run it (`shims/healthnorun.ts`). Null when nothing was refused — a series the
 * desktop app measured ran them there and carries their numbers.
 */
export function notRunWords(plot: RepoHealthPlot | null | undefined, file: string = REPOHEALTH_OWN_FILE): string | null {
  const { own, overrides } = notRunHere(plot);
  if (!own && !overrides.length) return null;
  const parts = [
    own ? `${own} reading${own === 1 ? "" : "s"} of its own` : null,
    overrides.length ? `its own version of ${overrides.join(", ")}` : null,
  ].filter(Boolean).join(" and ");
  return `This folder's ${file} asks for a command to measure ${parts}. The extension did not run it: it starts only git, never code from the folder. Those readings show as absent here with that reason. The ${BRAND.name} desktop app runs them, from the file as committed at HEAD, as code the repo supplies.`;
}

/** Under the "add one" line: who runs a declared reading, so the file is not written for this view. */
export function ownAddNoteWords(): string {
  return `The ${BRAND.name} desktop app runs what that file declares; this extension starts only git, so here they would show as absent.`;
}

/** The engine's stderr when the folder has no `.git` — git's own phrase, so it survives an engine bump. */
export const NOT_GIT = /not a git repository/i;

/** A folder with no git history, said plainly instead of quoting the engine's exit: nothing was
 *  wrong with the engine, and no rebuild answers it — only `git init` (or opening the repo root) does. */
export function notGitWords(): string {
  return "This folder is not a git repository. Repo health reads git history, one row per first-parent commit, so there is nothing to measure here. Open the repository's root folder, or run git init, then build the series.";
}

/** macOS's `/usr/bin/git` is a shim through Xcode; until Xcode's license is accepted it refuses every
 *  command with Apple's paragraph about `xcodebuild -license`. Matched on that command, not the prose. */
export const XCODE_LICENSE = /xcodebuild -license|Xcode license/i;

/** git itself is blocked on this Mac, said with its three fixes. Nothing in the folder or the
 *  extension is wrong, so neither a rebuild nor forgetting the series answers it — the view offers
 *  no Forget here, and the sentence says so, or the build button reads like a remedy. */
export function xcodeLicenseWords(): string {
  return "git is blocked on this Mac: Apple's git runs through Xcode, and Xcode's license has not been accepted, so it refuses every command, and no other git that runs was found (git.path, PATH, Homebrew's, the Command Line Tools'). Nothing is wrong with this folder or its series, and building again will not change that until git works. Fix it once in Terminal: sudo xcodebuild -license accept. Or, if the Command Line Tools are installed, sudo xcode-select -s /Library/Developer/CommandLineTools. Without admin rights, set VS Code's git.path to another git, such as Homebrew's. Then build the series.";
}

/** The read error said in our words when we know what it means; null = quote the engine. */
export function knownReadErrorWords(readError: string): string | null {
  if (XCODE_LICENSE.test(readError)) return xcodeLicenseWords();
  if (NOT_GIT.test(readError)) return notGitWords();
  return null;
}
