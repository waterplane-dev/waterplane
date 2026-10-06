/**
 * CLAUDE.md cannot be allowed to grow back.
 *
 * ── Why this is a test and not a sentence ───────────────────────────────────
 *
 * It already WAS a sentence. The file's own first paragraph said "keep this
 * under ~120k chars" and "add a subsystem ⇒ one line here, the why in the
 * notes", and it reached 148,582 chars anyway — 37k tokens, re-read on every
 * turn of every session and every subagent, measured at 21% of every token this
 * repo spent in a week. Nobody ignored the rule on purpose. Each edit added a
 * clause to one entry, every clause was worth writing, and none of them was the
 * one that broke it.
 *
 * That is the same argument `tools/eslint/rules.js` makes about `no-silent-send`
 * and `theme.test.mjs` makes about literal colours: a rule that is only prose
 * fails silently, weeks later, in a diff nobody reads as a violation. So the
 * three rules that keep this file small are checked here, and each failure says
 * what to do rather than only what is wrong.
 *
 * ── What is deliberately NOT checked ────────────────────────────────────────
 *
 * Nothing about content, wording or ordering. This file is the rules and it has
 * to stay readable and opinionated; the only thing under guard is that the
 * REASONING lives in `docs/notes/` and the RULE lives here. A budget is the one
 * mechanism that cannot be satisfied by writing more.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { descriptionModules, headModules, mapLines, ownership } from "./skillmap.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const MD = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");

/** A SKILL.md's frontmatter block, or "" when it has none. */
function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return m ? m[1] : "";
}

/**
 * A skill nobody in this repo wrote.
 *
 * `packages/host/src/visualskill.ts` writes `.claude/skills/visual-check/SKILL.md`
 * into any repo that has capture targets configured — this one included, the
 * moment `.waterplane/capture.json` gains a target. Every rule below would then be
 * asserted against a file no human here authored, and the one about CLAUDE.md
 * naming each skill would fail outright: the "which skill to load" table routes
 * by AREA OF THIS CODEBASE, and a repo-local preset addressed to the agent
 * working here is not a route. So the artifact declares what it is in its own
 * frontmatter and this exempts it on that declaration. A list of names here
 * would be wrong the day a second preset exists — and would also have to be kept
 * in step with a file written by the host, which is the drift this avoids.
 */
const GENERATED = /^generated-by:\s*\S/m;

/** The skills, which are the on-demand half of the same document. */
const SKILL_DIR = join(ROOT, ".claude", "skills");
function skills() {
  let names;
  try { names = readdirSync(SKILL_DIR); } catch { return []; }
  return names
    .map((n) => ({ name: n, path: join(SKILL_DIR, n, "SKILL.md") }))
    .filter((s) => { try { readFileSync(s.path); return true; } catch { return false; } })
    .map((s) => ({ ...s, text: readFileSync(s.path, "utf8") }))
    .filter((s) => !GENERATED.test(frontMatter(s.text)));
}

/**
 * The ceiling for the ALWAYS-ON file, in characters.
 *
 * `CLAUDE.md` is re-read on every turn of every session and every subagent, so
 * ~4 chars per token makes this ~3k tokens carried by everything the repo ever
 * does. The reference that used to live here is in `.claude/skills/`, which
 * costs a line of description until something actually loads it.
 *
 * **Raising this is a decision, not a fix.** If it fails, the question is which
 * section stopped being a rule and started being reference — and reference goes
 * to a skill, with the reasoning in `docs/notes/`.
 *
 * 12,000 → 12,800 (2026-09-27, asked for by the owner): the plugin section,
 * because "a plugin extends waterplane" and "the core tells a repo what waterplane offers"
 * were blended once in a single conversation and both are rules every area
 * touches, not reference.
 */
const MAX_CHARS = 12_800;

