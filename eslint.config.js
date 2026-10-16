// Flat config. See tools/eslint/rules.js for the repo-specific half.
//
// The generic presets are deliberately NOT pulled in: `tsc` already runs strict
// with noUnusedLocals/noUnusedParameters/noFallthroughCasesInSwitch, so a style
// preset would only add noise on top of a type-checker that is already clean.
// What is here is the set of rules that catch things tsc cannot see.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import local from "./tools/eslint/rules.js";

/** Files that legitimately own a global the rest of the app must not touch. */
const FETCH_OWNERS = [
  "packages/web/src/api.ts",       // the one HTTP call convention
  "packages/web/src/webapi/**",    // its slices (docs/notes/webclient-architecture.md)
  "packages/web/src/main.tsx",     // patches fetch for traffic accounting
  "packages/web/src/nettraffic.ts",
  "packages/web/src/hostUrl.ts",   // patches fetch/XHR/sendBeacon for host routing
];
/**
 * Every word the product has been called, current first. Literal on purpose:
 * `npm run lint` runs before `build:shared`, so this file cannot import the
 * built `brand.js` — `tools/brand.test.mjs` pins this list to
 * `BRAND_WORDS` from it instead.
 */
const BRAND_WORDS = ["waterplane", "usmc", "unsuck", "un-suck"];
const STORAGE_OWNERS = [
  "packages/web/src/storage.ts",  // the key registry and the four readers
  "packages/web/src/settings.ts", // patches setItem for the synced allow-list
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "packages/app/**", "packages/vscode/**", "docs/**"] },

  // ---- everything TypeScript ----
  {
    files: ["packages/*/src/**/*.{ts,tsx}", "packages/extensions/*/web/**/*.{ts,tsx}"],
    plugins: { local },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    rules: {
      "local/no-cors-wildcard": "error",
      // A hand-rolled `<a download>` is DEAD IN THE APK (`web/download.ts`): every
      // download goes through the one queue, or the button lies about having
      // saved something. Here rather than in the web-only block below, whose
      // `ignores` would quietly exempt `api.ts`, `main.tsx` and `hostUrl.ts` —
      // plausible places for exactly this line. `FilesSheet`'s anchor survived
      // the first pass of that refactor, which is why it is a rule at all.
      "local/no-anchor-download": "error",
      // Every storage prefix, current and legacy: `<word>.` for each brand word.
      "local/no-storage-key-literal": ["error", { prefixes: BRAND_WORDS.map((w) => `${w}.`) }],
      "local/no-brand-literal": ["error", { words: BRAND_WORDS }],
      "local/no-functional-setoutbox": "error",
      // `fork`/`resumePick`/`contextSeries` are optional on the wire and ABSENT
      // MEANS INHERIT. Read raw they are `undefined` on every desktop one
      // version behind and delete a control that works there. Here rather than
      // in the web-only block below for `no-anchor-download`'s reason — its
      // `ignores` would exempt files this could plausibly be written in — and
      // repo-wide because the HOST's own `BackendCaps` has no such fields at
      // all (they are minted for the wire), so nothing there can trip it.
      "local/no-raw-optional-cap": "error",
      // A draft is the last copy of words somebody typed, and this store has no
      // listing of its own — the only route back to one is re-opening the exact
      // sheet that wrote it. Seeding is therefore a delete unless it rescues
      // first; the owners are exempted below.
      "local/no-draft-clobber": "error",
      // Size is a proxy for "every feature edits this file". An error since the
      // pre-release splits (2026-10-04) took every source file under 900: a file
      // that grows past it is cut by subject behind its path (skill
      // `refactoring`), never given a disable comment or a higher number.
      "max-lines": ["error", { max: 900, skipBlankLines: false, skipComments: false }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            "Markdown renders React nodes only — never raw HTML. Transcript text is " +
            "whatever an agent wrote and whatever a tool returned.",
        },
      ],
    },
  },

  // ---- web: the two globals with an owner ----
  {
    files: ["packages/web/src/**/*.{ts,tsx}", "packages/extensions/*/web/**/*.{ts,tsx}"],
    ignores: [...FETCH_OWNERS, ...STORAGE_OWNERS],
    plugins: { local, "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "local/no-second-socket": "error",
      // Decision 6 of the rework: no tap may be silent. The prose version of
      // this rule was already in the codebase — `sendInput`'s own comment
      // explains exactly why a bare send in a handler dies at the next reload —
      // and it was obeyed only where somebody had read that paragraph.
      "local/no-silent-send": "error",
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Go through api.ts. It carries the auth token, the host routing, the error " +
            "shape and the timeout — a raw fetch has none of them and fails differently " +
            "on exactly the link this app is for.",
        },
      ],
      // The KEY is the part that must be central; the global itself is fine to
      // touch where a helper would only be a pass-through (a prefix sweep, a
      // `Object.keys(localStorage)` walk). Warn, so growth is visible.
      "no-restricted-properties": [
        "warn",
        {
          object: "localStorage",
          property: "getItem",
          message: "`lsGet`/`lsJson`/`lsBool`/`lsNum` from storage.ts already swallow the private-mode throw.",
        },
        {
          object: "localStorage",
          property: "setItem",
          message: "`lsSet`/`lsSetJson`/`lsSetBool` from storage.ts already swallow the quota throw.",
        },
      ],
    },
  },
  // The feature folders' import boundary. Its own block rather than the one
  // above, whose `ignores` would exempt `main.tsx` and `api.ts` — both files
  // that could plausibly reach into a feature.
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    plugins: { local },
    rules: { "local/feature-boundary": "error" },
  },
  // The extension seam, both ways: an extension imports only the SDK, the kit
  // and @waterplane/shared; core imports an extension only through its entry. Covers
  // the .mts host and shared halves, which no other block lints.
  {
    files: [
      "packages/extensions/*/{web,host,shared}/**/*.{ts,tsx,mts}",
      "packages/web/src/**/*.{ts,tsx}",
      "packages/host/src/**/*.ts",
    ],
    plugins: { local },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    rules: { "local/extension-boundary": "error" },
  },
  // DemoHost's core is DOM-free and node-runnable (docs/analysis/demo-mode-plan.md
  // §1): it imports only its own folder and @waterplane/shared, touches no
  // browser global, keeps no storage and reads no wall clock. Everything else
  // comes in through `DemoHost`'s interface from the transport (WP1). A rule,
  // not a paragraph: one convenient `import … from "../../storage.ts"` and the
  // node tests stop running and the snapshot rule is quietly bypassed.
  // These blocks REPLACE the web block's `no-restricted-globals` /
  // `-properties` / `-syntax` for this folder, so `fetch` is listed again.
  {
    files: ["packages/web/src/demo/host/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "DemoHost is DOM-free; React belongs to the transport (WP1)." },
            { name: "react-dom", message: "DemoHost is DOM-free." },
          ],
          patterns: [
            {
              group: ["../*", "@capacitor/*", "@waterplane/sdk", "@waterplane/kit"],
              message:
                "DemoHost imports only its own folder and @waterplane/shared. storage.ts and " +
                "every DOM-touching module are the transport's: pass what you need in.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["window", "document", "navigator", "location", "localStorage", "sessionStorage", "indexedDB",
          "fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "setInterval", "requestAnimationFrame"].map((name) => ({
          name,
          message: "DemoHost is DOM-free and never waits: time comes from DemoClock, delays go out as `afterMs`, storage is the transport's.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Read time from the injected DemoClock; tests pin it." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "Read time from the injected DemoClock; tests pin it." },
      ],
    },
  },
  // The host's layering: sessions/, intents/ and server/ slices behind their
  // facades (docs/notes/host-architecture.md). Pinned both ways by
  // tools/hostboundary.test.mjs; tools/hostshape.test.mjs asserts this block.
  {
    files: ["packages/host/src/**/*.ts"],
    plugins: { local },
    rules: { "local/host-boundary": "error" },
  },
  // ws.ts owns the socket and the health probe behind the watchdog reload.
  { files: ["packages/web/src/ws.ts"], rules: { "local/no-second-socket": "off" } },
  // `backendCaps.ts` IS the resolution — `hasCap`/`capReason` are where absent
  // becomes "inherit what used to imply it". It reads the fields computed
  // (`b.caps[cap]`), which the rule does not see anyway; the exemption is here
  // so the ownership is stated where every other owner's is.
  { files: ["packages/web/src/backendCaps.ts"], rules: { "local/no-raw-optional-cap": "off" } },
  // The registry declares the keys; shared/settings.ts is the allow-list they
  // are checked against. Both must name them literally.
  {
    files: ["packages/web/src/storage.ts", "packages/shared/src/settings.ts"],
    rules: { "local/no-storage-key-literal": "off" },
  },
  // The one file allowed to spell the product's names, current and legacy —
  // storage prefixes included.
  {
    files: ["packages/shared/src/brand.ts"],
    rules: { "local/no-brand-literal": "off", "local/no-storage-key-literal": "off" },
  },
  // The host stores synced values opaquely and never parses them, but it does
  // recognise their key names in tests and defaults.
  { files: ["packages/host/src/**"], rules: { "local/no-storage-key-literal": "off" } },
  // The store itself, and the two sheets that OWN a draft: they write what the
  // person is typing, per keystroke, which is the thing the rule protects — not
  // a hazard to it. Everywhere else a write replaces someone else's words.
  {
    files: ["packages/web/src/outbox.ts", "packages/web/src/SendSheet.tsx", "packages/web/src/send/useSendSheet.ts", "packages/web/src/PadSheet.tsx"],
    rules: { "local/no-draft-clobber": "off" },
  },
);
