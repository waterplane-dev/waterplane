// Button hints: the rule that decides whether a tap is spent on an explanation.
//
// This is worth pinning because both failure directions are SILENT. Too eager
// and a fresh install becomes a click-through — every one of the app's ~290
// buttons wanting an OK before it does anything. Too shy and the feature is
// simply absent: no error, no warning, just the row of unlabelled icons it was
// built to explain. Neither shows up anywhere except in someone's hands.
//
// The second half checks something no unit test could: that every `data-hint`
// written into the UI names a hint that exists. A typo there is invisible —
// the button keeps working and silently falls back to its own `title`, which is
// exactly the tooltip a phone never renders.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decideHint, HINTS } from "../packages/shared/dist/hints.js";

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

// ── The decision table ──────────────────────────────────────────────
const hold = HINTS["queue.hold"];        // curated, interrupts once
const move = HINTS["queue.moveup"];      // curated copy, but never interrupts

check(decideHint({ mode: "first", explain: false, def: hold, seen: false }) === "explainThenAct",
  "a curated action explains itself the first time it is tapped");
check(decideHint({ mode: "first", explain: false, def: hold, seen: true }) === "act",
  "…and never again once it has been read");
check(decideHint({ mode: "first", explain: false, def: move, seen: false }) === "act",
  "a hint without `confirm` never interrupts a tap, however many times");
check(decideHint({ mode: "first", explain: false, def: undefined, seen: false }) === "act",
  "a button with no hint at all is untouched");

check(decideHint({ mode: "press", explain: false, def: hold, seen: false }) === "act",
  "in long-press-only mode nothing interrupts a tap");
check(decideHint({ mode: "off", explain: false, def: hold, seen: false }) === "act",
  "…and “off” is off");

// Explain mode is switched on deliberately, seconds before the tap. A mode the
// user just enabled that silently did nothing would be worse than no feature at
// all, so it outranks every other state — including "off" and "already seen".
check(decideHint({ mode: "press", explain: true, def: move, seen: true }) === "explain",
  "explain mode explains an action that never interrupts, and one already seen");
check(decideHint({ mode: "off", explain: true, def: hold, seen: true }) === "explain",
  "…and outranks “off”, which is the state it is the way out of");
check(decideHint({ mode: "first", explain: true, def: hold, seen: false }) === "explain",
  "explain mode never offers to go ahead — the tap buys the answer, not the action");
check(decideHint({ mode: "first", explain: true, def: undefined, seen: false }) === "act",
  "…but it cannot explain a button that has nothing to say, so that tap still acts");

// ── The catalog itself ──────────────────────────────────────────────
const ids = Object.keys(HINTS);
const confirming = ids.filter((k) => HINTS[k].confirm);
check(confirming.length > 0 && confirming.length <= 40,
  `only a curated few interrupt a tap (${confirming.length} of ${ids.length})`);
check(ids.every((k) => HINTS[k].title && HINTS[k].what),
  "every hint says both what it is called and what it does");
// A hint that interrupts has bought a whole tap; it owes more than a caption.
check(confirming.every((k) => (HINTS[k].what + (HINTS[k].when ?? "")).length >= 120),
  "every interrupting hint earns the interruption (says when, or why not)");
// The repo-health cards explain a screen whose whole discipline is that it
// holds no opinion: `tools/repohealth.mjs` fails its own build if "good",
// "bad", "healthy" or "grade" appears in what it writes, and
// `repoHealthWords.test.mjs` extends that ban to every sentence the phone
// draws. A help card sits one tap under those sentences and was outside both
// — and a card is the easiest place of all for a verdict to arrive, because
// explaining a metric is exactly when one wants to say what a high number
// means. The first draft of these cards said a rising re-touch rate "gets
// worse", one tap under an arrow drawn in `currentColor` precisely so that
// nothing on screen decides which direction is the bad one.
const RH = Object.keys(HINTS).filter((k) => k.startsWith("repohealth."));
const VERDICT = ["score", "grade", "healthy", "unhealthy", "good", "bad", "should", "worse", "better"];
const verdicts = RH.flatMap((k) => {
  const text = `${HINTS[k].title} ${HINTS[k].what} ${HINTS[k].when ?? ""}`;
  return VERDICT.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text)).map((w) => `${k}: "${w}"`);
});
check(RH.length > 0 && verdicts.length === 0,
  verdicts.length
    ? `no repo-health card carries a verdict — found ${verdicts.join(", ")}`
    : `no repo-health card carries a verdict (${RH.length} cards checked)`);

