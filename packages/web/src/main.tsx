// FIRST, before any other module is evaluated: finish a pending host switch
// and migrate the one-host storage (`hostBoot.ts` says why it must be first).
import "./hostBoot";
import { StrictMode, useEffect, useRef, useState } from "react";
import type { PairTarget } from "@waterplane/shared";
import { createRoot } from "react-dom/client";
import { installUiScale } from "./uiScale";
import { App } from "./App";
import { NetPulseBar } from "./NetPulseBar";
import { LocalRtBar } from "./LocalRtBar";
import { SessionTabsBar } from "./SessionTabsBar";
import { startLocalRtWatch } from "./localRt";
import { startInstallLog } from "./installLog";
import { startNetStalls } from "./link/linkStalls";
import { HintLayer } from "./HintLayer";
import { ToastLayer } from "./ToastLayer";
import { SlotAskLayer } from "./SlotAskLayer";
import { ConfirmHost } from "./Confirm";
import { AskTextHost } from "./AskText";
import { AskRepoHost, registerAskRepoShortcuts } from "./AskRepo";
import { ShortcutCardHost, installShortcutCard } from "./ShortcutCard";
import { registerComposeShortcut } from "./core/compose/composeShortcut";
import { UpdateBanner } from "./UpdateBanner";
import { HaltBanner } from "./core/Banners";
import { deviceId, installLinkMeters, startLinkProbes } from "./link";
import { makeConnection } from "./ws";
import { startLanRoute } from "./lanLink";
import { installShellNet } from "./shellNet";
import { installShellShare } from "./shellShare";
import { BootGuard, armBootTrap } from "./BootGuard";
import { HostSetup } from "./HostSetup";
import { hostConfigured, installHostRouting, isNativeShell } from "./hostUrl";
import { installHints } from "./hints";
import { installPrimaryKey } from "./core/layout/primaryKey";
import { installDownloads } from "./download";
import { installDictations } from "./dictateQueue";
import { installShellBridge, onShellPair } from "./shellLink";
import { syncInstallAllow } from "./nativeInstall";
import { requestPersistence } from "./persist";
import { installTheme } from "./theme";
import { applyCachedThemeOverlay, refreshThemeOverlay } from "./themeOverlay";
import { bgJson } from "./api";
import { PassiveScreen, UnlockedBar } from "./PassiveScreen";
import { passiveApi } from "./passiveApi";
import { bootMode, cachedPassive, rememberPassive, type BootMode } from "./passiveMode";
import { SHELL_NUDGE_EVENT } from "./shellLink";
import { updateSupported, updates } from "./webUpdate";
import { resumeLanding } from "./resumeRoute";
import { installDemoTransport } from "./demo/transport";
import { demoProblem, setDemoActive } from "./demo/mode";
import { leaveDemo } from "./demoEntry";
import { DemoLine } from "./DemoLine";
import { FlaskConical } from "lucide-react";
import { Button } from "./kit/Button";
import "./styles.css";

/** How often the shell re-asks the daemon which web build it is serving. The
 *  manifest is a few hundred bytes and the host caches its hashes, so this is
 *  cheap; it exists so a phone left open overnight picks up the morning's build
 *  without being restarted. */
/**
 * How often the shell asks the desktop what bundle it is serving.
 *
 * Was thirty minutes, which is a long time to run last week's UI when the
 * desktop has been serving the new one since breakfast — and the cost of asking
 * is a few hundred bytes against a manifest the host caches by mtime, which
 * `check()`'s own doc calls "cheap enough to run on every reconnect".
 *
 * The interval is the FLOOR, not the mechanism. The two triggers below it are
 * what actually make an update land promptly: picking the phone up, and the
 * socket coming back — the two moments a person is present and the two moments
 * a stale bundle is about to be used.
 */
const UPDATE_POLL_MS = 5 * 60 * 1000;

armBootTrap();

// Put the route back when the app has just restarted into a DIFFERENT BUNDLE.
// Every other reload keeps the hash by itself; the Android shell's update does
// not — Capacitor swaps bundles with `Bridge.setServerBasePath`, whose last act
// is `webView.loadUrl(appUrl)`, the bare start URL, and the cold launch after a
// staged build boots the same way. So the screen is remembered as it changes
// (`App.tsx`) and restored here, once, only when `webUpdate.ts` armed it and
// only onto a document that booted with no route of its own. Before React
// mounts, because `App` reads the hash in a `useRef` initializer on its first
// render — and `replaceState` rather than a navigation, so the entry the routing
// effect then seeds its ancestors under is this one.
// The entry's state is what the screen was opened on (the git view's repo), so the seed adopts it.
resumeLanding(location, Date.now());

