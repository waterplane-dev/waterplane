// Three sessions of one repo asking at once read as the repo's name three times
// unless each card also says the desktop's name for the conversation. Every card
// shape in `QuestionsSheet.tsx` must say it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Bundled first: node cannot load a .tsx, as in `tools/webclientpins.test.mjs`.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const dir = join(ROOT, "node_modules", ".ssr");
mkdirSync(dir, { recursive: true });
const out = join(dir, "questionscard-bundle.mjs");
await createRequire(join(ROOT, "package.json"))("esbuild").build({
  entryPoints: [join(HERE, "QuestionsSheet.tsx")], bundle: true, platform: "node", format: "esm", outfile: out, jsx: "automatic", logLevel: "error",
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  external: ["react", "react-dom", "lucide-react"], nodePaths: [join(ROOT, "node_modules")],
  define: { "import.meta.env": "{}", __BUILD_ID__: '"TEST"' },
});
const { QuestionsSheet } = await import(`${pathToFileURL(out).href}?t=${Date.now()}`);

const noop = () => {};
const sheet = (s) => renderToStaticMarkup(createElement(QuestionsSheet, {
  sessions: [{ id: "s1", cwd: "/r/myapp", title: "myapp", tabTitle: "Vault card fill", running: true, ...s }],
  cut: { words: null, showingAll: false, total: 1, onToggleAll: noop },
  outbox: [], online: true, seenAt: null,
  onAnswer: noop, onOpen: noop, onAck: noop, onSendSuggestion: noop, onClose: noop,
}));

const shapes = {
  "a question asked in prose": { asking: { text: "Go ahead at this cost?" } },
  "a dialog that could not be read": { awaitingInput: true },
  "a parsed box": { prompt: { kind: "choice", question: "Proceed?", options: [{ key: "1", label: "Yes" }] } },
};

for (const [name, s] of Object.entries(shapes)) {
  test(`${name} says the session's name beside its title`, () => {
    const html = sheet(s);
    assert.match(html, /class="q-head"/);
    assert.match(html, /Vault card fill/);
  });
}

test("a session with no derived name draws its title and no empty name", () => {
  const html = sheet({ ...shapes["a question asked in prose"], tabTitle: undefined });
  assert.match(html, /myapp/);
  assert.doesNotMatch(html, /row-name/);
});
