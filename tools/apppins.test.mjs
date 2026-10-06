/**
 * Pins for splitting `App.tsx` (docs/notes/app-architecture.md).
 *
 * `App()` was ~1000 lines: the host-state lists, the socket's frame switch,
 * the launcher's view cuts, a dozen boot effects and the overlay table. They
 * move into hooks and modules under `core/`, and a move like that can change
 * behaviour while every type still checks:
 *
 *  - P1: `App.tsx` exports exactly `App` — read off the type checker, as
 *    `sendpins` reads `sendIntent.ts`.
 *  - P2: **the ORDER of every hook that runs an effect or subscribes**, with
 *    each moved hook INLINED where App calls it. React runs effects in hook
 *    order and a custom hook's effects are its caller's, so moving a run of
 *    hooks verbatim into `useX()` called at the same place keeps this list
 *    identical; moving one past another changes it (a moved mount effect once
 *    spent a send retry on every reload — docs/notes/refactoring.md). Plain
 *    state (`useState`/`useRef`/`useMemo`/`useCallback`/`useLatest`) is left
 *    out: its position has no order of its own to keep. An effect is named by
 *    the first call in its body.
 *  - P3: one subscription for App's frames, the features' one AFTER it, one
 *    `bindCore`, and no socket of the split's own.
 *
 * Changing a list here is a behaviour decision, named in the commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");

/** The hooks App's split moved code into, and the file each lives in. P2
 *  inlines a call to one of these; any other `useX(` is a leaf. */
const MOVED = {
  useHostState: "core/sessions/useHostState.ts",
  useSettingsAdoption: "core/settings/useSettingsAdoption.ts",
  useLauncherView: "core/launcher/useLauncherView.ts",
  useHostFrames: "core/conn/useHostFrames.ts",
  useRepoRefresh: "core/launcher/useRepoRefresh.ts",
  useInstallOffer: "core/settings/useInstallOffer.ts",
  useTabStripBridge: "core/sessions/useTabStripBridge.ts",
  useOutsideOpens: "core/route/useOutsideOpens.ts",
  useQueueSignals: "core/queue/useQueueSignals.ts",
};

/** Comments, strings and template literals blanked to spaces (same length). */
function blank(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const j = src.indexOf("\n", i); const e = j < 0 ? src.length : j; out += " ".repeat(e - i); i = e; continue; }
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); const e = j < 0 ? src.length : j + 2; out += src.slice(i, e).replace(/[^\n]/g, " "); i = e; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, " ") + c; i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

/** The body of `export function <name>(` in `rel`, blanked: from its opening
 *  brace to the matching close. */
function fnBody(rel, name) {
  const bl = blank(readFileSync(join(SRC, rel), "utf8"));
  const at = new RegExp(`export function ${name}\\b[^{]*?\\)\\s*(?::[^{]*)?\\{`).exec(bl);
  assert.ok(at, `no \`export function ${name}(\` in ${rel}`);
  let depth = 0;
  for (let i = at.index + at[0].length - 1; i < bl.length; i++) {
    if (bl[i] === "{") depth++;
    else if (bl[i] === "}" && --depth === 0) return bl.slice(at.index + at[0].length, i);
  }
  return bl.slice(at.index + at[0].length);
}

const STATE = new Set(["useState", "useRef", "useMemo", "useCallback", "useLatest"]);
const EFFECTS = new Set(["useEffect", "useLayoutEffect"]);