// Light or dark, before React mounts. `index.html` already set the attribute
// inline (that is what stops the cold-start flash); this takes ownership of it
// — it subscribes to the OS, so `system` keeps following the phone while the
// app is open, and it pushes the resolved theme to the Android shell's system
// bars, which no stylesheet can reach.
// A fork's look (`themeOverlay.ts`): the cached overlay first, so the theme
// below pushes ITS chrome colour, and the terminal mounts in its palette.
applyCachedThemeOverlay();
installTheme();

// The demo (`?demo=<id>`, or "Try the demo"): every transport answered by the
// fake desktop in the bundle, and nothing leaves the device. FIRST of the
// transport patches, for two reasons: the host routing below must see the
// demo is on and stand down (it would otherwise aim `/api` at a paired host),
// and the byte meters after it must wrap THIS, as they wrap the host routing
// — they delegate to whatever `fetch` they found. A no-op outside the demo.
// It turns its own refusals into the demo problem; this catch is the backstop,
// because a throw at module top strands the APK on a white page before React mounts.
try { installDemoTransport(); } catch (e) { setDemoActive(null, `The demo could not start: ${String((e as Error)?.message ?? e)}`); }

// Aim `/api` at the paired host before ANY app code can issue a request. A
// no-op in the browser, where the page is served by the daemon itself — and
// in the demo, whose transport is already in place.
installHostRouting();

// Count the bytes every transport moves. AFTER the host routing (and demo)
// patch on purpose — this wrapper delegates to whatever `fetch` it found, so installing
// it second leaves the rewrite in place and still sees the request.
installLinkMeters();

// Ask the host for its theme overlay once, now that `/api` is aimed at it.
void refreshThemeOverlay(bgJson);

// Define the two globals the Android shell calls into (`shellNudge`,
// `shellOpen`). Before React mounts on purpose: a cold start from a tapped
// notification reaches native's first attempt long before there is a listener,
// and `shellOpen` can only park that session id for the handler that
// registers a moment later if it exists by then. A no-op in every browser,
// where it defines two functions nothing will ever call.
installShellBridge();
// `window.shellNetChanged` — the shell's network events, for the LAN route
// (`lanLink.ts`). Same reason as above: defined before anything can miss one.
installShellNet();
// `window.shellShare` — another app's share sheet (`shellShare.ts`). Same
// reason again: a cold start from a share asks before React has mounted.
installShellShare();

// Ask to be exempt from automatic storage eviction, before anything writes.
// The queued-upload bytes, the partial downloads and the reconstructed
// scrollback are the only copies of what they hold; by default the browser may
// drop all of it under storage pressure, unasked. Best-effort and fire-and-
// forget — a refusal changes nothing about how the app behaves.
void requestPersistence();

// Hand a finished download to the device the moment it lands, whichever button
// asked for it (`download.ts`). Installed here, above `App`, for the case the
// feature exists for: the transfer finished while the app was closed, so the
// hand-off has to happen at launch with no screen involved.
installDownloads();

// Pick up dictation nobody has had back yet. Installed here for the same
// reason, and the same case: the app was killed (or simply put away) with a
// recording still waiting on a tunnel, and nobody should have to open the right
// screen for their words to come back. See `dictateHold.ts`.
installDictations();

// Mirror "which apps may install themselves" into the Android shell. The list
// is synced, so it can arrive from another phone while this one is asleep, and
// the download service reads the shell's copy — at the end of a transfer, with
// the document frozen, which is exactly when a bridge call would not be
// answered. No-op in a browser.
syncInstallAllow();

// Delegated long-press / explain-mode handling for every button in the app.
// Installed here rather than in a component so it covers the pairing screen and
// anything else that renders above `App`, and so no future sheet has to opt in.
installHints();

// Ctrl/Cmd+Return answers the open dialog with its blue button (physical keyboard).
installPrimaryKey();
// The shortcut card (hold Ctrl/⌘/Alt alone) and the chords core owns on it.
installShortcutCard();
registerComposeShortcut();
registerAskRepoShortcuts();

