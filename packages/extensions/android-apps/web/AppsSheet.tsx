import { useEffect, useMemo, useState } from "react";
import {
  BellRing, Boxes, CircleAlert, CircleCheck, CircleHelp, CircleX, Download, FolderCog, Hammer, History,
  PackageCheck, PackagePlus, RotateCw, Settings, Trash2, X,
} from "lucide-react";
import {
  deviceId, enableBuilds, pluginClient, pullRules, setInstallAllow, shellInstall, useConnStatus, useCore, useInstallAllow,
  useInstallCaps, useInstallSources, usePullRecords, useStore,
} from "@waterplane/sdk";
import { ago, Button, Empty, Hint, hhmm, Row, RowSub, SetLine, SetNote, SheetHead, useRemoteResource } from "@waterplane/kit";
import type { AndroidAppsMethods } from "../shared/wire.mts";
import {
  appInstallVerb, appRows, installVerbText, appsSummary, appStateText, buildsOf, cleanupLabel, cleanupText, isPlayBuild, NO_INSTALL,
  readyApps, snoozeText, toggleAllow, type InstallCaps,
} from "./appRows.ts";
import { APPS_SHEET, installLog } from "./state.ts";
import { logDeviceName, readInstallLog, setLogDeviceName } from "./installLog.ts";
import { takeAppsCut, type AppsCut, type AppsPane } from "./appsPane.ts";
import { readiness, type AppReadiness, type CheckState } from "./appReady.ts";
import { appHeadline, appsCut, appSteps, fixFor, fixLabel, switchAlsoEnablesPull, type FixKind } from "./appSteps.ts";
import { InstallLogPane } from "./AppsHistory.tsx";

const client = pluginClient<AndroidAppsMethods>("android-apps");

/**
 * **Your repos' apps on this phone — one card per app, three steps each.**
 *
 * Getting a repo's Android app onto a phone and keeping it updated is a chain: the desktop BUILDS it
 * (a build button, its APK copied into the outbox), this phone DOWNLOADS it (the repo's auto-download
 * rule), and this phone INSTALLS it (install access, the app's switch, and the first install having
 * come from here). That chain used to be spread over the Build sheet, Downloads' rules, four tabs of
 * this screen and the repo's setup sheet, worded differently in each — and its author could not say
 * from here whether an app updates itself (owner, 2026-11-01, R-apk-021).
 *
 * So each app is ONE card: its three steps in the same words everywhere (`appSteps.ts`), a headline
 * saying whether it updates itself or which step stops it, and the fix for that step as a button on
 * the card — turning the repo's download rule on included, so nobody has to find Downloads › rules.
 * The checklist under it is the details (`appReady.ts`). The install history is the other tab.
 *
 * **It keeps no state of its own.** The switch is `waterplane.installAllow` (synced, mirrored into the
 * shell by `setInstallAllow`), the builds are `pull.ts`'s records, the repo half is
 * the `readiness` call on the host half. Every platform refusal is a SENTENCE with its Settings button, never a
 * dimmed switch (`Unavailable.tsx`).
 */
