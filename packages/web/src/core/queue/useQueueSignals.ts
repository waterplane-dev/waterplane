import { useEffect } from "react";
import { noteStuckSends } from "../../link";
import { setReloadGuard } from "../../ws";
import { annotatorBusy } from "../../features/images";
import type { useActivityConfirmedDone, useActivityFiled } from "../../features/activity";
import type { QueueApi } from "./useQueue";

export interface UseQueueSignalsCtx {
  outbox: QueueApi["entries"];
  activityFiled: ReturnType<typeof useActivityFiled>;
  activityConfirmedDone: ReturnType<typeof useActivityConfirmedDone>;
  allBufsRef: QueueApi["uploads"]["allBufsRef"];
}

/**
 * What the queue tells the rest of the page: the stuck-sends count for the
 * connection strip, and the reload veto while words or markup exist nowhere
 * else (docs/notes/app-architecture.md). Two of App's effects, verbatim and in
 * their order.
 */
export function useQueueSignals(ctx: UseQueueSignalsCtx) {
  const { outbox, activityFiled, activityConfirmedDone, allBufsRef } = ctx;
  /**
   * The connection strip's one red reading: sends that gave up and that nobody
   * has dealt with.
   *
   * PUSHED into `link.ts` rather than read out of the queue by it, which is the
   * rule that file states about itself: it is POSTed to the host once a minute
   * and prompt text is not telemetry, so it may hold the number and never the
   * rows. The give-ups ledger used to push this; the rows themselves do now,
   * which also fixes what that ledger got wrong — it kept counting a row for a
   * day after the user had dealt with it, because a dismissal was not something
   * a separate store could see.
   */
  const stuckSends = outbox.filter((e) => e.status === "failed" && !activityFiled.has(`queue:${e.ackId}`)
    && !activityConfirmedDone.has(`queue:${e.ackId}`)).length;
  useEffect(() => { noteStuckSends(stuckSends); }, [stuckSends]);

  // The watchdog's hard reload is safe for everything the app persists — and
  // fatal for the one thing it cannot: an image being marked up exists only as
  // canvas state until it is sent. Veto the reload while that is on screen (or
  // while a batch is still being encoded and parked); the socket is not worth
  // the user's markup, and the watchdog re-arms itself. Both halves read live.
  useEffect(() => {
    setReloadGuard(() => annotatorBusy() || allBufsRef.current.size > 0);
    return () => setReloadGuard(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: the guard closure reads `allBufsRef` live, so it never needs re-arming
  }, []);
}
