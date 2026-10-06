/**
 * The apps that install themselves (`apps`). The component is the existing
 * `AppsSheet.tsx`; this only wires it to the core.
 */
import { AppsSheet } from "../../AppsSheet";
import { useCore } from "../../sdk";

// Which of your own apps install themselves — the allow-list as a list, not
// as a switch buried on whichever download happened to bring the file
// (`AppsSheet.tsx`). It keeps no state: the list is synced localStorage and
// the builds are `pull.ts`'s records, so it paints offline.
export function AppsListSheet() {
  const core = useCore();
  return <AppsSheet onClose={() => core.nav.close("apps")} onOpenDownloads={() => core.nav.open("pull")} />;
}