export function AppsSheet() {
  const c = useCore();
  const say = c.say;
  const onClose = () => c.nav.close(APPS_SHEET);
  const onOpenDownloads = () => c.nav.open("pull");
  /** The repo's Build sheet (by repo id). */
  const onOpenBuild = (repoId: string) => {
    const repo = c.world.repos.find((r) => r.id === repoId);
    if (repo) c.nav.openBuild(repo);
    else say.toast("that repo is not in this phone's list yet — open it once from the launcher");
  };
  /** The repo's setup checklist (by repo id). */
  const onOpenSetup = (repoId: string) => c.nav.openSetup(repoId, { region: "setup" });
  /** Turn the repo's auto-download rule on, keeping the rest of it; `done` is the toast. The one
   *  implementation (`enableBuilds`): never writes defaults over a rule nobody has read. */
  const onEnablePull = (repoDir: string, done: string) => enableBuilds(repoDir, done);
  /** Read a repo's current rule, so turning it on keeps what the person set. */
  const onAskPull = (repoDir: string) => { pullRules.ask(repoDir); };

  const records = usePullRecords();
  // This sheet is one of the restored overlays, so cold start is exactly when
  // these are read — `null` caps is "still asking", never "cannot install".
  const { caps, cleanup, setCleanup } = useInstallCaps();
  const allow = useInstallAllow();
  // The desktop's log of what every phone installed (`installLog.ts`), cached per host; the manifest's
  // `boot` read the cache (never a render: that read may set the store).
  const log = useStore(installLog);
  const status = useConnStatus();
  const live = status === "open";
  // Reporting on every connect and every download change is the manifest's `boot`
  // (`startInstallLog`), with or without this sheet. Opening it reads the log fresh.
  useEffect(() => { if (status === "open") void readInstallLog(); }, [status]);
  const [pane, setPane] = useState<AppsPane>("apps");
  const [cut, setCut] = useState<AppsCut>(takeAppsCut);
  const [open, setOpen] = useState<string | null>(null);
  // The phone's own name, held HERE rather than in the history pane: the pane
  // unmounts when you flip back, and a half-typed name is typed words.
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(() => logDeviceName());
  /** The history cut to one package or one device (a count on a control is a filter). */
  const [logCut, setLogCut] = useState<{ pkg?: string; deviceId?: string }>({});

  const res = useRemoteResource("apps:readiness", async () => {
    const r = await client.read("readiness", undefined);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });
  const facts = res.data?.apps ?? null;
  const known = caps ?? NO_INSTALL;
  const rows = appRows(buildsOf(records), allow, known, log.doc.entries);

  // Who installed each package — asked for every package EITHER half names,
  // flavors included. Unknown stays unknown.
  const pkgs = useMemo(() => {
    const s = new Set<string>(rows.map((r) => r.pkg));
    for (const f of facts ?? []) for (const p of [f.pkg, ...(f.variants ?? [])]) if (p) s.add(p);
    return [...s].sort();
  }, [rows, facts]);
  const sources = useInstallSources(pkgs, `${pkgs.join(",")}|${rows.map((r) => r.install ?? "").join(",")}`);

  // A repo whose download rule is OFF gets its rule read now, so the card's
  // "download by itself: on" keeps the person's patterns rather than writing defaults.
  const offRepos = (facts ?? []).filter((f) => !f.autoPull.enabled).map((f) => f.repoDir);
  useEffect(() => { for (const d of offRepos) onAskPull(d); }, [offRepos.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps -- asked once per set of repos

  const cards = readiness(facts, rows, { caps: known, allow, sources, log: log.doc.entries, me: deviceId(), now: Date.now(), ago });
  const waitingPkgs = new Set(readyApps(rows).map((r) => r.pkg));
  const waiting = appsCut(cards, { kind: "waiting" }, waitingPkgs);
  const shown = appsCut(cards, cut, waitingPkgs);

  const flip = (card: AppReadiness) => {
    const pkg = card.pkg;
    const next = toggleAllow(allow, pkg);
    const on = next.includes(pkg);
    setInstallAllow(next);
    say.track("action:apps.allow");
    // One switch for the whole automatic path: on, it also turns the repo's
    // downloads on when they are known off — a person's tap, said in the toast.
    if (on && switchAlsoEnablesPull(card) && card.facts) {
      onEnablePull(card.facts.repoDir, `${card.label}: new builds now download and install by themselves`);
      setTimeout(() => res.reload({ quiet: true }), 1500);
      return;
    }
    say.toast(on
      ? `${card.label}: new builds install by themselves`
      : `${card.label}: new builds wait for your tap`);
  };

  const fix = (kind: FixKind, card: AppReadiness) => {
    say.track(`action:apps.fix.${kind}`);
    const f = card.facts;
    switch (kind) {
      case "open-build": if (f) onOpenBuild(f.repoId); return;
      case "open-setup": if (f) onOpenSetup(f.repoId); return;
      case "enable-pull":
        if (f) { onEnablePull(f.repoDir, `${f.repoName}: new builds now download to this phone by themselves`); setTimeout(() => res.reload({ quiet: true }), 1500); }
        return;
      case "allow-access":
        void shellInstall.openSettings().catch(() => say.toast("this phone has no screen for that switch"));
        return;
      case "allow-app": flip(card); return;
    }
  };

  const play = isPlayBuild(known);
  const cutText = cut.kind === "waiting" ? "with a build waiting to install" : cut.kind === "repo" ? `from ${cut.repo}` : "";

  return (
    <div className="sheet">
      <SheetHead title={<><Boxes size={16} /> Android apps</>} onClose={onClose} />

      <div className="segmented">
        <button className={`seg ${pane === "apps" ? "on" : ""}`}
          onClick={() => { setPane("apps"); say.track("action:apps.pane.apps"); }}>
          <Boxes size={14} /> apps{cards.length ? ` · ${cards.length}` : ""}
        </button>
        <button className={`seg ${pane === "log" ? "on" : ""}`}
          onClick={() => { setPane("log"); setLogCut({}); say.track("action:apps.pane.log"); }}>
          <History size={14} /> history{log.doc.total ? ` · ${log.doc.total}` : ""}
        </button>
      </div>

      <div className="sheet-scroll">
      {pane === "log" ? (
        <InstallLogPane log={log} live={live} cut={logCut} onCut={setLogCut}
          naming={naming} draft={nameDraft} onNaming={setNaming} onDraft={setNameDraft}
          onName={(n) => setLogDeviceName(n, records)} />
      ) : (
      <>
        <Hint>
          Your repos' Android apps (APKs) on this phone, each in three steps: the desktop <b>builds</b> it,
          this phone <b>downloads</b> it, then <b>installs</b> it. A card says which steps happen by themselves, and has the fix for the first one that does not.{" "}
          <Button title="read the repos again"
            onClick={() => { res.reload({ quiet: true }); say.track("action:apps.reload"); say.toast("reading the repos again"); }}>
            <RotateCw size={14} /> re-read
          </Button>
        </Hint>

        {/* What this phone will allow at all — said once, above every card, with its Settings button. */}
        {caps !== null && (!caps.supported || !caps.canInstall || play) && (
          <Hint className="warn">
            {appsSummary(rows, caps)}
            {shellInstall.supported() && !caps.canInstall && (
              <> <Button title="open the phone's install-unknown-apps setting"
                onClick={() => { say.track("action:apps.settings"); void shellInstall.openSettings().catch(() => say.toast("this phone has no screen for that switch")); }}>
                <Settings size={14} /> allow installs
              </Button></>
            )}
          </Hint>
        )}

        {/* The list's controls, above it: the one filter, and the phone-wide clean-up switch. */}
        {(waiting.length > 0 || cut.kind === "waiting") && (
          <SetLine>
            <Button className={cut.kind === "waiting" ? "active" : ""}
              title="only the apps with a downloaded build that has not installed yet"
              onClick={() => { setCut(cut.kind === "waiting" ? { kind: "all" } : { kind: "waiting" }); say.track("action:apps.cut.waiting"); }}>
              <BellRing size={14} /> waiting to install · {waiting.length}
            </Button>
          </SetLine>
        )}
        {cut.kind !== "all" && (
          <Hint>
            {shown.length} of {cards.length} app{cards.length === 1 ? "" : "s"} · {cutText}{" "}
            <Button onClick={() => setCut({ kind: "all" })}><X size={14} /> show all</Button>
          </Hint>
        )}
        {caps?.supported && !play && cleanup !== undefined && (
          <SetLine>
            {cleanup !== null && (
              <Button className={cleanup ? "active" : ""}
                onClick={() => {
                  const next = !cleanup;
                  say.track("action:apps.cleanup");
                  void shellInstall.setCleanAfterInstall(next).then(() => {
                    setCleanup(next);
                    say.toast(next
                      ? "an installed build's APK will now be deleted from this phone"
                      : "installed builds keep their APK on this phone");
                  }).catch((e: unknown) => say.toast(e instanceof Error ? e.message : "could not change it"));
                }}><Trash2 size={14} /> {cleanupLabel(cleanup)}</Button>
            )}
            <SetNote as="span">{cleanupText(cleanup)}</SetNote>
          </SetLine>
        )}

        <div className="list">
          {caps === null && <Hint>Asking this phone what it will allow…</Hint>}
          {facts === null && cards.length === 0 && (
            <Empty res={res} thing="the desktop's repos">Asking the desktop which repos build an Android app…</Empty>
          )}
          {facts !== null && cards.length === 0 && (
            <Empty res={res}>
              No repo on this desktop builds an Android app, and no app has been downloaded to this phone.
              A repo with an Android module gets a card here by itself.
            </Empty>
          )}
          {cards.length > 0 && shown.length === 0 && (
            <Empty>{cut.kind === "waiting"
              ? "Every build on this phone is installed. A new one shows here, and in a notification, when it arrives."
              : `No app from ${cut.kind === "repo" ? cut.repo : "here"} yet — this repo has no Android module the desktop could read.`}</Empty>
          )}
          {shown.map((card) => {
            const id = `${card.repo ?? ""}:${card.pkg}`;
            return (
              <AppCard key={id} card={card} caps={known} open={open === id}
                onToggle={() => setOpen(open === id ? null : id)}
                onFlip={() => flip(card)} onFix={(k) => fix(k, card)}
                logged={log.doc.entries.filter((e) => e.pkg === card.pkg).length}
                onOpenLog={() => { setPane("log"); setLogCut({ pkg: card.pkg }); say.track("action:apps.rowlog"); }}
                onOpenDownloads={onOpenDownloads} />
            );
          })}
        </div>
      </>
      )}
      </div>
    </div>
  );
}

const ICON: Record<CheckState, typeof CircleCheck> = {
  ok: CircleCheck, no: CircleX, warn: CircleAlert, unknown: CircleHelp,
};
// closed: the check state is computed on the phone (`appReady.ts`)
const CLS: Record<CheckState, string> = { ok: "pass", no: "fail", warn: "warn", unknown: "ignored" };
const FIX_ICON: Record<FixKind, typeof Hammer> = {
  "open-build": Hammer, "open-setup": FolderCog, "enable-pull": Download, "allow-access": Settings, "allow-app": PackageCheck,
};

/**
 * One app. Closed: the headline, the three steps (one line each) and the verbs. A tap on the card
 * opens every checklist line under its step — it toggles nothing else; the switch is its own button.
 */
function AppCard({ card, caps, open, onToggle, onFlip, onFix, logged, onOpenLog, onOpenDownloads }: {
  card: AppReadiness; caps: InstallCaps; open: boolean; onToggle: () => void;
  onFlip: () => void; onFix: (k: FixKind) => void; logged: number; onOpenLog: () => void; onOpenDownloads: () => void;
}) {
  const say = useCore().say;
  const steps = appSteps(card);
  const fixKind = fixFor(card);
  const row = card.row;
  const verb = row ? appInstallVerb(row, caps) : null;
  const state = row ? appStateText(row) : null;
  const snoozed = row ? snoozeText(row, Date.now(), hhmm) : null;
  const play = isPlayBuild(caps);
  const allowed = card.checks.find((c) => c.id === "switch")?.state === "ok";
  const headState: CheckState = card.blocker ? "no" : steps.some((s) => s.state === "warn") ? "warn" : "ok";
  const HeadIcon = ICON[headState];
  return (
    <div className={`check-row check-${CLS[headState]}`}>
      <Row as="button" kind="grow" title={open ? "hide the details" : "show every check under each step"} onClick={onToggle}>
        <span className="check-top">
          <span className="check-icon"><HeadIcon size={16} /></span>
          <span className="check-label">{card.label}</span>
          <span className="check-kind">{open ? "hide" : "details"}</span>
        </span>
        <RowSub className="mono">{card.pkg}{row?.version ? ` · ${row.version}` : ""}{card.repo ? ` · ${card.repo}` : ""}</RowSub>
        <RowSub className={card.blocker ? "warn" : undefined}>{appHeadline(card)}</RowSub>
        {state && <RowSub className={row?.install === "failed" ? "warn" : "dim"}>{state}</RowSub>}
        {snoozed && <RowSub className="dim">{snoozed}</RowSub>}
        {row?.repeat && <RowSub className="warn">{row.repeat}</RowSub>}
      </Row>
      <ol className="check-list app-steps">
        {steps.map((s, i) => {
          const I = ICON[s.state];
          return (
            <li key={s.id} className={`check-row check-${CLS[s.state]}`}>
              <span className="check-top">
                <span className="check-icon"><I size={14} /></span>
                <span className="check-label">{i + 1} · {s.title}</span>
              </span>
              <span className="check-detail">{s.text}</span>
              {open && s.checks.length > 1 && (
                <ul className="check-list">
                  {s.checks.map((c) => {
                    const C = ICON[c.state];
                    return (
                      <li key={c.id} className={`check-row check-${CLS[c.state]}`}>
                        <span className="check-top">
                          <span className="check-icon"><C size={12} /></span>
                          <span className="check-label">{c.label}</span>
                        </span>
                        <span className="check-detail">{c.text}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <div className="row-acts pull-acts">
        {fixKind && (() => {
          const F = FIX_ICON[fixKind];
          return (
            <Button variant="primary" title={card.blocker?.text} onClick={() => onFix(fixKind)}>
              <F size={16} /> {fixLabel(fixKind)}
            </Button>
          );
        })()}
        {verb && row && (
          <Button variant={fixKind ? undefined : "primary"} title={verb.label}
            onClick={() => {
              say.track("action:apps.install");
              void shellInstall.install(verb.id).catch((e: unknown) => say.toast(e instanceof Error ? e.message : "could not start the install"));
            }}>
            {row.install === "failed" ? <RotateCw size={16} /> : <PackagePlus size={16} />}
            {row.install === "failed" ? installVerbText(row.install, row.installError) : `install ${row.version || "this build"}`}
          </Button>
        )}
        {/* The switch, when it is not already the fix button above. */}
        {caps.supported && !play && fixKind !== "allow-app" && (
          <Button className={allowed ? "active" : ""}
            title={allowed ? `stop installing ${card.label} by itself` : `install ${card.label} by itself`}
            onClick={onFlip}><PackageCheck size={16} /> install by itself: {allowed ? "on" : "off"}</Button>
        )}
        {card.blocker?.id === "pull" && card.facts?.autoPull.enabled && (
          <Button title="the rule is on but does not take this APK — change it under Downloads › rules"
            onClick={onOpenDownloads}><Download size={16} /> download rules</Button>
        )}
        {/* A COUNT ON A CONTROL opens exactly what it counted: this app's history rows. */}
        {logged > 0 && (
          <Button title={`everything the history holds about ${card.label}, on every phone`}
            onClick={onOpenLog}><History size={16} /> {logged} in history</Button>
        )}
      </div>
    </div>
  );
}
