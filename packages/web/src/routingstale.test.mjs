/**
 * A stale `#o=<overlay>` hash lands on home (docs/notes/android-apps-architecture.md section 7, P0).
 *
 * `parseHash` keeps an `o=` only when the overlay is in `PERSISTED_OVERLAYS`; anything else (a sheet
 * that was removed, one that is never persisted, a typo, an extension sheet that is not installed)
 * reads as "no overlay". When the Apps screen moves into the optional android-apps extension, an
 * old bookmark `#o=apps` on a phone whose desktop lacks the extension must take that same path.
 *
 * Since P4 `apps` is no core overlay (the screen is the extension's `feature:android-apps/main`,
 * never persisted), so an old `#o=apps` bookmark lands on the launcher like any other stale hash.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PERSISTED_OVERLAYS, parseHash } from "./routing.ts";

function withHash(hash, fn) {
  const was = globalThis.location;
  globalThis.location = { hash, search: "" };
  try { return fn(); } finally { if (was === undefined) delete globalThis.location; else globalThis.location = was; }
}

test("an overlay the hash cannot restore reads as home, session kept", () => {
  for (const stale of ["#o=nonexistent-sheet", "#o=queue", "#o=send", "#o=android-apps", "#o="]) {
    const r = withHash(stale, () => parseHash());
    assert.equal(r.overlay, null, stale);
    assert.equal(r.activeId, null, stale);
  }
  assert.deepEqual(withHash("#a=s1&o=zzz", () => { const r = parseHash(); return [r.activeId, r.overlay]; }), ["s1", null]);
});

test("#o=apps (the Apps screen before it moved into the extension) lands on the launcher", () => {
  assert.equal(PERSISTED_OVERLAYS.has("apps"), false);
  const r = withHash("#o=apps", () => parseHash());
  assert.equal(r.overlay, null);
  assert.equal(r.activeId, null);
  assert.equal(PERSISTED_OVERLAYS.has("feature:android-apps/main"), false);
});
