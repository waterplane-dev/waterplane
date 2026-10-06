# offline

### R-offline-001 · shipped
Commands submitted while offline (including when spawning a new CLI session without internet) queue locally and auto-fire once connectivity returns.
- asked: 97c33dbd, 6a7f4a66, 9b5d5db9
- shipped: 664187d

### R-offline-002 · shipped
User can read latest session results and transcripts while offline, with reliable background download, cache-first rendering, and viewed logs/transcripts remaining accessible (without hanging) once the internet is lost.
- asked: 6a7f4a66, fa563a9e, 6e70471a, bfa500f5
- shipped: 2be1e5e, 73085aa

### R-offline-003 · shipped
User can modify queued commands while offline.
- asked: 6a7f4a66
- shipped: 664187d

### R-offline-004 · requested
Offline UI and features remain accessible with no connectivity, including defined tools, scheduling commands offline, queuing new prompts regardless of system state, identical online/offline dialogs that open immediately without waiting for CLI startup, and an offline download dialog that stays visible once opened.
- asked: 4a28d82d, d8d5c4a9, bcfdd1cc, 5c8d1211, 5557ada0, 48be8bda

### R-offline-005 · requested
Images, including cached images and full-screen thumbnails, display correctly and are preserved in offline mode, and remain preserved and fully shown when restoring after a poor-connection send/run.
- asked: 40eed476, d1ffa517, 57444d90, d626dd9c, 2026-09-11 (session 390ca63b)

### R-offline-006 · requested
Responsive layout behavior from offline mode also works in online mode.
- asked: 47ca01d3

