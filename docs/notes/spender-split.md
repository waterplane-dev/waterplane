# The unattended spenders, split: `smartpick` and `assess` as barrels

_Target document for cutting `smartpick.ts` and `assess.ts` in `packages/host/src` and
`packages/shared/src` (the `refactoring` skill). Moves only — the `claude -p` flags, prompts,
timeouts and the rule that nothing applies itself are the same text as before. The spawn seam is
`sidecar.ts`, not touched here._

Each original path stays as a **barrel**: the module's header comment and explicit
`export { … } from "./<name>/<slice>.js"` lists, so no importer changes. Nothing outside
`<name>/` names a slice. Basenames are unique across packages, hence the prefixes (`hsp`/`hass`
host, `ssp`/`sass` shared; web's assess slices are `arows*`/`asx*`).

| module | slice | holds |
| --- | --- | --- |
| host smartpick | `hspknobs` | the env knobs and caps |
| | `hspprompt` | `SMARTPICK_SYSTEM`, `smartpickPrompt` |
| | `hspstore` | the on-disk record types and `SmartPickStore` |
| | `hspdeps` | `SmartPickIntents` (the narrowed store), `SmartPickDeps`, `HOLD_TEXT`, `InFlight` |
| | `hspbase` → `hspmerges` → `hsppasses` → `hspclass` | the `SmartPick` class as a chain of abstract classes, each `extends` the one before, so method bodies keep `this` and nothing is rewired: base (state, `kick`, `whileApplying`, `record`, `candidates`, `repoFacts`), merges (`performMerge`, `finishApplying`, `undo`), passes (`start`, `finish`, `apply`), the class (`hold`, `mergedHold` — the guard ladder). Calls only go down the chain. `private` became `protected`; the three base classes are not exported through the barrel |
| | `hsphelpers` | candidate rows and the pure helpers, `route` |
| host assess | `hassknobs`, `hassstore`, `hassinput`, `hassprogress`, `hassutil`, `hassrun` (the `claude` spawn), `hassexec`, `hassapply` | knobs · `AssessStore` · input and prompt · watching a run · result parsing and atomic write · the run · the executor and start · applying a proposal |
| shared smartpick | `ssptypes`, `sspconst`, `sspfinger`, `sspclean`, `sspapply`, `sspwords` | wire types · caps, path regexes · fingerprint · reading the model's answer · turning a proposal into a plan · the strip's sentences |
| shared assess | `sassvocab`, `sassio`, `sassclean`, `sasswords`, `sassapply` | vocabulary, caps, files · input/output types · `cleanAssessment` · sentences, questions · `applyAssessment` |

Imports inside a folder are acyclic; a slice never imports its barrel.

## Pins

`tools/spenderssplit.test.mjs`: for all four modules, the barrel's exported surface (name, value or
type) read off the type checker and equal to the pre-split files'; barrel line ratchets (lower
them when code moves out); every slice ≤ 500 lines; no definition in two files; no slice imports
its barrel; nothing outside the folder imports a slice.

## The one non-move

`ASSESS_PROGRESS_MS` was read when `assess.js` loaded, and `assessprogress.test.mjs` re-imports that
one file (`?throttle=1`) to change it. With the read in a slice the re-import no longer reaches it, so
`runAssessment` asks `assessProgressMs()` (same expression) at the start of the throttle check instead.
The exported constant is unchanged; a daemon's env never moves, so the value is the same.