/**
 * The longest a single module entry may be.
 *
 * "One line here, the why in the notes" made checkable. 1,000 characters is
 * roughly ten wrapped lines — generous for an entry carrying two or three hard
 * rules, and a hard stop on one that has started explaining itself. Measured
 * across the file when this was written: 82 entries, median 352, p90 766.
 *
 * Two exemptions, both because the rule is "one MODULE, one line" and not "no
 * long bullets":
 *
 *  - Only `## Architecture` is measured. `## Invariants` and `## Heuristics` are
 *    rule prose by design — their budget is the total-size check above, and
 *    capping a paragraph there would push a hard-won rule into a footnote.
 *  - A bullet naming four or more modules is an INDEX (`autopull.ts` ·
 *    `oracle.ts` · …), which is the compression this rule wants, not a
 *    violation. Penalising it would push toward one bullet each, which is
 *    bigger. A bullet with nested `  - ` children is measured by its own text.
 */
const MAX_ENTRY_CHARS = 1_000;

/** A router is a map, not a reference. ~2k tokens on every task in the area. */
const MAX_ROUTER_CHARS = 9_000;

/** And a sub-skill is a slice, not the whole file again. */
const MAX_SUBSKILL_CHARS = 28_000;
const INDEX_MODULES = 4;

function entries(doc) {
  const lines = doc.split("\n");
  const out = [];
  let cur = null;
  let inArch = false;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const l of lines) {
    if (/^## /.test(l)) { flush(); inArch = !/^## (Invariants|Heuristics|Security)/.test(l); continue; }
    if (!inArch) continue;
    if (/^- /.test(l)) { flush(); cur = { head: l.slice(2, 72), len: l.length, text: l, nested: false }; continue; }
    if (!cur) continue;
    if (/^\s{2,}- /.test(l)) { cur.nested = true; continue; }   // a child, not this entry's prose
    if (cur.nested) continue;                                    // everything after the first child
    if (/^\s+\S/.test(l)) { cur.len += l.length + 1; cur.text += " " + l; continue; }
    if (/^#{1,6} /.test(l)) flush();
  }
  flush();
  return out.filter((e) => {
    const names = new Set([...e.text.matchAll(/`([A-Za-z][A-Za-z0-9_/.]*\.(?:ts|tsx))`/g)].map((m) => m[1]));
    return names.size < INDEX_MODULES;
  });
}

test("CLAUDE.md stays inside its token budget", () => {
  assert.ok(
    MD.length <= MAX_CHARS,
    `CLAUDE.md is ${MD.length} chars, over the ${MAX_CHARS} budget by ${MD.length - MAX_CHARS}.\n` +
    `This file is re-read on every turn of every session and every subagent, so this is\n` +
    `~${Math.round((MD.length - MAX_CHARS) / 4)} extra tokens on EVERY turn anyone runs in this repo.\n` +
    `Fix: move the reference half to a skill under .claude/skills/ and the reasoning to\n` +
    `docs/notes/. What STAYS here is what is dangerous not to know before acting —\n` +
    `a skill that is not invoked is a rule that does not exist.`,
  );
});

test("every skill declares a name and a description that can find it", () => {
  // Discovery is the whole risk of moving a rule out of the always-on file. A
  // skill is chosen from its description alone, so a vague one silently retires
  // everything it holds.
  const bad = [];
  for (const s of skills()) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(s.text);
    if (!fm) { bad.push(`${s.name}: no frontmatter`); continue; }
    const name = /^name:\s*(\S+)/m.exec(fm[1]);
    const desc = /^description:\s*(.+)$/m.exec(fm[1]);
    if (!name) bad.push(`${s.name}: no name:`);
    else if (name[1] !== s.name) bad.push(`${s.name}: name: says "${name[1]}"`);
    if (!desc) bad.push(`${s.name}: no description:`);
    else if (desc[1].trim().length < 120) bad.push(`${s.name}: description is ${desc[1].trim().length} chars — too vague to be found`);
  }
  assert.deepEqual(bad, [], `A skill is chosen from its description alone. Say what it covers AND when to load it.`);
});

/**
 * A skill addressed to an outside contributor, not to the agent working here.
 *
 * `feature-request` runs on a CONTRIBUTOR's machine to draft an intent request
 * (CONTRIBUTING.md). The "which skill to load" table routes the owner's agents by
 * area of this codebase; naming a contributor-only skill there would put it in
 * front of every session here, which is exactly what its description asks not to
 * happen. So it declares its audience in its own frontmatter, like `generated-by:`
 * above, and is held to every other skill rule in this file.
 */
const CONTRIBUTOR = /^audience:\s*contributor\s*$/m;

