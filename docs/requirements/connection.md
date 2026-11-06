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


### R-connection-024 · shipped
When a session's turn ends because claude gave up on a temporary API or network error (can't reach the API server, connection lost, no response, 529 overloaded), the desktop types "continue" for it on a widening schedule (20s, 1m, 2m, 5m, 10m, 15m…, at most 8 tries), the phone shows "Network error — retrying in 40s (2/8)" with a cancel, and anything the person types, a usage or spend limit, or the halt stops it. Past the last try it stops and says so. A backlog item (or any waiting work) fired into that session is not marked done by the failed turn: it finishes when the retried turn really answers, and finishes normally on the person's own turn if they type over the retry. When the retries run out it is neither failed nor run again: it stays running, its backlog and Activity rows say "Stalled — API unreachable, 8 retries used", and the row offers "retry now" (the desktop types "continue" again, the same way its retry does) beside the auto-retry switch; the work finishes on the next real reply. A stalled row is never failed for its silence, including after a desktop restart. The session's own retry line offers "retry now" once it gave up too. Dismissing that line only hides it: the work stays stalled, keeps its note and is still never failed for its silence. While work is stalled and the switch is on, the desktop tries once more every 30 minutes (`WATERPLANE_NET_RETRY_STALL_MS`), with no cap, and the stalled note says when ("next try in 23m"); a real reply finishes the work and lets the repo's next queued item start, and the switch off, the halt, a limit or the person typing stops it. A queued item in the same repo held only because the stalled one holds the repo's one-at-a-time slot says "waiting behind a stalled item: API unreachable" on its own row, with "show the stalled item" to cut the backlog to it. When the desktop starts and finds a session still sitting on such an error that it never saw end (it was down, or the error came before it could tell), and nobody typed after the error, it treats that session as stalled ("stopped retrying: found stuck when the host started"), tries once about 30 s later and then every 30 minutes like any stall. The retry line goes away as soon as the retried turn's first real reply is in the log, not when that turn ends; if that same turn then fails again, the retry carries on from the tries already used.
- asked: 2026-10-27
- shipped: 6358bcc1
- amended: 2026-10-28 — waiting work follows the retry (asked by the owner, session 01NLkDCK)
- amended: 2026-10-29 — out of retries ⇒ stalled, not failed; retry now and the switch on the row (asked by the owner, session 01NLkDCK)
- amended: 2026-10-29 — dismiss only hides the line; the stall probe every 30 min; the queued row says it waits behind a stall (asked by the owner, session 01NLkDCK)
- amended: 2026-10-31 — a give-up found standing at start-up is adopted as a stall (asked by the owner, after five sessions sat on ENOTFOUND from 10-28 to 10-31)
- amended: 2026-11-05 — the line clears on the first real reply (owner read "retried (2/8), waiting for the reply" over a session already working as a failed retry)

### R-connection-025 · shipped
The network-error retry (R-connection-024) has a person-facing switch, "retry on network errors" in Settings › Sessions, on by default and kept by the desktop across restarts; the retry line under a session also offers "turn off". Turning it off cancels every pending retry and clears their lines and stops the stall probe; a session that already stopped retrying keeps its line (and any stalled row its note), and the switch is also on a stalled backlog/Activity row. When the desktop's environment forces it off (`WATERPLANE_NET_RETRY=0`), the row says so in a sentence instead of looking like a working switch.
- asked: 2026-10-28
- shipped: 0618ee0d
### R-connection-026 · shipped
When the user leaves a screen, its in-flight host request is cancelled so it does not hold a connection open until timeout.
- asked: 2026-10-30
- shipped: 64ddddee, 6bed50e4


### R-connection-027 · shipped
A network outage retries as ONE wave per desktop: the first session whose retry is due types its continue alone, and the others wait without spending a try; once its reply comes back the rest follow a second apart, and if it fails they stay held until its next try. A held session says it is waiting for another session's retry (and who holds it), and work waiting on it reads as stalled while the holder's probe is stalled.
- asked: 2026-11-02 (owner)
- shipped: 59fead43
### R-connection-028 · shipped
Switching to a peer desktop that is on and reachable completes; after a switch the app works only against the new desktop and never claims to act on one that is off or unreachable. A failed switch says so in plain words and offers a way back.
- asked: 2026-11-01, 2026-11-01
- shipped: b57a7eef, 0d9cedcc

### R-connection-029 · requested
The desktop-switch banner names the desktop being switched to, not the one being left, and a slow repo load on the old desktop does not hold up the switch.
- asked: 2026-11-01


### R-connection-030 · shipped
A paired desktop the phone is not switched to that waits on the person (a session showing a question, a card such as a vault approval) is announced on the launcher by name and count while the app is on screen, with a one-tap switch that lands on the waiting item. Nothing switches or answers by itself; a desktop that does not answer shows no number, and a phone signed out there says so with the way back.
- asked: 2026-11-03 (owner)
- shipped: 3c7e8a80