/**
 * Decides whether the app can mount at all.
 *
 * In the browser it always can — the daemon serves us, so its address is the
 * one in the address bar. In the Android shell (`packages/app`) the UI comes out
 * of the APK and nothing knows where the desktop is until someone says, so the
 * pairing screen stands in front of `App` until a host is stored. It sits here,
 * above `App`, because `App` opens the WebSocket in a `useRef` initializer on
 * its very first render — there is no "mounted but not connected yet" state to
 * render the screen from.
 */
function Root() {
  const [setup, setSetup] = useState(() => !hostConfigured());
  // A pairing deep-link `…://pair` link that arrived while the setup screen is up (the first
  // run, typically: installed from the landing page, then its "open in app").
  // It only PREFILLS the pair form — any app can fire that link.
  const [pairLink, setPairLink] = useState<PairTarget | null>(null);
  useEffect(() => (setup ? onShellPair(setPairLink) : undefined), [setup]);

  // A passive device (the kids' phone, `passiveMode.ts`) gets ONE screen and
  // never the socket. The remembered mark decides the first paint, the host's
  // status the rest; an app already drawn for a token the host now calls
  // passive reloads rather than keep a socket the host will refuse.
  const [mode, setMode] = useState<BootMode>(() => (hostConfigured() ? bootMode(cachedPassive(), null) : "full"));
  const drewApp = useRef(mode === "full");
  const [unlockedUntil, setUnlockedUntil] = useState<number | null>(null);
  useEffect(() => {
    if (setup) return;
    let live = true;
    void passiveApi.status().then((st) => {
      if (!live || !st) return;
      rememberPassive(st);
      const next = bootMode(cachedPassive(), st);
      setUnlockedUntil(next === "full" && st.scope === "passive" && st.unlockedUntil ? st.unlockedUntil : null);
      if (next === "passive" && drewApp.current) { window.location.reload(); return; }
      setMode(next);
    });
    return () => { live = false; };
  }, [setup]);

  // Settings → Paired host reopens it (hostUrl.requestHostSetup).
  useEffect(() => {
    const open = () => setSetup(true);
    window.addEventListener("app:host-setup", open);
    return () => window.removeEventListener("app:host-setup", open);
  }, []);

  // Android shell only (no-ops elsewhere). `markHealthy` is what stops the
  // native boot watchdog from falling back to the APK's built-in bundle — it
  // fires HERE, from a mounted React tree, because "the app rendered" is exactly
  // the claim it is making about a freshly-downloaded bundle. **It fires in the
  // demo too** — a demo boot that never marked healthy would roll the bundle
  // back after three launches. Only `check`/`download`/`apply` refuse there
  // (`webUpdate.ts`), so the demo never asks a desktop for a bundle.
  useEffect(() => {
    if (!updateSupported()) return;
    void updates.markHealthy().then(() => updates.check());
    // Visible only: hidden, a check is a radio wake for a bundle nobody can
    // apply yet, and the wake below asks the moment the phone is picked up.
    const t = setInterval(() => { if (document.visibilityState === "visible") void updates.check(); }, UPDATE_POLL_MS);
    // Picking the phone up. A backgrounded shell is frozen (`shellLink.ts`), so
    // the interval above did not run while it was away — the wake is not an
    // extra check, it is the FIRST one since whenever the freezer took hold.
    // Rate-limited against the interval so a person flicking between apps does
    // not ask the desktop once a second.
    let lastAsk = Date.now();
    const askIfStale = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastAsk < 60_000) return;
      lastAsk = Date.now();
      void updates.check();
    };
    document.addEventListener("visibilitychange", askIfStale);
    window.addEventListener("focus", askIfStale);
    // …and the socket coming back, which is the moment the desktop becomes
    // answerable at all. `check()` says it is cheap enough for exactly this.
    const onLink = () => { lastAsk = Date.now(); void updates.check(); };
    window.addEventListener(SHELL_NUDGE_EVENT, onLink);
    // ...and the other half: a staged build restarts the app once it is put
    // down. Checking and downloading were already automatic; without this the
    // last step was a button on a settings screen nobody opens, so a phone ran
    // a build from days ago while the desktop had served the new one for days.
    const stopApply = updates.watchAutoApply();
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", askIfStale);
      window.removeEventListener("focus", askIfStale);
      window.removeEventListener(SHELL_NUDGE_EVENT, onLink);
      stopApply();
    };
  }, []);

  // A demo was asked for (`?demo=`, or the stored choice) that this build does
  // not carry: say so, in words, with the way out. Never silently the real app —
  // and in the shell never a screen against `demo.invalid`.
  const noDemo = demoProblem();
  if (noDemo) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <div className="auth-title"><FlaskConical size={16} style={{ verticalAlign: "-3px" }} /> Demo not available</div>
          {/* raw: boot screen, loads before the settings kit */}
          <div className="set-note">{noDemo}</div>
          {/* raw: boot screen, loads before the settings kit */}
          <div className="set-row demo-problem">
            <Button variant="primary" onClick={leaveDemo}>Leave the demo</Button>
          </div>
        </div>
      </div>
    );
  }

  if (setup) {
    // The toast layer too: an invalid pairing link and a redeem's note are
    // said here, before `App` exists.
    return (
      <>
      <ToastLayer />
      <HostSetup
        // The first desktop. Adding one reloads into it; the host switcher
        // (`features/hosts`) is where every later one is added or edited.
        mode="first"
        pair={pairLink}
        pairFromLink={!!pairLink}
        onDone={() => setSetup(!hostConfigured())}
        onCancel={hostConfigured() ? () => setSetup(false) : undefined}
      />
      </>
    );
  }
  if (mode === "passive") {
    // The OTA update (the effect above, `/api/webbundle`) still runs: it is on
    // the host's passive allowlist, and it is how this screen itself updates.
    return (
      <>
        <ToastLayer />
        <UpdateBanner />
        <PassiveScreen onUnlocked={(until) => { setUnlockedUntil(until); drewApp.current = true; setMode("full"); }} />
      </>
    );
  }
  // The permanent connection strip lives OUTSIDE `App` for the same reason the
  // hint layer does: `App` returns early from a dozen places (every sheet is its
  // own `return`), so a strip mounted inside it would have to be added to each
  // one and would be missing from the next sheet somebody writes. Here it is on
  // every screen by construction.
  //
  // It is mounted only past the pairing gate, because the probe needs the
  // socket: `makeConnection()` throws when no host is stored, which is exactly
  // the state `setup` is in.
  return (
    <>
      <App />
      <PulseProbe />
      <NetPulseBar />
      {/* The local-runner strip, beside the connection one and for exactly its
          reason: `App` returns early once per overlay, so an always-on layer
          mounted inside it would be missing from the next sheet somebody
          writes. It sits UNDER the connection strip (each publishes its own
          height, and every screen pads itself clear of both), because a dead
          tunnel outranks a desktop's memory: the first explains why the second
          is not moving. */}
      <LocalRtBar />
      {/* The third strip, and here for the reason the two above it are: `App`
          returns early once per overlay, so a bar meant to be on every screen
          cannot be rendered inside it. It sits UNDER both — a dead tunnel and a
          swapping desktop are why the session you are in is not moving, so they
          are read first — and it publishes its own height the same way, so no
          screen has to know it exists in order to stay clear of it. Off by
          default; what it draws and how many fit is `sessionTabs.ts`. */}
      <SessionTabsBar />
      {/* Beside `App`, not inside it, for the reason the strip above is: `App`
          returns early from a dozen places, one per sheet, and a card rendered
          in only two of those branches is worse than none — a `confirm` hint
          SWALLOWS the tap it is explaining, so every hint-gated button inside a
          sheet was a dead button, permanently (only reading the card marks it
          seen). Hint state is module-level in `hints.ts`, so one mount here
          serves every screen. */}
      <HintLayer />
      {/* Same hole, same fix: `App` rendered its toast on two branches only, so
          every sentence a sheet fired — a queue row refusing to send, a save
          declined — was painted for nobody. State lives in `toast.ts`. */}
      <ToastLayer />
      {/* The slot check's ask after a timed send (`slotAskStore.ts`) — beside
          the toast for the toast's reason, and not a modal: nothing under it
          is blocked. */}
      <SlotAskLayer />
      {/* The in-app replacement for `window.confirm` (`Confirm.tsx`). Mounted
          here for the third time for the same reason: the questions it asks
          come from a host frame or from a failed request, which can land while
          any sheet is up, and a dialog rendered inside `App` would be missing
          from every branch that returns early. */}
      <ConfirmHost />
      {/* `window.prompt`'s replacement, mounted here for `ConfirmHost`'s reason. */}
      <AskTextHost />
      {/* "Which repo?" for a keyboard (`AskRepo.tsx`), same reason. */}
      <AskRepoHost />
      <ShortcutCardHost />
      {/* Fourth time, fourth subsystem, same hole: a staged build is ready
          whichever screen you are on, and the one thing left to do about it was
          a button on a settings page nobody opens. `App` returns early per
          overlay, so this cannot live in it. */}
      <UpdateBanner />
      {/* The halt latch, for the same reason: it explains why nothing starts,
          on whichever screen you are looking at (`features/halt`). */}
      <HaltBanner />
      {/* Fifth, and the one that must never be missing: it is what says the
          whole screen is pretend. Renders nothing outside the demo. */}
      <DemoLine />
      {/* A passive device unlocked by its PIN says until when, and how to lock. */}
      {unlockedUntil && <UnlockedBar until={unlockedUntil} />}
    </>
  );
}

