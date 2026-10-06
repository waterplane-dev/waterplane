/**
 * Back INSIDE a screen: the step a sheet takes without changing the route.
 *
 * The route (`useRoute`) is which session, which sheet, which repo focus — and
 * the history stack pushes one entry per route. But a sheet has screens of its
 * own that are not routes: the file browser opens a file, a list opens a row's
 * detail, a picker drills into a folder. Those lived in the sheet's `useState`
 * and pushed nothing, so the Android swipe — which pops ONE history entry —
 * popped the whole sheet: open a file from the browser, swipe back, and you
 * are on the main view instead of the listing you just left. The in-app arrow
 * did the right thing and the gesture did not, which is the worst kind of
 * inconsistency because it trains the hand to distrust the gesture.
 *
 * So a sub-view says it is open, and that is the whole contract:
 *
 *     const [open, setOpen] = useState<File | null>(null);
 *     useBackStep(open !== null, () => setOpen(null));
 *
 * While the condition holds, one history entry sits above the screen. Back
 * (gesture, hardware, `shellBack`) pops it and calls the close — the sheet stays.
 * Closing it by any other means (its own arrow, a pick, the sheet unmounting)
 * retires the entry, so the next Back is not a dead press.
 *
 * The stack state lives HERE, not in a ref inside `useRoute`, because the step
 * hook and the route hook must agree on one depth — and the Android shell is
 * told that depth (`pushBackDepth`) so it knows the gesture is ours.
 */
import { useEffect, useRef, useState } from "react";
import { shellInterface } from "./shellBridge";
import { screenOfKey, stepKey, VACANT } from "./routing.ts";

/** The keys this document pushed, by depth, and where we are in them. */
export const routeStack: { depth: number; keys: string[] } = { depth: 0, keys: [] };

/**
 * Tell the Android shell how deep the app is, BEFORE it needs to know.
 *
 * Android 13+ asks at the START of a predictive-back swipe — before the
 * gesture commits — whether the app will handle Back, so it can choose the
 * in-app animation or the exit one. There is no `evaluateJavascript` round
 * trip available at that moment, which is exactly why the gesture behaved
 * differently from the button: the shell could only ask `window.shellBack()`
 * after the fact. So the depth is PUSHED instead, and `shellBack` stays as the
 * fallback. It must be pushed from every place the depth moves — a depth left
 * stale at 0 makes every Back exit the app.
 */
export function pushBackDepth(): void {
  shellInterface<{ setBackDepth?: (n: number) => void }>()?.setBackDepth?.(routeStack.depth);
}

/** Open steps, by the depth of their entry. */
const steps = new Map<number, { id: number; close: () => void }>();
let nextId = 1;

/**
 * A pop landed at `depth`: every step above it is closed — by the Back that
 * popped it, so its own close must not pop again. Returns whether the entry
 * landed on is DEAD (a step slot with nothing open behind it), in which case
 * the caller keeps going back.
 */
export function popStepsTo(depth: number): boolean {
  for (const [d, s] of [...steps]) {
    if (d <= depth) continue;
    steps.delete(d);
    s.close();
  }
  const k = routeStack.keys[depth];
  return k === VACANT || (k !== undefined && k.includes("#step") && !steps.has(depth));
}

let retireQueued = false;
/**
 * After the commit that closed a step: pop the vacant slots left at the TOP.
 * Deferred, because the same commit may also change the route — then the
 * routing effect has already unwound past them or pushed over them, and there
 * is nothing left for us to do.
 */
function queueRetire(): void {
  if (retireQueued) return;
  retireQueued = true;
  queueMicrotask(() => {
    retireQueued = false;
    let n = 0;
    while (routeStack.depth - n > 0 && routeStack.keys[routeStack.depth - n] === VACANT) n++;
    if (!n) return;
    routeStack.depth -= n;
    routeStack.keys.length = routeStack.depth + 1;
    pushBackDepth();
    history.go(-n);
  });
}

/**
 * While `open`, one history entry above this screen whose Back calls `close`.
 * See the file header. `close` may change on every render; the latest is used.
 *
 * **A close that leaves it open RE-ARMS.** Back from a sub-folder goes to its
 * parent, which is still not the root: `useBackStep(dir !== "", up)` then
 * pushes a fresh entry, so the next Back walks up again rather than out of the
 * sheet. That is how one call covers a drill-down of any depth.
 */
export function useBackStep(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const [armed, rearm] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = nextId++;
    let below = routeStack.depth;
    while (below > 0 && routeStack.keys[below] === VACANT) below--;
    const depth = routeStack.depth + 1;
    const key = stepKey(screenOfKey(routeStack.keys[below] ?? ""), id);
    history.pushState({ navRoute: key, navDepth: depth }, "");
    routeStack.depth = depth;
    routeStack.keys[depth] = key;
    routeStack.keys.length = depth + 1;
    steps.set(depth, { id, close: () => { closeRef.current(); rearm((n) => n + 1); } });
    pushBackDepth();
    return () => {
      // Closed by a Back: `popStepsTo` already took it out, and the entry is gone.
      if (steps.get(depth)?.id !== id) return;
      steps.delete(depth);
      if (routeStack.keys[depth] === key) routeStack.keys[depth] = VACANT;
      queueRetire();
    };
  }, [open, armed]);
}
