# skills

The skills & plugins switch: what every NEW session of a repo carries in its skill listing, and the
switches for it. Claude backend only (`caps.skillSwitch`); any other backend gets the sentence
`skillSwitchReason` says, not a dimmed screen. Doors: the Setup sheet's context-weight row, and the
skill-listing card of the request breakdown (`CarriedSection`'s `onSkills`).

**Owns**

- `store.ts` — the repo it is aimed at, the level (this repo / all repos, local or shared file),
  the DRAFT (chosen, not saved), filter, sort, query. One writer: `actions.ts`.
- `actions.ts` — `aimSkills` (the door's aim, `src/skillsDoor.ts`, becomes this state on mount), the draft edits, and `saveChanges`, the ONE write
  path: `POST /api/repos/:id/skills/write` with the layer rev the screen read. A 409 or 422 keeps
  the draft and says why. A different repo starts with an empty draft.
- `logic.ts` + `logic.test.mjs` — draft math, filters (one `bucket` feeds the chip number and the
  cut), sort, weight and savings sentences. Savings come from shared `savingsOf`.
- `SkillsSheet.tsx`, `SkillRows.tsx` — the sheet, plugin cards (one switch per plugin; its skills
  read-only under a fold: the CLI ignores `skillOverrides` for plugin skills) and skill rows.

**Reads from core**: `nav.open/close`, `world.backends`, `say.toast`, `say.track`. Reads from the
host: `GET /api/repos/:id/skills` (polled every 3 s while uses are still being counted).

**Rules that apply**: changes reach NEW sessions only (said once at the top); the screen names the
file a save writes; a re-read never overwrites the draft; an unmeasured row says so, never `0`;
a total ships with its split; no dimmed buttons, a locked row prints its sentence; nothing applies
itself — the Recommend list (`SuggestList.tsx`) is only a list until its one Apply tap, which goes through the same `saveChanges` with just the ticked rows.
