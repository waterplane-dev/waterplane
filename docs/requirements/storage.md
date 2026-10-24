# storage

### R-storage-001 · shipped
Cleanup utilities let the user see and remove accumulated downloads and other stored items across repos.
- asked: 2026-09-22
- shipped: 9d1e2ac, c365766

### R-storage-002 · shipped
App storage lives under the waterplane namespace; the legacy .usmc location still resolves to it.
- shipped: f8ec634

### R-storage-003 · shipped
Per-user state lives in the state directory (WATERPLANE_STATE_DIR, else XDG_STATE_HOME, else ~/.local/state/waterplane); config lives in ~/.config/waterplane and per-repo state in <repo>/.waterplane.
- asked: 2026-10-04
- shipped: 9d3cf94

### R-storage-004 · shipped
An overview shows disk usage and free space per volume.
- asked: 2026-10-06
- shipped: 13492173

### R-storage-005 · shipped
The private disk-space plugin gives one-click cleanup for purely temporary files, shows delete buttons only for AI models and temporary files (other large items are display-only), and can scan on demand for large files with a script that uses no AI tokens.
- asked: 2026-10-07
- shipped: ac002699

### R-storage-006 · shipped
The host warns once when free disk falls under 10 GB (default) and again under 3 GB, before macOS starts ending apps.
- asked: 2026-10-21
- shipped: d9bcc454

### R-storage-007 · shipped
The disk space plugin UI looks polished and well designed.
- asked: 2026-10-21
- shipped: aba149fa

