/**
 * The `clihealth` overlay: `CliHealthSheet.tsx` wired to this feature's
 * filter. Moved verbatim out of App (`overlayViews.clihealth`).
 */
import { CliHealthSheet } from "../../CliHealthSheet";
import { useCore, useStore } from "../../sdk";
import { filter } from "./store";
import { requestCliHealth } from "./actions";

// The ten places this app reads something it does not own, and what each of
// them last managed to read. `online` is the SOCKET's verdict rather than
// `navigator.onLine`, which stays true while the Tailscale path is dead —
// i.e. during exactly the outage this board is opened during.
export function HealthBoardSheet() {
  const c = useCore();
  const f = useStore(filter);
  return <CliHealthSheet online={c.conn.status === "open"} request={requestCliHealth} onClose={() => c.nav.close("clihealth")}
    filter={f} onClearFilter={() => filter.set(null)}
    onClearWarnings={(through, n) => c.conn.liveSend({ t: "clihealth.clear", through },
      `Cleared ${n} warning${n === 1 ? "" : "s"} — a new miss brings ${n === 1 ? "it" : "them"} back.`)} />;
}