check(ids.every((k) => !/\bthis button\b/i.test(HINTS[k].what)),
  "no hint describes itself as “this button”");

// ── Every data-hint in the UI names a real one ──────────────────────
// Every id carries a "." or a ":" by construction, which is what makes a
// DYNAMIC attribute (`data-hint={mode === "idle" ? "compose.idle" : …}`)
// readable from source at all: the ids in the expression are separable from the
// ordinary strings around them.
check(Object.keys(HINTS).every((k) => /[.:]/.test(k)), "every hint id is shaped like an id");

const SRC = "packages/web/src";
const used = new Map();
// Recursive: a sheet under `features/<name>/` names hints like any other.
for (const f of readdirSync(SRC, { recursive: true }).filter((n) => n.endsWith(".tsx") || n.endsWith(".ts"))) {
  const text = readFileSync(join(SRC, f), "utf8");
  for (const m of text.matchAll(/data-hint="([^"]+)"/g)) used.set(m[1], f);
  for (const m of text.matchAll(/data-hint=\{([^}]*)\}/g)) {
    for (const q of m[1].matchAll(/"([^"]*[.:][^"]*)"/g)) used.set(q[1], f);
  }
  // `HintChip` carries the id as a PROP and puts it on `data-hint` itself, so
  // the two patterns above see `data-hint={id}` — a variable — and none of the
  // ids the chips actually name. Left unscanned, renaming a def would make
  // every one of those chips vanish (the chip renders nothing rather than a
  // dead tap) with no test saying so, which is the silent-in-both-directions
  // failure this whole script exists for.
  for (const m of text.matchAll(/<HintChip\b[^>]*?\bid="([^"]+)"/g)) used.set(m[1], f);
  // …and a component that takes an id and hands it to a chip further down
  // (`<MagnitudeCurve hint="…">`) is the same hole one level deeper. Any
  // `hint="…"` whose value is shaped like an id — the `.`/`:` rule checked
  // above — is one of these; an ordinary prose prop cannot be mistaken for it.
  for (const m of text.matchAll(/\bhint="([^"]*[.:][^"]*)"/g)) used.set(m[1], f);
}
check(used.size >= 20, `the UI actually names hints (${used.size} attributes found)`);
const unknown = [...used].filter(([id]) => !HINTS[id]);
check(unknown.length === 0,
  unknown.length ? `every data-hint names a real hint — missing: ${unknown.map(([i, f]) => `${i} (${f})`).join(", ")}`
                 : "every data-hint in the UI names a hint that exists");

// The registry is also allowed to describe things by `title` fallback only, so
// unused entries are fine — except the toolbar ones, which exist precisely
// because `renderToolbarItem` looks them up by id.
// The catalog lives in `toolbar.ts` (extracted from App.tsx, which is where a
// scrape like this one used to have to look).
const app = readFileSync(join(SRC, "toolbar.ts"), "utf8");
const toolbarIds = [...app.matchAll(/\{ id: "([a-z]+)", name: "[^"]*", Icon:/g)].map((m) => m[1]);
check(toolbarIds.length > 10, `read the toolbar catalog (${toolbarIds.length} items)`);
const strayToolbarHints = Object.keys(HINTS).filter((k) => k.startsWith("toolbar:") && !toolbarIds.includes(k.slice(8)));
check(strayToolbarHints.length === 0,
  strayToolbarHints.length ? `a toolbar hint names an item that no longer exists: ${strayToolbarHints.join(", ")}`
                           : "no toolbar hint describes a button that was removed");

// ── The dismissal has to be able to follow the user ─────────────────
const synced = readFileSync("packages/shared/src/settings.ts", "utf8");
check(synced.includes(`lsKey("hints")`),
  "dismissals are on the synced allow-list — being re-taught on the desktop is the point of the feature, inverted");

console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
