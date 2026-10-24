/**
 * Build your first app: three questions, one consent screen, a checklist, a hand-off
 * (`docs/analysis/first-app-plan.md`, "The journey", WP7).
 *
 * Nothing starts before Go: the questions and the plan are reads, and Go sends EXACTLY the ticks
 * of the lines the host listed (`consentToSend`). No control is greyed: a step that cannot be
 * taken yet replaces its button with the sentence saying why (`questionsBlocker`, `goBlocker`).
 * Every step's words are the host's; the phone adds the order, the icons and the fixes.
 */
import { useEffect, useRef, useState } from "react";
import {
  AppWindow, Check, CheckSquare, Circle, ExternalLink, Hammer, Loader, MessageSquare, MinusCircle, OctagonAlert,
  Rocket, Smartphone, Square, Terminal as TerminalIcon,
} from "lucide-react";
import type { OnboardConsent, OnboardJob, OnboardPath, OnboardPlan } from "@waterplane/shared";
import { Sheet } from "../../Sheet";
import { useNow } from "../../useNow";
import { openExternal } from "../../openExternal";
import { nativeInstallSupported } from "../../nativeInstall";
import { core, useBackStep, useStore } from "../../sdk";
import {
  closeOnboard, fetchPlan, forgetStartedHere, installSwitchOff, openArtifactOf, openInstallSwitch, openNewSession,
  refreshJob, resumeJob, startJob,
} from "./actions";
import { jobStore, startedHereStore, useOnboardJob } from "./store";
import {
  INSTALL_SWITCH_OFF, answersFrom, artifactFile, checklist, consentRows, consentToSend, defaultPath, fixLabel, goBlocker,
  initialTicks, plannedSteps, progressHead, questionsBlocker, suggestName, type CheckIcon, type CheckRow, type ConsentRow,
} from "./logic";
import { Button } from "../../kit";
import { SetNote } from "../../SettingsKit";

type Stage = "questions" | "consent" | "progress";

interface Answers { name: string; path: OnboardPath; describe: boolean; description: string; setup: boolean }

export function OnboardSheet() {
  const job = useOnboardJob();
  const startedHere = useStore(startedHereStore);
  // Opened before the host was asked (a cold start straight onto the card): ask now.
  useEffect(() => { if (jobStore.get() === undefined) void refreshJob(); }, []);
  const canInstall = nativeInstallSupported();
  const live = !!job && (job.state !== "done" || job.id === startedHere);
  const [stage, setStage] = useState<Stage>(live ? "progress" : "questions");
  const [answers, setAnswers] = useState<Answers>(() => ({
    name: suggestName(), path: defaultPath(canInstall), describe: false, description: "", setup: true,
  }));
  const [plan, setPlan] = useState<OnboardPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The job read arrived after the sheet opened: a running or stopped one is the screen.
  const decided = useRef(job !== undefined);
  useEffect(() => {
    if (decided.current || job === undefined) return;
    decided.current = true;
    if (job && (job.state !== "done" || job.id === startedHere)) setStage("progress");
  }, [job, startedHere]);
  // A job that starts elsewhere (another phone) while the questions are up: show it.
  useEffect(() => { if (job && job.state === "running" && stage !== "progress") setStage("progress"); }, [job, stage]);
  // Back (and the swipe) from the consent screen is its Cancel: back to the questions, not out.
  useBackStep(stage === "consent", () => { setStage("questions"); setError(null); });

  const readPlan = async (a: Answers) => {
    setBusy(true); setError(null);
    const p = await fetchPlan(answersFrom(a));
    setBusy(false);
    if (!("steps" in p)) { setError(p.error); return; }
    setPlan(p); setStage("consent");
  };

  const title = stage === "progress" && job ? job.name : "Build your first app";
  const icon = <Rocket size={18} />;

  if (stage === "progress" && job) {
    return (
      <Sheet title={title} icon={icon} onClose={closeOnboard}>
        <Progress job={job} onAnother={() => { forgetStartedHere(); setPlan(null); setAnswers((a) => ({ ...a, name: suggestName() })); setStage("questions"); }} />
      </Sheet>
    );
  }
  if (stage === "consent" && plan) {
    return (
      <Consent plan={plan} canInstall={canInstall} title={title} icon={icon}
        onBack={() => { setStage("questions"); setError(null); }}
        onWeb={() => { const a = { ...answers, path: "web" as const }; setAnswers(a); void readPlan(a); }}
        onStarted={() => setStage("progress")} />
    );
  }
  const blocker = questionsBlocker(answers);
  const set = (patch: Partial<Answers>) => { setAnswers((a) => ({ ...a, ...patch })); setError(null); };
  return (
    <Sheet title={title} icon={icon} onClose={closeOnboard}
      footer={blocker ? <span className="onb-why">{blocker}</span> : (
        <button className="send onb-next" onClick={() => void readPlan(answers)}>
          {busy ? <><Loader size={14} className="spin" /> asking the desktop…</> : "Next: see what this will do"}
        </button>
      )}>
      <div className="sheet-scroll">
        <div className="set-group">
          <div className="onb-q">What is it called?</div>
          <input className="search onb-name" value={answers.name} onChange={(e) => set({ name: e.target.value })}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="app name" />
          <SetNote>It becomes a new folder on your desktop, under the host root.</SetNote>
        </div>
        <div className="set-group">
          <div className="onb-q">What should it do?</div>
          <div className="onb-choice">
            <Button className={!answers.describe ? "active" : ""} onClick={() => set({ describe: false })}>plain hello world</Button>
            <Button className={answers.describe ? "active" : ""} onClick={() => set({ describe: true })}>describe it</Button>
          </div>
          {answers.describe && (
            <input className="search" placeholder="one line: what should the app do?" value={answers.description}
              onChange={(e) => set({ description: e.target.value })} aria-label="description" />
          )}
          <SetNote>
            {answers.describe
              ? "The hello world is built first, so the tools are proven; then your line is the new session's first prompt."
              : "A working hello world, built from a template. Changing it is your first prompt."}
          </SetNote>
        </div>
        <div className="set-group">
          <div className="onb-q">Where does it run?</div>
          <div className="onb-choice">
            <Button className={answers.path === "android" ? "active" : ""} onClick={() => set({ path: "android" })}>
              <Smartphone size={14} /> phone app (Android)
            </Button>
            <Button className={answers.path === "web" ? "active" : ""} onClick={() => set({ path: "web" })}>
              <AppWindow size={14} /> web page
            </Button>
          </div>
          <SetNote>
            {answers.path === "android"
              ? "Needs the Android build tools on the desktop; the next screen says what is missing before anything is downloaded."
              : "Needs nothing installed. The page opens in the gallery here."}
          </SetNote>
        </div>
        <div className="set-group">
          <Button className={`onb-tick${answers.setup ? " active" : ""}`} onClick={() => set({ setup: !answers.setup })}>
            {answers.setup ? <CheckSquare size={14} /> : <Square size={14} />} set this repo up for the phone (recommended)
          </Button>
          <SetNote>The setup checklist's one-tap fixes, run as one step.</SetNote>
        </div>
        {error && <div className="set-group"><SetNote className="warn" role="alert">{error}</SetNote></div>}
      </div>
    </Sheet>
  );
}

