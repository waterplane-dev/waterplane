#!/usr/bin/env node
// Keep a repo's requirements list current from the prompts that asked for things
// and the commits that shipped them.
//
//   node scripts/requirements/update.mjs <repo> [--dry-run] [--full]
//
// Reads the person's interactive prompts from the CLI's transcripts
// (~/.claude/projects/<encoded repo path>/*.jsonl) and the git log, both since
// docs/requirements/.state.json, then:
//   1. extract — a cheap model turns batches of prompts into candidate items;
//   2. merge   — a stronger model compares candidates with the existing list and
//                answers with OPS (add / amend / status), never with a rewrite;
//   3. apply   — this script applies the ops. Items no op names keep their exact
//                bytes, so a drifting model cannot quietly lose one.
// The result is an uncommitted diff. Nothing applies itself: a person reviews it.
//
// Both model calls start from the flags every unattended `claude -p` here uses
// (see sidecar.ts): no project settings, no tools, own system prompt — plus
// --no-session-persistence, so this run's own prompts never land in the
// transcripts it reads next time.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIREMENT_STATUSES, REQ_SKILL_REL, REQ_STATE_REL,
  promptSeen, requirementsSkillText, transcriptDirName, transcriptPrompt,
} from "../../packages/shared/dist/index.js";

const EXTRACT_MODEL = process.env.REQ_EXTRACT_MODEL || "haiku";
const MERGE_MODEL = process.env.REQ_MERGE_MODEL || "sonnet";
const BATCH = 25;
const MERGE_CHUNK = 120; // candidates per merge call
const PROMPT_CAP = 3000; // chars per prompt: pasted logs are not requirements
const COMMIT_CAP = 400;
const BODY_CAP = 400; // chars of each commit body the merge sees
const STATUSES = [...REQUIREMENT_STATUSES];

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const full = args.includes("--full");
if (!repo) {
  console.error("usage: update.mjs <repo> [--dry-run] [--full]");
  process.exit(2);
}
const root = resolve(repo);
const reqDir = join(root, "docs", "requirements");
const statePath = join(root, REQ_STATE_REL);
const skillPath = join(root, REQ_SKILL_REL);
const self = fileURLToPath(import.meta.url);

// ── sources ────────────────────────────────────────────────────────────────

/**
 * The person's own prompts, oldest first. What counts is `transcriptPrompt`'s
 * (@waterplane/shared) — the setup row counts with the same filter, so "N new since"
 * goes to zero after a run.
 */