test("CLAUDE.md points at every skill, and every skill is pointed at", () => {
  // The map in CLAUDE.md is the only thing that makes the split navigable from
  // the always-on half. A skill nothing points at is a skill nobody loads.
  const have = skills().filter((s) => !CONTRIBUTOR.test(frontMatter(s.text))).map((s) => s.name).sort();
  const named = have.filter((n) => MD.includes(n));
  assert.deepEqual(
    have.filter((n) => !named.includes(n)), [],
    `These skills exist but CLAUDE.md never names them — add them to the "Which skill to load" table.`,
  );
  assert.ok(have.length > 0, "no skills found under .claude/skills — did the directory move?");
});

test("a preset the host writes into a repo declares itself machine-written", () => {
  // The other half of the exemption above, pinned from the WRITER's side. Drop
  // the marker there and nothing fails here — it fails later, in whatever repo
  // has capture targets, as a `npm test` that broke because the host wrote a
  // file into it. Read as text so this costs no build and no import.
  const src = readFileSync(join(ROOT, "packages", "host", "src", "visualskill.ts"), "utf8");
  // The block lives in a template literal, so its opening `---` shares a line
  // with the `return`. Anchor on the `name:` line instead.
  const block = /^name: visual-check\n[\s\S]*?\n---$/m.exec(src);
  assert.ok(block, "`visualskill.ts` no longer writes a `name: visual-check` frontmatter block — find where the preset's text moved to.");
  assert.match(
    block[0], GENERATED,
    "The `visual-check` preset must keep declaring `generated-by:` in its frontmatter.\n" +
    "That marker is what exempts it from the skill rules in this file — without it,\n" +
    "every repo with capture targets starts failing a check about a file it never wrote.",
  );
});

