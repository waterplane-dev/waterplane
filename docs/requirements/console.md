# console

### R-console-001 · shipped
Console has zoom buttons to increase text size and show more content, and a full-screen toggle that doesn't open the keyboard; both are positioned as an overlay in the upper-right/far-right corner and are also available in read mode. Zoom buttons are also available in the scroll-back function.
- asked: 2026-09-13, 2026-09-18, 2026-09-20
- shipped: 8fbe9f1

### R-console-002 · shipped
Console no longer displays the size value.
- asked: 2026-09-13
- shipped: 8fbe9f1f

### R-console-003 · shipped
Scroll-back recording happens server-side so it can be captured reliably.
- asked: 2026-09-20
- shipped: 4b18afc

### R-console-004 · shipped
Scroll-back display never duplicates or omits lines from the recording.
- asked: 2026-09-20
- shipped: 4b18afc

### R-console-005 · shipped
The scrollback never archives the same screen lines twice, so the CLI logo and header are not repeated after a resize or repaint.
- asked: 2026-09-26
- shipped: 63de6aa

### R-console-006 · shipped
CLI view draws a tick per row for line-by-line selection; picked rows are visually distinct and can be quoted, copied or answered.
- asked: 2026-10-01
- shipped: e98a940

### R-console-007 · shipped
The last-opened session card in the session list has a prominent background wash.
- shipped: 89b9392

### R-console-008 · shipped
An abort button on the reader's working card stops the current run, after two taps.
- shipped: 54a1442

### R-console-009 · shipped
On the session card the status chip comes first in a fixed order, and a page-colour gutter separates the session cards more strongly.
- shipped: ab24f9d4

### R-console-010 · shipped
A section on the session card shows recent prompts, token costs and context information.
- shipped: 4e366ae6

### R-console-011 · shipped
Agent worktrees show under the session that made them.
- shipped: 65e5c1b

### R-console-012 · shipped
Tapping a shell row shows its full command and live output on demand.
- asked: 2026-10-03
- shipped: 8721e1e

### R-console-013 · shipped
The console does not flicker when the CLI folds away or during login.
- asked: 2026-10-03
- shipped: b51f407

### R-console-014 · shipped
Terminal and peek font size stays stable and does not change repeatedly.
- asked: 2026-10-03
- shipped: 3ead575