function Consent({ plan, canInstall, title, icon, onBack, onWeb, onStarted }: {
  plan: OnboardPlan; canInstall: boolean; title: string; icon: React.ReactNode;
  onBack(): void; onWeb(): void; onStarted(): void;
}) {
  const rows = consentRows(plan, canInstall);
  const [ticks, setTicks] = useState<OnboardConsent>(() => initialTicks(rows));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocker = goBlocker(rows, ticks);
  const go = async () => {
    setBusy(true); setError(null);
    const r = await startJob({ name: plan.name, path: plan.path, ...(plan.firstPrompt ? { description: plan.firstPrompt } : {}), setup: plan.steps.some((s) => s.id === "setup" && s.needed) }, consentToSend(rows, ticks), plan.confirm);
    setBusy(false);
    if ("error" in r) { setError(r.error); return; }
    onStarted();
  };
  const footer = (
    <>
      <Button className="onb-cancel" onClick={onBack}>Cancel</Button>
      {blocker ? <span className="onb-why">{blocker}</span> : (
        <button className="send onb-go" onClick={() => void go()}>
          {busy ? <><Loader size={14} className="spin" /> starting…</> : <><Rocket size={14} /> Go</>}
        </button>
      )}
    </>
  );
  return (
    <Sheet title={title} icon={icon} onClose={onBack} footer={footer}>
      <div className="sheet-scroll">
        <div className="set-group">
          <div className="onb-q">{plan.path === "android" ? "A phone app" : "A web page"} called {plan.name}</div>
          <SetNote>
            Go allows exactly what is ticked below, and nothing else. Nothing is downloaded, created or
            installed before you tap it. Cancel goes back to the questions.
          </SetNote>
        </div>
        {plan.signIn && <div className="set-group"><SetNote className="warn" role="status">{plan.signIn}</SetNote></div>}
        <div className="set-group onb-lines">
          {rows.map((r) => <ConsentLine key={r.id} row={r} on={ticks[r.id] === true}
            onToggle={() => setTicks((t) => ({ ...t, [r.id]: t[r.id] === true ? false : true }))}
            onWeb={r.id === "toolchain" ? onWeb : undefined} />)}
        </div>
        <div className="set-group">
          <div className="onb-q">Then, in order</div>
          <ol className="onb-steps">{plannedSteps(plan).map((w, i) => <li key={i}>{w}</li>)}</ol>
        </div>
        {error && <div className="set-group"><SetNote className="warn" role="alert">{error}</SetNote></div>}
      </div>
    </Sheet>
  );
}

