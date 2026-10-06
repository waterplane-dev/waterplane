# scrollback — the terminal's history, read locally

Panning up in the terminal is a wheel event FOR THE TUI and needs the socket; this sheet is the copy
that doesn't. Lines that scrolled off are archived per session in IndexedDB (`screenlog.ts`), and the
host's PTY recording replaces that copy only when it is actually more. The sheet is the flat
`ScrollbackSheet.tsx`, wrapped by `ScrollArchiveSheet.tsx`; its rules (two sources and which one is
on screen is SAID, its own stored zoom, never the console's) are in the `web-term` skill.

**Owns** (`store.ts`, one writer — `openScrollback` in `actions.ts`): `liveGrid`, the terminal grid
as it was when the sheet opened. It is read in `openScrollback`, BEFORE the sheet replaces the
terminal — rendering the sheet unmounts `TerminalView`, and a snapshot taken after that is empty —
and folded into the screen log on the way past (`screenlog.absorb`), so the sheet's last line is
what was just on screen even if the 400 ms settle hadn't fired.

**Sheet**: `scrollback` (not persisted; `null` with no session on screen). **Messages**: none.

**Reads from core**: `world.active`, `term.snapshot()` (the xterm grid; `[]` with none mounted),
`conn.status`, `nav.open/close`, `say.toast`.

**Exports for App**: `openScrollback()` — the toolbar's `scrollback` item, the terminal's
reach-back gesture and the corner button.

**Tests**: e2e `scripts/e2e-screenlog.mjs`, `scripts/e2e-scrollcomposer.mjs`.
