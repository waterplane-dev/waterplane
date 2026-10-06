# toolbarCfg

What is in the session header and the burger's menu, as this device has it: the menu's order
(by hand or most-used), which items are hidden, which are PINNED into the header, the header's
one-tap commands (`headerCmds.ts`), and whether the menu is open. The items themselves (id,
label, icon) are still declared in `toolbar.ts`, which owns order and pinning semantics; the menu
and the header are drawn by the session screen. Rules: `web-chrome` (the toolbar IS the
burger's menu; a tap closes it except `MENU_KEEP_OPEN`; `splitHeaderCmds` withholds, never
deletes, a slash chip a backend cannot take).

**Owns** (`store.ts`, every writer in `actions.ts`):

- `toolbarCfg` (`LS.toolbar`, synced) and `headerCmds` (`LS.headerCmds`, synced) — both seeded
  from this device's copy, both reloaded by `bootToolbarSync` (the manifest's `boot`) when a copy
  is adopted from another device. One feature owns both because "what is in my header" is one
  question: the `hdrcmd` sheet configures the chips AND the pins, and the `toolbar` sheet counts
  both.
- `usedOrder` — the most-used order, SNAPSHOTTED (on mount, session switch, turning the mode on,
  once a minute; never per tap) by `useUsedOrderSnapshot(activeId)`, which App calls.
- `toolbarOpen` (`LS.toolbarOpen`, per device) — `setToolbarOpen` (the burger) and
  `closeToolbarMenu(id?)` (a menu choice) are its only writers, so open/shut is one fact.
- `logic.ts` — `MENU_KEEP_OPEN`/`closesMenu`, and the pure list edits (`toggled`, `movedBy`,
  `draggedOnto`), tested in `logic.test.mjs`.
- Sheets: `toolbar` (persisted, `ToolbarSheet.tsx`), `hdrcmd` (not persisted,
  `HeaderCmdsSheet.tsx`, on the shared `SnippetSheet.tsx`).
- Track ids: `action:toolbar.pin`, `action:hdrcmd.manage`, `action:hdrcmd.save` (unchanged).

**Reads from core**: `world.active/backends/sessionCan` (the hidden-slash sentence), `nav.open/
close`, `say.track`.

**Exports for App / the session screen**: `useToolbarCfg`, `useHeaderCmds`, `useHeaderSplit`
(the ONE `splitHeaderCmds` call — the session header and the `hdrcmd` sheet both read it, so the
count and the cut cannot drift), `useUsedOrder`, `useToolbarOpen`, `setToolbarOpen`,
`closeToolbarMenu`, `useUsedOrderSnapshot`.
