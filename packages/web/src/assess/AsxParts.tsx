/**
 * The step log, a kind's head, and a row's files.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { useMemo } from "react";
import { Sparkles, Wrench } from "lucide-react";
import type { AssessStep, ItemCategory } from "@waterplane/shared";
import { CATEGORY_ICON } from "../backlog/backlogLabels";
import { AttachStrip } from "../AttachStrip";
import { refsIn } from "../fileRefs";
import type { OutboxEntry } from "../outbox";
import { useInView } from "../useInView";
import { STEP_ICON } from "./asxConst";

/**
 * **What the run actually did, step by step.**
 *
 * The CLI's own events, worded by `assessRows.ts` and never re-narrated here.
 * It is a TAIL — the count above it says how many steps there have really been,
 * because a list of the last twenty of two hundred that does not say so is a
 * claim that the run did twenty things.
 *
 * Its own scroll region, like the build log's, because this is unbounded in the
 * one direction a sheet is not.
 */
export function RunLog({ steps }: { steps: readonly AssessStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="assess-log">
      {steps.map((st, i) => {
        const Icon = STEP_ICON[st.kind] ?? Wrench;
        return (
          <div key={`${st.at}:${i}`} className={`assess-step${st.kind === "say" ? " assess-step-say" : ""}`}>
            <Icon size={12} />
            <span className="assess-step-label">{st.label}</span>
            {st.detail ? <span className="assess-step-detail">{st.detail}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * **The pictures a piece of text names**, under the text.
 *
 * The whole component is the decision to REUSE `AttachStrip` rather than draw a
 * thumbnail here: it is the one thing in this app that knows a file mention may
 * resolve to the phone's own bytes, to the host's copy, or to nothing at all,
 * and it says which in a sentence — a file that is gone reads as a stated fact,
 * an offline check reads as "can't check without a connection" rather than as
 * absence, and every thumbnail opens through the single `requestAttachOpen`
 * route App already listens on. All three are load-bearing on a screen where
 * the picture is the evidence for a retirement.
 *
 * Two cheap guards, both `ActivitySheet`'s and for its reasons. `refsIn` first,
 * so a proposal full of rows that name nothing mounts no component and runs no
 * effect; then `useInView`, so forty rows that DO name something are forty repo
 * listings fired as they are scrolled to, and not forty fired at open over
 * exactly the link whose failures this screen may already be about.
 */
/**
 * **What a run proposes to CALL something** — a kind chip and a title, in one
 * line, in the three places this sheet shows somebody's work: an assessed row,
 * a merge card, a new item.
 *
 * One component because it is one claim. The chip is drawn only where a kind
 * was given (absent means the run said nothing — never a default bucket), the
 * `Sparkles` mark is drawn only where the words are the MACHINE's, and neither
 * is a control: nothing here is applied until the switch at the end of the
 * scroll says so, and a chip that looked tappable would be offering a decision
 * that is taken somewhere else.
 *
 * No colour per kind, for `CATEGORY_ICON`'s reason one sheet along: a red `bug`
 * beside this screen's own red verdict pills is two different alarms wearing
 * one colour.
 */
export function NameHead({ headline, suggested, category }: {
  headline?: string;
  suggested?: boolean;
  category?: ItemCategory;
}) {
  if (!headline && !category) return null;
  const I = category ? CATEGORY_ICON[category] : null;
  return (
    <>
      {category && I ? <span className="bl-chip bl-cat"><I size={11} /> {category}</span> : null}
      {headline
        ? <span className="act-where asr-headline">{suggested ? <Sparkles size={11} /> : null}{headline}</span>
        : null}
    </>
  );
}

export function ItemFiles({ text, repoId, outbox, online }: {
  text: string;
  repoId: string;
  outbox: readonly OutboxEntry[];
  online: boolean;
}) {
  const has = useMemo(() => !!text && refsIn(text).length > 0, [text]);
  const [seen, boxRef] = useInView(has);
  if (!has) return null;
  // The box is what the observer watches, so it exists before the strip does: a
  // zero-height marker coming near the viewport is the signal to go and ask.
  return (
    <div ref={boxRef}>
      {seen ? <AttachStrip compact text={text} repoId={repoId} outbox={outbox as OutboxEntry[]} online={online} /> : null}
    </div>
  );
}
