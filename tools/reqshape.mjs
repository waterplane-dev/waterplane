/**
 * The requirements list's own shape (docs/requirements/*.md), checked without a model call:
 * every heading parses, an ID's area is its file's name, no ID is used twice, the status is one
 * of the four words (skill `requirements`: any other word HIDES the item from the phone's list
 * and the counts), a superseded item says by what and that item exists, `superseded-by` sits
 * only on a superseded item, and every commit-looking token on a `shipped:` line is a commit in
 * this repo. Whether two items contradict each other is not a shape and is not checked here.
 *
 * `shipped:` is free text on purpose (a work-package name, "this commit", a note), so only its
 * 7–40-hex tokens are looked up, and a shipped item with no commit is allowed: "a commit or the
 * code shows it".
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const STATUSES = ["requested", "shipped", "superseded", "dropped"];
const SHA = /\b[0-9a-f]{7,40}\b/g;

/** Items from one area file's text. */
export function parseArea(file, text) {
  const out = [];
  for (const block of text.split(/^(?=### )/m)) {
    if (!block.startsWith("### ")) continue;
    const head = block.split("\n", 1)[0].trim();
    const h = /^### (\S+) · (\S+)$/.exec(head);
    const it = { file, head, id: h?.[1] ?? null, status: h?.[2] ?? null, shas: [], supersededBy: null };
    for (const line of block.split("\n")) {
      const s = /^- shipped: (.*)$/.exec(line);
      if (s) it.shas.push(...(s[1].match(SHA) ?? []));
      const b = /^- superseded-by: (.*)$/.exec(line);
      if (b) it.supersededBy = b[1].trim();
    }
    out.push(it);
  }
  return out;
}

/** Problems as `<ID or file>: <sentence>`, from parsed items. `known` = commits that exist
 *  (a Set), or null when there is no git to ask: then commits are not checked. */
export function shapeProblems(items, known) {
  const out = [];
  const seen = new Map();
  for (const it of items) {
    if (!it.id) { out.push(`${it.file}: heading does not parse: ${it.head}`); continue; }
    const area = it.file.replace(/\.md$/, "");
    if (!new RegExp(`^R-${area}-\\d{3}$`).test(it.id)) out.push(`${it.id}: ID is not R-${area}-<nnn> (file ${it.file})`);
    if (seen.has(it.id)) out.push(`${it.id}: used twice (${seen.get(it.id)} and ${it.file})`);
    seen.set(it.id, it.file);
    if (!STATUSES.includes(it.status)) out.push(`${it.id}: status "${it.status}" is not one of ${STATUSES.join("/")} — the phone hides it`);
  }
  for (const it of items) {
    if (!it.id) continue;
    if (it.status === "superseded" && !it.supersededBy) out.push(`${it.id}: superseded but no superseded-by`);
    if (it.supersededBy && it.status !== "superseded") out.push(`${it.id}: superseded-by on a ${it.status} item`);
    if (it.supersededBy && !seen.has(it.supersededBy)) out.push(`${it.id}: superseded-by ${it.supersededBy}, which does not exist`);
    if (it.supersededBy === it.id) out.push(`${it.id}: superseded by itself`);
    if (known) for (const s of it.shas) if (!known.has(s)) out.push(`${it.id}: shipped ${s} is not a commit here`);
  }
  return out;
}

/** Every item under `<root>/docs/requirements`. */
export function readAll(root) {
  const dir = join(root, "docs", "requirements");
  return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()
    .flatMap((f) => parseArea(f, readFileSync(join(dir, f), "utf8")));
}

/** The subset of `shas` that are commits in the repo at `root`, or null with no git there — and null
 *  when the history holds none of them: the public snapshot and the mirror start their own history,
 *  so a cited commit is "not here" because the repo is a copy, not because the note is wrong. */
export function knownCommits(root, shas) {
  const list = [...new Set(shas)];
  let out;
  try {
    out = execFileSync("git", ["cat-file", "--batch-check"], {
      cwd: root, input: list.map((s) => `${s}^{commit}`).join("\n") + "\n", stdio: ["pipe", "pipe", "ignore"],
    }).toString().split("\n");
  } catch { return null; }
  const known = new Set(list.filter((_, i) => out[i] && !/ (missing|ambiguous)$/.test(out[i])));
  return list.length > 0 && known.size === 0 ? null : known;
}
