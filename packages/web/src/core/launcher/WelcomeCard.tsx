/**
 * **Welcome, in a browser** (journey spec T1, decision 3, §7 Q15): a card at the
 * top of Home, first open only.
 *
 * In a browser the page is already served by a desktop, so there is nothing to
 * connect: the card says which desktop answered and offers two ways on —
 * `Start with my repos` (dismisses: the repo rows are right below) and
 * `Try the demo first`. The APK's Welcome is a screen of its own, before any
 * desktop is known (`HostSetup.tsx`).
 *
 * "First open" is read off the desktop, not off a key on this device: no
 * session has ever run from here (none open, none recent, none closed). Once
 * one has, the card never comes back; `Start with my repos` hides it until the
 * app reloads, as the card it replaces did.
 *
 * A drop-in for `FirstRunCard` (same props): while an onboarding job runs or
 * waits on the person, that card's job view is what shows here, and outside the
 * first open the card it replaces draws nothing either.
 */
import { FolderOpen, PlayCircle, Rocket } from "lucide-react";
import { createStore, useCore, useStore } from "../../sdk";
import { FirstRunCard, openOnboard, useOnboardJob } from "../../features/onboard";
import { activeHost } from "../../hosts";
import { Button } from "../../kit/Button";

const dismissed = createStore(false);

/** The desktop's name as a person would say it: the saved row's, else the address it served from. */
function desktopName(): string {
  try {
    const h = activeHost();
    if (h?.name) return h.name;
  } catch { /* no saved desktops in a browser */ }
  try { return location.hostname || "this desktop"; } catch { return "this desktop"; }
}

export function WelcomeCard({ repos, demo, onDemo }: { repos: number; demo: boolean; onDemo(): void }) {
  const c = useCore();
  const job = useOnboardJob();
  const hidden = useStore(dismissed);
  if (job) return <FirstRunCard repos={repos} demo={demo} onDemo={onDemo} />;
  const firstOpen = !demo && c.conn.status === "open"
    && c.world.sessions.length === 0 && c.world.recent.length === 0 && c.world.closed.length === 0;
  if (!firstOpen || hidden) return null;
  return (
    <div className="onb-card" data-card="welcome" role="region" aria-label="Welcome">
      <div className="onb-card-head"><span>Welcome</span></div>
      <div className="onb-card-body">
        Connected to {desktopName()}. Drive Claude Code on it from this phone: it runs there; this phone steers.
        {repos === 0 && " No repos under its root yet."}
      </div>
      <div className="onb-card-acts">
        <button className="send" onClick={() => { c.say.track("action:welcome.start"); dismissed.set(true); }}>
          <FolderOpen size={16} /> Start with my repos
        </button>
        <Button onClick={() => { c.say.track("action:welcome.demo"); onDemo(); }}>
          <PlayCircle size={16} /> Try the demo first
        </Button>
      </div>
      <div className="onb-card-body">
        Starting from nothing?{" "}
        <button className="link-btn" onClick={() => { c.say.track("action:welcome.onboard"); openOnboard(); }}>
          <Rocket size={13} /> Build your first app
        </button>
      </div>
    </div>
  );
}
