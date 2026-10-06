/**
 * The two things the Build sheet asks an agent to do, as words.
 *
 * Both of them hand a session a prompt and let it edit the repo's builds file
 * itself — there is no reply channel back into this sheet and deliberately so:
 * the file IS the contract, the same one `builds.ts` reads, and the list
 * refreshes the next time the sheet is opened (`openBuildFor` re-asks
 * `build.list` every time).
 *
 * They are two different SIZES of the same job, which is why there are two:
 *
 *  • `SETUP_PROMPT` — the empty sheet. Read the whole repo, work out how it
 *    really builds and ships, write every button worth having. A whole agent
 *    turn, and the right one to spend while Claude still has tokens, since this
 *    sheet is what you fall back to when it does not.
 *  • `oneBuildPrompt()` — the editor's wand. ONE entry, seeded with whatever is
 *    already typed in the three fields, and told to touch nothing else. Adding
 *    "the same as the release APK but for the other flavour" should not re-read
 *    a monorepo, and the whole-repo prompt merging a second opinion over five
 *    working buttons is the failure that shape has.
 *
 * Pure strings, in their own module rather than in `BuildSheet.tsx`, for two
 * reasons: the schema below is written ONCE and both prompts interpolate it (two
 * copies drift, and the drifting one is always the one an agent is reading), and
 * a prompt is a contract with a machine — `buildPrompt.test.mjs` pins it, which
 * a JSX component cannot be imported into.
 */

import { BRAND, paramEnvName, stateRel, type BuildConfig } from "@waterplane/shared";

const BUILDS_FILE = stateRel("builds.json");

/**
 * The file format, written once.
 *
 * The parameter half is the part worth being explicit about: an agent that has
 * never seen this app will otherwise write forty near-identical buttons for a
 * monorepo, which is exactly the thing parameters exist to stop.
 */
export const BUILDS_SCHEMA = `\`${BUILDS_FILE}\` is a JSON array of objects \`{ "id", "name", "cmd", "dir", "params" }\`:
- \`id\`: short unique slug. If the file already exists, KEEP the ids that are there.
- \`name\`: short button label, e.g. "Release APK". It is read on a phone, so keep it short.
- \`cmd\`: ONE shell command line, run by the login shell.
- \`dir\`: repo-relative working sub-dir, or omit for the repo root.
- \`params\` (optional): what the button ASKS before it runs — an array of \`{ "id", "label", "kind", "options", "optionsCmd", "default", "hint" }\`.
  - Use this instead of writing one button per member of a monorepo. One "Screenshot app" with an \`app\` parameter beats forty buttons.
  - \`id\`: \`[A-Za-z][A-Za-z0-9_]*\`. Referenced in \`cmd\` and \`dir\` as \`{{id}}\`, and exported to the command as \`${paramEnvName("<ID>")}\` (upper-cased) whether or not the command line names it.
  - \`kind\`: \`"text"\` (typed on a phone keyboard — avoid where a list is possible) or \`"choice"\` (a drop-down).
  - A choice gets its options from a fixed \`options: ["a","b"]\`, or from \`optionsCmd\` — a shell one-liner run IN THE REPO ROOT when the form opens, one option per line of stdout (e.g. \`ls -1 apps\`). Prefer \`optionsCmd\` where the list can change: a hard-coded list of a monorepo's apps goes stale the week somebody adds one.
  - \`default\`: used when nobody is asked — a schedule, a chain, "run it now". A parameter with no default REFUSES those runs in words rather than guessing, which is correct for "which app" and wrong for "which flavour"; give a default where one is genuinely safe.
  - The value is substituted VERBATIM, so quote the placeholder in the command if a value could contain spaces: \`--app "{{app}}"\`. A placeholder no parameter declares is left as written, and the command fails loudly.`;

/**
 * What a build must NOT do about its own output any more.
 *
 * This is the half the first generation of these prompts got wrong, and it
 * produced the same three defects in every repo it wrote for: a deliverable
 * called `app-debug.apk` (three repos here produce a file by exactly that
 * name), a script that copies it somewhere friendlier and leaves the original
 * so both are detected and the phone fetches 227 MB twice, and nothing
 * anywhere that ever removes an old one.
 *
 * None of it is the build's job now. The app collects what a run produced into
 * `.claude/outbox/`, names it after the repo, the variant and the project's
 * own version, folds two names for the same bytes into one artifact, and
 * removes older builds of that same artifact — per repo, on by default, and
 * visible as two switches in the Build sheet (`shared/artifacts.ts`). A script
 * that does any of it by hand does it a second time, differently.
 */
