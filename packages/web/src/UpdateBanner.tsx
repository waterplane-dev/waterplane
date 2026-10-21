/**
 * **"A new build is ready" — on the screen you are actually looking at.**
 *
 * The last step of the update path used to be a button on a settings page
 * nobody opens. Everything before it was automatic — check, download, verify,
 * stage — and then the new bundle sat there, complete and unused, while the
 * phone went on running a build from days ago. `watchAutoApply()` closed half
 * of that (it restarts once the phone is put down), and this closes the other
 * half: **the case where you are holding it and would rather have the new one
 * now.**
 *
 * ── Why it is mounted in `main.tsx` ─────────────────────────────────────────
 *
 * `App` returns early once per overlay, so anything that must be visible on
 * every screen cannot live inside it — the same reason `HintLayer` and the
 * toast are mounted beside `NetPulseBar` rather than in the tree. A banner that
 * disappeared the moment somebody opened a sheet would be a banner nobody sees.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It never applies anything on its own. A restart throws away whatever is being
 * composed in memory — an image mid-annotation has no durable form — which is
 * `ws.ts`'s `reloadGuard` argument exactly, and the reason the automatic path
 * waits for the phone to be PUT DOWN. Here a person is holding it, so the
 * decision is theirs and the button is the whole of it.
 *
 * It is also silent for every phase but `staged`. `downloading` is progress
 * nobody asked to watch, `error` belongs on the settings screen with the retry
 * next to it, and `idle` is the state the app is in almost always — a bar that
 * says "up to date" is a bar that trains people to ignore bars.
 */
import { useEffect, useState } from "react";
import { ArrowUpCircle, Clock, X } from "lucide-react";
import { updates, updateSupported, type UpdateStatus } from "./webUpdate";
import { track } from "./usage";
import { LS, lsGet, lsSetJson } from "./storage";
import { showToast } from "./toast";
import {
  SNOOZE_CHOICES, parseSnooze, snoozeActive, snoozeFor, snoozeSentence,
} from "./updateSnooze";
import { Button } from "./kit/Button";

/** Dismissal is per BUILD, not per session: waving away this one must not hide
 *  the next. Kept in memory — a reload is exactly when you want to be told
 *  again, since a reload is what applies it.
 *
 *  That is the right default and the wrong ONLY answer: not every reload is a
 *  decision (the wake watchdog, a cold start, a navigation in the APK), so a
 *  phone mid-task can be asked a dozen times. The snooze beside it is the
 *  durable version, per build and with an end — `updateSnooze.ts`. */
let dismissed: string | null = null;

export function UpdateBanner() {
  const [st, setSt] = useState<UpdateStatus>(() => updates.get());
  const [, bump] = useState(0);
  // Which durations are showing. A second tap on the clock takes it back, so
  // opening the choice is never a trap on a bar with no dismiss of its own.
  const [picking, setPicking] = useState(false);
  useEffect(() => updates.subscribe(setSt), []);

  if (!updateSupported()) return null;
  if (st.phase !== "staged" || !st.stagedId) return null;
  if (dismissed === st.stagedId) return null;
  if (snoozeActive(parseSnooze(lsGet(LS.webUpdateSnooze)), st.stagedId, Date.now())) return null;
  const staged = st.stagedId;

  return (
    <div className="staged-bar" role="status">
      <ArrowUpCircle size={15} />
      <span className="staged-bar-text">
        {picking ? "Hide this for how long?" : "A newer build is ready and verified on this phone."}
      </span>
      {!picking && <Button
        className="staged-bar-go"
        title="restart into the new build — anything half-written in a box is lost"
        onClick={() => { track("action:update.applyNow"); void updates.applyNow(); }}
      >
        Restart into it
      </Button>}
      <button
        className="staged-bar-later"
        aria-label={picking ? "keep showing it" : "hide for a while"}
        aria-expanded={picking}
        title={picking
          ? "keep showing it"
          : "hide for a while — pick how long; the build still applies on its own once you put the phone down"}
        onClick={() => setPicking((v) => !v)}
      ><Clock size={14} /></button>
      {picking && SNOOZE_CHOICES.map((c) => (
        // Chips, in the bar, rather than a dialog: this is a preference, not a
        // destructive act, so it belongs nowhere near `askConfirm` (whose
        // primary is danger-red by construction) — and a modal to answer "not
        // for five minutes" costs more taps than the thing it is postponing.
        // The clock stays put while they are open and takes the choice back, so
        // the only way out of the question is not the × that hides the bar.
        <Button
          key={c.ms}
          className="staged-bar-span"
          title={`hide the bar for ${c.label}, across reloads — the build still applies on its own once you put the phone down`}
          onClick={() => {
            track("action:update.snooze");
            lsSetJson(LS.webUpdateSnooze, snoozeFor(staged, Date.now(), c.ms));
            showToast(snoozeSentence(c.ms));
            setPicking(false);
            bump((n) => n + 1);
          }}
        >{c.label}</Button>
      ))}
      <button
        className="staged-bar-x"
        aria-label="not now"
        title="not now — it applies on its own once you put the phone down"
        onClick={() => { dismissed = staged; bump((n) => n + 1); }}
      ><X size={14} /></button>
    </div>
  );
}
