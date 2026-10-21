import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownToLine, CheckCircle2, Loader2, RotateCcw, ShieldAlert, Smartphone, XCircle } from "lucide-react";
import { autoApply, autoUpdate, nativeInfo, setAutoApply, setAutoUpdate, updates, type NativeUpdateInfo, type UpdateStatus } from "./webUpdate";
import { ago } from "./format";
import { track } from "./usage";
import { Button } from "./kit/Button";
import { SetNote } from "./SettingsKit";

/**
 * Settings → App version. Android shell only.
 *
 * A self-contained section rather than more state in `App.tsx`: nothing else in
 * the app cares about the bundle version, and the alternative was threading a
 * subscription through a 4000-line component for one panel.
 *
 * The wording is deliberate about *when* things happen. A staged update is not
 * "installed", it is waiting for a restart, and saying so is the difference
 * between someone trusting the number in front of them and wondering why their
 * change is not visible.
 */
export function AppUpdateSection({ onToast, bare }: {
  onToast?: (m: string) => void;
  /**
   * Draw the body only — no `<section>`, no heading of its own.
   *
   * Settings puts this inside a group now, and a `.set-group` nested in a
   * `.set-group` doubles the padding and draws a second divider through the
   * middle of one subject. The standalone form is kept because this component
   * is the whole answer to "what version am I on" and is worth being able to
   * drop somewhere on its own.
   */
  bare?: boolean;
}) {
  const [s, setS] = useState<UpdateStatus>(updates.get());
  const [auto, setAuto] = useState(autoUpdate());
  const [apply, setApply] = useState(autoApply());
  const [native, setNative] = useState<NativeUpdateInfo | null>(null);
  useEffect(() => updates.subscribe(setS), []);
  // Refetched whenever a bundle swap could have happened — `staged` becoming
  // true again means a restart landed, and this is the one place that can
  // confirm it actually did rather than assuming from `stagedId` bookkeeping.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the derived boolean (a restart landing), not the whole status
  useEffect(() => { void nativeInfo().then(setNative); }, [s.phase === "staged"]);

  const fresh = !!s.current && !!s.available && s.current === s.available;

  const Frame = bare
    ? ({ children }: { children: ReactNode }) => <>{children}</>
    : ({ children }: { children: ReactNode }) => (
        <section className="set-group">
          <h3 className="set-title"><Smartphone size={14} style={{ verticalAlign: "-2px" }} /> App version</h3>
          {children}
        </section>
      );

  return (
    <Frame>
      <SetNote>
        The interface lives inside the APK so it survives a dead tunnel. It still
        updates itself from the desktop — you only need a new APK when the native
        shell itself changes. Checking, downloading and restarting all happen by
        themselves; the buttons here are for when you don't want to wait.
      </SetNote>

      <div className="set-row">
        <span className="set-note" style={{ flexBasis: "auto" }}>
          running <code>{s.current ?? "unknown"}</code>
          {s.available && !fresh && <> · host has <code>{s.available}</code></>}
          {fresh && <> · up to date</>}
          {s.lastCheckedAt && <> · checked {ago(s.lastCheckedAt)}</>}
        </span>
      </div>
      {native && (
        <div className="set-row">
          <span className="set-note" style={{ flexBasis: "auto" }}>
            {native.builtIn ? "serving the APK's own built-in bundle" : "serving a downloaded bundle"}
            {native.versionName && <> · shell version <code>{native.versionName}{native.versionCode ? ` (${native.versionCode})` : ""}</code></>}
          </span>
        </div>
      )}
      {s.phase === "unsupported" && (
        <SetNote>
          no update mechanism on this build — either this is not the Android
          shell, or the installed APK predates the plugin OTA relies on.
          "check now" below does nothing until a newer APK is sideloaded.
        </SetNote>
      )}

      {s.phase === "downloading" && s.progress && (
        <SetNote>
          <Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} />{" "}
          downloading {s.progress.files}/{s.progress.totalFiles} files ·{" "}
          {Math.round(s.progress.bytes / 1024)} / {Math.round(s.progress.totalBytes / 1024)} KB
        </SetNote>
      )}
      {s.phase === "staged" && (
        <div className="set-note" style={{ color: "var(--ok)" }}>
          <CheckCircle2 size={13} style={{ verticalAlign: "-2px" }} /> build <code>{s.stagedId}</code> downloaded
          and verified — {apply
            ? "it starts by itself once you put the app down."
            : "it starts the next time the app does."}
        </div>
      )}
      {s.phase === "held" && (
        <div className="set-note" style={{ color: "var(--warn)" }}>
          <ShieldAlert size={13} style={{ verticalAlign: "-2px" }} /> {s.message}. Not downloaded
          again by itself — the desktop's next build is taken as usual.
        </div>
      )}
      {s.phase === "unavailable" && (
        <SetNote>the desktop cannot serve a bundle: {s.message}</SetNote>
      )}
      {s.phase === "error" && (
        <div className="set-note" style={{ color: "var(--dead)" }}>
          <XCircle size={13} style={{ verticalAlign: "-2px" }} /> {s.message}
        </div>
      )}

      <div className="set-row" style={{ flexWrap: "wrap" }}>
        <Button
          disabled={s.phase === "checking" || s.phase === "downloading"}
          onClick={() => { track("action:appUpdate.check"); void updates.check(); }}
        >
          {s.phase === "checking" ? <Loader2 size={12} className="spin" /> : <ArrowDownToLine size={12} />} check now
        </Button>
        {s.phase === "staged" && (
          <Button
            variant="primary"
            onClick={() => { track("action:appUpdate.apply"); onToast?.("restarting into the new build"); void updates.applyNow(); }}
          >restart into it</Button>
        )}
        {!!s.available && !fresh && s.phase !== "downloading" && s.phase !== "staged" && (
          s.phase === "held" ? (
            <Button
              onClick={() => { track("action:appUpdate.retryHeld"); void updates.download(true); }}
            >try build {s.available.slice(0, 8)} again</Button>
          ) : (
            <Button
              onClick={() => { track("action:appUpdate.download"); void updates.download(); }}
            >download now</Button>
          )
        )}
        <Button
          className={auto ? "active" : ""}
          onClick={() => { const n = !auto; setAuto(n); setAutoUpdate(n); track("action:appUpdate.auto"); }}
        >{auto ? "auto-update on" : "auto-update off"}</Button>
        <Button
          className={apply ? "active" : ""}
          onClick={() => { const n = !apply; setApply(n); setAutoApply(n); track("action:appUpdate.autoApply"); }}
        >{apply ? "auto-restart on" : "auto-restart off"}</Button>
      </div>
      <SetNote>
        A downloaded build never replaces the screen you are reading: the restart
        waits until the app has been in your pocket for a bit, or takes the moment
        you come back after a couple of minutes away — where it reads as the app
        starting rather than as the app reloading.
      </SetNote>

      <div className="set-row">
        <Button
          variant="danger"
          onClick={() => { track("action:appUpdate.revert"); onToast?.("back to the built-in build"); void updates.revertToBuiltIn(); }}
        ><RotateCcw size={12} /> use the build inside the APK</Button>
        <span className="set-note">
          The escape hatch if a downloaded build misbehaves. The app does this by
          itself too, when a downloaded build has not started after 15 seconds on
          screen, or after three launches that never finish starting — and then
          leaves that build alone until the desktop serves a different one.
        </span>
      </div>
    </Frame>
  );
}
