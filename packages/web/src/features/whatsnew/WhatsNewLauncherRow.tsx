/**
 * The one-time row at the top of the launcher: shown when the desktop's
 * version has rows and differs from what this phone was last told
 * (`LS.whatsNewSeen`). Two verbs, both retire it; its `title` names the way
 * back (Settings › Tools & diagnostics › what's new). Absent until the host has
 * said its version.
 */
import { Sparkles } from "lucide-react";
import { BRAND } from "@waterplane/shared";
import { core, useCore } from "../../sdk";
import { Button, RowTitle } from "../../kit";
import { markSeen, openWhatsNew } from "./actions";
import { useEffect } from "react";
import { announce, isFreshPhone, launcherLine, RELEASES } from "./logic";
import { useApkVersion, useDesktopVersion, useSeen } from "./store";
import { isNativeShell } from "../../hostUrl";

const WAY_BACK = "shown once for this version — Settings › Tools & diagnostics › what's new brings it back";

export function WhatsNewLauncherRow() {
  const desktop = useDesktopVersion();
  const seenV = useSeen();
  const c = useCore();
  // The hello sends the session lists before updates.status, so by the time the version is known they are in.
  const fresh = !!desktop && isFreshPhone({ sessions: c.world.sessions.length, recent: c.world.recent.length, closed: c.world.closed.length });
  const rel = announce(RELEASES, desktop, seenV, fresh);
  // A first install has nothing "new": quietly count this version as told.
  useEffect(() => { if (fresh && desktop) markSeen(desktop); }, [fresh, desktop]);
  const apk = useApkVersion(rel !== null);
  if (!rel || !desktop) return null;
  const shell = { native: isNativeShell(), apk };
  return (
    <div className="wn-row" title={WAY_BACK}>
      <div className="wn-head"><Sparkles size={16} /><RowTitle>{launcherLine(BRAND.name, rel, shell)}</RowTitle></div>
      <div className="wn-acts">
        <Button variant="primary" title={WAY_BACK} onClick={openWhatsNew}>see them</Button>
        <Button title={WAY_BACK} onClick={() => { markSeen(desktop); core().say.toast("Settings › Tools & diagnostics › what's new brings it back"); }}>got it</Button>
      </div>
    </div>
  );
}
