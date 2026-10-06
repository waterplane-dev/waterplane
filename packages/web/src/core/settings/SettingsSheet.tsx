/**
 * The Settings screen — the app's own configuration and the aggregator of every
 * feature's rows (`featureSettingsRows`), so a core screen like `overlayViews`
 * rather than a feature: it cannot be owned by any one of the things it lists.
 *
 * What it reads: this device's preferences through `usePref` (`core/prefs.ts`),
 * the host's facts through `core()` (launch defaults, backends, the queue, the
 * link), and — as props — the handful of things only App holds today (the
 * install offer, the reconnect question, the backend switch, the screenshot
 * repo picker, the socket's reconnect).
 *
 * **Where a feature's rows land** is its `order`, cut into BANDS so a row can
 * keep the place it had before it moved out of App:
 *  - `order < 0` — at the HEAD of the group, before the core's own rows
 *    (Connection: the host tools' paired-host / app version / endpoints);
 *  - `order >= 0` — at the END of the group (Sessions: limits 10, auto-compact 30;
 *    Notifications: notifications 10, host tools 20; Offline: downloads 10);
 *  - Tools is the one group with a RACK: `order < -10` is above it (token
 *    statistics, -20), `-10 <= order < 0` opens it (CLI health, -10; the
 *    decision log, -5), and `order >= 0` follows it (plugins, 10).
 *
 * Every row id drawn here or by a feature is in `settingsIndex.ts`, and the
 * `<SetGroup>` ORDER below is the catalogue's — `settingsIndex.test.mjs` reads
 * this file back for both.
 */
import {
  Bell, Bot, CloudUpload, CornerDownLeft, Cpu, ExternalLink, Gauge, HardDrive, HelpCircle, KeyRound,
  ListChecks, Lock, Monitor, Radio, RotateCw, Settings, ShieldAlert, Smartphone, SunMoon, Waypoints,
  Activity, BarChart3, DoorClosed,
} from "lucide-react";
import { BRAND, SYNCED_SETTING_KEYS, envName, type Effort, type PermissionMode } from "@waterplane/shared";
import { useEffect } from "react";
import { createStore, useStore } from "../../sdk/store.ts";
import { settingsOnly, useSettingsOnly } from "../../settingsFocus.ts";
import { core } from "../api.ts";
import { featureSettingsRows } from "../settingsRows.ts";
import { RISKY_PERM_MODES, RISKY_PERM_WARNING } from "./permModes.ts";
import { setPref, usePref } from "../prefs.ts";
import { SheetHead } from "../../Sheet.tsx";
import { SyncMark } from "../../SyncMark.tsx";
import {
  SetAction, SetCustom, SetFilterBar, SetGroup, SetPick, SetSearch, SetSwitch, SettingsScope, newSettingsTally,
} from "../../SettingsKit.tsx";
import { CantInline, Unavailable } from "../../Unavailable.tsx";
import { ModelField } from "../../ModelField.tsx";
import { CLAUDE as CLAUDE_ID, agentBackends, backendOptionLabel, backendUnavailable, capReason, effortChoices, hasCap, permModeChoices, showBackendPicker, windowNote } from "../../backendCaps.ts";
import { clearHostedAck } from "../../hostedAck.ts";
import { askConfirm } from "../../Confirm.tsx";
import { pushAllSettings } from "../../settings.ts";
import { api } from "../../api.ts";
import { showToast } from "../../toast.ts";
import { track } from "../../usage.ts";
import { showHostStat, takeShot } from "../../features/hostTools";
import {
  AppearanceRows, OfflineRows, WritingRows, type InstallFacts, type ReconnectFacts, type VoiceFacts,
} from "./SettingsGroups.tsx";

/**
 * The search box. Transient on purpose — no storage key, no sync: a filter is
 * the tap, not a setting, and coming back to Settings with a week-old query
 * still narrowing it is how a screen looks broken. Page-lifetime, as App's
 * state was, so closing and reopening within one visit keeps it.
 */
const query = createStore("");
/** Live SettingsSheet instances — see the pin's effect in the sheet. */
let mounted = 0;
/** The LAN password being typed — never persisted anywhere. */
const lanPwDraft = createStore("");

