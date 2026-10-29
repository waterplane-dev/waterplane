import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, ExternalLink, GitMerge, GitPullRequest, Loader, X } from "lucide-react";
import type { BranchRules, MergeMethod, PrActionResult, PrListDoc, PullRequestView } from "@waterplane/shared";
import { api } from "./api";
import { Empty } from "./Empty";
import { ConfirmButton } from "./Confirm";
import { CantInline } from "./Unavailable";
import { Button, Hint } from "./kit";
import { openExternal } from "./openExternal";
import { showToast } from "./toast";
import { LEASE_RENEW_MS, checksState, checksWords, mergeMethod, reviewWords } from "./prCardLogic";

/** One failing check's log (or its page), shown under the card until closed. */
interface LogView { title: string; text: string }

function CheckIcon({ state }: { state: "none" | "failed" | "running" | "passed" }) {
  if (state === "failed") return <CircleX size={14} />;
  if (state === "running") return <Loader size={14} className="spin" />;
  return <CircleCheck size={14} />;
}

/**
 * The person's open PRs in a PR-mode repo. Mounted by GitView only behind `cardVisible`, so a lease
 * exists exactly while this component does: POST on mount, again every 30 s, stopped on unmount.
 */
export function PrCard({ repoId, rules }: { repoId: string; rules: BranchRules }) {
  const [doc, setDoc] = useState<PrListDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [log, setLog] = useState<LogView | null>(null);
  const [method, setMethod] = useState<MergeMethod | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const holder = useRef(`phone-${Math.random().toString(36).slice(2)}`);

  const lease = useCallback(async () => {
    try { setDoc(await api.prLease(repoId, holder.current)); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }, [repoId]);
  useEffect(() => {
    void lease();
    const t = setInterval(() => { void lease(); }, LEASE_RENEW_MS);
    return () => clearInterval(t);
  }, [lease]);

  /** Run one action and say what came back, in a toast and in the note. */
  async function act(key: string, run: () => Promise<PrActionResult>, fallback: string) {
    setBusy(key);
    try {
      const r = await run();
      const words = r.ok ? (r.output ?? fallback) : (r.error ?? "The desktop refused.");
      setNote(words);
      showToast(words.split("\n")[0]);
      setTimeout(() => { void lease(); }, 1500);
    } catch (e) {
      const words = `Did not reach the desktop: ${(e as Error).message}`;
      setNote(words);
      showToast(words);
    }
    setBusy(null);
  }

  async function openLog(pr: PullRequestView, name: string, url?: string) {
    setBusy(`log-${pr.number}-${name}`);
    try {
      const r = await api.prLog(repoId, pr.number, name);
      if (r.ok && r.output) setLog({ title: `${name} · #${pr.number}`, text: r.output });
      else if (r.url ?? url) { if (!openExternal((r.url ?? url)!)) showToast("That check's page is not a web link."); }
      else setNote(r.error ?? `No log came back for ${name}.`);
    } catch (e) {
      setNote(`Did not reach the desktop: ${(e as Error).message}`);
    }
    setBusy(null);
  }

  const prs = doc?.prs;
  const allowed = rules.allowedMerge;
  const use = mergeMethod(rules, method);
  return (
    <div className="pr-card">
      <div className="pr-head"><GitPullRequest size={14} /> Pull requests{prs ? ` · ${prs.length}` : ""}</div>
      {allowed.length > 1 && (
        <div className="sheet-actions pr-methods">
          <span className="pr-meta">merge by</span>
          {allowed.map((m) => (
            <Button key={m} className={m === use ? "active" : ""} onClick={() => setMethod(m)}>{m}</Button>
          ))}
        </div>
      )}
      {doc?.why && !prs && <Hint tone="warn">{doc.why}</Hint>}
      <Empty res={{ state: err ? "error" : doc ? "fresh" : "loading", error: err }} empty={!prs || prs.length === 0} thing="your pull requests" noun="pull requests">
        {doc?.why ? null : "No open pull requests of yours here. Push from a branch to open one."}
      </Empty>
      {prs?.map((pr) => {
        const cs = checksState(pr.checks);
        const review = reviewWords(pr.reviewDecision);
        return (
          <div key={pr.number} className="pr-row">
            <div className="pr-title">#{pr.number} {pr.title}</div>
            <div className="pr-meta mono">{pr.headRefName}{review ? ` · ${review}` : ""}</div>
            <div className={`pr-checks ${cs}`}>
              <CheckIcon state={cs} /> {checksWords(pr.checks)}
            </div>
            {pr.checks.filter((c) => c.state === "failed").map((c) => (
              <Button key={c.name} className="pr-failed" title={`read why ${c.name} failed`} onClick={() => { void openLog(pr, c.name, c.url); }}>
                <CircleX size={14} /> {c.name}{busy === `log-${pr.number}-${c.name}` ? " …" : ""}
              </Button>
            ))}
            <div className="sheet-actions">
              <Button variant="primary" title={pr.blockedBy ?? `merge #${pr.number}`}
                onClick={() => {
                  if (pr.blockedBy) { setNote(pr.blockedBy); showToast(pr.blockedBy); return; }
                  void act(`merge-${pr.number}`, () => api.prMerge(repoId, pr.number, use), "Merged.");
                }}>
                <GitMerge size={14} /> {busy === `merge-${pr.number}` ? "merging…" : use ? `Merge (${use})` : "Merge"}
              </Button>
              {rules.autoMerge && (
                <Button title="merge by itself once every check is green" onClick={() => { void act(`auto-${pr.number}`, () => api.prAutoMerge(repoId, pr.number, !pr.autoMerge), pr.autoMerge ? "Merge when green is off." : "Merge when green is on."); }}>
                  Merge when green: {pr.autoMerge ? "on" : "off"}
                </Button>
              )}
              <Button title="open this pull request on GitHub" onClick={() => { if (!openExternal(pr.url)) showToast("That link is not a web link."); }}>
                <ExternalLink size={14} /> Open on GitHub
              </Button>
              <ConfirmButton title={`close #${pr.number} without merging`} confirmTitle={`tap again to close #${pr.number}`}
                confirm={<><X size={14} /> sure?</>}
                onConfirm={() => { void act(`close-${pr.number}`, () => api.prClose(repoId, pr.number), "Closed.") }}>
                <X size={14} /> Close
              </ConfirmButton>
            </div>
            {pr.blockedBy && <CantInline>{pr.blockedBy}</CantInline>}
            {pr.autoMerge && <Hint>Merge when green is on: it merges itself once the checks pass.</Hint>}
          </div>
        );
      })}
      {log && (
        <div className="pr-log">
          <div className="sheet-actions"><span className="pr-meta">{log.title}</span><Button title="close the log" onClick={() => setLog(null)}><X size={14} /></Button></div>
          <pre className="git-push-tail">{log.text}</pre>
        </div>
      )}
      {note && <Hint className="git-note">{note}</Hint>}
    </div>
  );
}
