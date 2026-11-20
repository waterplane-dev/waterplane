/**
 * Home's words for its numbers (whole-app journey spec D2, glossary §3): every count carries its
 * noun — "6 modified files", "2 to commit", "3 to fix" — never a bare figure. Pure, node-tested
 * (`homeWords.test.mjs`); the counts themselves come from the callers' own buckets, never re-cut here.
 */
import type { RepoTarget } from "@waterplane/shared";
import { behindLabel, incomingReading } from "../../gitCounts.ts";

/** "1 branch copy", "3 branch copies": n with its noun, singular at exactly one. */
export function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The repo row's files badge: what Claude left since it was last opened. */
export const newFilesWords = (n: number): string => counted(n, "modified file", "modified files");

/**
 * The repo row's git badge, worded: "2 to commit · 1 to push · 3 to pull". `""` when nothing waits
 * (the caller then says "Changes", the screen it opens). ↓ keeps `behindLabel`'s honesty: a count
 * nobody fetched recently is "? to pull" only when nonzero is unknown, and nothing at all when zero
 * is all it could say — the git sheet states how old it is.
 */
export function gitWords(r: Pick<RepoTarget, "changedCount" | "ahead" | "behind" | "fetchedAt">, now = Date.now()): string {
  return gitParts(r, now).join(" · ");
}

/** gitWords one fact at a time: "2 to commit", "1 to push", "3 to pull" — the repo header lists them stacked. */
export function gitParts(r: Pick<RepoTarget, "changedCount" | "ahead" | "behind" | "fetchedAt">, now = Date.now()): string[] {
  const parts: string[] = [];
  if (r.changedCount > 0) parts.push(`${r.changedCount} to commit`);
  if ((r.ahead ?? 0) > 0) parts.push(`${r.ahead} to push`);
  const inc = incomingReading(r, now);
  if (inc.kind !== "none" && inc.behind > 0) parts.push(`${behindLabel(inc)} to pull`);
  return parts;
}

/** The repo ⋯'s setup line: the screen's title, then the findings as a worded count. */
export function setupLine(setup?: { issues: number }): string {
  return setup && setup.issues > 0 ? `Setup & health · ${setup.issues} to fix` : "Setup & health";
}

/** An extension's menu label as a line in a titled menu: first letter upper case, the rest kept. */
export const capFirst = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The extensions whose repo ⋯ line is WORK (the rest group under "Set up"). */
export const WORK_EXT: ReadonlySet<string> = new Set(["requirements"]);

/** The Home chip for questions: "1 question", "2 questions". */
export const questionsWords = (n: number): string => counted(n, "question", "questions");