export interface SettingsSheetProps {
  /** Switch the default backend — clears the model with it (App's `pickBackend`). */
  pickBackend(id: string | undefined): void;
  voice: VoiceFacts;
  install: InstallFacts;
  reconnect: ReconnectFacts;
  /** Drop the socket and dial again (after logging this device out). */
  redial(): void;
  /** More than one repo could store a desktop screenshot: ask which. */
  pickShotRepo(): void;
}

export function SettingsSheet(props: SettingsSheetProps) {
  const settingsQ = useStore(query);
  const only = useSettingsOnly();
  // A door's pin is for that visit only: closing Settings drops it, so the
  // menu's own "Settings" never opens on one row left over from a door.
  // Counted and checked a microtask later, because StrictMode's dev-only
  // unmount/remount would otherwise drop the pin on the way IN.
  useEffect(() => {
    mounted++;
    return () => { mounted--; queueMicrotask(() => { if (mounted === 0) settingsOnly.set(null); }); };
  }, []);
  const c = core();
  const { status } = c.conn;
  const { tailscaleIp } = c.conn.info;
  /* One tally per render pass. The rows push their ids into it as they
     draw, and `SetFilterBar` — last in the markup, first on the screen —
     reads the finished counts. See `SettingsKit.tsx`. */
  const tally = newSettingsTally(settingsQ, only);
  return (
    <div className="sheet">
      <SheetHead title={<><Settings size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} /> Settings</>} onClose={() => c.nav.close("settings")}>
        <div className={`conn conn-${status}`}>{status}{tailscaleIp ? ` · ${tailscaleIp}` : ""}</div>
      </SheetHead>
      {/* Every switch below this line follows the user to their other
          devices. The `conn` chip in the head says whether there is a link;
          this says whether what you changed has actually crossed it, which
          is a different question and the one nothing answered. */}
      <SyncMark keys={SYNCED_SETTING_KEYS} thing="your settings" />
      {/* Above the scroll, not in it: the box you type into must not walk
          off the top of the screen while you read what it found. */}
      <SetSearch value={settingsQ} onChange={(q) => { settingsOnly.set(null); query.set(q); }} />
      <SettingsScope value={tally}>
      <div className="settings">

        {/* ── Sessions ──────────────────────────────────────────────────
            First, because what brings anybody to this screen is a session
            doing something they did not ask for. The three sections this
            replaces — "New session defaults", "Usage limit", "Usage budget"
            — were one subject filed under three heads. */}
        <SetGroup id="sessions" title="Sessions" icon={Bot}>
          {featureSettingsRows("sessions", { to: 0 })}
          <SessionRows pickBackend={props.pickBackend} />
          {featureSettingsRows("sessions", { from: 0 })}
        </SetGroup>

        {/* ── Notifications ─────────────────────────────────────────── */}
        <SetGroup id="notifications" title="Notifications" icon={Bell}>
          {featureSettingsRows("notifications")}
        </SetGroup>

        {/* ── Appearance ────────────────────────────────────────────────
            Everything that decides what this screen looks like, including
            the three always-on strips whose switches used to live under
            "Tools" — a strip costs a line of THIS screen, which is the same
            question as the text size, not a diagnostic. All per device: the
            phone in a dark room and the desktop under a window want
            different answers. */}
        <SetGroup id="appearance" title="Appearance" icon={SunMoon}>
          {featureSettingsRows("appearance", { to: 0 })}
          <AppearanceRows />
          {featureSettingsRows("appearance", { from: 0 })}
        </SetGroup>

        {/* ── Writing & reading ─────────────────────────────────────── */}
        <SetGroup id="writing" title="Writing &amp; reading" icon={CornerDownLeft}>
          {featureSettingsRows("writing", { to: 0 })}
          <WritingRows voice={props.voice} />
          {featureSettingsRows("writing", { from: 0 })}
        </SetGroup>

        {/* ── Offline & data ────────────────────────────────────────── */}
        <SetGroup id="offline" title="Offline &amp; data" icon={Smartphone}>
          {featureSettingsRows("offline", { to: 0 })}
          <OfflineRows install={props.install} reconnect={props.reconnect} />
          {featureSettingsRows("offline", { from: 0 })}
        </SetGroup>

        {/* ── Connection ────────────────────────────────────────────── */}
        <SetGroup id="connection" title="Connection" icon={ExternalLink}>
          {featureSettingsRows("connection", { to: 0 })}
          <ConnectionRows redial={props.redial} />
          {featureSettingsRows("connection", { from: 0 })}
        </SetGroup>

        {/* ── Tools & diagnostics ───────────────────────────────────────
            Things you OPEN and read, not things you set. Nine doors in a
            rack rather than nine full-width rows with a paragraph each —
            the labels are what tells them apart, so the labels are all the
            row needs to be. */}
        <SetGroup id="tools" title="Tools &amp; diagnostics" icon={Waypoints}>
          {featureSettingsRows("tools", { to: -10 })}
          <div className="set-doors">
            {featureSettingsRows("tools", { from: -10, to: 0 })}
            <ToolDoors pickShotRepo={props.pickShotRepo} />
          </div>
          {featureSettingsRows("tools", { from: 0 })}
        </SetGroup>

        {/* Drawn last, floated to the top by `order: -1` — it reads the
            tally the rows above filled in during this same render. */}
        <SetFilterBar tally={tally} onClear={() => { settingsOnly.set(null); query.set(""); }} />
      </div>
      </SettingsScope>
    </div>
  );
}

