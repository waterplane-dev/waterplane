// Two host-pushed lists that are READ offline: a repo's build commands and the
// schedules.
//
// Both are host state, both were kept in socket-fed React state only, and both
// are looked at almost exclusively when the link is bad — the build sheet is the
// escape hatch for a rate-limited or unreachable desktop, and "what runs
// tonight" is asked from a train. With no socket they rendered EMPTY, and an
// empty list is a claim: the build sheet told a repo with five commands that it
// had none and offered to spend tokens working them out again.
//
// The failure is silent in both directions, which is what makes it worth a
// script. Nothing throws, nothing logs, and a future edit that re-initialises
// either piece of state to `new Map()` / `[]` — the obvious-looking thing to
// write — puts the lie straight back on the screen with no test going red
// anywhere else. This is a source check, like `e2e-hints.mjs`'s `data-hint`
// sweep: no host, no daemon, just the invariants that have no other guard.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = (p) => readFileSync(join(repoRoot, "packages/web/src", p), "utf8");
const has = (p) => existsSync(join(repoRoot, "packages/web/src", p));
/** Every .ts/.tsx under a src/ folder, as one string ("" before it exists). */
const dirSrc = (d) => (has(d)
  ? readdirSync(join(repoRoot, "packages/web/src", d), { recursive: true }).filter((f) => /\.tsx?$/.test(f)).sort().map((f) => src(`${d}/${f}`)).join("\n")
  : "");

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

const app = src("App.tsx");
const build = src("BuildSheet.tsx");
// The build list's state left App for `features/build/` on the shared SDK
// helpers (`sdk/repoRun.ts` over `sdk/cached.ts`). Each property is asserted
// against the file that now OWNS it — grepping App for a property that moved
// would go green the moment it moved, the opposite of what this is for.
const buildStore = src("features/build/store.ts");
const buildIdx = src("features/build/index.ts");
const buildView = src("features/build/BuildButtonsSheet.tsx");
const repoRun = src("sdk/repoRun.ts");
const cached = src("sdk/cached.ts");
// The schedule list's state is leaving App for `features/schedule/`: its checks
// read App PLUS that folder, so each property is found wherever it lives now —
// and the negative checks see a copy left behind in either.
const schedHome = `${app}\n${dirSrc("features/schedule")}`;
const sched = has("ScheduleSheet.tsx") ? src("ScheduleSheet.tsx") : src("features/schedule/ScheduleSheet.tsx");
const local = src("localState.ts");
// The schedule sheet's two list invariants moved into `clockCuts.ts` when
// Schedules became a directory of clocks: the sheet renders the cut, the cut
// decides it. Read both, and assert each property against the file that now
// owns it — a check that kept grepping the sheet would go green the moment a
// property moved, which is the opposite of what this script is for.
const cuts = src("clockCuts.ts");
const storage = src("storage.ts");

// ── The keys exist, and only in the registry ────────────────────────
check(/snapBuilds:\s*lsKey\("snap\.builds"\)/.test(storage) && /snapSchedules:\s*lsKey\("snap\.schedules"\)/.test(storage),
  "both snapshot keys are declared in storage.ts (the one place a storage key literal may live)");

// ── Seeded from the cache, not from empty ───────────────────────────
// The state initialisers are the whole feature: everything downstream renders
// whatever these hold at first paint, which offline is all it will ever hold.
check(/repoRunStore<BuildConfig, BuildRun>\(\{\s*load:\s*loadBuildsSnap,\s*save:\s*saveBuildsSnap\s*\}\)/.test(buildStore)
  && /const cfgs = cachedList<C>\(io\)/.test(repoRun)
  && /createStore<CachedLists<T>>\(fromSnap\(io\.load\(\)\)\)/.test(cached),
  "the build feature seeds the per-repo build commands from the device cache");
