import test from "node:test";
import assert from "node:assert/strict";

import { isShellSuggestion } from "./cliSuggest.ts";

test("a proposal that runs a shell command is told apart from a prompt", () => {
  assert.equal(isShellSuggestion("! ollama rm qwen3-coder:30b && rm -rf ~/Library/Caches/pip"), true);
  assert.equal(isShellSuggestion("  !git push"), true);
  assert.equal(isShellSuggestion("watch CI and report when it finishes"), false);
  assert.equal(isShellSuggestion("push it!"), false);
});