/** Starts the probe loop once the connection singleton exists. Split out so the
 *  strip itself stays a pure rendering of `netpulse` state. */
function PulseProbe() {
  useEffect(() => {
    try { startLinkProbes(makeConnection()); } catch { /* no host paired — nothing to probe */ }
    // The local-runner store, attached to the same singleton socket. It takes a
    // STRUCTURAL source rather than importing `ws.ts` itself (`link.ts`'s
    // `PulseSource` argument, plus one more: it keeps that store's pure half
    // runnable under `node --test`), so this is where the two are introduced.
    // Idempotent, and it costs nothing until something asks for a lease — with
    // the strip off and no picker open, nothing is ever sent.
    try { startLocalRtWatch(makeConnection()); } catch { /* no host paired — nothing to watch */ }
    // The install log's client half, on the same socket and for the same
    // reason it is here rather than in `App.tsx`: it has to report on every
    // `welcome`, and an overlay that returns early must not be able to switch
    // that off. One host, many phones — see `installLog.ts`.
    try { startInstallLog(makeConnection()); } catch { /* no host paired — nothing to report to */ }
    // HTTP stall diagnostics, over the same socket (`shared/netstall.ts`).
    try { startNetStalls(makeConnection(), deviceId); } catch { /* no host paired — nothing to report to */ }
    // The LAN route (APK) / the route chip (browser), on the same socket: it
    // re-runs on every reopen, and an overlay must not be able to stop that.
    try { startLanRoute(makeConnection()); } catch { /* no host paired — no route to choose */ }
  }, []);
  return null;
}

