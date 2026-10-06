/**
 * One commit's tree, read once and handed to the metrics as plain data.
 *
 * ── Why "what counts as source" is not decided here ─────────────────────────
 *
 * It used to be, and the argument for deciding it exactly once now lives in
 * `source.mjs`, which every reader of a tree — this file and every metric that
 * takes a `path` — calls instead of filtering for itself. What `source.mjs`
 * decides AGAINST is no longer a constant either: `census.mjs` builds the
 * effective config from the packs the repo activates, and it is passed in
 * here rather than imported, so this module holds no opinion about what
 * language it is reading.
 *
 * ── Why LOC is not `wc -l` ─────────────────────────────────────────────────
 *
 * `wc -l` counts newlines, so it loses the last line of any file that does not
 * end in one. The two conventions differ by up to one line per file — 325 lines
 * repo-wide, which is precisely the size of the disagreement that makes two
 * "measured" totals irreconcilable a year later. `PREREG` pins the inclusive
 * one and this is the only implementation of it.
 *
 * ── Why derivation is memoised by oid and not by path ───────────────────────
 *
 * A path names a different file at every sha; an oid names the same bytes
 * forever. Decoding and counting 325 files × 155 commits is 50,000 operations
 * over ~2,000 distinct blobs, and keying the cache by path would recompute all
 * of them while looking like it did not.
 *
 * ── Why skill ownership is imported and never re-derived ───────────────────
 *
 * `SkillFile.headModules` is which modules a skill claims, and it comes from
 * `tools/skillmap.mjs`. "A module belongs to the skill whose bullet HEAD names
 * it" is one rule with three readers — the router's generated map,
 * `claudemd.test.mjs`'s drift check, and `context.mjs`'s per-area weight. A
 * second copy of that regex here would let the map the agent reads and the
 * cost this series reports disagree, silently, about who owns what, and the
 * disagreement would look like a measurement. The whole file text is scanned,
 * exactly as `ownership()` scans it, so both see the same bullets. The one
 * thing this file supplies is WHICH extensions count as a module name, which
 * is the active packs' business and not `skillmap.mjs`'s.
 *
 * ── Why the shape of the repo is derived here and not pinned ───────────────
 *
 * Three metrics used to hardcode `packages/<x>`: `cochange` for the boundary
 * coupling stops at, `classics` for the per-package LOC breakdown, `context`
 * for which commits are a task in which area. That string is a fact about one
 * monorepo. `groups` and `areas` below are the same two ideas derived from the
 * tree at each sha, so they are reproducible from a row's own sha and they say
 * nothing at all in a repo that has no such structure — which is the correct
 * answer there, and is not the same answer as zero.
 */
import { headModules } from "../skillmap.mjs";
import { inExcludedDir, isSource, isTestPath } from "./source.mjs";
import { scopeEntries } from "./scope.mjs";

/** oid -> { text, loc }. Same argument as the blob cache in `git.mjs`. */
const DERIVED = new Map();

/**
 * LOC per `PREREG.LOC_COUNTS_UNTERMINATED_LAST_LINE`: newlines, plus one when
 * the file's final line has content and no terminator.
 */
export function countLoc(text) {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}

function derive(oid, buf) {
  let d = DERIVED.get(oid);
  if (!d) {
    const text = buf.toString("utf8");
    d = { text, loc: countLoc(text) };
    DERIVED.set(oid, d);
  }
  return d;
}

const SKILL_PATH = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/;

/**
 * ── Source groups: the neighbourhood, derived ───────────────────────────────
 *
 * A GROUP is the unit inside which co-change is counted, the unit `classics`
 * breaks LOC down by, and the unit an area's commits are matched against. It
 * was the literal string `packages/<x>`.
 *
 * The rule that replaces it: a path's group is its FIRST SEGMENT, unless that
 * directory holds no source file of its own and has two or more source-bearing
 * children, in which case it is `first/second`. A file at the repo root is in
 * group `.`.
 *
 * It reproduces `packages/<x>` on this repo — `packages/` holds no source file
 * directly and has four source-bearing children — and it does the right thing
 * on the shapes it was not written for. A repo with `src/` at the root: `src`
 * holds files directly, so the group is `src` and coupling is counted across
 * the whole project, which is true, because there is no boundary there to
 * stop at. A repo with `app/` and `lib/` and nothing else: two first segments,
 * two groups. A Gradle multi-module build with `core/`, `ui/` and `data/`
 * under one parent: the parent has no sources of its own and three
 * source-bearing children, so the modules become the groups, exactly as
 * `packages/*` does.
 *
 * "Two or more", not one: a lone child is not a partition. A project whose
 * only code is `src/main/kotlin/**` should not have `src/main` invented as a
 * boundary, because a boundary with one side is not a boundary and coupling
 * inside it is coupling across the whole repo under another name.
 *
 * "Holds no source file of its own" is what keeps `tools/` and `scripts/`
 * whole: both have files directly in them, so they are one group each, and
 * `tools/repohealth/*` does not become a neighbourhood of its own just because
 * it is the only subdirectory with code in it.
 */
