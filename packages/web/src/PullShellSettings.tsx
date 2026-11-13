/**
 * The Downloads sheet's "This phone" rows after the master switch: where a finished download goes
 * (save to Downloads, keep only that copy, with the shell-version gate in words), and the pointer to
 * the screen of this phone's own apps. Cut out of `PullSheet.tsx` by subject; the master switch and
 * the per-repo rules stay there.
 *
 * A top-level module, not `features/pull/`: `PullSheet.tsx` is a top-level module, and only App and
 * core import a feature (`local/feature-boundary`).
 */
import { useEffect, useState } from "react";
import { Boxes, Download, HardDrive } from "lucide-react";
import { BRAND } from "@waterplane/shared";
import type { PullRecord } from "./pull";
import { autoSaveOutPref, setAutoSaveOut } from "./download";
import { nativeSaveSupported } from "./nativeSave";
import { track } from "./usage";
import { Button } from "./kit";
import { isNativeShell } from "./hostUrl";
import { nativeDropAfterSave, setNativeDropAfterSave } from "./nativePull";
import { showToast } from "./toast";
import type { InstallCaps } from "./installPolicy";
import { nativeInstallSupported } from "./nativeInstall";
import { SetLine, SetNote, SetSwitch } from "./SettingsKit";
import { nativeInfo } from "./webUpdate";
import { APK_0_1_8, apkNeedWords, apkOk, shellApkUrl, shellApkWhere, shellApkWords } from "./apkGate";
import { openExternal } from "./openExternal";

interface Props {
  caps: InstallCaps;
  /** `installIntroText(caps, allow)`, as the sheet's files pane words it. */
  installIntro: string | null;
  /** The finished downloads, so the gate names the files tab only when a new enough shell APK is there. */
  finished: readonly PullRecord[];
  /** Absent while no extension owns the apps screen: the pointer is then OMITTED (`PullSheet` Props). */
  onOpenApps?: () => void;
  /** Switch the sheet to its files pane (the gate's `files` door). */
  onShowFiles: () => void;
}

export function PullShellSettings({ caps, installIntro, finished, onOpenApps, onShowFiles }: Props) {
  const [autoSave, setAutoSaveState] = useState(autoSaveOutPref());
  // Held by the shell (the save it follows runs with the page frozen), so it is
  // ASKED on open. Undefined: no shell, or one older than the switch.
  const [dropCopy, setDropCopy] = useState<boolean | undefined>(undefined);
  const [phoneApk, setPhoneApk] = useState("");
  useEffect(() => { void nativeInfo().then((n) => setPhoneApk(n?.versionName ?? "")); }, []);
  useEffect(() => {
    let live = true;
    void nativeDropAfterSave().then((on) => { if (live) setDropCopy(on); });
    return () => { live = false; };
  }, []);
  // Where a newer shell comes from (`apkGate.ts`): the files tab only for a download that passes
  // this switch's gate, else Play's page or the release page.
  const apkWhere = shellApkWhere(caps.distribution, caps.self, finished.map((r) => ({ pkg: r.pkg, version: r.pkgVersion })), APK_0_1_8);
  const apkWords = shellApkWords(apkWhere);
  const getApk = () => {
    track(`action:pull.getApk.${apkWhere}`);
    const url = shellApkUrl(apkWhere, caps.self ?? BRAND.appId, BRAND.githubOrg, BRAND.slug);
    if (!url) onShowFiles();
    else if (!openExternal(url)) showToast("could not open that page on this device.");
  };

  return (
    <>
      {/* Where a finished download GOES. The save button on every row was a
          second step nobody wants to take 28 times, and taking it twice made a
          second copy rather than overwriting the first — so the hand-off is
          automatic and the rows say what the folder holds. */}
      <SetSwitch
        label="save to Downloads automatically" icon={Download} on={autoSave}
        onChange={() => { const on = !autoSave; setAutoSaveOut(on); setAutoSaveState(on); track("action:pull.autosave"); }}
        note={nativeSaveSupported()
          ? "Every file that finishes downloading is put in the phone's Downloads by itself. A file already there is left alone — saving it again would only add a copy beside it."
          : "In a browser the file is handed to the browser's own downloads, which it may refuse unless a tap asked for it — so here this only covers files you tapped."}
      />

      {/* One copy, not two: once Downloads holds the file, this app's own
          copy is the same bytes again. APKs still install — the shell reads
          the Downloads copy. */}
      {isNativeShell() && (
        // The shell's own answer draws the switch; the version gate (`apkGate.ts`, shared with
        // What's new) words the refusal. A new enough shell still being asked draws nothing yet.
        dropCopy !== undefined ? (
          <SetSwitch
            label="keep only the Downloads copy" icon={HardDrive} on={dropCopy}
            onChange={() => {
              const on = !dropCopy;
              track("action:pull.dropcopy");
              void setNativeDropAfterSave(on).then(
                () => setDropCopy(on),
                (e: unknown) => showToast(`could not change it — ${e instanceof Error ? e.message : String(e)}`));
            }}
            note="Once a file is in Downloads, this app deletes its own copy."
            more={<p>Apps still install from the Downloads copy; delete that one and the file has to be fetched again.</p>}
          />
        ) : !apkOk(APK_0_1_8, phoneApk) && (
          <SetLine>
            <SetNote as="span">
              This switch {apkNeedWords(APK_0_1_8, phoneApk)}.
            </SetNote>
            {/* `shellApkWhere`: never a door to an empty pane */}
            <SetNote as="span">{apkWords.note}</SetNote>
            <Button title={apkWords.title} onClick={getApk}>{apkWords.verb}</Button>
          </SetLine>
        )
      )}

      {/* Installing is its OWN screen — this is the pointer to it, on the
          settings pane where somebody looking for "which apps update
          themselves" will look for it. */}
      {nativeInstallSupported() && onOpenApps && (
        <SetLine>
          <Button onClick={() => { track("action:pull.apps"); onOpenApps(); }}>
            <Boxes size={14} /> android apps
          </Button>
          <SetNote as="span">
            Which of your apps install themselves when a new build lands here. {installIntro ?? ""}
          </SetNote>
        </SetLine>
      )}
    </>
  );
}
