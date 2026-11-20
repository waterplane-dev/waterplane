/**
 * Waiting work's frame (journey spec D4): the screen that hosts the four bodies, and the tab row each
 * body draws under its head. State and the rules are `waitingWork.ts`'s; see there.
 */
import { createContext, createElement, useContext } from "react";
import type { SheetDef } from "./sdk";
import { useStore } from "./sdk";
import { FilterChip } from "./kit/FilterChip";
import { TAB } from "./sheetNames";
import {
  WAITING_TABS, keepWaiting, leaveWaiting, switchWaitingTab, tabOf, waitingBody, waitingTabs, type WaitingId,
} from "./waitingWork";

/** Which screen id the body is drawn under; null = drawn outside the frame (no tab row). */
const WaitingCtx = createContext<WaitingId | null>(null);

/** The screen: the body of the tab this id shows. A tab with no body registered falls through (null). */
export function WaitingFrame({ id }: { id: WaitingId }) {
  const tabs = useStore(waitingTabs);
  const body = waitingBody(tabOf(id, tabs));
  return body ? <WaitingCtx.Provider value={id}>{body.render()}</WaitingCtx.Provider> : null;
}

/** The tab row, drawn by each body right under its head. Nothing outside the frame. */
export function WaitingTabs() {
  const id = useContext(WaitingCtx);
  const tabs = useStore(waitingTabs);
  if (!id) return null;
  const on = tabOf(id, tabs);
  return (
    <div className="fchips" role="tablist" aria-label="Waiting work" style={{ padding: "0 calc(var(--gutter) - 3px)", flexShrink: 0 }}>
      {WAITING_TABS.map((t) => (
        <FilterChip key={t} on={on === t} clears={false} onClick={() => switchWaitingTab(id, t)}>{TAB.waiting[t]}</FilterChip>
      ))}
    </div>
  );
}

/** The sheet entry for one of the five ids, spread into a literal `{ id, persisted, ...waitingSheet(id) }`
 *  (`tools/webshape.test.mjs` reads the id and the flag off the literal): the same screen, its own
 *  tab, its own leave and keep. */
export function waitingSheet(id: WaitingId): Pick<SheetDef, "render" | "onLeave" | "keep"> {
  return {
    render: () => createElement(WaitingFrame, { id }),
    onLeave: (reason) => leaveWaiting(id, reason),
    keep: () => keepWaiting(id),
  };
}