export function deriveGroups(paths) {
  /** first segment -> files directly inside it. */
  const direct = new Map();
  /** first segment -> second segments that contain source deeper down. */
  const children = new Map();
  let root = false;
  for (const p of paths) {
    const segs = p.split("/");
    if (segs.length === 1) {
      root = true;
      continue;
    }
    const head = segs[0];
    if (!direct.has(head)) {
      direct.set(head, 0);
      children.set(head, new Set());
    }
    if (segs.length === 2) direct.set(head, direct.get(head) + 1);
    else children.get(head).add(segs[1]);
  }
  const out = new Set();
  if (root) out.add(".");
  for (const [head, n] of direct) {
    const kids = children.get(head);
    if (n === 0 && kids.size >= 2) for (const kid of kids) out.add(head + "/" + kid);
    else out.add(head);
  }
  return [...out].sort();
}

/**
 * The group a path belongs to, given the snapshot's group list.
 *
 * Total by construction, like the `neighbourhood()` it replaces: a path the
 * groups do not cover — a history path whose file no longer exists, a
 * non-source path a caller passed anyway — gets its first segment rather than
 * `undefined`, because two `undefined`s compare equal and would silently
 * couple every stray path to every other one.
 *
 * Groups are at most two segments deep, so this is an exact lookup and not a
 * longest-prefix search.
 *
 * @param {string} path
 * @param {readonly string[]} groups  `Snapshot.groups`.
 */
export function groupOf(path, groups) {
  const segs = path.split("/");
  if (segs.length === 1) return ".";
  const two = segs[0] + "/" + segs[1];
  return groups.includes(two) ? two : segs[0];
}

/**
 * ── Areas: a router, the code it routes for, and what it routes to ──────────
 *
 * This is the table `PREREG.AREA_SKILLS` used to hold by hand, and every word
 * of the argument below was written about that table. It is all still true;
 * it has just stopped being about three typed-out entries.
 *
 * An area is a ROUTER, the source tree a task in it touches, and whatever else
 * that router routes to. The weight of an area is CLAUDE.md + EVERY skill's
 * description + the router + the bodies the task then loads. This deliberately
 * disagrees with CLAUDE.md's framing that skill bodies are on-demand and
 * therefore free: `web` says "load BEFORE reading anything under
 * packages/web", so for a web task that body is always-on. CLAUDE.md alone
 * went 88k to 11.7k and looks solved; the weight moved rather than left.
 *
 * ── Why router + prefix, and not a list of skills ───────────────────────────
 *
 * The sub-skills of an area are every skill named `<router>-*`, derived and
 * not listed, because a list is a second map that goes stale silently — add
 * `web-foo` and a hand-written list keeps reporting the area as if it did
 * not exist. The same argument `skillmap.mjs` makes about the router's own
 * module map: derive it, or it is wrong the first time something moves.
 *
 * That argument always applied one level up as well, and the table was where
 * it stopped: which skills ARE routers was itself a hand-written list of
 * three. So a router is now derived by the same rule that derives its
 * children — a skill `S` is a router when at least one skill named `S-*`
 * exists in this tree. Nothing declares it. On this repo that finds `host`
 * and `web` and does NOT find `shared`, which the table listed: there
 * has never been a `shared-*` skill, so `shared` routes to nothing
 * and is a leaf that the table was costing as an area with a `subs` count of
 * zero.
 *
 * `also` is for a skill the router genuinely routes to that is not under its
 * prefix. `host`'s map sends nine module lines to `heuristics`, so a
 * host task can load it exactly like a sub-skill; leaving it out would mean
 * that folding host prose into `heuristics` — which is what happened when
 * the 77k router was split — showed up as a saving. It is not one. The prose
 * is still loaded by the same tasks. Derived the same way: a skill name the
 * router's BODY writes in backticks, that exists in this tree, and that is not
 * already one of its `S-*` children.
 *
 * `src` is what makes a commit evidence about an area: it touched something in
 * that source group. It is found by looking for a group's path written
 * verbatim in the router's DESCRIPTION, which is where a router says what it
 * is for — waterplane's say "(packages/web/src)", and `packages/web` is a group. The
 * description and not the body, because the description is the only thing an
 * agent reads when choosing a skill, so a path promised there is the router's
 * actual claim about its territory.
 *
 * Where no path matches, the area exists with `src: null`. It is not dropped:
 * the router is real, its bodies are real characters an agent loads, and the
 * repo-wide always-on weight still counts them. What becomes absent is the
 * per-commit `expected` reading, because no commit can be attributed — and
 * absent with a reason is the honest form of that, never a zero, which would
 * read as an area that costs nothing to enter. Where a repo has no router
 * convention at all, `areas` is simply empty and the same thing is true of
 * every area at once.
 *
 * ── Why two numbers per area and not one ────────────────────────────────────
 *
 * `context.mjs` reports `expected` (the median over this repo's own non-batch
 * commits of what those commits' files would have made an agent load) and
 * `ceiling` (the router plus EVERY sub-skill body). One number cannot do it:
 * read the router alone and the 109k→7.7k split prints a 90% win in a week
 * nothing was deleted, and `MAX(sub body)` — the obvious repair — pays for
 * fragmentation instead, since splitting a 24k sub-skill into three 8k ones
 * drops the MAX by two thirds while the agent loads the same prose. `expected`
 * moves when routing improves, `ceiling` moves only when prose leaves. The
 * pair is the reading; either alone is a lever.
 */