/** The ordered effect/subscription hooks of a body, moved hooks inlined. */
function sequence(body) {
  const out = [];
  for (const m of body.matchAll(/(?<![\w$.])(use[A-Z][\w$]*)\s*(?:<[^>]*>)?\(/g)) {
    const name = m[1];
    if (STATE.has(name)) continue;
    if (MOVED[name] && existsSync(join(SRC, MOVED[name]))) { out.push(...sequence(fnBody(MOVED[name], name))); continue; }
    if (EFFECTS.has(name)) {
      // Named by the first call in its callback that is not a keyword or a
      // builtin's method, plus its dependency list as written.
      const open = m.index + m[0].length - 1;
      let depth = 0, close = body.length, lastComma = -1;
      for (let i = open; i < body.length; i++) {
        if ("([{".includes(body[i])) depth++;
        else if (")]}".includes(body[i]) && --depth === 0) { close = i; break; }
        else if (body[i] === "," && depth === 1) lastComma = i;
      }
      const args = body.slice(open + 1, close);
      const hasDeps = lastComma > 0 && /^\s*\[/.test(body.slice(lastComma + 1, close));
      const deps = hasDeps ? body.slice(lastComma + 1, close).replace(/\s+/g, "") : "every-render";
      const SKIP = /^(if|return|function|for|while|switch|catch|find|filter|map|some|preventDefault|get|has|set|delete|push)$/;
      const first = [...args.matchAll(/(?<![\w$])((?:[A-Za-z_$][\w$?]*\.)*([A-Za-z_$][\w$]*))\s*\(/g)]
        .map((c) => c[2]).find((n) => !SKIP.test(n)) ?? "?";
      out.push(`${name}:${first}${deps}`);
      continue;
    }
    out.push(name);
  }
  return out;
}

test("P1: App.tsx exports exactly App", () => {
  const file = join(SRC, "App.tsx");
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true,
  });
  const mod = program.getTypeChecker().getSymbolAtLocation(program.getSourceFile(file));
  assert.ok(mod, "App.tsx did not parse as a module");
  assert.deepEqual(program.getTypeChecker().getExportsOfModule(mod).map((s) => s.name), ["App"]);
});

const ORDER = [
  "useConnection", "useAuthGate", "usePref", "usePref", "usePref", "useSessionVerbs", "useRoute",
  "useTermFeed", "useComposeDraft", "usePref", "usePref", "useSchedules", "usePullRecords",
  "useActivityFiled", "useActivityConfirmedDone", "useBacklog", "useRepoColors", "usePref",
  "useEffect:installSettingsSync[]", "useUsedOrderSnapshot", "useUsage", "useQueue", "useLaunch", "useSend",
  "useCompose", "useSessionChrome", "useTransportIndex", "useEffect:setDocTitle[focusRepo]", "useViewport",
  "useEffect:setInterval[]", "useEffect:track[overlay]", "useEffect:on[]", "useEffect:refreshRepos[status]",
  "useEffect:refreshRepos[activeId,active?.idle]", "useEffect:refreshRepos[activeId]", "useEffect:refreshRepos[activeId]", "useEffect:attach[bl.items,sessions]", "useCostNotices",
  "useEffect:setCanInstall[]", "useEffect:startLinkReporting[]",
  "useEffect:noteSessionTabs[sessions,activeId,repos,tabsOn]", "useEffect:idOfevery-render",
  "useEffect:send[overlay,active,status]", "useEffect:setRepoNamer[]", "useEffect:viewerHandles[]",
  "useEffect:attach[sessions]", "useEffect:onShellOpenSession[]",
  "useEffect:setShellWant[sessions,shellWant]", "useEffect:noteStuckSends[stuckSends]",
  "useEffect:setReloadGuard[]", "useEffect:runSheetLeave[overlay]", "useEffect:bootFeatures[]",
];

test("P2: App's effects and subscriptions run in the pinned order, moved hooks inlined", () => {
  const got = sequence(fnBody("App.tsx", "App"));
  assert.deepEqual(got, ORDER);
});

/** App plus every file its split created, as code (comments and strings blanked). */
const SPLIT_FILES = ["App.tsx", ...Object.values(MOVED), "core/route/overlayViews.tsx", "core/session/runToolbar.ts"];
const splitCode = () => SPLIT_FILES.filter((f) => existsSync(join(SRC, f)))
  .map((f) => ({ f, c: blank(readFileSync(join(SRC, f), "utf8")) }));
const countIn = (re) => splitCode().reduce((n, { c }) => n + [...c.matchAll(re)].length, 0);

test("P3: one subscription for App's frames, the features' after it, one bindCore, no socket of its own", () => {
  assert.equal(countIn(/connRef\.current\.on\(/g), 2, "App's switch and dispatchFeatureMessage, nothing else");
  const both = splitCode().filter(({ c }) => /connRef\.current\.on\(/.test(c));
  assert.equal(both.length, 1, "both subscriptions are made in ONE effect, in one file");
  const c = both[0].c;
  assert.ok(c.indexOf("connRef.current.on(dispatchFeatureMessage)") > c.indexOf("connRef.current.on((msg)"),
    "the features' listener is registered AFTER App's (ws.ts calls them in that order)");
  assert.equal(countIn(/\bbindCore\(/g), 1);
  assert.equal(countIn(/new WebSocket\b/g), 0);
});
