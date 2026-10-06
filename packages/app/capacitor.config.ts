import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android shell's whole configuration, and every line of it is load-bearing.
 *
 * The point of this package is one property: **the app shell is never on the
 * network.** In the browser PWA, any navigation while the Tailscale tunnel is
 * down replaces the entire app — queue, drafts, compose box and all — with the
 * browser's `ERR_CONNECTION_TIMED_OUT` page, and over plain `http://100.x`
 * there is not even a service worker to cache a shell against it. Here the UI is
 * read out of the APK, so there is no navigation left that can fail.
 */
const config: CapacitorConfig = {
  appId: "dev.waterplane.app",
  appName: "waterplane",

  // The web build, verbatim. `packages/web` is not forked, wrapped or
  // re-implemented — the APK ships the exact bundle the PWA serves, which is
  // why a UI change needs no work here at all.
  webDir: "../web/dist",

  server: {
    /**
     * **`http`, not Capacitor's `https` default.** Two consequences, both wanted:
     *
     *  - `http://localhost` is still a *secure context* (browsers treat
     *    localhost as potentially trustworthy), so service workers, clipboard
     *    and the install-time APIs all work — the things plain `http://100.x`
     *    silently no-ops in the browser. The `tailscale serve` HTTPS front door
     *    stops being a prerequisite.
     *  - A page on `https://…` may not open a `ws://` socket: mixed-content
     *    blocking applies to WebSockets regardless of the WebView's
     *    mixed-content setting. Since the daemon's normal address is plain
     *    `ws://100.x:8770/ws`, an `https` scheme here would break the one
     *    connection the whole app is built on.
     */
    androidScheme: "http",

    /**
     * The daemon is plain HTTP on the tailnet, and the shell's origin is
     * `http://localhost`, so requests to it are cleartext by definition.
     * `androidScheme: "http"` already implies this; it is stated for the reader.
     */
    cleartext: true,

    /**
     * Only ever the app's own asset server. There is deliberately no `url` here
     * pointing at the daemon: loading the UI from the host is what the browser
     * already does, and it is the failure this package exists to remove.
     */
    hostname: "localhost",
  },

  android: {
    /**
     * Images and downloads come off the daemon over plain HTTP while the page
     * itself is on `http://localhost`; same-scheme, so this is belt-and-braces
     * rather than the load-bearing switch. Left explicit so a future move to
     * `androidScheme: "https"` fails visibly instead of silently dropping every
     * artifact thumbnail.
     */
    allowMixedContent: true,

    /**
     * The terminal is xterm.js and the app is full of long-press gestures
     * (session reorder, image zoom). The default WebView debugging flag stays
     * off in release builds; Capacitor honours the build type.
     */
    webContentsDebuggingEnabled: true,
  },

  plugins: {
    /**
     * Capacitor 8 ships a built-in `SystemBars` plugin, and both of its defaults
     * are wrong for this app.
     *
     *  - **`style`** is otherwise derived from the PHONE's night mode. This app
     *    is dark in either mode, so on a phone set to light the plugin asked for
     *    dark status-bar icons and put them on top of a near-black bar: the
     *    clock, the signal and the notification icons invisible, and nothing
     *    left of the battery but its coloured fill. `DARK` here means "the bar
     *    is dark, draw light icons on it" and is a fact about this app, not
     *    about the phone. `MainActivity.applyBarAppearance()` re-asserts the
     *    same thing at runtime, because the window's insets controller is
     *    re-derived at several points after `onCreate`.
     *
     *  - **`insetsHandling`** otherwise picks between padding the WebView's
     *    container and passing the insets through for `env(safe-area-inset-*)`,
     *    based on the major version of the WebView the phone happens to have
     *    installed and on a probe of the viewport meta tag — and only does
     *    either above API 35. Three conditions, two of them properties of a
     *    component that updates itself out of the Play Store, deciding whether
     *    the app's top strip lands under the status bar. `disable` hands the
     *    whole job to `MainActivity.takeOverWindowInsets()`, which pads the
     *    container on every version from API 30 up and leaves
     *    `env(safe-area-inset-*)` at the 0 the web layer has always seen here.
     */
    SystemBars: {
      style: "DARK",
      insetsHandling: "disable",
    },
  },
};

export default config;
