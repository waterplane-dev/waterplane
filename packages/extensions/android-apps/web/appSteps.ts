import type { AppReadiness, CheckState, ReadyCheck } from "./appReady.ts";

/**
 * **An app's way onto this phone, as three steps** — what the Apps screen's card draws.
 *
 * The checklist (`appReady.ts`) is ten facts in two halves, and it was its own tab: the owner,
 * who wrote it, could not say from the Apps screen whether an app updates itself or what stops it
 * (2026-11-01). A person asks it in three questions, in order — does the desktop BUILD it, does it
 * DOWNLOAD to this phone by itself, does it INSTALL by itself — so the card says those three, each
 * with the one fact that decides it, and puts the fix for the first step that stops on a button.
 *
 * Pure: it words the checklist and picks the fix; it reads and changes nothing. One vocabulary,
 * used by every line here and nowhere spelled twice: **build**, **download**, **install**, and
 * "by itself" for the automatic path.
 */

export type StepId = "build" | "download" | "install";

export interface AppStep {
  id: StepId;
  /** "build" / "download" / "install" — the step's name as drawn. */
  title: string;
  state: CheckState;
  /** One sentence: the fact that decides this step. */
  text: string;
  /** Every checklist line under this step, for the card's details. */
  checks: ReadyCheck[];
}

/** What the card's one fix button does — the verb for the first step that stops. */
export type FixKind =
  | "open-build"     // the repo's Build sheet: add or run a build button
  | "open-setup"     // the repo's setup checklist: the signing key
  | "enable-pull"    // turn the repo's auto-download rule on
  | "allow-access"   // Android's install-unknown-apps screen
  | "allow-app";     // this app's install-by-itself switch

const STEP_OF: Record<ReadyCheck["id"], StepId> = {
  build: "build", outbox: "build", key: "build", sdk: "build", repo: "build",
  pull: "download",
  access: "install", switch: "install", owner: "install", last: "install",
};

const RANK: Record<CheckState, number> = { ok: 0, unknown: 1, warn: 2, no: 3 };

function worst(checks: readonly ReadyCheck[]): CheckState {
  // No lines at all is UNKNOWN, never ok: a step nobody could read has not passed.
  if (!checks.length) return "unknown";
  // All unknown stays unknown; a mix of ok and unknown is ok (unknown blocks nothing).
  if (checks.every((c) => c.state === "unknown")) return "unknown";
  return checks.reduce<CheckState>((w, c) => (RANK[c.state] > RANK[w] && c.state !== "unknown" ? c.state : w), "ok");
}

/** The sentence for a step that holds — said in the step's own words, not the checklist's. */
function okText(id: StepId, checks: readonly ReadyCheck[]): string {
  const by = (cid: ReadyCheck["id"]) => checks.find((c) => c.id === cid);
  if (id === "build") return by("outbox")?.text ?? by("build")?.text ?? "Built on the desktop.";
  if (id === "download") return "Each new build downloads to this phone by itself.";
  const owner = by("owner");
  return owner?.state === "warn"
    ? "Installs by itself. Its first install from here asks once; every update after it is quiet."
    : "Installs by itself, with no dialog.";
}

/** The three steps of one app, in order. */
export function appSteps(r: AppReadiness): AppStep[] {
  return (["build", "download", "install"] as const).map((id) => {
    const checks = r.checks.filter((c) => STEP_OF[c.id] === id);
    const state = worst(checks);
    const first = checks.find((c) => c.state === "no") ?? checks.find((c) => c.state === "warn");
    return {
      id,
      title: id,
      state,
      text: state === "ok" || !first ? (state === "unknown" ? (checks[0]?.text ?? "Not known yet.") : okText(id, checks)) : first.text,
      checks,
    };
  });
}

/** The card's headline: does it update itself, and if not, which step stops it. A step this device
 *  cannot read (install, in a browser) never lets the headline claim the whole chain. */
export function appHeadline(r: AppReadiness): string {
  const steps = appSteps(r);
  if (r.blocker) {
    const i = steps.findIndex((s) => s.id === STEP_OF[r.blocker!.id]);
    return `not by itself yet — stops at step ${i + 1}, ${steps[i].title}`;
  }
  const unread = steps.filter((s) => s.state === "unknown");
  if (unread.length) return `nothing stops it that this device can see — ${unread.map((s) => s.title).join(" and ")} cannot be checked here`;
  return steps.some((s) => s.state === "warn") ? "updates by itself — with a caveat below" : "updates by itself";
}

/** The verb that fixes the blocker, where this phone has one; null where it is words only
 *  (a targetSdk the agent must raise, an app another installer owns). */
export function fixFor(r: AppReadiness): FixKind | null {
  const b = r.blocker;
  if (!b) return null;
  switch (b.id) {
    case "build": case "outbox": return r.facts ? "open-build" : null;
    case "key": return r.facts ? "open-setup" : null;
    case "pull": return r.facts ? "enable-pull" : null;
    case "access": return "allow-access";
    case "switch": return "allow-app";
    default: return null;
  }
}

/** The fix button's label, as drawn — a VERB for what the tap does, never "fix" and never the
 *  "<setting>: on" form: that form is how a switch shows its CURRENT state everywhere else, so a fix
 *  button reading "install by itself: on" beside a step saying it is off read as a contradiction
 *  (owner, 2026-11-01). */
export function fixLabel(k: FixKind): string {
  // closed: FixKind is minted by `fixFor` on this phone, never read off the wire
  switch (k) {
    case "open-build": return "open the Build sheet";
    case "open-setup": return "open repo setup";
    case "enable-pull": return "turn on download by itself";
    case "allow-access": return "allow installs";
    case "allow-app": return "turn on install by itself";
  }
}

/** Turning an app's install-by-itself ON also needs its builds to arrive: when the repo's
 *  auto-download rule is known OFF, the same tap turns it on — and the toast says both.
 *  Unknown (no facts) is left alone. */
export function switchAlsoEnablesPull(r: AppReadiness): boolean {
  return !!r.facts && !r.facts.autoPull.enabled;
}

/** The list's cut — ONE function for the chip's number and the rows it opens (`CLAUDE.md`: a count is
 *  a filter). `waiting` is the cards whose phone row has a build that has not gone on (`readyApps`);
 *  `repo` is one repo's apps, the Build sheet's "get it on this phone". */
export function appsCut<T extends { repo?: string; row?: { pkg: string } }>(
  cards: readonly T[],
  cut: { kind: "all" } | { kind: "waiting" } | { kind: "repo"; repo: string },
  waitingPkgs: ReadonlySet<string>,
): T[] {
  if (cut.kind === "waiting") return cards.filter((c) => !!c.row && waitingPkgs.has(c.row.pkg));
  if (cut.kind === "repo") return cards.filter((c) => c.repo === cut.repo);
  return [...cards];
}
