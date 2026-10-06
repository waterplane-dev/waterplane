/**
 * **What this phone still has to allow** before the APK can do its work with
 * the app closed: stay connected, show alerts, start from the background, and
 * install a downloaded build.
 *
 * Android grants none of these to an app on its own — every one is a person's
 * tap on a system dialog or a Settings switch — so the most the app can do is
 * say which are missing and put the one tap in front of each. This is the pure
 * half: which steps exist and whether each is done. The Settings checklist and
 * the launcher banner both read it, so they cannot disagree about "2 of 4".
 *
 * **Unknown is absent, never "not done"**: a step whose answer has not arrived
 * (the install access is asked asynchronously) is left out rather than nagged
 * about.
 */

export type SetupStepId = "link" | "notifications" | "battery" | "install";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  done: boolean;
  /** What stops working without it, in words. */
  why: string;
}

export interface SetupInputs {
  /** The background link's status; null outside the Android shell. */
  link: { enabled: boolean; running: boolean; notifications: boolean; batteryExempt: boolean } | null;
  /** "Install unknown apps" granted; null while still asking or unsupported. */
  canInstall: boolean | null;
}

/** The steps for this phone, or null where there is no shell to set up. */
export function setupSteps(i: SetupInputs): SetupStep[] | null {
  if (!i.link) return null;
  const steps: SetupStep[] = [
    {
      id: "link", label: "background link", done: i.link.enabled,
      why: "keeps the connection with the app closed: queued sends go out, downloads start, alerts arrive",
    },
    {
      id: "notifications", label: "notifications", done: i.link.notifications,
      why: "alerts, download progress and the one-tap install have nowhere to appear without it",
    },
    {
      id: "battery", label: "background use", done: i.link.batteryExempt,
      why: "a phone that dozes the app refuses to start a download or reconnect from the background",
    },
  ];
  if (i.canInstall !== null) {
    steps.push({
      id: "install", label: "install apps", done: i.canInstall,
      why: "lets a downloaded build install from its notification or the Apps list",
    });
  }
  return steps;
}

/** "3 of 4 ready". */
export function setupSummary(steps: readonly SetupStep[]): string {
  return `${steps.filter((s) => s.done).length} of ${steps.length} ready`;
}

/** The missing steps by name, for a one-line banner. Null when nothing is. */
export function setupMissingText(steps: readonly SetupStep[]): string | null {
  const missing = steps.filter((s) => !s.done).map((s) => s.label);
  if (!missing.length) return null;
  return `Phone setup ${setupSummary(steps)} — still missing: ${missing.join(", ")}.`;
}

/**
 * What the banner's sheet lists: only the steps still to allow — the banner
 * named those, so tapping it opens exactly those. `hidden` is how many ready
 * steps the cut left out, so the sheet can SAY it is filtered ("2 of 4") and
 * offer the rest; `showAll` lifts the cut. One predicate (`!done`) feeds both
 * the banner's list and this cut.
 */
export function setupView(steps: readonly SetupStep[], showAll: boolean): { shown: SetupStep[]; hidden: number } {
  const shown = showAll ? [...steps] : steps.filter((s) => !s.done);
  return { shown, hidden: steps.length - shown.length };
}
