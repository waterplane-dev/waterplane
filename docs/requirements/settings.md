# settings

### R-settings-001 · shipped
Settings screen is reorganized with consistent controls, a single concept for toggling options, and a searchable, compact layout.
- asked: 2026-09-21
- shipped: e031cf2

### R-settings-002 · shipped
Cost and optimization suggestions can be ignored per repo, and the auto-compact window is a setting.
- asked: 2026-09-27
- shipped: 09b2442, 6b06dba

### R-settings-003 · shipped
The waterplane environment variables have sensible defaults so users do not need to configure them; WATERPLANE_ROOT falls back to the first usual code folder and never fails hard when ~/dev is missing.
- asked: 2026-10-07, 2026-10-07
- shipped: 708337a

### R-settings-004 · shipped
Settings has a "reset UI settings to default" button that forgets only this device's look.
- asked: 2026-10-07
- shipped: edc40bd5

### R-settings-005 · shipped
The auto-compact window is set to 400k for this repo.
- asked: 2026-10-11
- shipped: e1457229

### R-settings-006 · shipped
Settings search finds every setting, including the vault and other extension rows and installed plugins by name.
- asked: 2026-10-11
- shipped: 4637a41d, eab23a65

### R-settings-007 · shipped
A per-device setting sets how often background updates refresh: live, 1, 5, 15 minutes or off, default 5 minutes, trading battery for freshness of the offline status.
- asked: 2026-10-12, 2026-10-13
- shipped: 1bfe6427

### R-settings-008 · shipped
The main view can order repos by most open sessions first, ties alphabetical, or alphabetical only, chosen in a per-device repo order setting.
- asked: 2026-10-15
- shipped: b35c327a
- note: Default later became most open sessions first (15794716).

### R-settings-009 · shipped
A private permissions extension shows which Claude Code permission rules apply in a repo, read-only.
- asked: 2026-10-17
- shipped: 3eadc3e9

### R-settings-010 · shipped
Changing the default level and thinking effort in the dialog applies only to the running session or the one about to start, not to every session.
- asked: 2026-10-19
- shipped: be94de41

### R-settings-011 · requested
The exposure watch is switched on from a setup button in the repo opt-ins, and the watch region shows only for a repo that has it on.
- asked: 2026-10-26
- note: Opt-in button exists; watch chip is always shown.

### R-settings-012 · shipped
Functionality that only a few people need is optional rather than shown to everyone.
- asked: 2026-11-01
- shipped: 817a950c, 61e88d21

### R-settings-013 · shipped
The app has a link to the auto setup management screen.
- asked: 2026-10-31
- shipped: ca20fc62

