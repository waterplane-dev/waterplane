# requirements — an in-repo extension

What this repo is expected to do, as a person asked for it: `docs/requirements/<area>.md`, built by
`scripts/requirements/update.mjs` from the prompts and the commits, left as an uncommitted diff.

- `waterplane-plugin.json` — the same manifest an external plugin has. `host` names the SOURCE module;
  `.mts` because this folder is not a package; the daemon imports the compiled copy (`packages/host/src/plugins/builtin.ts`).
- `host/` — `activate(api: HostPluginApi)`: the setup row (`api.setupCheck`), the set-up fix
  (`api.setupFix("requirements")`) and four methods (`handleAll<ReqMethods>`): `summary` (area files only, the
  launcher chip asks it once per repo), `list` (items, areas, the row's own "behind" numbers, and each shipped
  commit's subject and date in one `git log --no-walk`), `setup` (the fix, no model call) and `update` (hands
  the run to the repo's agent through `api.handToAgent` WITHOUT `fire`: a backlog row that waits for a tap,
  keyed once per build state so a second tap finds the first). A `list` answer is ~100 KB for this repo's list
  (the wire cap is 512 KB); a repo with a far longer list would be refused in words, not truncated. Imports `@waterplane/shared` and node only — never a host module.
  Compiled by `packages/host/tsconfig.extensions.json` into `packages/host/dist/extensions/`.
- `web/` — `export const manifest: FeatureManifest`, found by `packages/web/src/features/registry.ts`'s
  EXTENSIONS glob and bundled with the phone (`web` in the manifest names the source). Imports only `@waterplane/sdk`,
  `@waterplane/kit`, `@waterplane/shared`, react, lucide-react and its own folder; a node test over it uses `import type` for
  the `@waterplane/*` aliases. `cut.ts` is the one predicate behind the chips' numbers, the list and the "n of N" sentence (a count is a
  filter; `cut.test.mjs`), `data.ts` the stores and the only writer, `RequirementsSheet.tsx` + `ItemRow.tsx` the
  sheet, `setupRow.ts` the words of the setup row (pinned by `web/setupRow.test.mjs`). Two doors to the update:
  the sheet's button and the setup row's hand-to-agent button (`SetupRowDef.agent`); both leave a backlog row
  waiting for a tap. A shipped commit opens the repo's git screen (working tree only — a per-commit screen is a
  follow-up); a session is text only (no `CoreApi` verb resolves an 8-character conversation prefix).
  Sheet ids are `feature:requirements/<name>` (`featureSheetId`), never persisted.
- `shared/methods.mts` — the method table (`ReqMethods`) and the two pure strings both ends word alike (`updateBrief`, `updateKey`). Files the host half imports must be `.mts`; `packages/host/tsconfig.extensions.json` includes `shared/`. The item parser is `@waterplane/shared`'s `parseRequirementsArea`, the same grammar as `scripts/requirements/update.mjs`.

The row's wording is pinned by `packages/host/test/requirementsrow.test.mjs`. Why extensions look
like this: [docs/notes/plugins.md](../../../docs/notes/plugins.md#in-repo-extensions).
