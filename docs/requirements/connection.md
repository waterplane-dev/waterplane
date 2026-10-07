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

