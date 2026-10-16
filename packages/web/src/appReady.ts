import { BRAND, type AppRepoFacts, type InstallLogEntry } from "@waterplane/shared";
import {
  failureText, installerName, isPlayBuild, quietVerdict, type AppRow, type InstallCaps, type InstallSources,
} from "./installPolicy.ts";

/**
 * **Is this app set up to install itself — all of it, in one place.**
 *
 * A quiet install needs a chain nobody could see whole: the repo has a build that
 * makes an APK, the APK lands in the outbox, the auto-download rule takes it, the
 * key never changes; then the phone allows installs, the app's switch is on, waterplane
 * did its FIRST install, and the last attempt did not die on Play Protect or a full
 * disk. The repo half was one prose row per repo's setup sheet, the phone half was
 * the Apps screen, and the outcomes were a log — three places, and a person with nine
 * apps lost track of which were actually ready.
 *
 * So this joins them per app: the desktop's facts (`GET /api/apps/readiness`,
 * `host/apkcheck.ts`) and this phone's own answers, into one checklist whose first
 * `no` is named as the blocker. **It decides nothing and changes nothing** — every
 * line is a fact with its reason, and an unknown stays `unknown`, never a guess
 * (`CLAUDE.md`: heuristics degrade to absent).
 */

/** `ok` holds; `no` blocks a quiet install; `warn` holds with a caveat worth
 *  knowing; `unknown` could not be read and blocks nothing. */
export type CheckState = "ok" | "no" | "warn" | "unknown";

export interface ReadyCheck {
  id: "build" | "outbox" | "key" | "sdk" | "pull" | "repo" | "access" | "switch" | "owner" | "last";
  half: "repo" | "phone";
  state: CheckState;
  /** A few words — what the line is about, as drawn. */
  label: string;
  /** The fact, and where it is not `ok`, what fixes it. */
  text: string;
}

export interface AppReadiness {
  /** The package THIS phone knows it as — a flavor's suffix included. */
  pkg: string;
  label: string;
  repo?: string;
  facts?: AppRepoFacts;
  row?: AppRow;
  checks: ReadyCheck[];
  /** The first `no`, desktop half first: what to fix next. */
  blocker?: ReadyCheck;
}

export interface PhoneHalf {
  caps: InstallCaps;
  allow: readonly string[];
  sources: InstallSources | null;
  log: readonly InstallLogEntry[];
  /** This phone's id in the install log. */
  me: string;
  now: number;
  /** "3 h ago" — passed in so this file stays pure. */
  ago: (ms: number) => string;
}

const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;
const base = (rel: string) => rel.split("/").pop() ?? rel;