### R-connection-031 · built, unverified on a phone
With the app swiped away, the Android app's background link watches every saved desktop, not only the one in use: an alert from any of them reaches the phone's notifications titled with that desktop's name (when there are several), and on each reconnect the phone asks that desktop once what waits there and posts one summary, because the link does not replay what it missed. A tap on another desktop's alert switches there and lands on the item (a whole alert, or the notification list for a summary of several) — only on that tap, nothing switches by itself. An older app or an older page keeps watching the one desktop as before. A password-gated desktop is watched too, with this phone's own token for that desktop, sent to that desktop's saved address only (never a LAN address, never another desktop) and kept sealed on the phone until the desktop is removed or the link is switched off — unless the phone locks its desktop sign-ins (R-apk-027), when a newer app keeps it in memory only and no copy at rest (R-apk-028), and an older app is handed none. A desktop that refuses the token pauses its own link, says "signed out there — pair again" and is not asked again until the phone holds a new token; one this phone holds no token for pauses and says it needs signing in. A passive (kids') phone's token is never carried.
- asked: 2026-11-03 (owner)

### R-connection-032 · built, unverified on a phone
On a newer Android app, a desktop paired over an encrypted link is reached over it on the Wi-Fi and never over plain HTTP: the app learns the desktop's key on a protected connection, then dials the desktop's encrypted port, and a key that does not match is refused with words ("the desktop's key changed, or someone is between: pair again by code") instead of "cannot reach". When the encrypted port is unreachable the app falls to the tailnet or says why; it never quietly drops to plain HTTP. The background link and the pull service follow the same rule with the page closed ("locked: open the app"). An older app, and a desktop that offers no encrypted port, keep plain HTTP with the warning of R-security-022.
- asked: 2026-11-03 (owner brief)
- shipped: 1da2c03a, b89402ae, aa2e3e3f
- note: the app's shell plugin (`ShellTls`) is the capability; the page detects it, never a version. Not tried on a phone.

### R-connection-033 · built, unverified on a phone
A phone with no Tailscale pairs with a desktop on the same Wi-Fi by typing the 8-character code or opening the QR's link with the system camera, and the code never crosses the network in the clear: the phone proves it knows the code and gets the token back sealed, so someone relaying on the Wi-Fi gets one guess per attempt and someone posing as the desktop at most five. With more than five codes open only the five newest pair this way; a phone holding an older one is told the desktop does not know it and to show a new QR. A page opened over plain Wi-Fi with a live code burns that code and shows no link; a code that already went out plain is dead on that phone. After 10 wrong tries a code stops working for this kind of pairing (it still works over the tailnet). An older desktop or app still pairs the old way, after a question that says why it might be unsafe. The desktop needs a password; with none it refuses and says so. The phone also learns the desktop's address as the one it was asked with, not the desktop's tailnet or loopback address. Paired at a saved desktop's LAN address with Tailscale off, where that desktop is not set to use the LAN from this Wi-Fi, the phone changes no setting: it says there is no way there yet and offers the LAN settings.
- asked: 2026-11-03 (owner brief)
- shipped: db775c2b, 8ef8316f
- note: SECURITY.md lists the accepted residuals. Whether every camera app opens the waterplane link is not known. Not tried on a phone.

### R-connection-034 · built, unverified on a phone
The way out of a pinned desktop whose encrypted port is off: the desktop's row has "use plain HTTP for this desktop" (works with no connection, asks first, says what it costs and the way back), which drops the pin and sends that desktop over plain HTTP again; pairing it again by code puts the pin back. Nothing does this by itself, and a changed key leads with why and offers pairing by code first.
- asked: 2026-11-03 (owner brief)
- shipped: aa2e3e3f

### R-connection-035 · built, unverified on a phone
A phone with no Tailscale still sees a desktop's images and downloads: the app asks for a short read ticket (one hour, renewed quietly) that is accepted only for those loads, only over the encrypted port, and only while the phone's sign-in exists, held to its scope (a passive phone gets what its token gets). Tickets are not written to logs and are stripped from shared links.
- asked: 2026-11-03 (owner brief)
- shipped: 3fdb8db0

### R-connection-036 · built, unverified on a phone
Everything the connection strip shows small has meaningfully more behind its tap, and a chart comes
first: ping, route, connection, unsaved items, sends and data over 1h / 24h / 7d / 30d, with drops,
route moves and what is still waiting listed, and data split by where it went. Time the app was not
on screen is drawn as not measured, never as zero or offline.
- asked: 2026-11-06 (user request, screenshot of the strip)