test("the skills are tracked by git, not ignored", () => {
  // `.gitignore` has `.claude/*`, and git cannot re-include anything below an
  // excluded DIRECTORY — so the obvious `.claude/` + `!.claude/skills/` silently
  // leaves every skill untracked. That was the state this check was written in:
  // the rules had been moved OUT of CLAUDE.md and into files a fresh clone would
  // not have. An ignored skill is a deleted rule with extra steps.
  const list = skills();
  if (!list.length) return;
  let ignored;
  try {
    ignored = execFileSync("git", ["check-ignore", "--no-index", ...list.map((s) => s.path)],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // exit 1 with no output is the good case: nothing matched an ignore rule.
    if (e.status === 1) return;
    return;  // git missing or not a repo — not this test's business
  }
  assert.equal(
    ignored.trim(), "",
    `These skills are gitignored, so a fresh clone of this repo would not have them —\n` +
    `and the rules they carry came OUT of CLAUDE.md. Re-include them: .gitignore needs\n` +
    `\`.claude/*\` (not \`.claude/\`) followed by \`!.claude/skills/\`.`,
  );
});

test("no module entry has grown into a paragraph", () => {
  const fat = [];
  for (const doc of [{ name: "CLAUDE.md", text: MD }, ...skills().map((s) => ({ name: s.name, text: s.text }))]) {
    for (const e of entries(doc.text)) {
      if (e.len > MAX_ENTRY_CHARS) fat.push(`${e.len} in ${doc.name}: ${e.head}`);
    }
  }
  assert.deepEqual(
    fat, [],
    `These entries are over ${MAX_ENTRY_CHARS} chars. An entry is one line per subsystem;\n` +
    `the reasoning belongs in docs/notes/ under the same name. Keep the imperative,\n` +
    `move the story, and link to it.`,
  );
});

/**
 * The routers, and the two checks that keep a split navigable.
 *
 * Splitting `web` (109k) and `host` (77k) into a router plus area
 * sub-skills only pays if the agent loads ONE of them. That depends entirely on
 * two things being true, and neither is visible in a diff:
 *
 *  - the router's map must name every module its sub-skills claim, or the agent
 *    is sent to a skill that does not hold the rule — which reads exactly like
 *    "there is no rule here", the worst possible failure of a rules document;
 *  - the descriptions must claim DISJOINT modules, because a description is all
 *    the agent sees when choosing. Two skills claiming `outbox.ts` means either
 *    both get loaded (the split undone) or one is guessed (the rule missed).
 *
 * The map is generated by `tools/skillmap.mjs` rather than typed, so the first
 * check is a regeneration, not a spot-check.
 */
const ROUTERS = ["web", "host"];

test("each router's map names every module its sub-skills claim, and nothing else", () => {
  const drift = [];
  for (const router of ROUTERS) {
    const text = skills().find((s) => s.name === router)?.text;
    if (!text) { drift.push(`${router}: router missing`); continue; }
    const want = mapLines(ownership(SKILL_DIR, router));
    for (const line of want) {
      if (!text.includes(line)) drift.push(`${router} is missing or has a stale line:\n    ${line}`);
    }
    // Equality, not inclusion: a line left behind by a renamed or deleted
    // sub-skill points at a skill that no longer holds the rule, which is the
    // same failure as a missing line and harder to notice.
    for (const line of text.split("\n")) {
      if (!/^- `(web|host)-/.test(line)) continue;
      if (!want.includes(line)) drift.push(`${router} has a line nothing generates:\n    ${line}`);
    }
  }
  assert.deepEqual(
    drift, [],
    `A router's map is generated from its sub-skills' bullet HEADS by tools/skillmap.mjs.\n` +
    `It has drifted — a bullet moved and the map did not. Regenerate it:\n` +
    `  node -e 'import("./tools/skillmap.mjs").then(m=>console.log(m.mapLines(m.ownership(".claude/skills","web")).join("\\n")))'\n` +
    `A map that points at the wrong skill is worse than no map: it answers the question wrongly.`,
  );
});

test("sub-skills under one router claim disjoint modules in their descriptions", () => {
  const clashes = [];
  for (const router of ROUTERS) {
    const claimed = new Map();   // module -> skill that named it
    for (const s of skills()) {
      if (!s.name.startsWith(router + "-")) continue;
      const desc = /^description:\s*(.+)$/m.exec(frontMatter(s.text))?.[1] ?? "";
      for (const m of desc.matchAll(/\b([A-Za-z][A-Za-z0-9_]*\.(?:ts|tsx))\b/g)) {
        const mod = m[1];
        if (claimed.has(mod) && claimed.get(mod) !== s.name) clashes.push(`${mod}: ${claimed.get(mod)} and ${s.name}`);
        else claimed.set(mod, s.name);
      }
    }
  }
  assert.deepEqual(
    clashes, [],
    `A skill is chosen from its description alone. Two sub-skills of the same router naming the\n` +
    `same module makes that choice a coin flip — the agent loads both (which undoes the split)\n` +
    `or picks one (which misses the rule). Name a module in exactly one description; if the rules\n` +
    `for it genuinely live in two skills, say so in the ROUTER's map, not in both descriptions.`,
  );
});

test("the map never points at a module that is gone", () => {
  // The other half of generating the map: it is generated from PROSE, so a
  // module renamed or deleted in the tree lingers in a bullet head and the map
  // keeps answering for it. A tombstone is legitimate — `giveups.ts` is named
  // precisely to say it was deleted and its storage key was not — so the rule
  // is "exists, or the bullet says DELETED".
  const onDisk = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) onDisk.add(e.name);
    }
  };
  walk(join(ROOT, "packages"));
  onDisk.add("vite.config.ts");
  const ghosts = [];
  for (const s of skills()) {
    if (!/^(web|host)-/.test(s.name)) continue;
    for (const line of s.text.split("\n")) {
      if (!line.startsWith("- ")) continue;
      for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9_/.]*\.(?:ts|tsx))`/g)) {
        const base = m[1].split("/").pop();
        if (!onDisk.has(base) && !line.includes("DELETED")) ghosts.push(`${s.name}: ${base}`);
      }
    }
  }
  assert.deepEqual(
    [...new Set(ghosts)].sort(), [],
    `A bullet head names a module that is not in the tree, so the router's map answers\n` +
    `"that skill holds its rules" about a file nobody can open. Rename it in the bullet, or\n` +
    `say DELETED in the bullet the way the giveups.ts tombstone does.`,
  );
});

