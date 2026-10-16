/**
 * Settings → Code folder: the folder the host scans for repos, how it came to be that one, and the
 * door to the dialog that changes it (`CodeFolderSheet`).
 */
import { useEffect } from "react";
import { FolderOpen } from "lucide-react";
import { isDemo } from "../../demoEntry";
import { useStore } from "../../sdk";
import { SetAction, SetWarn } from "../../SettingsKit";
import { loadRoot, openCodeFolder } from "./actions";
import { pendingWords, pickedWords, rootLine } from "./logic";
import { rootInfo, rootUi } from "./store";

export function CodeFolderSettings() {
  const info = useStore(rootInfo);
  const ui = useStore(rootUi);
  // Read while Settings is on screen: the only place this row is drawn.
  useEffect(() => { if (!isDemo()) void loadRoot(); }, []);
  if (isDemo()) return null;
  const err = ui.phase === "idle" ? ui.readError : null;
  return (
    <SetAction
      id="code-folder" label="Code folder" icon={FolderOpen} opens onClick={openCodeFolder}
      note={info
        ? <><span className="mono">{rootLine(info)}</span> — {pickedWords(info.picked, info.envName)}</>
        : err ? `Could not read this desktop's code folder: ${err}` : "Reading which folder the desktop scans…"}
      more={<p>Everything under it is reachable from the phone; the host scans it for repos. A change takes effect when the host restarts.</p>}
    >
      {info?.pending && <SetWarn tone="plain">{pendingWords(info.pending)}</SetWarn>}
    </SetAction>
  );
}