/** The desktop's half, as checklist lines. */
export function repoChecks(f: AppRepoFacts, now: number, ago: (ms: number) => string): ReadyCheck[] {
  const out: ReadyCheck[] = [];
  const apkBuilds = f.builds.filter((b) => b.apk);
  out.push(apkBuilds.length
    ? { id: "build", half: "repo", state: "ok", label: "build command",
        text: `${apkBuilds.map((b) => `"${b.name}"`).join(", ")} builds it from the Build sheet.` }
    : f.builds.length
    ? { id: "build", half: "repo", state: "warn", label: "build command",
        text: `${f.builds.length} build command${f.builds.length === 1 ? "" : "s"}, none named like an APK build — fine if one of them makes it; else an agent's build is the only way one arrives.` }
    : { id: "build", half: "repo", state: "warn", label: "build command",
        text: "No build command in the Build sheet — only an agent's build reaches the phone. Build › set up offers one." });

  out.push(f.newestApk
    ? { id: "outbox", half: "repo", state: "ok", label: "APK in the outbox",
        text: `${f.apks} in the outbox, newest ${base(f.newestApk.rel)} (${mb(f.newestApk.size)}, ${ago(now - f.newestApk.mtime)}).` }
    : { id: "outbox", half: "repo", state: "no", label: "APK in the outbox",
        text: "No APK in .claude/outbox/ — a build left in the module's build/ directory never reaches the phone. Have the build copy its APK there." });

  switch (f.key) {
    case "desktop": case "debug": case "other": case "repo":
      out.push({ id: "key", half: "repo", state: "ok", label: "same signing key",
        text: f.key === "desktop" ? "Signed with this desktop's key, kept outside the repo."
          : f.key === "debug" ? "Signed with this desktop's debug key, through keystore.properties."
          : f.key === "repo" ? "Signed with the repo's own signing config — keep that key."
          : "Signed with the key named in keystore.properties." });
      break;
    case "debug-default":
      out.push({ id: "key", half: "repo", state: "warn", label: "same signing key",
        text: "No signing config: each machine's own debug key signs it. Builds from THIS desktop update each other; one from another machine cannot update the app." });
      break;
    case "missing":
      out.push({ id: "key", half: "repo", state: "no", label: "same signing key",
        text: "The build reads keystore.properties and there is none, so it has no key. The repo's setup checklist (signing key) creates and links one." });
      break;
  }

  out.push(f.targetSdk === undefined
    ? { id: "sdk", half: "repo", state: "unknown", label: "recent targetSdk",
        text: "targetSdk is not a literal in the gradle file, so it was not read." }
    : f.targetSdk < 33
    ? { id: "sdk", half: "repo", state: "no", label: "recent targetSdk",
        text: `targetSdk ${f.targetSdk}: newer Androids ask on every update of an app targeting below 33.` }
    : { id: "sdk", half: "repo", state: "ok", label: "recent targetSdk", text: `targetSdk ${f.targetSdk}.` });

  const p = f.autoPull;
  out.push(!p.enabled
    ? { id: "pull", half: "repo", state: "no", label: "auto-download",
        text: `Auto-download is off for ${f.repoName}: a new build waits in the outbox until someone fetches it. Downloads › auto-download turns it on.` }
    : p.newestMatches === false
    ? { id: "pull", half: "repo", state: "no", label: "auto-download",
        text: `Auto-download is on, but its rule does not take the newest APK${f.newestApk && p.maxBytes > 0 && f.newestApk.size > p.maxBytes
          ? ` — ${mb(f.newestApk.size)} is over its ${mb(p.maxBytes)} cap` : " — it is outside the rule's patterns"}. Downloads › auto-download.` }
    : { id: "pull", half: "repo", state: "ok", label: "auto-download",
        text: `On for ${f.repoName}${p.newestMatches ? ", and its rule takes the newest APK" : ""}.` });
  return out;
}

/** This phone's half, as checklist lines. */
export function phoneChecks(pkg: string, label: string, ph: PhoneHalf, row?: AppRow): ReadyCheck[] {
  const { caps } = ph;
  if (!caps.supported) {
    return [{ id: "access", half: "phone", state: "unknown", label: "installs on this device",
      text: `This is a browser — only ${BRAND.displayName}'s Android app installs builds.` }];
  }
  if (isPlayBuild(caps)) {
    return [{ id: "access", half: "phone", state: "no", label: "installs on this device",
      text: "This Google Play build of the app installs nothing by itself." }];
  }
  const out: ReadyCheck[] = [];
  out.push(caps.canInstall
    ? { id: "access", half: "phone", state: "ok", label: "install access", text: `This phone lets ${BRAND.displayName} install apps.` }
    : { id: "access", half: "phone", state: "no", label: "install access",
        text: `This phone has not allowed ${BRAND.displayName} to install apps (Settings › install unknown apps).` });

  out.push(ph.allow.includes(pkg)
    ? { id: "switch", half: "phone", state: "ok", label: "auto-install", text: "On here." }
    : { id: "switch", half: "phone", state: "no", label: "auto-install",
        text: "Off here: a new build waits for a tap." });

  const v = quietVerdict(pkg, ph.sources);
  out.push(v.verdict === "ours"
    ? { id: "owner", half: "phone", state: "ok", label: "first install from here",
        text: `Installed, and ${BRAND.displayName} owns its updates — they can go on without a dialog.` }
    : v.verdict === "other"
    ? { id: "owner", half: "phone", state: "no", label: "first install from here",
        text: `First installed by ${installerName(v.by)}: Android lets only that installer update it quietly, so every update asks. Uninstall it once (that deletes its data) and install from here.` }
    : { id: "owner", half: "phone", state: "warn", label: "first install from here",
        text: `Not installed on this phone, or the phone kept no record of who installed it. The first install from ${BRAND.displayName} asks once; after it, quiet.` });

  // The outcome on THIS phone: the log is the fleet, and another phone's success
  // says nothing about why this one keeps failing.
  const mine = ph.log.filter((e) => e.pkg === pkg && e.deviceId === ph.me)
    .sort((a, b) => (b.at ?? b.reportedAt) - (a.at ?? a.reportedAt));
  const last = mine[0];
  if (row?.install === "asked") {
    out.push({ id: "last", half: "phone", state: "warn", label: "last attempt",
      text: "Waiting for you to confirm it on this phone." });
  } else if (!last) {
    out.push({ id: "last", half: "phone", state: "unknown", label: "last attempt",
      text: `No install of ${label} reported from this phone yet.` });
  } else {
    const when = ph.ago(ph.now - (last.at ?? last.reportedAt));
    const recent = mine.slice(0, 5);
    const failed = recent.filter((e) => e.outcome === "failed").length;
    const tally = recent.length > 1 ? ` ${failed} of the last ${recent.length} here failed.` : "";
    out.push(last.outcome === "installed"
      ? { id: "last", half: "phone", state: failed ? "warn" : "ok", label: "last attempt",
          text: `${last.version ? `${last.version} ` : ""}installed ${last.auto ? "by itself" : "by tap"}, ${when}.${tally}` }
      : { id: "last", half: "phone", state: "no", label: "last attempt",
          text: `${last.version ? `${last.version} ` : ""}failed ${when}: ${failureText(last.error)}.${tally}` });
  }
  return out;
}