function readPrompts(since) {
  const dir = join(homedir(), ".claude", "projects", transcriptDirName(root));
  if (!existsSync(dir)) return [];
  const seen = new Set();
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const p = transcriptPrompt(j, basename(f, ".jsonl"));
      if (!p || (since && p.ts <= since) || promptSeen(seen, p)) continue;
      out.push(p);
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

function readCommits(since) {
  const range = since ? [`${since}..HEAD`] : [];
  let log = "";
  try {
    log = execFileSync("git", ["-C", root, "log", "--format=%x1e%h\t%ad\t%s%n%b", "--date=short", ...range],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch { return []; }
  // Subject plus the start of the body: a subject alone ("Polish the editor")
  // is too coarse to say which request a commit delivered, and every item it
  // cannot tie to a commit stays `requested`.
  return log.split("\x1e").map((c) => c.trim()).filter(Boolean).slice(0, COMMIT_CAP).reverse()
    .map((c) => { const [head, ...body] = c.split("\n"); const b = body.join(" ").replace(/\s+/g, " ").trim(); return b ? `${head} — ${b.slice(0, BODY_CAP)}` : head; });
}

function headSha() {
  try { return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return null; }
}

// ── the list on disk ───────────────────────────────────────────────────────

/** Parse one area file into its preamble and items; each item keeps its raw text.
 *  Its twin for READING is `parseRequirementsArea` in packages/shared/src/requirements.ts — same grammar. */
function parseArea(src) {
  const parts = src.split(/^(?=### R-)/m);
  const preamble = parts[0];
  const items = parts.slice(1).map((raw) => {
    const lines = raw.split("\n");
    const m = /^### (R-[a-z0-9-]+-\d+) · (\w+)/.exec(lines[0]) || [];
    const item = { id: m[1], status: m[2], text: [], asked: [], shipped: [], supersededBy: null, raw };
    for (const l of lines.slice(1)) {
      const b = /^- (asked|shipped|superseded-by): (.*)$/.exec(l);
      if (!b) { if (l.trim()) item.text.push(l.trim()); continue; }
      if (b[1] === "superseded-by") item.supersededBy = b[2].trim();
      else item[b[1]] = b[2].split(/,\s*/).filter(Boolean);
    }
    item.text = item.text.join(" ");
    return item;
  });
  return { preamble, items };
}

function renderItem(it) {
  const lines = [`### ${it.id} · ${it.status}`, it.text];
  if (it.asked.length) lines.push(`- asked: ${it.asked.join(", ")}`);
  if (it.shipped.length) lines.push(`- shipped: ${it.shipped.join(", ")}`);
  if (it.supersededBy) lines.push(`- superseded-by: ${it.supersededBy}`);
  return lines.join("\n") + "\n\n";
}

function loadAreas() {
  const areas = new Map();
  if (!existsSync(reqDir)) return areas;
  for (const f of readdirSync(reqDir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    areas.set(basename(f, ".md"), parseArea(readFileSync(join(reqDir, f), "utf8")));
  }
  return areas;
}

// ── the model calls ────────────────────────────────────────────────────────

function claude({ model, system, prompt, schema, timeoutMs }) {
  return new Promise((ok, fail) => {
    const p = spawn("claude", [
      "-p", "--output-format", "json", "--model", model,
      "--setting-sources", "user", "--tools", "", "--no-session-persistence",
      "--system-prompt", system, "--json-schema", JSON.stringify(schema),
    ], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill(); fail(new Error(`${model} timed out`)); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => {
      clearTimeout(t);
      let env;
      try { env = JSON.parse(out); } catch { return fail(new Error(`${model}: no JSON\n${out}${err}`.slice(0, 800))); }
      if (env.is_error || !env.structured_output) return fail(new Error(`${model}: ${env.result || err}`.slice(0, 800)));
      ok({ data: env.structured_output, cost: env.total_cost_usd || 0 });
    });
    p.stdin.end(prompt);
  });
}

const EXTRACT_SYSTEM = `You read prompts a person sent to a coding agent while building a software project, and pull out the product requirements they express.

A requirement is observable behaviour of the product the person wants: a feature, a change to how something looks or works, a rule it must follow, a thing it must never do. Write each as one or two plain English sentences from the user's side ("Child mode shows exactly one canvas and cannot save"), whatever language the prompt is in. Describe the end state, not the change: a prompt saying "make the riddle simpler" becomes "The unlock riddle is simple enough for a parent to solve at a glance", not "The riddle is simpler".

Skip everything else: questions, praise, "build an APK", "commit", "push", how the agent should work, reports that something is broken with no statement of what it should do instead. A bug report DOES carry a requirement when it says what should happen.

For each requirement give an "area": a short lowercase slug for the part of the product it concerns (one or two words joined by "-"). Areas are BROAD — the main parts a user would name, so a whole product needs roughly 5 to 10 ("selection" covers the select box, moving and resizing; "shapes" covers the shape menu). Reuse an area from the given list whenever one fits.

Copy the prompt's ref verbatim into "asked". One prompt may yield several requirements or none.`;

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, area: { type: "string" }, asked: { type: "string" } },
        required: ["text", "area", "asked"],
      },
    },
  },
  required: ["candidates"],
};

const MERGE_SYSTEM = `You maintain a project's requirements list. You are given the current items, new candidate requirements extracted from the person's recent prompts (oldest first), and recent commit subjects. Answer only with operations on the list:

- "add": a candidate that no existing item covers. Give area, text, asked, and status "requested" — or "shipped" with the commit sha(s) in "shipped" when a commit clearly delivers it. If it replaces existing items, list their ids in "supersedes".
- "amend": an existing item the candidate refines or extends without contradicting. Give id, the full new text, and the new asked refs (they are appended).
- "status": an existing item whose status changes — "shipped" (with commit shas), "superseded" (with supersededBy when it is an existing id), or "dropped" (the person withdrew it).

Rules:
- Areas are broad; put an "add" in an existing area whenever it fits one, even if the candidate named a narrower one.
- Several candidates saying the same thing become ONE item, with all their asked refs.
- A later prompt that contradicts an earlier requirement supersedes it; do not keep both as live.
- Mark shipped only when a commit subject or body clearly names it. When unsure, leave it requested.
- Never restate an existing item that nothing new touches. No op is the right answer for most of the list.
- Keep text to behaviour from the user's side, one or two sentences, English, stating the end state rather than the change ("is simple", never "is simpler").`;

const MERGE_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "amend", "status"] },
          id: { type: "string" },
          area: { type: "string" },
          text: { type: "string" },
          status: { type: "string", enum: STATUSES },
          asked: { type: "array", items: { type: "string" } },
          shipped: { type: "array", items: { type: "string" } },
          supersedes: { type: "array", items: { type: "string" } },
          supersededBy: { type: "string" },
        },
        required: ["op"],
      },
    },
  },
  required: ["ops"],
};

