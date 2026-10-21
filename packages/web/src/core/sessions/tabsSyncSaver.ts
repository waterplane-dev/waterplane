import { askChoice } from "../../Confirm";
import { dataSaver } from "../../media";
import { SAVER_WORDS, offerUnsync, saverOn, tabsSynced, type SaverKind } from "../../sessionTabs";
import { phonePowerSave } from "../../shellLink";
import { LS, lsDel, lsGet, lsSet } from "../../storage";
import { showToast } from "../../toast";
import { prefs, setPref } from "../prefs";

/**
 * **A saver came on: offer to stop sharing the tab order.**
 *
 * Sharing sends a settings frame to the desktop on every tab switch — small,
 * but a person who just asked this device to save data or battery should be
 * asked whether that is one of the things to stop. Asked, never applied
 * (CLAUDE.md: nothing applies itself), once per saver spell: the mark is
 * cleared only when no saver is on (`saverOn`, the one predicate).
 */
export async function offerTabsUnsync(kind: SaverKind): Promise<void> {
  if (!tabsSynced()) return;
  lsSet(LS.tabsSaverAsked, "1");
  const r = await askChoice({
    title: `Stop sharing tab order while ${SAVER_WORDS[kind]} is on?`,
    lines: [
      "Shared, every tab you open sends a small update to the desktop so your other devices order their tabs the same way.",
      "Stopped, this device keeps its own order. Settings › Appearance › same tab order on every device turns it back on.",
    ],
    confirmLabel: "stop sharing",
    cancelLabel: "keep sharing",
  });
  if (!r) return;
  if (r.ok) {
    setPref("tabsSync", false);
    prefs.reload("tabsSort");
    showToast("tab order kept on this device — Settings › Appearance shares it again");
  } else {
    showToast("tab order still shared");
  }
}

interface NetInfo extends EventTarget { saveData?: boolean }
const conn = (): NetInfo | undefined => (navigator as unknown as { connection?: NetInfo }).connection;

/** Look at every saver once: offer when one is on and this spell has not
 *  asked, forget the spell when none is. */
async function check(): Promise<void> {
  const kind = saverOn({ app: dataSaver(), phoneData: !!conn()?.saveData, battery: await phonePowerSave() });
  if (!kind) { lsDel(LS.tabsSaverAsked); return; }
  if (offerUnsync(kind, tabsSynced(), lsGet(LS.tabsSaverAsked) === "1")) void offerTabsUnsync(kind);
}

let watching = false;
/**
 * Check after start-up settles, whenever the app comes back to the front
 * (the battery saver has no page event), and when the phone's link changes.
 */
export function watchSaverForTabs(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  setTimeout(() => { void check(); }, 4000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void check(); });
  try { conn()?.addEventListener("change", () => { void check(); }); } catch { /* no Network Information API */ }
}
