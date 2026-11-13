# snippets

Saved compose snippets: the texts the compose bar's snippet popover (the `Pencil`/list button
beside the mic) inserts into the draft, and the `snippets` sheet that adds, edits and deletes them.
The editor is the shared `SnippetSheet.tsx` (the header commands use it too, from `toolbarCfg`).

**Owns**

- `store.ts` — `snippets`: the list, **seeded from this device's copy** (`loadSnippets()`,
  `LS.snippets`, a SYNCED key), read by `useSnippets()`.
- `actions.ts` — its two writers: `saveSnippets` (the sheet's save; writes the store and the key,
  and the `settings.ts` patch pushes the write to the host) and `bootSnippetSync` (the manifest's
  `boot`: a copy adopted from another device reloads the store, the READ half of sync — held in a
  store, an adopted value would otherwise sit in localStorage until the next reload).
- `SnippetsSheet.tsx` — the wiring. Sheet: `snippets`, not persisted.

**Starters.** A person with NO list (the synced key absent, no copy adopted) sees the eight shipped
`STARTERS` (`snippetPicks.ts`); they are never written to the key until the person saves an edit in the
manage sheet, so a new phone of an existing user cannot push them over the real list. `[]` saved is a
choice and shows nothing. `addStarters` (the sheet's "starters" button) APPENDS the missing ones by text.
`store.ts` holds `{ list, starter }`.

**Not here — the shared picker.** `SnippetPicker.tsx` and `snippetPicks.ts` (pure, node-tested) sit at
the `src` root because both the compose bar (`core/compose/ComposeBar.tsx`) and `PromptComposer.tsx`'s
own button (Send sheet, pad) draw ONE picker: a tap inserts that snippet at once; the row's circle ticks (tap-order number), and once one is ticked a row tap ticks too; `Insert n`
above the list hands the ticked ones over, joined one per line. The compose bar's `appendSnippet`
(`useCompose`) APPENDS to the draft — never overwrites typed words.

**Reads from core**: `nav.close`. Track ids: `action:snippet.insert` (`core/compose/ComposeBar.tsx`,
and `PromptComposer.tsx`'s own picker; plus `action:snippet.insert.multi` when several were ticked), `action:snippet.save` (inside `SnippetSheet`), unchanged.
