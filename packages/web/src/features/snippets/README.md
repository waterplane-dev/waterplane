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

**Not here — the compose bar's** (`core/compose`): the popover's open state (`snippetOpen`, in
`useCompose`) and `appendSnippet` (`useCompose`), which APPENDS to the draft (newline-separated) —
never overwrites typed words. `ComposeBar.tsx` draws the popover and reads the list through
`useSnippets()`.

**Reads from core**: `nav.close`. Track ids: `action:snippet.insert` (`core/compose/ComposeBar.tsx`,
and `PromptComposer.tsx`'s own picker), `action:snippet.save` (inside `SnippetSheet`), unchanged.
