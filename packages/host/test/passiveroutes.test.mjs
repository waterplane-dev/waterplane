/**
 * Every auth-shaped route literal in the host is a DECISION about a passive (kids') device (R-connection-013).
 *
 * An unlocked passive row is full scope for 30 minutes, minus `passiveNeverAllows` (`src/passive.ts`), which is a
 * hand-kept list. So this test reads `packages/host/src` with the TypeScript parser, collects every string literal (and
 * template head) under `/api/(auth|pair|devices|lan|peers|peer)`, and fails on one this table does not classify — a new
 * pairing, device or LAN route is refused here until somebody decides what a passive row may do with it. A table row
 * whose literal is gone fails too, so the table cannot rot into a list of routes that no longer exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const { passiveNeverAllows } = await import("../dist/passive.js");

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const AUTH_ROUTE = /^\/api\/(auth|pair|devices|lan|peers|peer)(\/|$)/;

/**
 * literal → its class. `never`: refused to a passive row even while unlocked, for the methods named (checked against
 * `passiveNeverAllows` below). `own`: the passive row's own auth op. `handler`: refuses a passive row itself (`server/http.ts`).
 * `preauth`: answered before the token gate, so no device token (passive or not) is asked. `peer`: a PEER token's route,
 * which a device token never unlocks (`peers/routes.ts`). `read`: a full-scope read an unlocked row may make.
 * `prefix`: a dispatch prefix, not a route — every route under it has its own row.
 */
const TABLE = {
  "/api/auth/": { cls: "prefix" },
  "/api/auth/status": { cls: "own" },
  "/api/auth/unlock": { cls: "own" },
  "/api/auth/lock": { cls: "own" },
  "/api/auth/read-ticket": { cls: "own" },
  "/api/auth/logout": { cls: "own" },
  "/api/auth/login": { cls: "preauth" },
  "/api/auth/pin": { cls: "handler" },
  "/api/auth/token": { cls: "handler" },
  "/api/pair/": { cls: "prefix" },
  "/api/pair/mint": { cls: "never", never: ["POST"] },
  "/api/pair/redeem": { cls: "preauth" },
  "/api/pair/pake/start": { cls: "preauth" },
  "/api/pair/pake/finish": { cls: "preauth" },
  "/api/devices": { cls: "read" },
  "/api/devices/revoke": { cls: "never", never: ["POST"] },
  "/api/lan/": { cls: "prefix" },
  "/api/lan/identity": { cls: "never", never: ["GET", "HEAD", "POST"] },
  "/api/lan/verify": { cls: "preauth" },
  "/api/peers": { cls: "never", never: ["POST", "PUT", "DELETE"] },
  "/api/peers/": { cls: "never", never: ["POST", "PUT", "DELETE"] },
  "/api/peers/weekspend": { cls: "read" },
  "/api/peer": { cls: "peer" },
  "/api/peer/": { cls: "peer" },
  "/api/peer/hello": { cls: "peer" },
  "/api/peer/weekspend": { cls: "peer" },
  "/api/peer/jobs": { cls: "peer" },
  "/api/peer/jobs/": { cls: "peer" },
};

function* tsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) yield p;
  }
}

/** Every auth-shaped literal in host code (comments are not literals, so prose naming a route is not counted). */
function authLiterals() {
  const found = new Map(); // literal → first "file:line"
  for (const file of tsFiles(SRC)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n) => {
      const raw = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text : null;
      const text = raw === null ? null : raw.split("?")[0]; // a query names no other route
      if (text !== null && AUTH_ROUTE.test(text) && !found.has(text)) {
        found.set(text, `${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

test("every /api/(auth|pair|devices|lan|peers|peer) route literal in the host is classified for a passive device (R-connection-013)", () => {
  const found = authLiterals();
  assert.ok(found.size >= 20, `the scan found the host's auth routes (${found.size})`);
  const unclassified = [...found].filter(([lit]) => !(lit in TABLE)).map(([lit, at]) => `${lit} (${at})`);
  assert.deepEqual(unclassified, [], "a new auth route: decide what a passive (kids') row may do with it, unlocked, and classify it in TABLE (and in passiveNeverAllows when it is auth material)");
  const stale = Object.keys(TABLE).filter((lit) => !found.has(lit));
  assert.deepEqual(stale, [], "a classified route is gone from the host: drop its TABLE row");
});

test("a route classified `never` is refused by passiveNeverAllows for each method it names; a `read` is not", () => {
  for (const [lit, row] of Object.entries(TABLE)) {
    if (row.cls === "never") for (const m of row.never) assert.equal(passiveNeverAllows(m, lit), true, `${m} ${lit}`);
    if (row.cls === "read") assert.equal(passiveNeverAllows("GET", lit), false, `GET ${lit}`);
  }
});