test("a description only claims modules its own bullets are about", () => {
  // A description is the whole basis on which a skill is chosen. Naming a module
  // there that no bullet HEAD claims promises rules the router cannot route to,
  // and the repo-health metric — which charges a commit per head-claimed module —
  // then meters that load at zero forever.
  const unbacked = [];
  for (const s of skills()) {
    if (!/^(web|host)-/.test(s.name)) continue;
    const heads = headModules(s.text);
    for (const mod of descriptionModules(s.text)) {
      if (!heads.has(mod)) unbacked.push(`${s.name}: description names ${mod}, no bullet is about it`);
    }
  }
  assert.deepEqual(
    unbacked.sort(), [],
    `Either give the module a bullet of its own (or name it in an existing bullet's FIRST line,\n` +
    `which is what "this bullet is about it" means here), or stop naming it in the description.\n` +
    `A description that promises more than the bullets deliver sends the agent to the wrong skill.`,
  );
});

test("no sub-skill grows back into the thing that was split", () => {
  // The router has a budget; without one here, the split is un-guarded — every
  // bullet could migrate into one sub-skill and all three other checks stay green.
  // 28k is above today's largest (web-work) with room to grow, and well under
  // the 109k that started this.
  const fat = [];
  for (const s of skills()) {
    if (!/^(web|host)-/.test(s.name)) continue;
    if (s.text.length > MAX_SUBSKILL_CHARS) fat.push(`${s.name}: ${s.text.length} chars`);
  }
  assert.deepEqual(
    fat, [],
    `Over the ${MAX_SUBSKILL_CHARS}-char sub-skill budget. This is the 109k problem coming back one\n` +
    `level down: split the area again, or move the reasoning to docs/notes and leave the rule.`,
  );
});

test("a router stays a router", () => {
  // The routers exist because a 109k body was being carried on every turn after
  // it loaded. A router that grows back into a reference is that failure again,
  // one indirection later — and it is the file every task in the area loads.
  const fat = [];
  for (const router of ROUTERS) {
    const s = skills().find((x) => x.name === router);
    if (!s) continue;
    const body = s.text.length;
    if (body > MAX_ROUTER_CHARS) fat.push(`${router}: ${body} chars`);
  }
  assert.deepEqual(
    fat, [],
    `Over the ${MAX_ROUTER_CHARS}-char router budget. A router is a map plus the conventions every\n` +
    `slice needs; anything that belongs to ONE area belongs in that area's sub-skill.`,
  );
});

test("every module named in CLAUDE.md is described in docs/notes", () => {
  // The structural rule the other two rest on: if the only description of a
  // module is the one in CLAUDE.md, then trimming that entry LOSES it, and the
  // budget can only be met by deleting knowledge. Notes first, then the line here.
  const notesDir = join(ROOT, "docs", "notes");
  const notes = readdirSync(notesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(notesDir, f), "utf8"))
    .join("\n");
  const named = new Set();
  const all = [MD, ...skills().map((s) => s.text)].join("\n");
  for (const m of all.matchAll(/`([A-Za-z][A-Za-z0-9_/.]*\.(?:ts|tsx))`/g)) {
    named.add(m[1].split("/").pop());
  }
  const missing = [...named].filter((n) => !notes.includes(n)).sort();
  assert.deepEqual(
    missing, [],
    `These modules are named in CLAUDE.md or a skill but described nowhere in docs/notes/.\n` +
    `That makes that entry the only record of them, so it can never be trimmed.\n` +
    `Write the section in docs/notes/ first, then leave one line here pointing at it.`,
  );
});

test("the reasoning lives in docs/notes, and it is bigger than the rules", () => {
  // A cheap invariant with a real meaning: the moment CLAUDE.md approaches the
  // size of the notes, the explaining has moved back into the file that is
  // loaded on every turn.
  const notesDir = join(ROOT, "docs", "notes");
  const notesSize = readdirSync(notesDir)
    .filter((f) => f.endsWith(".md"))
    .reduce((n, f) => n + readFileSync(join(notesDir, f), "utf8").length, 0);
  const rules = MD.length + skills().reduce((n, s) => n + s.text.length, 0);
  assert.ok(
    notesSize > rules * 3,
    `docs/notes is ${notesSize} chars against ${rules} of rules (CLAUDE.md + skills).\n` +
    `The reasoning is supposed to live in the notes; if this ratio collapses it has\n` +
    `moved back into the documents that get loaded.`,
  );
});
