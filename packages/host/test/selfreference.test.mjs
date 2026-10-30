/**
 * This repo's own heuristic sources, shown as a session here shows them, read
 * through EVERY signal reader: none may fire.
 *
 * `prompt.ts` states the hazard: an agent's own reasoning about TUI chrome is
 * indistinguishable from TUI chrome by construction, and a session editing a
 * detector prints that detector's comments and literals all day. Each detector
 * has its own defence (`prompt.ts`'s footer-row and cursor evidence, 95ce6d4d;
 * `context.ts`'s figure and conversation-row gate, bca8349b; the repo rule that
 * keeps usage-limit banner phrases out of strings and comments). This corpus
 * makes those one tested property, so a NEW detector, or a new keyword in an old
 * one, is held to it without its author remembering the argument.
 *
 * The corpus is GENERATED from the sources at test time — never pasted here —
 * so no banner phrase is written in this file (the limit rule), and a comment
 * added to a detector tomorrow is in tomorrow's corpus. Every comment and string
 * literal is rendered three ways (an assistant message with its indented
 * continuation rows, a tool result, line-numbered diff rows), and each file's
 * pieces once more as one long message: the multi-row readers need rows together.
 *
 * Beside the ten readers of `signalreaders.mjs`, the two health GATES: a gate
 * firing where its reader rightly refuses files a MISS against a working
 * detector, which is how bca8349b's 18 false misses and a BROKEN chip happened.
 *
 * Needs `packages/host/dist` (`npm run build`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { READERS, readSignal } from "./signalreaders.mjs";
import { contextMeterRow } from "../dist/context.js";
import { dialogEvidence } from "../dist/prompt.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The sources that read the screen, and so the ones whose prose is most like it. */
const SOURCES = [
  ...["prompt", "promptbase", "promptmerge", "promptnav", "askbox", "planbox", "question", "context", "limit",
    "limitlog", "limitretry", "spendwall", "keyhints", "permmode", "composer", "echo", "slash", "login",
    "shelllinks", "clisuggest", "netlog", "clihealth"].map((n) => `packages/host/src/${n}.ts`),
  "packages/shared/src/working.ts",
];

const GATES = {
  // `sessions/health.ts`: a meter row on screen and no figure out of it is a miss.
  "context.gate": (t) => contextMeterRow(t) != null,
  // `sessions/boxread.ts`: a box really up and no parse out of it is a miss.
  "prompt.gate": (t) => dialogEvidence(t).box,
};

/** Every comment (one line per row, `//` and `*` gutters dropped) and string literal, as rows. */
function pieces(src) {
  const out = [];
  const sc = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src);
  for (let k = sc.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = sc.scan()) {
    let rows = null;
    if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) {
      rows = sc.getTokenText().replace(/^\/\*\*?|\*\/$/g, "").split("\n").map((l) => l.replace(/^\s*(?:\/\/+|\*)\s?/, ""));
    } else if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      rows = sc.getTokenValue().split("\n");
    }
    rows = rows?.map((r) => r.trimEnd()).filter(Boolean);
    if (rows?.length) out.push(rows);
  }
  return out;
}

const shapes = (rows) => ({
  assistant: rows.map((r, i) => (i ? "  " : "⏺ ") + r).join("\n"),
  tool: rows.map((r, i) => (i ? "     " : "  ⎿  ") + r).join("\n"),
  diff: rows.map((r, i) => `     ${String(i + 40).padStart(4)} +  ${r}`).join("\n"),
});

/** `[label, text]` for every rendering of every piece. */
function corpus() {
  const out = [];
  for (const file of SOURCES) {
    const ps = pieces(readFileSync(ROOT + file, "utf8"));
    ps.forEach((rows, n) => {
      for (const [shape, text] of Object.entries(shapes(rows))) out.push([`${file} #${n} (${shape}): ${rows[0]}`, text]);
    });
    out.push([`${file} (whole file, one message)`, shapes(ps.flat()).assistant]);
  }
  return out;
}

test("the corpus is the sources, and the readers are the ten", () => {
  assert.equal(Object.keys(READERS).length, 10, "a new signal reader is held to this corpus too — update the count");
  // A renamed source must fail here, not silently shrink the corpus.
  for (const file of SOURCES) assert.ok(pieces(readFileSync(ROOT + file, "utf8")).length > 5, file);
});

test("no signal reader and no health gate fires on our own heuristic sources", () => {
  const fired = [];
  for (const [label, text] of corpus()) {
    for (const id of Object.keys(READERS)) if (readSignal(id, text)) fired.push(`${id} ← ${label}`);
    for (const [id, gate] of Object.entries(GATES)) if (gate(text)) fired.push(`${id} ← ${label}`);
  }
  assert.deepEqual(fired, []);
});

test("bca8349b's prose about the context window, through every reader and gate", () => {
  // That commit's own rows: the agent's line filed 18 context.meter misses.
  for (const prose of ['I moved the /compact button onto the "Context window" title row', "the Context window title row has no number on it"]) {
    for (const t of Object.values(shapes([prose]))) {
      for (const id of Object.keys(READERS)) assert.equal(readSignal(id, t), false, `${id}: ${t}`);
      for (const [id, gate] of Object.entries(GATES)) assert.equal(gate(t), false, `${id}: ${t}`);
    }
  }
});
