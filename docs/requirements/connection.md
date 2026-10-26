# connection

### R-connection-001 · requested
Connection status bar is visible on every screen, showing connection state, ping response times as a graph, upload/download speed, total bytes transferred, last connection/sync time, and next session-limit reset time; tapping items shows detailed information.

### R-connection-002 · shipped
Offline star works and syncs when reconnected.
- shipped: 3702412

### R-connection-003 · shipped
The phone remembers every desktop it has paired with as a named, addressed host. Settings →
Connection lists them, and a single tap switches the active one (park the old host's state, restore
the new one, reload).
- asked: 2026-09-27 (user request)
- shipped: bb32175

### R-connection-004 · shipped
Switching or removing a host never deletes what was typed there: its drafts, pad notes, queued
prompts and caches are archived under that host's id and come back automatically if the same address
is re-added. Only the active host's state lives in the app's bare storage keys.
- asked: 2026-09-27 (user request)
- shipped: bb32175

### R-connection-005 · shipped
A saved host may carry a LAN address the phone can also reach on the home network. "Switch to LAN
automatically" defaults off; even when on, the phone only takes the LAN route once the Wi-Fi
network's name matches a saved one, a health probe answers, and the desktop proves its identity by
HMAC — any failure falls back to the tailnet immediately, and the connection strip says which route
it is on. A LAN address only works when the host is started with `WATERPLANE_ALLOW_PUBLIC=1` and a password
is set, and the identity check itself is only ever read over the tailnet or loopback, never over the
LAN address it protects.
- asked: 2026-09-27 (user request)
- shipped: 8ab0bd2

### R-connection-006 · shipped
A trusted phone can bring a new one onto the same desktop by showing a QR code: a one-time,
10-minute, single-use pairing code whose landing page offers "use the web version" or "download the
APK", with no reusable secret ever printed in the QR itself. Opening the code through the Android
app's `waterplane://pair` deep link still asks the person to confirm before adopting the host.
- asked: 2026-09-27 (user request)
- shipped: 10c5979

### R-connection-007 · shipped
Every device that connects gets its own revocable token, not a shared password. Settings →
Connection lists every paired device — name, first/last seen, how it last connected, "this phone" —
with a revoke action that ends that device's access immediately.
- asked: 2026-09-27 (user request)
- shipped: e8ac50d

### R-connection-008 · shipped
The web page offers a connect link that opens the Android app and pairs it without the user typing anything.
- asked: 2026-10-05
- shipped: 914f2c2f

### R-connection-009 · shipped
The pairing screen in the Android app looks polished and finished.
- asked: 2026-10-05
- shipped: 0a7c1e3b

### R-connection-010 · shipped
The host accepts the iOS shell's connection by allowing only its exact origin, capacitor://localhost, and no other origin is widened.
- asked: 2026-10-06
- shipped: be49c5ea


### R-connection-011 · shipped
Pairing a new device offers "Passive device". A passive device's token gets only the automatic app download/install path (health, the web-bundle update, the Apps/install manifest and the artifact downloads auto-install and autopull use) and the unlock route; every other request — the WebSocket included — is refused by the host. A route nobody put on that list is refused. Tokens paired before this exist keep full scope.
- asked: owner, 2026-10-14
- shipped: 1f2f2dbc

### R-connection-012 · shipped
A passive device has no tokenless path on any network: pairing one switches "gate Tailscale" on (the pairing sheet says so in one sentence), so the phone gets nothing more with Tailscale on than on home wifi. No Tailscale tags, whois or ACLs are configured for it.
- asked: owner, 2026-10-14
- shipped: 1f2f2dbc

### R-connection-013 · shipped
A passive device unlocks with a PIN the host checks (rate-limited, stored hashed, set only from a trusted device, never from a passive one). A correct PIN lifts that device to full scope for 30 minutes, held on the host, so a killed app or reboot comes back locked. The phone shows "Unlocked until HH:MM · Lock now", and drops back to passive when the time runs out.
- asked: owner, 2026-10-14
- shipped: 1f2f2dbc, acacd3b6

### R-connection-014 · shipped
With a passive token the app shows one screen: its apps with their update/install status, the last check, and a small "Unlock" link. No burger menu, no settings, no sessions.
- asked: owner, 2026-10-14
- shipped: acacd3b6

### R-connection-015 · shipped
Tailscale is the recommended way for the phone to reach the desktop from outside, not a requirement; the app works on home Wi-Fi, in the same room, or over another VPN without it.
- asked: 2026-10-14, 2026-10-15
- shipped: 72097f48

### R-connection-016 · shipped
The Android background notification link receives only the notification, authRequired and pull.new frames and no state snapshots on connect, never counts as an attached or watched session, and is recognised from its OkHttp User-Agent so the filter works before a new app version is installed.
- asked: 2026-10-15
- shipped: a5e813a

### R-connection-017 · requested
The webcam app's port can be changed to any other port.
- asked: 2026-10-16

### R-connection-018 · shipped
When the host restarts, the UI says the desktop is restarting, with the reason, the elapsed time and the usual duration, until it is back.
- asked: 2026-10-20
- shipped: 445307de

### R-connection-019 · requested
Tailscale keeps running when the disk is nearly full: a checklist row installs a watchdog that reopens it if macOS ended it, and names standalone tailscaled as the lasting fix; after switching, pairing, serve ports, allowed hosts and peer links still reach the Mac.
- asked: 2026-10-21, 2026-10-21, 2026-10-21

### R-connection-020 · requested
The WordPress site is reachable from the app.
- asked: 2026-10-22

### R-connection-021 · shipped
The app shows which other local IP addresses would work as an alternative to Tailscale, skipping VM bridges and tunnels.
- asked: 2026-10-24
- shipped: faee1c21

### R-connection-022 · requested
If the Mac loses internet or DNS, the owner can keep working from the phone through a fallback path (such as a static hosts entry) instead of sessions dying on API Error ENOTFOUND.
- asked: 2026-10-24

### R-connection-023 · requested
After the local CA certificate is installed on Windows, the measurement page loads over HTTPS on the LAN host name, and the tailnet link also loads.
- asked: 2026-10-26

