/**
 * Downloads (`pull`) over `pull.ts`'s records. The component is the existing
 * `PullSheet.tsx`; this only wires it to the core and the feature's store.
 */
import { PullSheet } from "../../PullSheet";
import { useCore, useStore } from "../../sdk";
import { cfgs, rulesFor } from "./store";
import { putCfg } from "./actions";

export function DownloadsSheet() {
  const core = useCore();
  const configs = useStore(cfgs);
  const rules = useStore(rulesFor);
  return <PullSheet
    repos={core.world.repos}
    configs={configs}
    online={core.conn.status === "open"}
    onLoadConfig={(repoDir) => core.conn.liveAsk({ t: "pull.get", repoDir })}
    // Rules are small and idempotent, and a lost one is re-saved by the next
    // tap — no durable-op ceremony needed, unlike a build or a fan-out.
    onSaveConfig={(repoDir, config) => {
      putCfg(repoDir, config);
      core.conn.liveSend({ t: "pull.save", repoDir, config }, "auto-download rule saved",
        "no connection — the rule lives on the desktop and was not saved");
    }}
    onDismiss={(id) => core.conn.liveSend({ t: "pull.dismiss", id }, "dismissed")}
    rulesFor={rules ?? undefined}
    onOpenApps={() => { core.say.track("overlay:apps"); core.nav.open("apps"); }}
    onClose={() => core.nav.close("pull")}
  />;
}
