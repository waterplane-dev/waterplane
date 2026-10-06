/**
 * `local/host-boundary`, pinned both ways.
 *
 * The host's three big files become facades over sliced folders (`sessions/`,
 * `intents/`, `server/` — docs/notes/host-architecture.md), and the folders
 * only hold while the edges between them do. As with `featureboundary`: a rule
 * too loose is invisible and one too tight is deleted the first time it blocks
 * a real import, so every allowed edge is asserted allowed, every refused one
 * refused, and once through ESLint so filename → `src/`-relative wiring and
 * `importKind` are covered too. Every edge that exists TODAY is in the
 * "allowed" half — the rule was wired refusing nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import local, { hostBoundary } from "./eslint/rules.js";

const ok = (from, to) => assert.equal(hostBoundary(from, to), null, `${from} → ${to} should be allowed`);
const ok_type = (from, to) => assert.equal(hostBoundary(from, to, true), null, `${from} → type-only ${to} should be allowed`);
const no = (from, to, re, typeOnly = false) => {
  const why = hostBoundary(from, to, typeOnly);
  assert.ok(why, `${from} → ${typeOnly ? "type-only " : ""}${to} should be refused`);
  if (re) assert.match(why, re);
};

test("today's edges are all allowed", () => {
  for (const f of ["api.ts", "backlog.ts", "deliver.ts", "fanout.ts", "opendeliveries.ts", "review.ts"]) ok(f, "sessions");
  for (const f of ["assess.ts", "backlog.ts", "builds.ts", "capture.ts", "fanout.ts", "review.ts"]) ok(f, "intents/manager");
  for (const f of ["assess.ts", "backlog.ts", "builds.ts", "fanout.ts", "review.ts"]) ok(f, "intents/adapters");
  ok("intents/adapters.ts", "intents/manager");
  ok("backends/claude.ts", "echo");
  ok("capture/window.ts", "host");
  ok("routes/session.ts", "intents/adapters");
  ok("routes/session.ts", "backends");
  ok("routes/types.ts", "intents/manager");
  ok("routes/types.ts", "sessions");
  ok("routes/index.ts", "routes/types");
  ok("routes/index.ts", "routes/session");
  for (const t of ["sessions", "intents/manager", "intents/adapters", "routes", "backends", "capture", "api"]) ok("main.ts", t);
});

test("main is imported by nobody, and imports anything", () => {
  for (const f of ["api.ts", "routes/index.ts", "server/http.ts", "sessions.ts", "sessions/wall.ts", "backends/claude.ts", "capture/window.ts"]) {
    no(f, "main", /entry point is never a library/);
    no(f, "main", /entry point/, true);
  }
  no("intents/manager.ts", "main", /leaf/);
  ok("main.ts", "server/ctx");
  ok("main.ts", "sessions/core");
});

test("a sessions slice reaches core and knobs, never its facade or a sibling", () => {
  ok("sessions/wall.ts", "sessions/core");
  ok("sessions/wall.ts", "sessions/knobs");
  ok("sessions/wall.ts", "limit");
  ok("sessions/wall.ts", "backends");
  no("sessions/wall.ts", "sessions", /never imports its facade/);
  no("sessions/wall.ts", "sessions", /never imports its facade/, true);
  no("sessions/wall.ts", "sessions/turn", /through `core`/);
  no("sessions/wall.ts", "sessions/turn", /through `core`/, true);
  no("sessions/index.ts", "sessions/turn", /through `core`/); // an index there is a slice, not the facade
  for (const t of ["server/ctx", "routes", "routes/types", "intents/manager", "intents/contract"]) {
    no("sessions/wall.ts", t);
    no("sessions/wall.ts", t, null, true);
  }
});

test("the sessions facade takes every slice, never server/, routes/ or intents/", () => {
  for (const t of ["sessions/core", "sessions/wall", "sessions/tmux", "deliver", "backends"]) ok("sessions.ts", t);
  for (const t of ["server/ctx", "routes", "intents/manager", "intents/contract"]) {
    no("sessions.ts", t);
    no("sessions.ts", t, null, true);
  }
});

test("the intent store is a leaf; its slices reach only intents/contract", () => {
  for (const t of ["intents/contract", "intents/fire", "intents/ladder"]) ok("intents/manager.ts", t);
  for (const t of ["sessions", "deliver", "backends", "routes/types"]) no("intents/manager.ts", t, /leaf/);
  no("intents/manager.ts", "sessions", /leaf/, true);
  ok("intents/fire.ts", "intents/contract");
  no("intents/fire.ts", "intents/manager", /facade/);
  no("intents/fire.ts", "intents/manager", /facade/, true);
  no("intents/fire.ts", "intents/ladder", /through `core`/);
  no("intents/fire.ts", "intents/adapters");
  no("intents/fire.ts", "sessions");
  no("intents/fire.ts", "deliver");
  no("intents/adapters.ts", "intents/contract");
  no("intents/adapters.ts", "sessions");
});

test("outside a folder, inner files are reached through the facade — `import type` is the one relaxation", () => {
  for (const f of ["deliver.ts", "routes/session.ts", "server/deliveries.ts"]) {
    no(f, "sessions/core", /facade `sessions`/);
    ok_type(f, "sessions/core");
    no(f, "intents/contract", /intents\/manager/);
    ok_type(f, "intents/contract");
    ok(f, "sessions");
    ok(f, "intents/manager");
    ok(f, "intents/adapters");
  }
});

test("deliver/ is reached only through deliver.ts, and never imports it", () => {
  for (const t of ["deliver/deliverrun", "deliver/deliverknobs", "deliver/delivertypes"]) {
    ok("deliver.ts", t);
    for (const f of ["main.ts", "sessions.ts", "fanout.ts", "server/deliveries.ts", "backlog/backlogsessions.ts", "sessions/drive.ts", "routes/session.ts", "intents/fire.ts"]) {
      no(f, t, /only through the facade `deliver`/);
      no(f, t, /only through the facade `deliver`/, true);
    }
  }
  ok("deliver/deliverrun.ts", "deliver/deliverreturn");
  ok("deliver/deliverrun.ts", "sessions");
  ok("deliver/deliverrun.ts", "echo");
  ok_type("deliver/deliverrun.ts", "sessions/core");
  no("deliver/deliverrun.ts", "sessions/core", /facade `sessions`/);
  no("deliver/deliverrun.ts", "deliver", /never imports its facade/);
  no("deliver/deliverrun.ts", "deliver", /never imports its facade/, true);
  no("deliver/deliverrun.ts", "routes", /called BY a route/);
  no("deliver/deliverrun.ts", "server/ctx");
});

test("server/ is reached only by main; routes/ not by a flat module", () => {
  ok("server/deliveries.ts", "server/ctx");
  ok("server/wsops.ts", "routes");
  ok("server/http.ts", "api");
  no("routes/session.ts", "server/ctx", /never reaches back/);
  no("routes/session.ts", "server/ctx", /never reaches back/, true);
  no("api.ts", "server/ctx", /never reaches back/);
  no("api.ts", "server/ctx", /never reaches back/, true);
  no("api.ts", "main", /entry point/);
  for (const f of ["backlog.ts", "deliver.ts", "files.ts"]) {
    no(f, "routes", /called BY a route/);
    no(f, "routes/apitable", /called BY a route/);
    no(f, "routes/types", /called BY a route/, true);
  }
});

test("api.ts is the HTTP router: it imports the routes/api* tables, and no table imports it", () => {
  ok("api.ts", "routes/apitable");
  ok("api.ts", "routes/apisystem");
  ok("api.ts", "sessions");
  ok("api.ts", "origin");
  ok("routes/apirepofiles.ts", "routes/apiio");
  ok("routes/apisystem.ts", "files");
  no("routes/apisystem.ts", "api", /never imports its router/);
  no("routes/apisystem.ts", "api", /never imports its router/, true);
  no("routes/session.ts", "api", /never imports its router/);
  no("routes/apisystem.ts", "server/http", /never reaches back/);
});

test("backends/ and capture/ are leaves over flat modules", () => {
  ok("backends/claude.ts", "echo");
  ok("backends/index.ts", "backends/claude");
  for (const f of ["backends/claude.ts", "capture/window.ts"]) {
    for (const t of ["sessions", "sessions/core", "intents/manager", "routes", "server/ctx"]) {
      no(f, t, /leaf/);
      no(f, t, /leaf/, true);
    }
  }
});

test("the rule reports through ESLint on the resolved path, reading importKind", () => {
  const linter = new Linter({ configType: "flat" });
  const config = [{ files: ["**/*.ts"], plugins: { local }, languageOptions: { parser: tsParser }, rules: { "local/host-boundary": "error" } }];
  const lint = (file, code) => linter.verify(code, config, { filename: file }).map((m) => m.message);
  const root = "packages/host/src/";
  assert.deepEqual(lint(root + "sessions/wall.ts",
    `import type { SessionCore } from "./core.js"; import { K } from "./knobs.js"; import { e } from "../echo.js"; import { c } from "../backends/index.js"; import pty from "node-pty";`), []);
  const bad = lint(root + "sessions/wall.ts",
    `import type { SessionManager } from "../sessions.js"; import { t } from "./turn.js"; export { m } from "../main.js"; const x = import("../server/ctx.js");`);
  assert.equal(bad.length, 4, bad.join("\n"));
  assert.ok(bad.every((m) => m.startsWith("Host layering: ")));
  // Type-only relaxes a flat module's reach into an inner file, never a value.
  assert.deepEqual(lint(root + "deliver.ts", `import type { Session } from "./sessions/core.js"; import { type A } from "./intents/contract.js";`), []);
  assert.equal(lint(root + "deliver.ts", `import { Session } from "./sessions/core.js"; import "./intents/contract.js";`).length, 2);
  // routes/index.ts is a route, not a flat module named `routes`.
  assert.deepEqual(lint(root + "routes/index.ts", `import { s } from "./session.js"; import type { HostCtx } from "./types.js";`), []);
  // A file outside the host tree is none of this rule's business.
  assert.deepEqual(lint("packages/web/src/x.ts", `import { a } from "./main";`), []);
});