// Text/icon size from storage, re-asserted over `index.html`'s inline pass so
// this module's clamp is the one that wins. Before React mounts: a size applied
// after the first paint moves the layout under a thumb already travelling.
installUiScale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BootGuard>
      <Root />
    </BootGuard>
  </StrictMode>,
);

// Register the service worker so the app is installable. Best-effort.
// updateViaCache:"none" stops the browser from serving sw.js from its HTTP
// cache, so a new build's worker is always detected. When that new worker takes
// control (skipWaiting + clients.claim in sw.js), reload once to pick up the
// freshly-built shell — the phone updates with no manual cache-clear.
//
// Skipped in the native shell: there the shell is already local (it ships inside
// the APK), so a worker caching it buys nothing, and the update dance it exists
// for — a new build arriving over the network — is done by installing a new APK
// instead. Leaving it registered would add a second, stale copy of the shell in
// front of the one the APK serves.
//
// Also skipped under a sub-path (the static demo on GitHub Pages, `/demo/`):
// sw.js keys everything to the origin root ("/", "/assets/…"), so there it
// would 404 or, worse, cache another site's root as the shell.
if ("serviceWorker" in navigator && !isNativeShell() && import.meta.env.BASE_URL === "/") {
  // Only an *update* should trigger a reload — not the first-ever install.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  const reloadNow = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !hadController) return;
    // A new build just took control. Reloading immediately would yank the page
    // out from under the user mid-interaction (the host rebuilds often), so
    // defer the pickup until the page is next hidden — the running page keeps
    // working under the new worker meanwhile (single JS bundle, /api and /ws
    // are never intercepted).
    if (document.visibilityState === "hidden") { reloadNow(); return; }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") reloadNow();
    });
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  });
}
