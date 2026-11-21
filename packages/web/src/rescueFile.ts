/**
 * **Where words the app rescued by itself go: the backlog of their repo, marked.**
 *
 * Every AUTOMATIC rescue (a draft stranded under a pending id that never opened,
 * a sheet draft about to be seeded over, a dictation whose box was gone) used to
 * land on the pad, where nothing counts them and nobody looks. Each now becomes a
 * row in THAT REPO's backlog, marked `rescued` with a one-line reason, waiting
 * for a tap (`hold`, never `autoFire`) and counted on the launcher's repo row.
 *
 * Not covered, on purpose: the explicit "keep it on the pad" actions
 * (`useCompose`'s keepOnPad, `NextPromptStrip`, `PadSheet`) are the person's own
 * choice and still `addPadNote` directly.
 *
 * The pure half lives here so `node --test` states each rule:
 *   • the repo is the rescue's own `cwd`, else the active / last-visited
 *     session's (`fallbackCwd`);
 *   • with no repo at all, or no filer bound yet, the words go to the PAD. That
 *     is the ONLY remaining automatic pad use: there is nowhere better to put
 *     words that name no repo;
 *   • a filer that REFUSES (`null`: the words name an upload that will never
 *     arrive) must not delete anything, so the words go to the pad and the
 *     outcome says why;
 *   • the row goes through `queueBacklog`'s existing `mode: "backlog"` entry
 *     (durable, ackId, rides the send queue offline). No new send path.
 */
import { RESCUE_WHY, type Rescued } from "@waterplane/shared";

export { RESCUE_WHY };

/** What the filer takes: the existing `queueBacklog` options, narrowed to what a rescue sets. */
export interface RescueFiling {
  text: string;
  repoDir: string;
  steps?: string[];
  /** Always set, always with `hold`: a rescued row is never started by the auto switch. */
  hold: true;
  rescued: Rescued;
}

/** `queueBacklog`'s answer: `false` online, `true` offline (durable either way), `null` refused. */
export type RescueFiler = (f: RescueFiling) => boolean | null;

export type RescueRoute =
  | { to: "backlog"; cwd: string }
  | { to: "pad"; because: "no-repo" | "no-filer" };

/** The decision alone: which repo, or the pad and why. */
export function rescueRoute(p: { cwd?: string | null; fallbackCwd?: string | null; canFile: boolean }): RescueRoute {
  const cwd = p.cwd || p.fallbackCwd || "";
  if (!cwd) return { to: "pad", because: "no-repo" };
  if (!p.canFile) return { to: "pad", because: "no-filer" };
  return { to: "backlog", cwd };
}

export type RescueOutcome =
  | { where: "backlog"; cwd: string; offline: boolean }
  | { where: "pad"; because: "no-repo" | "no-filer" | "refused"; refusal: string | null };

export interface RescueDeps {
  file: RescueFiler | null;
  fallbackCwd: () => string | null | undefined;
  /** The pad's one add; returns the refusal sentence or null once the note is on it. */
  addPad: (note: { text: string; steps?: string[]; cwd?: string }) => string | null;
}

/**
 * Rescue `text` (the chain split: `steps` are the rest). Returns where the words
 * ended up; on `pad` with a non-null `refusal` the pad refused too and NOTHING
 * took them — the caller keeps the source (draft, clip) exactly where it is.
 */
export function rescueWords(
  deps: RescueDeps,
  p: { text: string; steps?: string[]; cwd?: string | null; why: string },
  now: number = Date.now(),
): RescueOutcome {
  const route = rescueRoute({ cwd: p.cwd, fallbackCwd: deps.fallbackCwd(), canFile: !!deps.file });
  const padIt = (because: "no-repo" | "no-filer" | "refused"): RescueOutcome => ({
    where: "pad", because,
    refusal: deps.addPad({ text: p.text, ...(p.steps?.length ? { steps: p.steps } : {}), ...(p.cwd ? { cwd: p.cwd } : {}) }),
  });
  if (route.to === "pad") return padIt(route.because);
  const offline = deps.file!({
    text: p.text,
    repoDir: route.cwd,
    // `steps[0]` repeats `text` (`deliverChain`; keeps an older desktop running turn one).
    ...(p.steps?.length ? { steps: [p.text, ...p.steps] } : {}),
    hold: true,
    rescued: { why: p.why, at: now },
  });
  if (offline === null) return padIt("refused");
  return { where: "backlog", cwd: route.cwd, offline };
}