function ConsentLine({ row, on, onToggle, onWeb }: { row: ConsentRow; on: boolean; onToggle(): void; onWeb?: () => void }) {
  return (
    <div className={`onb-line${row.required ? " needed" : ""}`} data-line={row.id}>
      {row.cant ? (
        <div className="onb-line-what"><MinusCircle size={16} /> <span>{row.what}</span></div>
      ) : (
        <button className={`onb-line-what onb-tick${on ? " active" : ""}`} onClick={onToggle} aria-pressed={on}>
          {on ? <CheckSquare size={16} /> : <Square size={16} />} <span>{row.what}</span>
        </button>
      )}
      <div className="onb-line-facts">
        <span className="onb-tag">{row.required ? "needed" : "optional"}</span>
        {row.where && <span className="mono">{row.where}</span>}
        {row.size && <span>{row.size}</span>}
      </div>
      {row.cant && <SetNote>{row.cant}</SetNote>}
      {(row.link || onWeb) && (
        <div className="onb-line-acts">
          {row.link && (
            <Button onClick={() => { if (!openExternal(row.link!)) core().say.toast(`Could not open ${row.link}`); }}>
              <ExternalLink size={13} /> read the licence
            </Button>
          )}
          {onWeb && <Button onClick={onWeb}><AppWindow size={13} /> make a web page instead (nothing to install)</Button>}
        </div>
      )}
    </div>
  );
}

const ICONS: Record<CheckIcon, React.ReactNode> = {
  pending: <Circle size={16} />,
  running: <Loader size={16} className="spin" />,
  done: <Check size={16} />,
  skipped: <MinusCircle size={16} />,
  stopped: <OctagonAlert size={16} />,
};

function Progress({ job, onAnother }: { job: OnboardJob; onAnother(): void }) {
  const now = useNow(1000);
  const rows = checklist(job, now);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchOff, setSwitchOff] = useState<boolean | null>(null);
  const android = job.answers.path === "android";
  const art = artifactFile(job);
  useEffect(() => {
    if (!android || job.consent.installApps !== true) return;
    let gone = false;
    void installSwitchOff().then((v) => { if (!gone) setSwitchOff(v); });
    return () => { gone = true; };
  }, [android, job.consent.installApps, job.state]);

  const fix = async (r: CheckRow) => {
    setBusy(true); setError(null);
    const why = await resumeJob(r.fix?.consent ? { [r.fix.consent]: true } : undefined);
    setBusy(false);
    if (why) setError(why);
  };
  return (
    <div className="sheet-scroll">
      <div className="set-group">
        <div className={`onb-q${job.state === "stopped" ? " warn" : ""}`}>{progressHead(job)}</div>
        {job.state === "running" && <SetNote>This keeps going on the desktop if you leave this screen; the launcher shows where it is.</SetNote>}
      </div>
      <div className="set-group onb-check">
        {rows.map((r) => {
          const status = job.steps.find((s) => s.id === r.id)?.status;
          return (
            <div key={r.id} className={`onb-row ${r.icon}`} data-step={r.id}>
              <span className="onb-row-icon">{ICONS[r.icon]}</span>
              <div className="onb-row-body">
                <div className="onb-row-what">{r.what}{r.clock && <span className="onb-clock"> · {r.clock}</span>}</div>
                {r.note && <SetNote>{r.note}</SetNote>}
                {r.command && <SetNote>do it yourself: <code>{r.command}</code></SetNote>}
                {r.fix && (
                  <Button onClick={() => void fix(r)}>
                    {busy ? <Loader size={13} className="spin" /> : <Hammer size={13} />} {fixLabel(r.fix, status)}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {error && <SetNote className="warn" role="alert">{error}</SetNote>}
      </div>
      {job.state === "stopped" && (
        <div className="set-group">
          <Button onClick={onAnother}><Rocket size={14} /> start over with other answers</Button>
          <SetNote>What was already made stays on the desktop; a new start replaces this stopped job.</SetNote>
        </div>
      )}
      {job.state === "done" && (
        <div className="set-group onb-done">
          {art && (
            <Button onClick={() => openArtifactOf(art, job.answers.path)}>
              {android ? <><Smartphone size={14} /> install {art.name}</> : <><AppWindow size={14} /> open the page</>}
            </Button>
          )}
          {switchOff && (
            <>
              <SetNote className="warn">{INSTALL_SWITCH_OFF}</SetNote>
              <Button onClick={() => void openInstallSwitch()}><Smartphone size={14} /> open Android's setting</Button>
            </>
          )}
          {job.consent.session === true && (
            <>
              <button className="send onb-open" onClick={() => openNewSession(job)}>
                <TerminalIcon size={14} /> open the session in {job.name}
              </button>
              <SetNote>
                <MessageSquare size={12} /> {job.answers.description
                  ? "Your description is the session's first prompt."
                  : "A first prompt waits in the box there; change it or send it."}
              </SetNote>
            </>
          )}
          <Button onClick={onAnother}><Rocket size={14} /> build another app</Button>
        </div>
      )}
    </div>
  );
}
