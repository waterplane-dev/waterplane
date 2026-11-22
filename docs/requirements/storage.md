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

### R-storage-008 · shipped
The disk space view shows what fills the disk on Windows (through WSL) and Linux as well, and the extension is public and off by default; removal only deletes items from the latest scan, rechecked just before deletion, inside fixed folders.
- asked: 2026-11-12
- shipped: c71f7f3f2, 17120d936

### R-storage-009 · shipped
Each lost store write is recorded with the file, time and where its bytes went, and all records are listed on one phone surface in Settings; the queue bar says when the phone could not save the queue.
- asked: 2026-11-14
- shipped: 8f20bba6d, 351d51de6

### R-storage-010 · shipped
The disk-space screen shows temporary and AI-model rows with their delete buttons as soon as they are sized, finishes its large-file search without timing out, and lists rows as they are found, also on Windows and Linux.
- asked: 2026-11-22
- shipped: 1b9a45797, 07ad9b8a4, 147a97118

### R-storage-011 · shipped
Disk usage is shown per disk or partition, fullest first, with every list cut to the picked disk and an every-disk button.
- asked: 2026-11-22
- shipped: d267af353, 0944f4f59

### R-storage-012 · shipped
All localStorage access goes through storage.ts, and a lint rule rejects direct access elsewhere.
- asked: 2026-11-22
- shipped: 5a282693e

