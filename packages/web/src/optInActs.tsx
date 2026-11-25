/**
 * What the two screens that list opt-ins do on a tap, once: the Opt-ins region (`OptInRegion.tsx`) and
 * the set-up page (`features/repoSetup`). Doors onto the screen that already does a job, and the
 * download rule's write with its "never over a rule this phone has not read" half.
 */
import { useEffect } from "react";
import { Activity, Boxes, CalendarClock, Download, Link2, Send, Wrench } from "lucide-react";
import type { OptInAction, OptInReport, RepoTarget } from "@waterplane/shared";
import { track } from "./usage";
import { core } from "./core/api";
import { enableBuilds, pullRules, useAppsDoor, useOptInDoor } from "./sdk";
import { CantInline } from "./Unavailable";
import { Button } from "./kit/Button";

/** One icon per meaning: the verb's glyph says what kind of tap it is. */
export function optInVerbIcon(a: OptInAction) {
  switch (a.kind) {
    case "fix": return <Wrench size={14} />;
    case "open": return a.to === "series" ? <Activity size={14} /> : a.to === "links" ? <Link2 size={14} /> : <Boxes size={14} />;
    case "download": return <Download size={14} />;
    case "agent": return <Send size={14} />;
    case "schedule": return <CalendarClock size={14} />;
  }
}

/** The report as it may be cached: the one-shot confirm tokens stay out of this phone's storage. */
export function untokened({ confirm: _tokens, ...report }: OptInReport): OptInReport {
  return report;
}

/** `enableBuilds` never writes over a rule this phone has not read: ask for it while its row is up. */
export function useAskedDownloadRule(dir: string | undefined, asks: boolean): void {
  useEffect(() => { if (dir && asks) pullRules.ask(dir); }, [dir, asks]);
}

/** Turn this repo's downloads on, the rest of its rule kept. The toast is the receipt. */
export function turnDownloadsOn(repo: Pick<RepoTarget, "worktreePath" | "repoName">): "asked" | "saved" | "unsent" {
  track("action:optins.download");
  return enableBuilds(repo.worktreePath, `${repo.repoName}: new builds now download to this phone by themselves`);
}

/** The door of an `open` offer, or of a download whose rule leaves the file out (its patterns are the
 *  person's, so they are opened, never edited). A door this desktop has not got is a sentence. */
export function OptInDoor({ action: a, label, repo, onSeries }: {
  action: Extract<OptInAction, { kind: "open" | "download" }>;
  label: string;
  repo: RepoTarget | null;
  onSeries: () => void;
}) {
  const apps = useAppsDoor();
  const links = useOptInDoor("links");
  if (a.kind === "download") {
    return <Button onClick={() => { track("action:optins.downloads"); core().nav.open("pull"); }}>{optInVerbIcon(a)} {label}</Button>;
  }
  if (a.to === "series") {
    return <Button onClick={() => { track("action:optins.series"); onSeries(); }}>{optInVerbIcon(a)} {label}</Button>;
  }
  if (a.to === "links") {
    if (!links) return <CantInline>The links extension is off on this desktop. Switch it on under Settings › Plugins.</CantInline>;
    if (repo) return <Button onClick={() => { track("action:optins.links"); links(repo.repoName); }}>{optInVerbIcon(a)} {label}</Button>;
  }
  if (!repo || !apps) return <CantInline>The extension that installs apps is off on this desktop. Switch it on under Settings › Plugins.</CantInline>;
  return <Button onClick={() => { track("action:optins.apps"); apps.open({ kind: "repo", repo: repo.repoName }); }}>{optInVerbIcon(a)} {label}</Button>;
}