check(/(useState<ScheduleEntry\[\]>\(\(\)\s*=>\s*|createStore<ScheduleEntry\[\]>\()loadSchedulesSnap\(\)\.v\)/.test(schedHome),
  "the schedule list is seeded from the device cache");
check(!/useState<Map<string, BuildConfig\[\]>>\(new Map\(\)\)/.test(app)
  && !/createStore<[^>]*BuildConfig\[\][^>]*>\(new Map\(\)\)/.test(buildStore)
  && !/useState<ScheduleEntry\[\]>\(\[\]\)/.test(schedHome) && !/createStore<ScheduleEntry\[\]>\(\[\]\)/.test(schedHome),
  "…and neither starts empty (the regression that puts the false claim back)");

// ── Written back when the host confirms them ────────────────────────
// A seed with nothing writing to it is a cache that is empty for ever.
check(/"build\.list":[^\n]*builds\.onList\(msg\.repoDir, msg\.builds, msg\.runs\)/.test(buildIdx)
  && /onList\(repoDir, list, rs\) \{\s*cfgs\.put\(repoDir, list\)/.test(repoRun)
  && /io\.save\(repoDir, list\)/.test(cached),
  "`build.list` writes the repo's commands to the cache");
// In App it was one `case` line; in `features/schedule/` the handler calls the
// action that writes — both halves are asserted, so a handler that stopped
// calling it (or an action that stopped saving) fails.
check(/"schedule\.list":?[^\n]*saveSchedulesSnap\(msg\.entries\)/.test(schedHome)
  || (/"schedule\.list": \(msg\) => onScheduleList\(msg\.entries\)/.test(schedHome)
    && /function onScheduleList\(entries: ScheduleEntry\[\]\): void \{[^}]*saveSchedulesSnap\(entries\)/.test(schedHome)),
  "`schedule.list` writes the schedules to the cache");

// ── Each cached list can say how old it is ──────────────────────────
// A cached list that cannot state its age reads as current, and a build command
// deleted at the desk last week then looks exactly like a live one.
check(/stamps\.set\(repoDir, at\)/.test(cached) && /listAt=\{cfgs\.at\.get\(dir\) \?\? 0\}/.test(buildView),
  "the build sheet is told when its list was last confirmed");
check(/listAt=\{schedulesAt\}/.test(schedHome), "the schedule sheet is told when its list was last confirmed");
check(/listAt/.test(build) && /ago\(listAt\)/.test(build), "the build sheet renders that age");
check(/ago\(listAt\)/.test(sched), "the schedule sheet renders that age");

// ── Two different nothings ──────────────────────────────────────────
// "The host says this repo has none" and "this device has never seen this
// repo's list" are different facts, and printing the first for the second is
// the original bug: a repo with five commands, told it had none, on the very
// screen you reach for when the tunnel is down.
check(/builds\.length === 0 && \(online \?/.test(build),
  "the build sheet's empty state branches on whether the host actually said so");
// `standingTotal`, not the card list: once one-offs live in their repos'
// backlogs, "this device has seen nothing" has to count the clocks too, or a
// device holding a cached clock and no card claims to have no copy of a list it
// is at that moment displaying.
check(/standingTotal === 0 && !online/.test(sched) && /standingTotal === 0 && online/.test(sched),
  "the schedule sheet's empty state does the same");

// ── Arming one offline is visible ───────────────────────────────────
// `schedule.save` was always a durable op, so writing one offline worked — into
// a list that showed nothing, at the exact moment you had just scheduled
// something. The queued saves are rows.
check(/pendingSchedules/.test(schedHome) && /e\.mode === "op" && e\.op\?\.t === "schedule\.save"/.test(schedHome),
  "the schedule list reads the un-acked `schedule.save` ops straight out of the send queue");
check(/pending=\{pendingSchedules\}/.test(schedHome), "…and hands them to the sheet");
check(/\[\.\.\.pendingCards\.map\(\(p\) => p\.entry\), \.\.\.\(o\.entries \?\? \[\]\)\.filter\(\(e\) => !queued\.has\(e\.id\)\)\]/.test(cuts),
  "a queued save upserts on its id rather than sitting beside the row it edits");
// Running / disarming / deleting a row the host does not have yet are all
// meaningless: the first would spawn sessions off a schedule nobody stored, the
// last would leave the save in the queue to re-create it.
// Stated against the REASON rather than a `disabled` attribute: a blocked verb
// is not rendered as a control at all any more (`Unavailable.tsx` — a greyed
// button on a phone has no hover to reveal its `title`, so it is a sentence
// instead). The invariant is unchanged: queued ⇒ run/toggle/delete each carry a
// reason, so each is withheld, and `edit` is the only one left.
// Each reason is a ladder now — `sendFailed` (the send gave up, so the desktop
// never got it at all) is answered before the still-in-flight `queued` — so the
// check is "this verb's reason consults `queued`", not "its first branch is it".
check(/run: [\s\S]{0,400}?queued \?/.test(sched)
  && /toggle: [\s\S]{0,400}?queued \?/.test(sched)
  && /remove: [\s\S]{0,400}?queued \?/.test(sched),
  "a queued row gives a reason for run, toggle and delete");
check(/\{why\.run \? null : \(/.test(sched)
  && /\{why\.toggle \? null : \(/.test(sched)
  && /\{why\.remove \? null : \(/.test(sched)
  && /data-hint="schedule\.edit"/.test(sched),
  "a queued row offers only `edit` — the one action an upsert makes safe");
check(/<Unavailable cants=/.test(sched),
  "…and the withheld ones are stated as a sentence, never as a dimmed button");

// ── The cache stays bounded, and never caches a transient ───────────
check(/BUILD_SNAP_REPOS/.test(local), "the per-repo build cache is capped");
check(/running: _running/.test(local),
  "the schedule cache drops `running` (a row claiming days later to be running something)");

process.exit(failed ? 1 : 0);
