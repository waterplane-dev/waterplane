/**
 * The two banners both screens draw under their header — the launcher and
 * the session screen mount the same pair, so they are components here rather
 * than two copies of a render function.
 *
 * Their state lives OUTSIDE either screen (a module store for the snooze, the
 * synced `dismissedUpdate` pref for the update bar): the screens unmount under
 * every sheet, and a dismissal that came back on the next Back would be a
 * banner that cannot be dismissed.
 */
import { type ReactNode, useEffect, useState } from "react";
import { Download, Loader, OctagonX, RefreshCcw, RotateCw, ShieldAlert, Smartphone, X } from "lucide-react";
import type { ClientMessage, LaunchOpts, SessionInfo, UpdateInfo } from "@waterplane/shared";
import { cliRestartDue, cliRestartView } from "@waterplane/shared";
import { askConfirm } from "../Confirm";
import { CantInline } from "../Unavailable";
import { resumeIdOf } from "../sessionFacts";
import { createStore, useStore } from "../sdk";
import { setPref, usePref } from "./prefs";
import { updateBarView } from "../updateBar";
import { track } from "../usage";
import { LS, lsGet, lsSet } from "../storage";
import { usePhoneSetup } from "../usePhoneSetup";
import { setupMissingText } from "../phoneSetup";
import { haltBannerWords, liftHalt, useHalt } from "../features/halt";

const ICON = 16;

/** How long the "you are on plain HTTP" banner stays hidden after a dismiss.
 *  A week, not forever: the failure it warns about recurs on every dropped
 *  tunnel, so silencing it permanently just hides a live problem. */
const INSECURE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

// Snoozed-until timestamp, not a permanent dismissal. The consequence of
// staying on the insecure origin is not cosmetic — it is the app being
// replaced by the browser's error page every time the tunnel dies during a
// navigation — and a banner you can silence forever is a banner that gets
// silenced on the first calm day and never seen again. An old `"1"` from the
// permanent-dismiss version reads as "snooze from now", so nobody is
// re-nagged the instant they update.
function loadInsecureSnooze(): number {
  const raw = lsGet(LS.dismissInsecure);
  if (raw === "1") return Date.now() + INSECURE_SNOOZE_MS;
  return Number(raw) || 0;
}
const insecureSnooze = createStore<number>(typeof window === "undefined" ? 0 : loadInsecureSnooze());

/**
 * The halt latch (`features/halt`), on every screen while it holds. Mounted in
 * `main.tsx` beside `UpdateBanner` for that file's reason: `App` returns early
 * per overlay, and a latch that stops everything must not hide behind a sheet.
 * Draws nothing while off. Never dismissable — the only way it goes is the
 * lift, because "why is nothing starting?" with no banner is what it is for.
 */
export function HaltBanner(): ReactNode {
  const h = useHalt();
  if (!h.on) return null;
  return (
    <div className="staged-bar halt-bar" role="alert">
      <OctagonX size={16} />
      <span className="staged-bar-text">{haltBannerWords(h)}</span>
      <button type="button" className="key staged-bar-go" onClick={liftHalt}>Lift halt</button>
    </div>
  );
}

/**
 * "You are on the plain-HTTP door, and a secure one exists."
 *
 * Everything that makes this app survive a bad link needs a service worker:
 * the cached app shell, OS push, the installed PWA, Background Fetch. A
 * service worker needs a secure context, and `http://100.x.y.z:8770` is not
 * one. The practical consequence is the failure this banner exists to stop —
 * the tunnel drops mid-sentence, the page navigates or reloads, and the
 * browser's own ERR_CONNECTION_TIMED_OUT page replaces the entire app: no
 * queue, no compose box, no way back until the link returns.
 *
 * The host already discovers its own `tailscale serve` front door and sends
 * it as `welcome.httpsUrl`. It was only listed in Settings → Connection,
 * which nobody reads while it is working. So say it where it can be acted on,
 * once — dismissible, and never shown when we are already secure or when
 * there is no HTTPS door to move to.
 */
