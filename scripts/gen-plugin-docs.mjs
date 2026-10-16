#!/usr/bin/env node
// Writes docs/plugins-api.md — the public plugin API reference — from the JSDoc in
// packages/shared/src/plugin.ts, so the reference a fork builds against is the contract
// itself and cannot drift from it:
//
//   npm run docs:plugins              rewrite docs/plugins-api.md
//   npm run docs:plugins -- --check   exit 1 if it is stale (tools/plugindocs.test.mjs runs this)
//
// Uses the TypeScript compiler API (a root devDependency) over the SOURCE, so it needs no build.
// Every exported declaration is listed in source order with its doc comment and its
// signature as printed without comments; an interface lists each member the same way.
// Deterministic: the output depends on plugin.ts alone (no dates, no paths of this machine).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "packages/shared/src/plugin.ts";
const OUT = "docs/plugins-api.md";
const check = process.argv.includes("--check");

/** A source file to document. plugin.ts's `export * from "./x.js"` siblings are documented in place. */
function load(rel) {
  const t = fs.readFileSync(path.join(ROOT, rel), "utf8");
  return { text: t, sf: ts.createSourceFile(rel, t, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}
let text, sf;
const use = (c) => { ({ text, sf } = c); };
const main = load(SRC);
use(main);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, sf).trim();

/** The doc comment directly above `node` (the last `/** … *\/` before it), as markdown. */
function docOf(node) {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const docs = ranges.filter((r) => text.slice(r.pos, r.pos + 3) === "/**");
  if (!docs.length) return "";
  return cleanDoc(text.slice(docs.at(-1).pos, docs.at(-1).end));
}

function cleanDoc(raw) {
  const lines = raw.replace(/^\/\*\*/, "").replace(/\*\/$/, "").split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  // A one-line comment written as `/** text */` keeps its leading space; drop it.
  return lines.map((l, i) => (i === 0 ? l.trim() : l)).join("\n");
}

const isExported = (node) => !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const oneLine = (s) => s.replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s\)/g, ")").replace(/;\s*$/, "");

function signature(node) {
  if (ts.isFunctionDeclaration(node)) {
    const bare = ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
      node.typeParameters, node.parameters, node.type, undefined);
    return print(bare);
  }
  return print(node);
}

function kindOf(node) {
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isVariableStatement(node)) return "const";
  return "declaration";
}

function nameOf(node) {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map((d) => d.name.getText(sf)).join(", ");
  return node.name?.getText(sf) ?? "?";
}

function memberName(m) {
  const n = m.name ? m.name.getText(sf) : ts.isIndexSignatureDeclaration(m) ? "[index]" : ts.isCallSignatureDeclaration(m) ? "(call)" : "?";
  return n;
}

const out = [];
out.push("# Plugin API reference");
out.push("");
out.push(`<!-- GENERATED from ${SRC} by scripts/gen-plugin-docs.mjs — do not edit by hand. -->`);
out.push(`<!-- Rewrite with \`npm run docs:plugins\`; \`tools/plugindocs.test.mjs\` fails when this is stale. -->`);
out.push("");
// The product's name, read off brand.ts's source like everything else here (no build needed).
const brandName = fs.readFileSync(path.join(ROOT, "packages/shared/src/brand.ts"), "utf8").match(/^\s*name: "([^"]+)",/m)?.[1];
if (!brandName) { console.error("gen-plugin-docs: no BRAND.name in packages/shared/src/brand.ts"); process.exit(2); }
const topic = `${brandName}-plugin`;
out.push("Start a new plugin from `examples/plugin-template/`; installing one and the list of plugins are in");
out.push(`\`docs/plugins.md\`. **Publishing yours? Tag its GitHub repo with the \`${topic}\` topic**, so`);
out.push(`it shows up at https://github.com/topics/${topic}. A plugin is not a fork, so that topic is`);
out.push("the only place it is counted.");
out.push("");

let intro = "";
let version = null;
const sections = [];
for (const st of main.sf.statements) {
  if (ts.isImportDeclaration(st)) {
    if (!intro) intro = docOf(st);
    continue;
  }
  // `export * from "./x.js"`: the sibling's exports are part of the contract, listed here.
  if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
    const sib = load(path.join(path.dirname(SRC), st.moduleSpecifier.text.replace(/\.js$/, ".ts")));
    for (const s of sib.sf.statements) if (isExported(s)) sections.push({ st: s, c: sib });
    continue;
  }
  if (!isExported(st)) continue;
  if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) {
      if (d.name.getText(sf) === "PLUGIN_API_VERSION" && d.initializer && ts.isStringLiteral(d.initializer)) version = d.initializer.text;
    }
  }
  sections.push({ st, c: main });
}
if (!version) { console.error(`gen-plugin-docs: no string PLUGIN_API_VERSION in ${SRC}`); process.exit(2); }

out.push(`**API version: \`${version}\`** (\`PLUGIN_API_VERSION\`). A manifest's \`apiVersion\` loads when it has the`);
out.push("same major and a minor no newer than this one; the rules for what bumps which number are under");
out.push("`PLUGIN_API_VERSION` below. Why the API looks the way it does: `docs/notes/plugins.md`.");
out.push("");
if (intro) { out.push("## Overview"); out.push(""); out.push(intro); out.push(""); }

out.push("## Contents");
out.push("");
for (const { st, c } of sections) {
  use(c);
  const n = nameOf(st);
  out.push(`- [\`${n}\`](#${anchor(n)}) — ${kindOf(st)}`);
}
out.push("");

function anchor(n) { return n.toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/ /g, "-"); }

for (const { st, c } of sections) {
  use(c);
  const n = nameOf(st);
  out.push(`## ${n}`);
  out.push("");
  out.push(`*${kindOf(st)}*`);
  out.push("");
  const doc = docOf(st);
  if (doc) { out.push(doc); out.push(""); }
  if (ts.isInterfaceDeclaration(st)) {
    const head = print(ts.factory.updateInterfaceDeclaration(st, st.modifiers, st.name, st.typeParameters, st.heritageClauses, []));
    out.push("```ts");
    out.push(head.replace(/\{\s*\}$/, "{ … }"));
    out.push("```");
    out.push("");
    if (st.members.length) {
      out.push("| member | signature | notes |");
      out.push("|---|---|---|");
      for (const m of st.members) {
        const sig = oneLine(print(m)).replace(/\|/g, "\\|");
        const d = docOf(m).replace(/\n{2,}/g, "<br><br>").replace(/\n/g, " ").replace(/ {2,}/g, " ").replace(/\|/g, "\\|");
        out.push(`| \`${memberName(m)}\` | \`${sig}\` | ${d} |`);
      }
      out.push("");
    }
  } else {
    out.push("```ts");
    out.push(signature(st));
    out.push("```");
    out.push("");
  }
}

const doc = out.join("\n").replace(/\n+$/, "\n");
const file = path.join(ROOT, OUT);
const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
if (check) {
  if (before !== doc) {
    console.error(`${OUT} is stale against ${SRC} — run \`npm run docs:plugins\` and commit the result`);
    process.exit(1);
  }
  console.log(`${OUT} is current`);
} else if (before !== doc) {
  fs.writeFileSync(file, doc);
  console.log(`wrote ${OUT}`);
} else {
  console.log(`${OUT} already current`);
}
