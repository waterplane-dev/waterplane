// The send row never leaves a hole beside the primary, and never runs past
// three across (a fourth cell is too narrow for a whole word at 360px).
import { test } from "node:test";
import assert from "node:assert/strict";
import { annSendGrid } from "./annSendGrid.ts";

test("one row up to three, then two rows; the primary fills the gap", () => {
  assert.deepEqual(annSendGrid(1), { cols: 1, span: 1 });
  assert.deepEqual(annSendGrid(3), { cols: 3, span: 1 });
  assert.deepEqual(annSendGrid(4), { cols: 2, span: 1 });
  assert.deepEqual(annSendGrid(5), { cols: 3, span: 2 });
  assert.deepEqual(annSendGrid(6), { cols: 3, span: 1 });
  for (let n = 1; n <= 6; n++) {
    const { cols, span } = annSendGrid(n);
    assert.ok(cols <= 3);
    assert.equal((n - 1 + span) % cols, 0, `n=${n} leaves a hole`);
  }
});