export function InsecureBanner({ httpsUrl }: { httpsUrl: string | null }): ReactNode {
  const snooze = useStore(insecureSnooze);
  if (typeof window === "undefined" || window.isSecureContext) return null;
  if (!httpsUrl || Date.now() < snooze) return null;
  return (
    <div className="update-bar-wrap">
      <div className="update-bar">
        <ShieldAlert size={ICON} />
        <span className="update-text">
          Plain HTTP: no offline shell, so a dropped tunnel replaces the app with the browser's
          timeout page. No push and no background downloads either. Switch to the HTTPS address.
        </span>
        <button className="key" onClick={() => { track("action:https.switch"); location.href = httpsUrl + location.pathname + location.hash; }}>
          switch
        </button>
        <button className="key" title="hide for a week — this comes back, because the problem does"
          onClick={() => {
            const until = Date.now() + INSECURE_SNOOZE_MS;
            insecureSnooze.set(until);
            lsSet(LS.dismissInsecure, String(until));
          }}>
          <X size={ICON} />
        </button>
      </div>
    </div>
  );
}

/** The phone-setup banner hides for a week after ×, for the insecure
 *  banner's reason: what it warns about is still true tomorrow. */
const SETUP_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const setupSnooze = createStore<number>(typeof window === "undefined" ? 0 : Number(lsGet(LS.dismissPhoneSetup)) || 0);

/**
 * "This phone has not allowed everything the app needs in the background."
 *
 * Android grants none of it unasked, and the steps lived in two screens
 * (Settings, the Apps sheet) that nobody opens while things seem to work — so a
 * download that waits for the app to be opened, or a build nobody is told
 * about, looked like the app failing. Android shell only; shown while any step
 * is missing and it is not snoozed. Opens the checklist in Settings.
 */
export function PhoneSetupBanner({ onOpen }: { onOpen: () => void }): ReactNode {
  const snooze = useStore(setupSnooze);
  const { steps } = usePhoneSetup();
  const text = steps ? setupMissingText(steps) : null;
  if (!text || Date.now() < snooze) return null;
  return (
    <div className="update-bar-wrap">
      <div className="update-bar">
        <Smartphone size={ICON} />
        <span className="update-text">{text} Downloads, alerts and installs wait for the app to be opened until then.</span>
        <button className="key" onClick={() => { track("action:phoneSetup.open"); onOpen(); }}>set up</button>
        <button className="key" title="hide for a week — this comes back while something is still missing"
          onClick={() => {
            const until = Date.now() + SETUP_SNOOZE_MS;
            setupSnooze.set(until);
            lsSet(LS.dismissPhoneSetup, String(until));
          }}>
          <X size={ICON} />
        </button>
      </div>
    </div>
  );
}

export interface CliUpdateBannerProps {
  update: UpdateInfo | null;
  liveAsk: (frame: ClientMessage, blocked?: string) => boolean;
  liveSend: (frame: ClientMessage, done: string, blocked?: string) => boolean;
}

