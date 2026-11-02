// The Apps surface's route and message names in CORE, recorded as DATA (docs/notes/android-apps-architecture.md
// sections 4, 7 and 8). P5 deleted them: the install log and readiness are the android-apps extension's,
// over `plugin.call`/`plugin.push`. These assertions pin their ABSENCE; if you change this file you are
// changing the protocol, not "fixing a test". No retired no-op table: an old bundle's `install.get` /
// `install.report` is an unknown type, which `routes/index.ts` drops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HANDLED } from "../dist/routes/index.js";
import { passiveAllows } from "../dist/passive.js";

const src = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const here = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

test("core routes no install message", () => {
  for (const t of ["install.get", "install.report", "install.log"]) assert.ok(!HANDLED.includes(t), t);
});

test("the wire unions carry no install message", () => {
  const names = (s) => [...s.matchAll(/t: "(install\.[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names(src("shared/src/wire/messages/clienthost.ts")), []);
  assert.deepEqual(names(src("shared/src/wire/messages/hosttools.ts")), []);
  assert.doesNotMatch(src("host/src/routes/system.ts"), /install\.log|installLog/, "hello pushes no install log");
});

test("core has no readiness route, and a passive device token is still refused the path", () => {
  assert.doesNotMatch(src("host/src/routes/apihost.ts"), /\/api\/apps\/readiness/);
  assert.equal(passiveAllows("GET", "/api/apps/readiness", new URLSearchParams(), () => true), false);
});

test("core keeps no install-log store or rules: the extension is installs.json's one reader and writer", () => {
  assert.equal(existsSync(here("host/src/installlog.ts")), false);
  assert.equal(existsSync(here("shared/src/installlog.ts")), false);
  assert.doesNotMatch(src("host/src/routes/types.ts"), /InstallLog/);
  assert.doesNotMatch(src("host/src/server/ctxseal.ts"), /"installLog"/);
  assert.doesNotMatch(src("shared/src/wire/install.ts"), /InstallLog|InstallReport/, "only AppRepoFacts/AppReadinessReport stay");
});

test("the extension's pending debounce is flushed by deactivate/shutdown, which the shutdown handler calls in that order", () => {
  const sd = src("host/src/server/shutdown.ts");
  assert.ok(sd.indexOf("plugins.deactivateAll()") >= 0 && sd.indexOf("plugins.shutdownAll()") > sd.indexOf("plugins.deactivateAll()"));
});
