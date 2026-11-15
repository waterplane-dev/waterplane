# slowjobs

The wire half of the phone's slow-job store. A slow job is a host read that outlives the screen
that asked for it (host `slowjobs.ts`): the Repo readings checklist (`setup.check`), the skills
inventory (`skills.inventory`), its use counts (`skills.uses`) and the skill suggestions
(`skills.recommend`, the one model call — only ever started by a tap).

**Owns**

- `index.ts` — the manifest: `slowjob.state` frames go to the store (`src/slowJobs.ts`,
  `onSlowJobFrame`); every `welcome` (a reconnect) runs `resyncSlowJobs` against `GET /api/jobs`,
  so a run that ended while the socket was down is read, and one the desktop lost (a restart
  forgets every job) is asked for again by the screen showing it.
- `logic.ts` + `logic.test.mjs` — whether a run's end is toasted and its one sentence: only a run
  somebody waited on (a tap, or a screen with nothing to show yet), only while no screen shows that
  key. The toast's tap opens the screen (`nav.openSetup` / `nav.openSkills`).

**Not here, on purpose**: the store itself is `src/slowJobs.ts` (pure rules `src/slowJobsLogic.ts`),
because its readers sit on both sides of the feature boundary — `SetupSheet.tsx` at the root and
`features/skills`. A feature may not import another feature.

**Reads from core**: `world.repos` (the repo's name), `nav.openSetup`, `nav.openSkills`,
`say.toast` (with its `open` argument).

**Rules that apply**: nothing applies itself — a finished suggestion list is shown, never applied;
leaving a screen aborts nothing; a start while the link is down is refused with the offline gate's
sentence (`offlineSentence`), never queued; the frame never carries a result (read over HTTP).
