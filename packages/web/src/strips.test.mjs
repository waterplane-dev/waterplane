/**
 * The screen-height strips: a marker class must not also be a LAYOUT class.
 *
 * `PullStrip` carried `outbox-recover pull-bar`, where `pull-bar` was meant as a
 * marker (one `.screen.typing` rule hides it) — but `.pull-bar` is also the 3px
 * progress bar drawn on a PullSheet row, 1500 lines away in the same stylesheet.
 * The strip silently inherited `display: block`, `height: 3px` and `flex: 0 0
 * 100%`. In the launcher's flex COLUMN a 100% basis is 100% of the viewport
 * HEIGHT and `flex-shrink: 0` refuses to give it back, so one queued download
 * covered the whole launcher — repo list, session list, everything — and stayed
 * covered across an app restart, the queue being durable.
 *
 * Nothing about that is visible at either call site, which is why it is pinned
 * here rather than described in a comment: every class sharing an element with
 * `outbox-recover` is checked against its own bare rule in `styles.css`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "styles.css"), "utf8")
  // Comments hold braces and stray selectors; strip them before parsing.
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations that decide how big a flex item gets to be. */
const SIZING = /(^|;)\s*(flex|flex-basis|flex-grow|display|height|min-height|position)\s*:/;

/** Every rule in the stylesheet, as `{ selector, body }`. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim(), body: m[2] }));

/** The rules whose selector is `.token` ALONE — no descendant, no modifier. */
function bareRules(token) {
  return RULES.filter((r) => r.sel === "." + token).map((r) => r.body);
}

/** Static class tokens that share an element with `outbox-recover`. */
function companionClasses() {
  const found = new Set();
  // Recursive: a sheet in `features/<name>/` is as able to carry the class.
  for (const f of readdirSync(here, { recursive: true }).filter((n) => n.endsWith(".tsx"))) {
    const src = readFileSync(join(here, f), "utf8");
    for (const m of src.matchAll(/className=\{?[`"]([^`"]*outbox-recover[^`"]*)[`"]/g)) {
      // Drop the `${…}` holes: a state modifier is chosen at runtime and is
      // checked below by name, not by scraping the expression.
      for (const tok of m[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
        if (tok && tok !== "outbox-recover") found.add(tok);
      }
    }
  }
  return found;
}

test("a class riding on `outbox-recover` may not size itself", () => {
  for (const tok of companionClasses()) {
    for (const body of bareRules(tok)) {
      assert.ok(!SIZING.test(body),
        `.${tok} shares an element with .outbox-recover and sets its own sizing — ` +
        `in the screen's flex column that overrides the strip's height, not its width:\n  .${tok} {${body}}`);
    }
  }
});

test("the strip itself is sized by its content", () => {
  // `flex: 0 0 auto` is what makes a stray shorthand from elsewhere the only way
  // this can happen again — without it the strip has no stated main size at all.
  const [body] = bareRules("outbox-recover");
  assert.ok(body, "no bare `.outbox-recover` rule in styles.css");
  assert.match(body, /flex:\s*0\s+0\s+auto/);
});

test("`.pull-bar` is still the 3px row bar, and still full-basis", () => {
  // The rule the strip must never pick up again. If this changes shape, the
  // first test above is what keeps the strip out of it.
  const [body] = bareRules("pull-bar");
  assert.match(body, /height:\s*3px/);
  assert.match(body, /flex:\s*0\s+0\s+100%/);
});