export const ARTIFACT_RULES = `- Do NOT copy artifacts into \`.claude/outbox/\`, do NOT stamp a version or a timestamp into the output's file name, and do NOT delete old builds. ${BRAND.name} does all three itself after every run: it collects what the build produced into \`.claude/outbox/\`, names it after the repo + variant + the project's own version, and removes older builds of the same artifact. A command that also does it produces a second copy under a second name.
- Let the build write wherever it natively writes (\`build/outputs/…\`, \`dist/\`, \`target/\`). If the tool can be told to put the project's version in the file name natively, that is fine and is kept; anything else is renamed for you.`;

/** The rules a command has to satisfy to be worth a button — the load-bearing
 *  half, since these later run with no session and nobody watching. */
export const BUILD_RULES = `- Every command must be non-interactive, must not need a TTY, must not push, deploy, publish, tag or release anything, and must not need a secret that isn't already on this machine.
- Check the command actually exists (the npm script is in package.json, the gradle task is real, the script is executable). Do NOT run the builds themselves.
${ARTIFACT_RULES}`;

/**
 * The predefined "work out this repo's build commands" prompt.
 *
 * Wiring a build by hand means typing a gradle task into a phone, which is
 * exactly the thing this app exists to avoid — and the repo already knows the
 * answer (package.json scripts, gradlew, a CI workflow). So the empty state
 * offers to ask Claude instead, once, while it still can: this sheet is the
 * escape hatch for when it CAN'T.
 */
export const SETUP_PROMPT = `Set up ${BRAND.name}'s build buttons for this repo.

${BRAND.name} can run shell commands in this repo without a Claude session — the escape hatch for when you are rate-limited. The buttons come from \`${BUILDS_FILE}\` here.

1. Work out how this project really builds and packages, from the repo itself: package.json scripts, gradlew tasks, Makefile, Cargo.toml, pyproject, CMake, Xcode schemes, monorepo sub-dirs, and the CI workflow files (CI is usually the most honest source).
2. Write the file. ${BUILDS_SCHEMA}
   If the file already exists, merge into it and keep the ids that are already there.
3. Prefer commands that produce a downloadable artifact (apk/aab/ipa/zip/dmg/whl/tgz/…) — ${BRAND.name} collects those into \`.claude/outbox/\` under a versioned name and offers them for download when a run finishes. Then add the everyday ones worth having on a phone: full build, unit tests, lint/typecheck.
4. Where this repo holds many buildable members (a monorepo of apps, flavours, targets), write ONE parameterised button rather than one button each.
${BUILD_RULES}
5. Finish with one line per button you wrote, and say what you skipped and why.`;

/** What the person had already typed in the editor when they tapped the wand —
 *  the seed, and the only thing that makes this prompt about THEIR button. */
export interface BuildDraftSeed {
  /**
   * **What they actually want, in their own words** — asked for ON THE PHONE,
   * before a session is spent.
   *
   * The first version of this button had the PROMPT say "ask me what I want
   * before writing anything", and an agent handed that with an empty form did
   * what agents do: it started working. A rule that a model may decline is not
   * a gate, so the question moved to the one place that can hold it — the form
   * in front of the person, where answering it costs nothing and where "not
   * yet" is simply not tapping the button.
   */
  brief?: string;
  name?: string;
  cmd?: string;
  dir?: string;
  /** Present when the wand was tapped on an EXISTING entry (the id is what the
   *  agent must edit in place instead of appending a near-duplicate). */
  id?: string;
  /** True when this entry is already in the repo's builds file. A draft that has
   *  never been saved is one the agent must ADD. */
  existing?: boolean;
}

/** What the person typed, as lines an agent can read — or the sentence that says
 *  they typed nothing, which is a different instruction and not an empty one. */
function seedLines(seed: BuildDraftSeed): string {
  const lines: string[] = [];
  // Their own words first and VERBATIM — the fields below are what the form had
  // in it, which may be half of a thought or nothing at all.
  if (seed.brief?.trim()) lines.push(`- What I want: ${seed.brief.trim()}`);
  if (seed.name?.trim()) lines.push(`- Button label so far: "${seed.name.trim()}"`);
  if (seed.cmd?.trim()) lines.push(`- Command so far: \`${seed.cmd.trim()}\``);
  if (seed.dir?.trim()) lines.push(`- Working sub-dir so far: \`${seed.dir.trim()}\``);
  return lines.join("\n");
}