async function pool(tasks, n) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

// ── apply ──────────────────────────────────────────────────────────────────

const slug = (s) => String(s || "general").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general";
const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

function applyOps(areas, ops) {
  const byId = new Map();
  for (const [, a] of areas) for (const it of a.items) byId.set(it.id, it);
  const touch = (it) => { it.raw = null; };
  const log = [];
  for (const op of ops) {
    if (op.op === "add") {
      const area = slug(op.area);
      if (!areas.has(area)) areas.set(area, { preamble: `# ${area}\n\n`, items: [] });
      const a = areas.get(area);
      const next = 1 + Math.max(0, ...a.items.map((it) => Number(it.id.split("-").pop()) || 0));
      const status = STATUSES.includes(op.status) ? op.status : "requested";
      const it = {
        id: `R-${area}-${String(next).padStart(3, "0")}`, status, text: op.text || "",
        asked: op.asked || [], shipped: status === "shipped" ? op.shipped || [] : [], supersededBy: null, raw: null,
      };
      a.items.push(it); byId.set(it.id, it);
      log.push(`+ ${it.id} ${status}`);
      for (const sid of op.supersedes || []) {
        const old = byId.get(sid);
        if (!old) continue;
        old.status = "superseded"; old.supersededBy = it.id; touch(old);
        log.push(`~ ${sid} superseded by ${it.id}`);
      }
    } else {
      const it = byId.get(op.id);
      if (!it) { log.push(`? ${op.op} on unknown ${op.id} — ignored`); continue; }
      if (op.op === "amend" && op.text) { it.text = op.text; it.asked = union(it.asked, op.asked); }
      if (op.op === "status" && STATUSES.includes(op.status)) {
        it.status = op.status;
        if (op.status === "shipped") it.shipped = union(it.shipped, op.shipped);
        if (op.status === "superseded" && op.supersededBy) it.supersededBy = op.supersededBy;
      }
      touch(it);
      log.push(`~ ${it.id} ${op.op}${op.op === "status" ? " " + it.status : ""}`);
    }
  }
  return log;
}

function writeAreas(areas) {
  mkdirSync(reqDir, { recursive: true });
  // --full rebuilds from nothing: an area the new run did not produce must not linger.
  if (full) for (const f of readdirSync(reqDir)) if (f.endsWith(".md") && f !== "README.md") rmSync(join(reqDir, f));
  const rows = [];
  for (const [area, a] of [...areas].sort()) {
    writeFileSync(join(reqDir, `${area}.md`), a.preamble + a.items.map((it) => it.raw ?? renderItem(it)).join(""));
    const n = (s) => a.items.filter((it) => it.status === s).length;
    rows.push(`| [${area}](${area}.md) | ${n("requested")} | ${n("shipped")} | ${n("superseded") + n("dropped")} |`);
  }
  writeFileSync(join(reqDir, "README.md"), [
    "# Requirements",
    "",
    "<!-- The table is regenerated by scripts/requirements/update.mjs; items live in the area files. -->",
    "",
    "What this project is expected to do, as the person asked for it. Format and rules:",
    `\`${REQ_SKILL_REL}\`. Grep an area file before changing behaviour.`,
    "",
    "| area | requested | shipped | superseded / dropped |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"));
}

