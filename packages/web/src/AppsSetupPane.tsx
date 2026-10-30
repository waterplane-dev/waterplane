import { useEffect, useMemo, useState } from "react";
import { CircleAlert, CircleCheck, CircleHelp, CircleX, Download, PackageCheck, RotateCw, Settings, X } from "lucide-react";
import type { InstallLogEntry } from "@waterplane/shared";

import { api } from "./api";
import { Empty } from "./Empty";
import { track } from "./usage";
import { showToast } from "./toast";
import { agoText } from "./format";
import { useRemoteResource } from "./useRemoteResource";
import { installSources, openInstallSettings } from "./nativeInstall";
import { readiness, readinessCut, readinessVerdict, type AppReadiness, type CheckState } from "./appReady";
import type { AppRow, InstallCaps, InstallSources } from "./installPolicy";
import { Button } from "./kit/Button";
import { Row, RowSub } from "./kit/Row";
import { Hint } from "./kit/Hint";
import { SetLine } from "./SettingsKit";

/**
 * **Which apps are set up to install themselves** — the Apps screen's `setup`
 * pane. One card per app, the desktop's half (build command, outbox, key,
 * targetSdk, auto-download) over this phone's half (install access, the switch,
 * who owns its updates, the last attempt HERE), the first `no` named as what to
 * fix next. The checklist is `appReady.ts`; this only draws it.
 *
 * Reads; changes nothing on its own. The two verbs it offers are the ones the
 * Apps screen already has (the switch, the Settings screen) and Downloads for
 * the auto-download rule — a repo's own setup is in that repo's setup sheet,
 * named in the line that needs it.
 */