/**
 * The wand in the editor: ONE entry, and nothing else touched.
 *
 * Three cases, worded apart because they are three different instructions:
 *
 *  • Something typed ⇒ that is the brief. Finish it, correct it, parameterise it.
 *  • Nothing typed on a NEW entry ⇒ **ask first**. An agent handed "add a build
 *    button" with no subject will pick one, write it, and report success; a
 *    question costs one turn and gets the button somebody wanted.
 *  • An existing entry ⇒ edit THAT id in place. Appending a near-duplicate is
 *    how a sheet ends up with "Release APK" twice and no way to tell which one
 *    the schedule fires.
 */
export function oneBuildPrompt(seed: BuildDraftSeed, repoName?: string): string {
  const seeds = seedLines(seed);
  const where = repoName ? ` in ${repoName}` : "";
  const brief = seeds
    ? `Here is what I have typed into the form so far — treat it as the brief, finish it and correct it:\n${seeds}`
    : seed.existing
      ? "I have not said what to change. Read the entry named below and improve it — or ask me what I want before writing anything."
      : "I have not said what the button should do yet. ASK me what I want before writing anything — do not invent a build button.";
  const scope = seed.existing && seed.id
    ? `Edit the EXISTING entry with id \`${seed.id}\` in place. Do not add a second entry and do not touch any other entry in the file.`
    : "ADD exactly ONE entry. Keep every entry already in the file exactly as it is — same ids, same commands.";

  return `Add one build button to ${BRAND.name} for this repo${where}.

${BRAND.name} runs these shell commands without a Claude session — the escape hatch for when you are rate-limited. The buttons come from \`${BUILDS_FILE}\` here, and I am on the phone with the "new build" form open.

${brief}

${scope}

${BUILDS_SCHEMA}

Work out the real command from the repo itself (package.json scripts, gradlew tasks, Makefile, monorepo sub-dirs, the CI workflows — CI is usually the most honest source), rather than guessing a plausible one.

If the same command would otherwise be copied per app/flavour/target, give the entry a \`params\` question instead of writing several buttons.

${BUILD_RULES}

Finish with one line: the button you wrote, its command, and what it will ask for when I tap it.`;
}

/** The wand's own label and title, in one place: the editor draws it, and
 *  `BuildSheet` must not word the whole-repo button and this one the same. */
export const ONE_BUILD_LABEL = "work it out";
export const ONE_BUILD_TITLE =
  `say what this button should do, then have Claude work out THIS one build command from the repo and write it into ${BUILDS_FILE} — the whole-repo “set up” is the sheet's other button`;
/** The question the phone asks before any of it is spent, and the placeholder
 *  under it. Nothing is sent until the button below them is tapped. */
export const ONE_BUILD_ASK = "What should this button do?";
export const ONE_BUILD_PLACEHOLDER =
  "e.g. take a screenshot of one Garmin app — let me pick which app when I tap run";
/** Said under the box: what travels with the words, so nobody retypes the three
 *  fields they have already filled in. */
export const ONE_BUILD_ASK_NOTE =
  "The name, command and sub-dir above go with this. Nothing is sent until you tap “work it out”, and it writes only this one entry.";
/** And what there is to work out when nothing has been said at all — the
 *  `Unavailable.tsx` sentence in place of the button, never a dimmed one. */
export const ONE_BUILD_NOTHING =
  `say what the button should do first — a session with no brief starts guessing`;

/** What the editor says when the wand is tapped: the sheet closes and a session
 *  opens, so the receipt has to name where the work went. */
export function oneBuildToast(seed: BuildDraftSeed): string {
  return seed.brief?.trim() || seed.name?.trim() || seed.cmd?.trim()
    ? "opening a session to work that build out — it writes the button itself"
    : "opening a session — tell it what the button should do";
}

/** A one-line reading of what an entry will ASK when it is tapped, for the row
 *  in the list: three words, so a parameterised button is visibly one. */
export function paramsRowNote(b: Pick<BuildConfig, "params">): string {
  const ps = b.params ?? [];
  if (!ps.length) return "";
  return `asks for ${ps.map((p) => p.label || p.id).join(", ")}`;
}