function deriveAreas(skillTexts, groups) {
  const names = [...skillTexts.keys()].sort();
  const candidates = groups.filter((g) => g !== ".");
  const areas = [];
  for (const name of names) {
    const prefix = name + "-";
    if (!names.some((n) => n.startsWith(prefix))) continue;
    const { yaml, body } = skillTexts.get(name);
    const desc = skillDescription(yaml) ?? "";

    // Every group whose path is written in the description as a path, rather
    // than as a word that happens to be spelled the same. `packages/web` in
    // "(packages/web/src)" qualifies — a following `/` is fine — and
    // `packages/web` inside `packages/websocket` does not. `.` is never a
    // candidate: it occurs in every sentence ever written.
    const hits = candidates.filter((g) =>
      new RegExp(`(?<![\\w/.-])${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`).test(desc),
    );
    // Most specific wins. Two matches of equal length is a genuine ambiguity
    // and resolves to `null`, not to whichever sorted first: a wrong `src`
    // attributes another area's commits to this one, which is worse than
    // attributing none.
    hits.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    const src = hits.length === 0 || (hits.length > 1 && hits[0].length === hits[1].length) ? null : hits[0];

    const also = new Set();
    for (const m of body.matchAll(/`([^`\n]+)`/g)) {
      const n = m[1];
      if (n === name || n.startsWith(prefix) || !skillTexts.has(n)) continue;
      also.add(n);
    }

    areas.push({ router: name, src, also: [...also].sort() });
  }
  return areas;
}

/** The frontmatter block of a SKILL.md, or "" when it has none. */
function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  return m ? { yaml: m[1], body: text.slice(m[0].length) } : { yaml: "", body: text };
}

/**
 * The `description:` value as YAML would read it.
 *
 * Every skill in this repo's history writes it on one line, but a description
 * is the always-on half of a skill's cost and someone will eventually fold one
 * across lines to keep the file readable. A parser that only handled the
 * one-line form would then report that skill's always-on weight as the length
 * of `>-`, i.e. as ~2 chars, exactly when it grew large enough to be worth
 * wrapping. Block scalars (`|`, `>`, with any chomping indicator) and plain
 * multi-line continuations are all folded to the string YAML would yield;
 * literal blocks keep their newlines, folded ones join with a space.
 */
export function skillDescription(yaml) {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at === -1) return null;
  const head = lines[at].slice("description:".length).trim();
  const block = /^([|>])([+-]?\d*|\d*[+-]?)$/.exec(head);
  const cont = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      if (block) cont.push("");
      else break;
      continue;
    }
    if (!/^\s/.test(l)) break; // a new top-level key ends the value
    cont.push(l.trim());
  }
  while (cont.length && cont.at(-1) === "") cont.pop();
  if (block) return cont.join(block[1] === "|" ? "\n" : " ");
  const plain = [head, ...cont].filter((s) => s !== "").join(" ");
  const quoted = /^(['"])([\s\S]*)\1$/.exec(plain);
  return quoted ? quoted[2] : plain;
}

/**
 * `visual-check` is written at runtime by `packages/host/src/visualskill.ts`.
 * `PREREG.COUNT_GENERATED_SKILLS` counts it anyway — this metric asks what is
 * loaded, and a generated skill loads exactly like a written one — but it is
 * flagged so a narrative can say which half of a jump nobody typed. The
 * frontmatter declaration is checked first so a second generated preset needs
 * no edit here; `claudemd.test.mjs` exempts on the same marker.
 */
const GENERATED_MARKER = /^generated-by:\s*\S/m;
const GENERATED_NAMES = new Set(["visual-check"]);

/**
 * Read one commit's tree into the `Snapshot` of `types.mjs`.
 *
 * @param {string} root
 * @param {string} sha
 * @param {typeof import("./git.mjs")} git   Injected so this module spawns nothing.
 * @param {ReturnType<typeof import("./census.mjs").configure>} prereg
 *   The effective config. Passed rather than imported: this module used to
 *   read `PREREG` at module level, which made "what is source" a property of
 *   the process and not of the repo being measured — so a second root in one
 *   run would have been read with the first one's definitions.
 * @returns {import("./types.mjs").Snapshot}
 */
export function buildSnapshot(root, sha, git, prereg, scope = null) {
  // The ONE place a scope exists below the CLI: the entry list is cut to the
  // subtree and re-rooted, and everything after this line measures what it is
  // given without knowing whether it is a repo or part of one. See
  // `scope.mjs` for why that re-rooting is the whole mechanism.
  const entries = scopeEntries(git.listTree(root, sha), scope);

  const srcEntries = entries.filter((e) => isSource(e.path, prereg));
  const testEntries = entries.filter((e) => isTestPath(e.path, prereg) && !inExcludedDir(e.path, prereg.SRC.excludeDirs));
  const skillEntries = entries.filter((e) => SKILL_PATH.test(e.path));

  // A manifest is whatever an active pack says one is, at any depth, outside
  // the excluded directories — a committed `node_modules/*​/package.json` is
  // somebody else's declaration, not this project's.
  const manifestPacks = prereg.PACKS.filter((p) => p.pack.manifestPath);
  const manifestEntries = manifestPacks.map((p) => {
    const re = new RegExp(p.pack.manifestPath);
    return { pack: p, entries: entries.filter((e) => re.test(e.path) && !inExcludedDir(e.path, prereg.SRC.excludeDirs)) };
  });

  const claudeMd = entries.find((e) => e.path === "CLAUDE.md") ?? null;
  const agentsMd = entries.find((e) => e.path === "AGENTS.md") ?? null;

  // One batch for the whole snapshot; `git.mjs` drops the oids it already has.
  const wanted = [...srcEntries, ...testEntries, ...skillEntries];
  for (const m of manifestEntries) wanted.push(...m.entries);
  if (claudeMd) wanted.push(claudeMd);
  if (agentsMd) wanted.push(agentsMd);
  const blobs = git.readBlobs(root, wanted.map((e) => e.oid));
  const textOf = (e) => derive(e.oid, blobs.get(e.oid)).text;

  const files = srcEntries.map((e) => {
    const d = derive(e.oid, blobs.get(e.oid));
    return { path: e.path, oid: e.oid, text: d.text, loc: d.loc };
  });

  const groups = deriveGroups(files.map((f) => f.path));

  const tests = testEntries
    .map((e) => ({ path: e.path, text: textOf(e) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  /** name -> its frontmatter and body, for the area derivation below. */
  const skillTexts = new Map();
  const skills = skillEntries
    .map((e) => {
      const text = textOf(e);
      const { yaml, body } = frontMatter(text);
      const name = SKILL_PATH.exec(e.path)[1];
      skillTexts.set(name, { yaml, body });
      const desc = skillDescription(yaml);
      return {
        name,
        // A skill with no `description:` contributes no always-on characters,
        // which is a measured 0 rather than an absence.
        descriptionChars: desc === null ? 0 : desc.length,
        bodyChars: body.length,
        generated: GENERATED_MARKER.test(yaml) || GENERATED_NAMES.has(name),
        // Which modules this skill claims — see the note above `headModules`.
        // The active packs' extensions, so a router that names a `.kt` module
        // is read by the same rule as one that names a `.ts`.
        headModules: [...headModules(text, prereg.SRC.exts)].sort(),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  const manifests = [];
  for (const m of manifestEntries) {
    const rows = m.pack.pack.manifests(m.entries, textOf);
    if (!rows) continue;
    for (const r of rows) manifests.push({ pack: m.pack.name, ...r });
  }
  manifests.sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));

  const claudeText = claudeMd ? textOf(claudeMd) : null;

  return {
    sha,
    files, // already sorted by path: `listTree` sorts
    groups,
    claudeMdChars: claudeText === null ? null : claudeText.length,
    claudeMdLines: claudeText === null ? null : countLoc(claudeText),
    // Absent at every sha so far. `null`, never 0 — a repo with an empty
    // AGENTS.md and a repo with none are different claims.
    agentsMdLines: agentsMd ? countLoc(textOf(agentsMd)) : null,
    skills,
    areas: deriveAreas(skillTexts, groups),
    tests,
    manifests,
  };
}