export function AppsSetupPane({ rows, caps, allow, log, me, onFlip, onOpenDownloads }: {
  rows: readonly AppRow[];
  caps: InstallCaps;
  allow: readonly string[];
  log: readonly InstallLogEntry[];
  me: string;
  onFlip: (pkg: string) => void;
  onOpenDownloads: () => void;
}) {
  const res = useRemoteResource("apps:readiness", () => api.appReadiness());
  const facts = res.data?.apps ?? null;
  const [cut, setCut] = useState<"all" | "blocked" | "ready">("all");
  const [open, setOpen] = useState<string | null>(null);

  // Who installed each package — asked for every package EITHER half names,
  // flavors included: the apps list only asks about apps with a build here.
  const pkgs = useMemo(() => {
    const s = new Set<string>(rows.map((r) => r.pkg));
    for (const f of facts ?? []) for (const p of [f.pkg, ...(f.variants ?? [])]) if (p) s.add(p);
    return [...s].sort();
  }, [rows, facts]);
  const [sources, setSources] = useState<InstallSources | null>(null);
  useEffect(() => {
    let live = true;
    void installSources(pkgs).then((s) => { if (live) setSources(s); });
    return () => { live = false; };
  }, [pkgs.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps -- `pkgs` is a fresh array whenever `rows`/`facts` move; its joined value is the identity, so the same set of packages is not asked again

  const all = readiness(facts, rows, { caps, allow, sources, log, me, now: Date.now(), ago: agoText });
  const blocked = readinessCut(all, "blocked");
  const ready = readinessCut(all, "ready");
  const shown = readinessCut(all, cut);

  return (
    <>
      <Hint>
        Each app's whole chain for a build to install by itself — the desktop's half (from its repo) and this phone's.
        The first line marked <CircleX size={12} /> is what to fix next.{" "}
        <Button title="read the repos again"
          onClick={() => { res.reload({ quiet: true }); track("action:apps.setup.reload"); showToast("reading the repos again"); }}>
          <RotateCw size={14} /> re-read
        </Button>
      </Hint>

      {/* Two chips, each a filter that opens exactly what it counts. */}
      {all.length > 0 && (
        <SetLine>
          <Button className={cut === "blocked" ? "active" : ""}
            onClick={() => { setCut(cut === "blocked" ? "all" : "blocked"); track("action:apps.setup.blocked"); }}>
            <CircleX size={14} /> not yet · {blocked.length}
          </Button>
          <Button className={cut === "ready" ? "active" : ""}
            onClick={() => { setCut(cut === "ready" ? "all" : "ready"); track("action:apps.setup.ready"); }}>
            <CircleCheck size={14} /> set up · {ready.length}
          </Button>
        </SetLine>
      )}
      {cut !== "all" && (
        <Hint>
          {shown.length} of {all.length} · {cut === "blocked" ? "not yet set up" : "set up"}{" "}
          <Button onClick={() => setCut("all")}><X size={14} /> show all</Button>
        </Hint>
      )}

      <div className="list">
        {facts === null && (
          <Empty res={res} thing="the desktop's repos">
            Asking the desktop which repos build an Android app…
          </Empty>
        )}
        {facts !== null && all.length === 0 && (
          <Empty res={res}>
            No repo on this desktop builds an Android app, and no app has been downloaded to this phone.
          </Empty>
        )}
        {shown.map((r) => (
          <ReadyCard key={`${r.repo ?? ""}:${r.pkg}`} r={r}
            open={open === `${r.repo ?? ""}:${r.pkg}`}
            onToggle={() => setOpen(open === `${r.repo ?? ""}:${r.pkg}` ? null : `${r.repo ?? ""}:${r.pkg}`)}
            onFlip={() => onFlip(r.pkg)} onOpenDownloads={onOpenDownloads} />
        ))}
      </div>
    </>
  );
}

const ICON: Record<CheckState, typeof CircleCheck> = {
  ok: CircleCheck, no: CircleX, warn: CircleAlert, unknown: CircleHelp,
};
// closed: the check state is computed on the phone (`appReady.ts`)
const CLS: Record<CheckState, string> = { ok: "pass", no: "fail", warn: "warn", unknown: "ignored" };

/** One app. Closed it is the verdict and, where there is one, the blocker in
 *  full — the one line somebody opened this screen for. Open it is every line. */
function ReadyCard({ r, open, onToggle, onFlip, onOpenDownloads }: {
  r: AppReadiness; open: boolean; onToggle: () => void; onFlip: () => void; onOpenDownloads: () => void;
}) {
  const b = r.blocker;
  const state: CheckState = b ? "no" : r.checks.some((c) => c.state === "warn") ? "warn" : "ok";
  const Icon = ICON[state];
  return (
    <div className={`check-row check-${CLS[state]}`}>
      <Row as="button" kind="grow" title={open ? "hide the checklist" : "show every line of the checklist"} onClick={onToggle}>
        <span className="check-top">
          <span className="check-icon"><Icon size={16} /></span>
          <span className="check-label">{r.label}</span>
          <span className="check-kind">{open ? "hide" : `${r.checks.filter((c) => c.state === "ok").length}/${r.checks.length}`}</span>
        </span>
        <RowSub className="mono">{r.pkg}{r.repo ? ` · ${r.repo}` : ""}</RowSub>
        <RowSub className={b ? "warn" : undefined}>{readinessVerdict(r)}</RowSub>
        {!open && b && <span className="check-detail">{b.text}</span>}
      </Row>
      {open && (
        <ul className="check-list">
          {(["repo", "phone"] as const).map((half) => {
            const lines = r.checks.filter((c) => c.half === half);
            if (!lines.length) return null;
            return [
              <li key={half} className="check-kind">{half === "repo" ? "on the desktop" : "on this phone"}</li>,
              ...lines.map((c) => {
                const I = ICON[c.state];
                return (
                  <li key={c.id} className={`check-row check-${CLS[c.state]}`}>
                    <span className="check-top">
                      <span className="check-icon"><I size={14} /></span>
                      <span className="check-label">{c.label}</span>
                    </span>
                    <span className="check-detail">{c.text}</span>
                  </li>
                );
              }),
            ];
          })}
        </ul>
      )}
      {/* The verbs this screen already owns, offered where the blocker is theirs. */}
      {b && (b.id === "switch" || b.id === "access" || b.id === "pull") && (
        <div className="row-acts pull-acts">
          {b.id === "switch" && (
            <Button variant="primary" title={`always install ${r.label}`}
              onClick={() => { track("action:apps.setup.allow"); onFlip(); }}>
              <PackageCheck size={16} /> auto-install: on
            </Button>
          )}
          {b.id === "access" && (
            <Button variant="primary" title="open the phone's install-unknown-apps setting"
              onClick={() => {
                track("action:apps.setup.settings");
                void openInstallSettings().catch(() => showToast("this phone has no screen for that switch"));
              }}><Settings size={16} /> allow it</Button>
          )}
          {b.id === "pull" && (
            <Button variant="primary" title="the auto-download rule lives in Downloads"
              onClick={() => { track("action:apps.setup.downloads"); onOpenDownloads(); }}>
              <Download size={16} /> downloads
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
