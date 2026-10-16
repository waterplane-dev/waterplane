/**
 * What a list says when it has no rows — written once.
 *
 * There were sixty `div.empty` blocks across twenty-five sheets, and most of
 * them were the same four-line ladder copied by hand:
 *
 *     {res.state === "loading" && <div className="empty">loading…</div>}
 *     {res.state === "offline" && <div className="empty">No connection — …</div>}
 *     {res.state === "error"   && <div className="empty">The host could not …</div>}
 *     {rows.length === 0       && <div className="empty">Nothing here.</div>}
 *
 * That is precisely the rot `useRemoteResource` was written to stop, one level
 * up: the hook made "the host refused this" and "the host was not reachable"
 * different STATES, and then every sheet got to decide independently whether to
 * honour the distinction, and whether a CACHED list mentions its age at all.
 * One sheet forgetting the age label is not a crash — it is a screen quietly
 * claiming to be current, which is worse, and it is invisible in review because
 * the sheet looks finished. `stalenessNote` existed for exactly this and had one
 * importer.
 *
 * So the four sentences live here, and the two that must never merge stay
 * separate by construction:
 *
 *   offline — the request could not be made or could not be answered. The next
 *             action is about the tunnel.
 *   error   — the host answered, and said no. The next action is about the
 *             repo, the permissions, or the path. Collapsing this into
 *             "offline" is how a permissions problem reads as a bad link for a
 *             week.
 *
 * `children` is the fourth case and the only one a caller must supply: "the
 * host answered, and there is genuinely nothing here" is the one sentence this
 * component cannot know. A list that is not a host read at all (the pad, the
 * queue, the snippet catalog) passes no `res` and gets just its own words in
 * the same box — which is why every site migrates rather than only the
 * resource-backed ones.
 *
 * How it LOOKS is one decision too (`.empty-msg`): one centred, muted sentence
 * in the space the rows would take. It used to sit top-left at body size, and
 * the callers that stacked a 20 px glyph over two sentences made every empty
 * sheet read as a stub somebody forgot to finish. An icon a caller passes is
 * centred and quiet; the age line is NOT centred, because it also stands above
 * a list that has rows and belongs to the list's edge. The words, and which of
 * the four states says them, are untouched by any of that.
 */
import type { ReactNode } from "react";
import { agoText, type ResourceState } from "./useRemoteResource";

export interface EmptyProps {
  /**
   * The read these rows came from. Omit for a list that is local state.
   *
   * Deliberately a structural type rather than `RemoteResource<T>`: several
   * sheets track the same three facts by hand (a socket-pushed list with its
   * own arrival stamp), and forcing them through the hook to get the wording
   * would be the tail wagging the dog.
   */
  res?: { state: ResourceState; age?: number | null; error?: string | null };
  /**
   * Whether there is anything to show. Defaults true, because most call sites
   * already render this inside their own `rows.length === 0` test.
   *
   * Passing it explicitly is what lets the CACHED-age line appear above a list
   * that DOES have rows — the case the hand-written ladders never covered,
   * since a four-branch chain guarded by emptiness cannot say anything about a
   * non-empty list.
   */
  empty?: boolean;
  /** The thing being listed, as it reads mid-sentence: "branches", "the
   *  archive", "the working tree". Without it the sentences stay generic. */
  thing?: string;
  /** An extra clause on the offline sentence — what ELSE is unavailable while
   *  the link is down ("nothing can be staged or committed until it is back"). */
  offlineNote?: ReactNode;
  /** An extra clause on EVERY sentence — the way out that holds whatever the
   *  state is ("you can still type any command"). Separate from `offlineNote`
   *  because "what is still possible" and "what is additionally impossible"
   *  are opposite facts, and a screen that prints one where the other belongs
   *  is worse than a screen that prints neither. */
  note?: ReactNode;
  /** Noun for the cached-age line. "listing" suits most; a log or a board
   *  wants its own word. */
  noun?: string;
  /** The nothing-here sentence: the host answered and there are no rows. */
  children?: ReactNode;
}

export function Empty({ res, empty = true, thing, offlineNote, note, noun = "listing", children }: EmptyProps) {
  // The age line stands whether or not there are rows, which is the whole
  // reason `empty` is a prop and not an assumption.
  const stale = res?.state === "cached" && res.age != null
    ? <div className="empty empty-stale">Cached {noun} from {agoText(res.age)} — the link is down, so anything added since won’t be here.</div>
    : null;
  if (!empty) return stale;

  const what = thing ?? "this";
  let body: ReactNode = children ?? null;
  if (res) {
    switch (res.state) {
      case "loading":
        body = <>Reading {what}…</>;
        break;
      case "offline":
        // Names the desktop, because on this app's link the useful next thought
        // is "the desktop has it and I cannot reach the desktop", not "empty".
        // `thing` is kept in OBJECT position throughout — "branches lives on
        // the desktop" was the first draft, and a template that has to agree in
        // number with a caller's noun is a template that will be wrong for
        // half of them.
        body = <>No connection — this phone could not reach the desktop, so {what} cannot be read.{offlineNote ? <> {offlineNote}</> : null}</>;
        break;
      case "error":
        body = <>The host could not read {what}{res.error ? <>: {res.error}</> : "."}</>;
        break;
      // "fresh" and "cached" both mean the host's answer is on screen, and an
      // empty answer is the caller's own sentence.
    }
  }
  if (!body) return stale;
  return <>{stale}<div className="empty empty-msg">{body}{note ? <> {note}</> : null}</div></>;
}