/** Which of a repo's packages this phone actually has an answer about — the
 *  flavor that installs (`dev.waterplane.app.dev`), else the base package. */
function phonePkg(f: AppRepoFacts, known: Set<string>): string | undefined {
  if (!f.pkg) return undefined;
  const all = [f.pkg, ...(f.variants ?? [])];
  return all.find((p) => known.has(p)) ?? f.pkg;
}

/**
 * Every app either half knows about, joined on the package: the desktop's
 * Android modules, and this phone's app rows. `facts` null is "the desktop has
 * not answered" — the phone half still shows, and the repo half is not invented.
 * Blocked first (that is what somebody opened this to find), then by name.
 */
export function readiness(facts: readonly AppRepoFacts[] | null, rows: readonly AppRow[], ph: PhoneHalf): AppReadiness[] {
  const known = new Set<string>([
    ...rows.map((r) => r.pkg), ...ph.allow, ...ph.log.map((e) => e.pkg),
    ...Object.keys(ph.sources?.byPkg ?? {}),
  ]);
  const out: AppReadiness[] = [];
  const taken = new Set<string>();
  for (const f of facts ?? []) {
    const pkg = phonePkg(f, known);
    const row = pkg ? rows.find((r) => r.pkg === pkg) : undefined;
    const label = row?.label ?? ph.log.find((e) => e.pkg === pkg && e.label)?.label ?? f.repoName;
    const checks = repoChecks(f, ph.now, ph.ago);
    if (pkg) {
      taken.add(pkg);
      checks.push(...phoneChecks(pkg, label, ph, row));
    } else {
      checks.push({ id: "repo", half: "repo", state: "unknown", label: "package",
        text: `${f.module} names no literal applicationId, so this phone cannot tell which installed app it is.` });
    }
    out.push(finish({ pkg: pkg ?? f.module, label, repo: f.repoName, facts: f, row, checks }));
  }
  for (const row of rows) {
    if (taken.has(row.pkg)) continue;
    const checks: ReadyCheck[] = [{
      id: "repo", half: "repo", state: "unknown", label: "repo on this desktop",
      text: facts === null
        ? "The desktop has not answered yet."
        : `No repo on this desktop builds ${row.pkg}${row.repo ? ` (it came from ${row.repo} — another desktop, or an applicationId the desktop could not read)` : ""}.`,
    }, ...phoneChecks(row.pkg, row.label, ph, row)];
    out.push(finish({ pkg: row.pkg, label: row.label, repo: row.repo, row, checks }));
  }
  return out.sort((a, b) => (Number(!!b.blocker) - Number(!!a.blocker)) || a.label.localeCompare(b.label));
}

function finish(r: Omit<AppReadiness, "blocker">): AppReadiness {
  return { ...r, blocker: r.checks.find((c) => c.state === "no") };
}

/** The verdict line on a card. */
export function readinessVerdict(r: AppReadiness): string {
  if (r.blocker) return `not yet — ${r.blocker.label}`;
  if (r.checks.some((c) => c.state === "warn" || c.state === "unknown")) return "set up — with a caveat below";
  return "installs itself";
}

/** The split the pane's two chips filter by — ONE function for the number and the cut. */
export function readinessCut(rows: readonly AppReadiness[], cut: "all" | "blocked" | "ready"): AppReadiness[] {
  if (cut === "all") return [...rows];
  return rows.filter((r) => (cut === "blocked") === !!r.blocker);
}