// ── main ───────────────────────────────────────────────────────────────────

const state = !full && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const prompts = readPrompts(state.promptsThrough);
const commits = readCommits(state.commitsThrough);
console.log(`${prompts.length} new prompts, ${commits.length} new commits since ${state.promptsThrough || "the start"}`);
if (!prompts.length && !commits.length) process.exit(0);

const areas = full ? new Map() : loadAreas();
const areaList = [...areas.keys()].join(", ") || "(none yet)";
let cost = 0;

const batches = [];
for (let i = 0; i < prompts.length; i += BATCH) batches.push(prompts.slice(i, i + BATCH));
const extracted = await pool(batches.map((b) => async () => {
  const body = b.map((p) => `--- ref: ${p.ts.slice(0, 10)} (session ${p.session})\n${p.text.slice(0, PROMPT_CAP)}`).join("\n\n");
  const r = await claude({
    model: EXTRACT_MODEL, system: EXTRACT_SYSTEM, schema: EXTRACT_SCHEMA, timeoutMs: 180_000,
    prompt: `Existing areas: ${areaList}\n\nPrompts:\n\n${body}`,
  });
  cost += r.cost;
  return r.data.candidates;
}), 4);
const candidates = extracted.flat();
console.log(`extract (${EXTRACT_MODEL}): ${candidates.length} candidates from ${batches.length} batch(es)`);

// Merge in chunks, oldest first, each against the list as the previous chunk
// left it: a first build over hundreds of prompts is one answer too long to
// come back whole, and a later prompt must be able to supersede an item an
// earlier chunk added.
const allOps = [];
for (let i = 0; i < Math.max(1, candidates.length); i += MERGE_CHUNK) {
  const chunk = candidates.slice(i, i + MERGE_CHUNK);
  const current = [...areas.values()].flatMap((a) => a.items).map((it) => `${it.id} [${it.status}] ${it.text}`).join("\n");
  const merge = await claude({
    model: MERGE_MODEL, system: MERGE_SYSTEM, schema: MERGE_SCHEMA, timeoutMs: 600_000,
    prompt: [
      `Current items:\n${current || "(none)"}`,
      `Candidates (oldest first):\n${chunk.map((c) => `- [${c.area}] ${c.text} (asked: ${c.asked})`).join("\n") || "(none)"}`,
      `Commits (oldest first: sha, date, subject — body):\n${commits.join("\n") || "(none)"}`,
    ].join("\n\n"),
  });
  cost += merge.cost;
  allOps.push(...merge.data.ops);
  console.log(`merge (${MERGE_MODEL}) ${Math.floor(i / MERGE_CHUNK) + 1}: ${merge.data.ops.length} ops · run cost so far $${cost.toFixed(3)}`);
  // Applied in memory even on a dry run, so the next chunk sees what this one added.
  for (const l of applyOps(areas, merge.data.ops)) if (!dryRun) console.log("  " + l);
}

if (dryRun) { console.log(JSON.stringify(allOps, null, 2)); process.exit(0); }

writeAreas(areas);
writeFileSync(statePath, JSON.stringify({
  promptsThrough: prompts.at(-1)?.ts ?? state.promptsThrough ?? null,
  commitsThrough: headSha() ?? state.commitsThrough ?? null,
  lastRun: new Date().toISOString(),
  lastCostUsd: Number(cost.toFixed(4)),
}, null, 2) + "\n");
if (!existsSync(skillPath)) {
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, requirementsSkillText(`node ${self} .`));
  console.log(`wrote ${skillPath}`);
}
console.log(`\nReview: git -C ${root} diff -- docs/requirements .claude/skills/requirements`);
