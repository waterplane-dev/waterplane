// e2e fixture plugin (scripts/e2e-usagesources.mjs): registers two usage probes.
//   "stub"  — answers from the JSON file named by the E2E_PROBE_MODE knob (the manifest declares
//             it by full name; the name here is BRAND's prefix, as everywhere), re-read on every ask:
//             { mode: "ok" | "null" | "throw", pct, resetAt }. Each ask appends a line to "<file>.asks".
//   "quiet" — always answers null: a source with nothing to say, which must draw nothing.
import { readFileSync, appendFileSync } from "node:fs";
import { BRAND } from "../../../packages/shared/dist/brand.js";

export function activate(api) {
  const file = api.env(`${BRAND.envPrefix}E2E_PROBE_MODE`);
  api.usageProbe({
    source: "stub", label: "Stub", everyMs: 60_000,
    probe: async () => {
      const m = JSON.parse(readFileSync(file, "utf8"));
      appendFileSync(file + ".asks", "ask\n");
      if (m.mode === "throw") throw new Error("stub probe told to fail");
      if (m.mode === "null") return null;
      return { checkedAt: Date.now(), windows: [{ id: "day", unit: "d", pct: m.pct, resetAt: m.resetAt }] };
    },
  });
  api.usageProbe({ source: "quiet", label: "Quiet", probe: async () => null });
}
