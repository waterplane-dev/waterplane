# The unattended spenders, split: `assess` as a barrel

_Target document for cutting `assess.ts` in `packages/host/src` and
`packages/shared/src` (the `refactoring` skill). Moves only — the `claude -p` flags, prompts,
timeouts and the rule that nothing applies itself are the same text as before. The spawn seam is
`sidecar.ts`, not touched here._

(`smartpick` was cut the same way and removed 2026-10-16; see [host.md](host.md#smart-pick--removed-2026-10-16).)

Each original path stays as a **barrel**: the module's header comment and explicit
`export { … } from "./<name>/<slice>.js"` lists, so no importer changes. Nothing outside
`<name>/` names a slice. Basenames are unique across packages, hence the prefixes (`hass`
host, `sass` shared; web's assess slices are `arows*`/`asx*`).

| module | slice | holds |
| --- | --- | --- |
| host assess | `hassknobs`, `hassstore`, `hassinput`, `hassprogress`, `hassutil`, `hassrun` (the `claude` spawn), `hassexec`, `hassapply` | knobs · `AssessStore` · input and prompt · watching a run · result parsing and atomic write · the run · the executor and start · applying a proposal |
| shared assess | `sassvocab`, `sassio`, `sassclean`, `sassslot`, `sasswords`, `sassapply` | vocabulary, caps, files · input/output types · `cleanAssessment` · the slot check's conflict/split cleaners · sentences, questions · `applyAssessment` |

Imports inside a folder are acyclic; a slice never imports its barrel.

## Pins

`tools/spenderssplit.test.mjs`: for both modules, the barrel's exported surface (name, value or
type) read off the type checker and equal to the pre-split files'; barrel line ratchets (lower
them when code moves out); every slice ≤ 500 lines; no definition in two files; no slice imports
its barrel; nothing outside the folder imports a slice.

## The one non-move

`ASSESS_PROGRESS_MS` was read when `assess.js` loaded, and `assessprogress.test.mjs` re-imports that
one file (`?throttle=1`) to change it. With the read in a slice the re-import no longer reaches it, so
`runAssessment` asks `assessProgressMs()` (same expression) at the start of the throttle check instead.
The exported constant is unchanged; a daemon's env never moves, so the value is the same.
