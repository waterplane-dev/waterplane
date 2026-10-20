/**
 * `tmuxLiteral`: ctrl+b is our tmux client's prefix, so a phone's ctrl+b
 * reaches the pane only doubled (tmux's default `C-b C-b` = send-prefix).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmuxLiteral } from "../dist/sessions/knobs.js";

test("every ctrl+b is doubled, nothing else is touched", () => {
  assert.equal(tmuxLiteral("\x02"), "\x02\x02");
  assert.equal(tmuxLiteral("a\x02b\x02"), "a\x02\x02b\x02\x02");
  assert.equal(tmuxLiteral("hello\r"), "hello\r");
  assert.equal(tmuxLiteral("\x1b[A\x03"), "\x1b[A\x03");
});
