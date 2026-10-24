/**
 * The kit's one door to `@waterplane/shared`: the pure validators and constants are IMPORTED from
 * the built package next to this directory, never copied, so a plugin tested here is tested against
 * the contract the host was built from. Needs `npm run build:shared` once in the waterplane checkout.
 */
let shared;
try {
  shared = await import(new URL("../shared/dist/index.js", import.meta.url).href);
} catch (e) {
  throw new Error(`@waterplane/plugin-testkit needs the built shared package (packages/shared/dist) — run \`npm run build:shared\` in the checkout this kit sits in (${e?.message ?? e})`);
}
export const {
  FACT_NAMES, SOURCE_KEYS_MAX, SOURCE_TYPED_MAX, PLUGIN_BACKEND_ID_RE, PLUGIN_API_VERSION,
  PLUGIN_HOOK_HOLD_DEFAULT_MS, PLUGIN_HOOK_HOLD_MAX_MS,
  manifestProblems, pluginApiProblem, bindConversation, pickBound, BIND_CONFIRM_MS,
  // 2.2 slot shapes: the one rule the host's consumers ask too (`shared/src/sourceshape.ts`).
  SOURCE_COMMANDS_MAX, SOURCE_COMPACTIONS_MAX, sourceModeProblem, sourceCommandsProblems, sourceSpendProblems,
  sourceCompactionsProblems, sourceContextSampleProblems,
  // 2.2 `caps.launchModes`: the one subset rule the host refuses by (`shared/src/launchmodes.ts`).
  launchModesProblems, launchModesOf, PERMISSION_MODE_NAMES,
  LEGACY,
} = shared;