/** The desktop's `claude` update: available, running, or what the last try said. */
export function CliUpdateBanner({ update, liveAsk, liveSend }: CliUpdateBannerProps): ReactNode {
  const dismissedUpdate = usePref("dismissedUpdate");
  const [, bump] = useState(0);
  // Whether the bar is up, and what a × on it records — `updateBar.ts`, which
  // is where the rule is pinned by tests. It was inline here, and the × was
  // dead on exactly the bars people most want gone.
  const { show, sig, recentResult, canApply, staleAt } = updateBarView(update, dismissedUpdate, Date.now());
  // "Fresh" is a clock reading, and nothing else re-renders this when the 30 s
  // run out — without a timer the "Updated: …" bar sat there until the next
  // status frame, however long that took.
  useEffect(() => {
    if (staleAt == null) return;
    const t = setTimeout(() => bump((n) => n + 1), Math.max(0, staleAt - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [staleAt]);
  if (!update || !show) return null;
  const result = update.lastResult;
  // A FRESH result outranks the "an update is available" headline, and that
  // order is the whole point: the upgrade you just pressed can run clean and
  // move nothing (a Homebrew cask lagging the npm release the CLI nags about),
  // which leaves `available` true — so the old ladder asked for an upgrade
  // again and never said why the last one did nothing. The reason was on the
  // wire the whole time; only a toast carried it, for a few seconds, on a
  // phone. The headline comes back on its own once the result goes stale.
  const text = update.running
    ? "Updating Claude…"
    : result && recentResult
      ? (result.ok ? `Updated: ${result.message}` : `Update failed: ${result.message}`)
      : update.available
        ? `Claude ${update.current ?? ""} → ${update.latest ?? "new"} available${update.source === "cli" ? (update.route === "brew" ? " (cask lags npm)" : " (the CLI says so)") : ""}`
        : `Claude ${update.current ?? "(unknown)"} · up to date`;
  const cls = update.running ? "running" : update.available ? "" : "idle";
  const showLog = (update.running || recentResult) && update.log && update.log.length > 0;
  return (
    <div className={`update-bar-wrap ${cls}`}>
      <div className={`update-bar ${cls}`}>
        <Download size={ICON} />
        <span className="update-text">{text}</span>
        {/* While the upgrade runs, check / apply / dismiss cannot do anything,
            so they are not drawn — the state is said in words instead of three
            dimmed buttons (`Unavailable.tsx`); they come back when it ends. */}
        {update.running ? (
          <span className="act-cant act-cant-inline"><Loader size={ICON} className="spin" /> running — the buttons come back when it finishes</span>
        ) : <>
          <button className="key" onClick={() => liveAsk({ t: "update.check" }, "no connection — the update lives on the desktop and can't be checked from here")}>
            <RotateCw size={ICON} />
          </button>
          {canApply && <button className="key" onClick={() => liveSend({ t: "update.apply" }, "updating — the host restarts itself when it is done")}>
            {update.applyLabel ?? "update"}
          </button>}
          <button className="key" title="dismiss this — it comes back for a newer version, a new upgrade result or a new error"
            onClick={() => setPref("dismissedUpdate", sig)}>
            <X size={ICON} />
          </button>
        </>}
      </div>
      {showLog && (
        <pre className="update-log" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
          {update.log!.slice(-50).join("\n")}
        </pre>
      )}
    </div>
  );
}

/** Which restart offers were waved away, as `<session id>|<installed version>`:
 *  per session and per version, so a newer install asks again. In memory — a
 *  reload is a fine moment to be told once more. */
const restartDismissed = new Set<string>();

export interface CliRestartBannerProps {
  active: SessionInfo;
  update: UpdateInfo | null;
  relaunch(s: SessionInfo, patch: Partial<LaunchOpts>): void;
}

/**
 * **This session runs an older `claude` than the one installed** — the CLI's
 * own "Update installed · Restart to apply", with the restart as a button.
 *
 * The restart is `relaunch` with nothing changed: kill + create as one durable
 * op, resuming this exact conversation (`--resume <id>`), so the process is
 * replaced and the conversation is not. What it WOULD kill — a running turn, a
 * background agent — is named and asked about first; it never fires itself
 * (`shared/clirestart.ts`).
 */
export function CliRestartBanner({ active, update, relaunch }: CliRestartBannerProps): ReactNode {
  const [, bump] = useState(0);
  const due = cliRestartDue(active.cliVersion, update?.current);
  if (!due) return null;
  const key = `${active.id}|${due.installed}`;
  if (restartDismissed.has(key)) return null;
  const v = cliRestartView(due, {
    turnActive: active.turnActive, agents: active.agents?.length, shells: active.shells, resumeId: resumeIdOf(active),
  });
  const restart = async () => {
    if (v.loses && !(await askConfirm({
      title: "Restart this session now?",
      lines: [
        `Restarting stops ${v.loses}; their work so far stays in the conversation, but what they were still doing is not finished.`,
        "The conversation itself reopens on the new version.",
      ],
      confirmLabel: "Restart now",
    }))) return;
    track("action:session.cliRestart");
    relaunch(active, {});
  };
  return (
    <div className="update-bar-wrap">
      <div className="update-bar">
        <RefreshCcw size={ICON} />
        <span className="update-text">
          {v.text}{v.loses ? ` Running now: ${v.loses}.` : ""}
        </span>
        {v.cant
          ? <CantInline>can't restart here — {v.cant}</CantInline>
          : <button className="key" onClick={() => void restart()}>Restart, same conversation</button>}
        <button className="key" title="hide this for this version — a newer install asks again"
          onClick={() => { restartDismissed.add(key); bump((n) => n + 1); }}>
          <X size={ICON} />
        </button>
      </div>
    </div>
  );
}
