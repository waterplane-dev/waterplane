/**
 * **The one screen between a tap and the first session that sends this repo to
 * somebody else's servers.**
 *
 * `ModelField` carries the same disclaimer and is not enough by itself: it is a
 * PICKER, and the ordinary shape of this app is that a model is chosen once and
 * every launch after that is a tap on a repo row with no model control anywhere
 * on the path (`hostedAck.ts` has the full argument). So the words get a second
 * home on the launch itself, once per device, keyed to the version of the text
 * that was actually shown.
 *
 * ── What this sheet may and may not say ────────────────────────────────────
 *
 * **It writes no policy prose of its own.** Every sentence about what happens
 * to the data is `HOSTED_DISCLAIMER` and `ZERO_COST_DISCLAIMER`, imported
 * verbatim from `backendCaps.ts`. A second wording of a data-transmission
 * warning is a second thing that can drift out of true on its own schedule, and
 * the whole reason those constants are worded the way they are is that waterplane
 * must never restate a third party's terms — they change without notice, and
 * the person has already sent the code by the time the app is wrong about it.
 * **No vendor is named anywhere here**, for the same reason;
 * `hostedAck.test.mjs` pins both.
 *
 * The sheet's OWN sentences say only what is specific to this launch: what is
 * about to start, on which binary, with which model. That is the restatement a
 * decision needs, and none of it is a claim about an operator.
 *
 * ── Why it is a sheet and not a confirm ────────────────────────────────────
 *
 * Never a native browser confirm: that modal blocks the WebView's event loop
 * and cannot be styled, which is `Confirm.tsx`'s rule. And this is longer than a
 * confirm anyway — three paragraphs somebody is meant to read, not a yes/no
 * about a file.
 *
 * ── Nothing is greyed, and closing starts nothing ──────────────────────────
 *
 * There is no disabled state on this sheet at all. Before acceptance the launch
 * has simply NOT BEEN SENT — there is no session, no queued op, nothing to
 * withdraw — so the × is a cancel and says so, in `LaunchAskSheet`'s words. The
 * primary button restates the whole decision rather than saying "OK", because
 * "OK" on a screen about sending source code somewhere is a button whose
 * meaning depends on having read the screen it is on.
 *
 * Accepting writes the ack and resumes the EXACT deferred launch — the one that
 * was gate-checked, never a fresh read of the defaults, which may have been
 * answered differently by the per-launch ask two taps ago.
 */
import { AlertTriangle, Play } from "lucide-react";
import type { LaunchOpts } from "@waterplane/shared";
import { SheetHead } from "./Sheet";
import {
  backendInfo, isZeroCost, CLAUDE, HOSTED_DISCLAIMER, ZERO_COST_DISCLAIMER, type BackendList,
} from "./backendCaps";
import { Hint } from "./kit/Hint";

interface Props {
  /** What is about to be opened — the caller's own title for this launch, so
   *  the button can restate the decision rather than say "OK". */
  title: string;
  /** Every backend this host described, for the label and the zero-cost list. */
  backends: BackendList;
  /** The launch that was gate-checked, resumed verbatim on acceptance. */
  launch: LaunchOpts;
  /** Record the acknowledgement and start it. */
  onAccept: () => void;
  /** Close without starting anything. */
  onClose: () => void;
}

export function HostedAckSheet({ title, backends, launch, onAccept, onClose }: Props) {
  const info = backendInfo(backends, launch.backend);
  const model = launch.model ?? "";
  // Only ids the HOST MEASURED at zero (`models.zeroCost`) — never inferred
  // from a `-free` in the name, and never shown for a price nobody reported.
  const free = isZeroCost(info?.models.zeroCost, model);
  return (
    <div className="sheet">
      <SheetHead title="Before this starts" onClose={onClose} />
      {/* What is about to happen, in this launch's own terms. The model id is
          shown as itself: it is the person's own selection echoed back, not a
          claim about anybody. */}
      <Hint>
        {title} would run <b>{model}</b>{info && info.id !== CLAUDE ? <> on {info.label}</> : null}, which is a
        hosted model — it runs on somebody’s server, not on the Mac.
      </Hint>
      <div className="form">
        <div className="model-warn">
          <AlertTriangle size={14} />
          <span>{HOSTED_DISCLAIMER}</span>
        </div>
        {free && (
          <div className="model-warn">
            <AlertTriangle size={14} />
            <span>{ZERO_COST_DISCLAIMER}</span>
          </div>
        )}
        <Hint>
          The long form is §2 of <b>DISCLAIMER.md</b> in this repo.
        </Hint>
        {/* The whole decision, restated. Tapping records the acknowledgement on
            THIS device and resumes the exact launch that was held. */}
        <button className="send" onClick={onAccept}>
          <Play size={14} /> I understand — start {title}
        </button>
        <Hint>
          Closing this starts nothing — nothing is queued until you accept. Asked once on this
          phone; the settings screen can bring it back.
        </Hint>
      </div>
    </div>
  );
}