// ── Sessions: the new-session defaults ──────────────────────────────────────

function SessionRows({ pickBackend }: { pickBackend: SettingsSheetProps["pickBackend"] }) {
  const c = core();
  const backends = c.world.backends;
  const launch = c.world.launch;
  const setLaunchOpt = c.launch.setOpt;
  const launchAsk = usePref("launchAsk");
  const closeWhenDone = usePref("closeWhenDone");
  return (
    <>
      {/* Rendered ONLY once this desktop has said what it can launch
          (`showBackendPicker`: the frame arrived AND it named more than
          one). A host that predates backends sends no frame, and there
          the picker is ABSENT — not greyed, not an empty select — so
          nothing can ask that host to spawn a binary it has never heard
          of. `launchFor` strips a stale stored `backend` on the way to
          the wire for the same reason. */}
      {showBackendPicker(backends) && (
        <SetPick
          id="launch-backend" label="backend"
          control={
            /* Switching backend clears the model with it. A model id
               belongs to the catalogue it came from — `opus` means
               nothing to a local runner and `ollama/qwen3-coder:30b`
               means nothing to claude — and carrying one across is how
               a launch fails with a message from a binary about a name
               it was handed by this app. */
            <select value={launch.backend ?? CLAUDE_ID}
              onChange={(e) => pickBackend(e.target.value === CLAUDE_ID ? undefined : e.target.value)}>
              {agentBackends(backends)!.map((b) => <option key={b.id} value={b.id}>{backendOptionLabel(b)}</option>)}
            </select>
          }
          note={<>What a new session runs.{windowNote(backends, launch.backend) ? ` ${windowNote(backends, launch.backend)}.` : ""}</>}
          more={<p>Sessions already open keep the binary they started with. The window size is said only when it is known — never a 0k, and never claude's window borrowed for a local model.</p>}
        >
          {/* What this backend cannot do, as sentences — the controls
              below are simply not drawn for it, and this is where they
              went (`Unavailable.tsx`). Never folded: an absence is the
              one thing that has to be read without being asked for. */}
          {backendUnavailable(backends, launch.backend) && (
            <div className="act-cants set-note"><CantInline>{backendUnavailable(backends, launch.backend)}</CantInline></div>
          )}
          <Unavailable className="set-note" cants={([
            ["context meter", "contextMeter"], ["transcript", "transcript"],
            ["slash commands", "slash"], ["effort", "effort"],
            ["remote control", "remoteControl"],
          ] as const).flatMap(([label, cap]) => {
            const reason = capReason(backends, launch.backend, cap);
            return reason ? [{ label, reason }] : [];
          })} />
        </SetPick>
      )}

      <SetPick
        id="launch-model" label="model"
        /* Aliases AND versions in one drop-down, with the typed field
           kept for a backend that names no models at all — `ModelField`
           owns all three cases, because the per-session ask
           (`LaunchAskSheet`) offers the same choice and a second copy of
           it is a second opinion about what claude accepts. */
        control={<ModelField backends={backends} backend={launch.backend} value={launch.model}
          onChange={(model) => setLaunchOpt({ model })} />}
      />

      {effortChoices(backends, launch.backend).length > 0 && (
        <SetPick
          id="launch-effort" label="effort"
          control={
            <select value={launch.effort ?? ""} onChange={(e) => setLaunchOpt({ effort: (e.target.value || undefined) as Effort })}>
              <option value="">default</option>
              {effortChoices(backends, launch.backend).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          }
        />
      )}

      {permModeChoices(backends, launch.backend).length > 0 && (
        <SetPick
          id="launch-permission" label="permission"
          control={
            <select
              className={launch.permissionMode && RISKY_PERM_MODES.has(launch.permissionMode) ? "danger" : ""}
              value={launch.permissionMode ?? ""}
              onChange={(e) => {
                const mode = (e.target.value || undefined) as PermissionMode | undefined;
                if (!mode || !RISKY_PERM_MODES.has(mode)) { setLaunchOpt({ permissionMode: mode }); return; }
                // Confirm before arming a no-approval mode. A `<select>`
                // has nothing to arm — the decision is made by the
                // change, not by a tap on a button — so this is the
                // dialog shape. Snapping the control back is
                // unconditional and immediate: the await means the
                // select would otherwise sit on the risky value while
                // the question is up, which reads as already applied.
                e.target.value = launch.permissionMode ?? "";
                void (async () => {
                  if (await askConfirm({ title: mode, lines: RISKY_PERM_WARNING, confirmLabel: "Run without asking" })) {
                    setLaunchOpt({ permissionMode: mode });
                  }
                })();
              }}
            >
              <option value="">default</option>
              {/* The modes this backend actually understands — never a
                  guessed subset. An empty list means it has no such
                  concept and the control above is not drawn at all. */}
              {permModeChoices(backends, launch.backend).map((x) => <option key={x} value={x}>{x}{RISKY_PERM_MODES.has(x) ? " — no approvals" : ""}</option>)}
            </select>
          }
        >
          {launch.permissionMode && RISKY_PERM_MODES.has(launch.permissionMode) && (
            <div className="set-note danger-note">
              <ShieldAlert size={13} style={{ verticalAlign: "-2px" }} /> New sessions run every tool call
              without asking. Nothing will stop a destructive command.{" "}
              <button className="link-btn" onClick={() => setLaunchOpt({ permissionMode: undefined })}>back to default</button>
            </div>
          )}
        </SetPick>
      )}

      {hasCap(backends, launch.backend, "remoteControl") && (
        <SetSwitch
          id="launch-remote" label="remote control" icon={Radio}
          on={!!launch.remoteControlled}
          onChange={() => setLaunchOpt({ remoteControlled: !launch.remoteControlled })}
          note="Starts new sessions with --remote-control, so they are steerable from claude.ai."
          more={<p>Applies to sessions you start from here. Sessions already open keep the flags they were started with.</p>}
        />
      )}

      {/* The other half of the values above: they are what a session
          runs when you are not thinking about it, and this is the switch
          for when you are. Off by default — an app that asks a question
          nobody wanted is worse than one that assumes. */}
      <SetSwitch
        id="launch-ask" label="ask before each launch" icon={HelpCircle}
        on={launchAsk}
        onChange={() => { track("action:launchAsk.toggle"); setPref("launchAsk", !launchAsk); }}
        note={<>On, starting a new session asks {showBackendPicker(backends) ? "which backend and model" : "which model"} first, starting from the values above.</>}
        more={<p>The answer applies to that session only — these defaults stay as they are. Resuming a conversation never asks: it keeps the launch it was recorded with.</p>}
      />

      {/* **Automatic sessions stay open unless asked.** The session a fired
          backlog or scheduled item opens used to close itself once done; the
          person chose OFF as the default, with a per-row answer on the
          backlog that wins either way. Synced, and read by the HOST — the
          desktop is the one place it acts. */}
      <SetSwitch
        id="close-when-done" label="Close automatic sessions when done" icon={DoorClosed}
        on={closeWhenDone}
        onChange={() => { track("action:closeWhenDone.toggle"); setPref("closeWhenDone", !closeWhenDone); }}
        note={closeWhenDone
          ? <>On: a session that a backlog or scheduled item opened closes itself once its work is done and it has sat idle for 10 minutes (the desktop's default). Its conversation stays under “Recently closed” and reopens where it left off.</>
          : <>Off: a session that a backlog or scheduled item opened stays open until you close it, so you can read it and carry on in it.</>}
        more={<>
          <p><b>Which sessions this covers.</b> Only the ones {BRAND.name} opens for work you queued: a backlog item (whether the backlog fired it or you tapped fire), each run of a scheduled item, a prompt an agent posted for later, and the session that continues one of these after a usage limit. Their titles start with “backlog ·”.</p>
          <p><b>Never closed by this.</b> Sessions you open yourself, the backlog's “open a session here”, one prompt sent to several repos, a launch you queued for later, and anything you reopened from “Recently closed”.</p>
          <p><b>What “done” means.</b> The turn has ended and the idle wait (10 minutes by default) has passed with nobody watching it on a phone, no background agent and no background shell still running under it. A session waiting on your answer is never closed.</p>
          <p><b>One item, its own answer.</b> Open a row on the backlog (or use the choice under “To” when you schedule one) to say “keep open” or “close when done” for that item only; it wins over this switch.</p>
          <p><b>What a slot is.</b> The desktop runs at most 3 automatic sessions at the same time (the default; <code>{envName("BACKLOG_SESSIONS")}</code> on the desktop changes it). Each open “backlog ·” session holds one of those slots, whether it is working or finished and idle; the backlog's “open a session here” holds one too. Sessions you open yourself never do.</p>
          <p><b>Why there is a limit.</b> Every session is a real <code>claude</code> process on your desktop, using its memory and your account's usage. Without a limit, a desktop that comes back after a few days with a pile of due items would start them all inside a minute.</p>
          <p><b>Why it matters with this switch off.</b> A finished session keeps its slot until you close it. Once all 3 are held, the next backlog or scheduled item does not start: it waits and says “waiting for a free slot”, with “close one to make room” listing exactly the sessions holding them. Turn this on, or set “close when done” on items you will not read, if you want queued work to keep flowing without you.</p>
        </>}
      />

      {/* The hosted-model acknowledgement. It is a statement somebody
          made after reading words on THIS screen, so it is per device
          and never synced — and there has to be a way to re-read what
          was agreed to, or to hand the phone to somebody who has agreed
          to nothing. Clearing it starts nothing and refuses nothing. */}
      <SetAction
        id="hosted-notice" label="show the hosted-model notice again" icon={RotateCw}
        onClick={() => {
          track("action:hostedAck.reset");
          clearHostedAck();
          showToast("hosted-model notice reset — the next hosted launch will show it again");
        }}
        note="The first session on a model that runs on somebody else's server stops once and says what that means."
        more={<p>After you accept, it stays out of the way. Local models and Claude Code never show it.</p>}
      />
    </>
  );
}

// ── Connection ──────────────────────────────────────────────────────────────

function ConnectionRows({ redial }: { redial(): void }) {
  const c = core();
  const authState = c.conn.info.auth;
  const status = c.conn.status;
  const lanPw = useStore(lanPwDraft);
  return (
    <>
      {authState.canManage ? (
        <SetCustom
          id="lan-password" label="LAN password" icon={Lock}
          note={authState.enabled
            ? "A password is set. Devices reaching this host over the local network (not Tailscale) must enter it."
            : `No password set. While a LAN interface is bound (${envName("ALLOW_PUBLIC")}=1), LAN devices are blocked until you set one here.`}
          more={<p>Changing or clearing the password logs out every gated device. Password management is only available on this trusted path — LAN devices can never set it.</p>}
        >
          <div className="set-chips">
            <input
              className="auth-input" type="password" placeholder={authState.enabled ? "new password" : "set a password"}
              value={lanPw} onChange={(e) => lanPwDraft.set(e.target.value)} style={{ maxWidth: 220 }}
            />
            {/* A password shorter than four characters is refused in
                words, where a grey button used to say it silently. */}
            {lanPw.length >= 4 ? (
              <button
                className="key primary"
                onClick={() => { c.conn.send({ t: "auth.set", password: lanPw }); lanPwDraft.set(""); showToast(authState.enabled ? "password changed" : "password set"); }}
              >{authState.enabled ? "change" : "set password"}</button>
            ) : (
              <span className="set-cant-why">{lanPw.length === 0 ? "type a password of at least four characters" : "at least four characters"}</span>
            )}
            {authState.enabled && (
              <button className="key danger" onClick={() => { c.conn.send({ t: "auth.clear" }); showToast("password cleared — LAN blocked"); }}>clear</button>
            )}
          </div>
        </SetCustom>
      ) : (
        <SetAction
          id="lan-logout" label="log out this device" icon={Lock}
          onClick={async () => { await api.auth.logout(); redial(); }}
          note="Connected over the local network (authenticated). The password is managed from the desktop or a Tailscale connection."
        />
      )}

      {authState.canManage && authState.enabled && (
        <SetSwitch
          id="lan-gate-tailscale" label="gate Tailscale too" icon={Lock}
          on={authState.gateTailscale}
          onChange={() => c.conn.liveSend({ t: "auth.gateTailscale", enabled: !authState.gateTailscale }, authState.gateTailscale ? "Tailscale devices no longer need the password" : "Tailscale devices now need the password")}
          note="Require the password from Tailscale peers as well. Off = Tailscale trusted; loopback stays exempt either way."
        />
      )}

      {/* Was `disabled` with the reason in a `title` — invisible on a
          phone, which is the thing this app does not do. */}
      <SetAction
        id="sync-push" label="use this device's copy" icon={CloudUpload}
        cant={status !== "open" ? "no connection to the host right now" : undefined}
        onClick={() => {
          const n = pushAllSettings();
          showToast(n ? `pushing ${n} setting${n === 1 ? "" : "s"} from this device` : "nothing to push");
        }}
        note="Makes this device's copy the one every other client gets. The newest edit wins."
        more={<p>Prompt templates, fan-out presets, header commands, the prompt pad, the toolbar layout and your new-session defaults are kept on the host, so every client — this phone, a desktop tab, the Android app — has the same ones. The send queue, drafts and anything about this device's link stay here. If a client adopted the wrong list (the first one to connect after an update seeds the host), push from the device that has the good one.</p>}
      />
    </>
  );
}

// ── Tools: the door rack (after the features' doors at its head) ────────────

function ToolDoors({ pickShotRepo }: { pickShotRepo(): void }) {
  const c = core();
  const open = c.nav.open;
  return (
    <>
      <SetAction id="tool-net-health" compact label="connection health" icon={Activity}
        title="what the link has been doing to your prompts"
        onClick={() => { track("overlay:nethealth"); open("nethealth"); }} />
      <SetAction id="tool-storage" compact label="storage" icon={HardDrive}
        title="what this phone is holding, and what clearing any of it would cost"
        onClick={() => { track("overlay:storage"); open("storage"); }} />
      <SetAction id="tool-speedtest" compact label="speed test" icon={Gauge}
        title="connection speed test + diagnostics"
        onClick={() => open("speedtest")} />
      <SetAction id="tool-host-stat" compact label="host stat" icon={Cpu}
        title="host CPU / memory load"
        onClick={() => void showHostStat()} />
      <SetAction id="tool-repo-setup" compact label="repo setup" icon={ListChecks}
        title="repo setup checklist"
        onClick={() => open("setup")} />
      <SetAction id="tool-secret" compact label="secret" icon={KeyRound}
        title="set a secret (write-only)"
        onClick={() => open("secret")} />
      <SetAction id="tool-features" compact label="feature usage" icon={BarChart3}
        title="which features you actually use (and which you never do)"
        onClick={() => open("features")} />
      <SetAction id="tool-screenshot" compact label="screenshot" icon={Monitor}
        title="screenshot the desktop"
        onClick={() => {
          const visibleRepos = c.world.visibleRepos;
          if (!visibleRepos.length) showToast("no repo to store the shot");
          else if (visibleRepos.length === 1) void takeShot(visibleRepos[0].id);
          else pickShotRepo();
        }} />
    </>
  );
}
