import { useRef, useState } from "react";
import type { Intent, BackendInfo, ClosedSession, MeterSummary, RecentSession, RepoTarget, SessionInfo, UpdateInfo } from "@waterplane/shared";
import { loadSnap, loadReposAt } from "../../localState";
import { LS } from "../../storage";

/**
 * The lists the host pushes, as App's state (docs/notes/app-architecture.md).
 * State only — no effect, so where App calls it has no order to keep. The
 * socket's frame switch (`core/conn/useHostFrames.ts`) is what writes them.
 */
export function useHostState() {
  // Seed from the last-known snapshot so the launcher renders immediately, before
  // the WS connects (decouples first paint from the handshake). Live data replaces
  // these as soon as it arrives.
  const [sessionsRaw, setSessions] = useState<SessionInfo[]>(() => loadSnap<SessionInfo[]>(LS.snapSessions, []));
  const [recent, setRecent] = useState<RecentSession[]>(() => loadSnap<RecentSession[]>(LS.snapRecent, []));
  const [closed, setClosed] = useState<ClosedSession[]>(() => loadSnap<ClosedSession[]>(LS.snapClosed, []));
  const [repos, setRepos] = useState<RepoTarget[]>(() => loadSnap<RepoTarget[]>(LS.snapRepos, []));
  /** When that listing last came from the host. Seeded from the snapshot, so a
   *  cold start offline says how old its rows are rather than implying they are
   *  this minute's. */
  const [reposAt, setReposAt] = useState<number>(loadReposAt);
  /** When a re-read of that listing last FAILED (0 = none this run). Only a
   *  failure newer than `reposAt` may say the host has stopped answering — an
   *  old listing alone means nobody asked, not that nobody answered. */
  const [reposFailAt, setReposFailAt] = useState<number>(0);
  /**
   * **Everything the desktop is holding, as the durable rows themselves.**
   *
   * The host has kept one Intent store since `intents/` folded five managers
   * into it, and it has broadcast `intent.list` on every change since that day.
   * Nothing read it: the phone took the five OLD projections instead
   * (`launch.list`, `backlog.list`, `schedule.list`, `fanout.run`,
   * `build.run`), each of which drops `state`, `blockReason` and
   * `blockDetail` — so Activity reconstructed a lifecycle the host had already
   * decided, five times, in five vocabularies.
   *
   * This is that list. `activityRows.ts` reads it directly and guesses nothing.
   * The five DTO states below stay for the SHEETS that still speak them
   * (`Backlog`, `ScheduleSheet`, `BuildSheet`, `FanoutSheet`); they are no
   * longer how the app knows what is going on.
   */
  const [intents, setIntents] = useState<Intent[]>([]);
  /**
   * Every backend this desktop can launch — **or `null`, meaning it never
   * said**.
   *
   * The null is the whole compatibility story and is deliberately not `[]`:
   * a host that predates `wire/backend.ts` sends no `backends` frame, and on
   * one of those this app must look and behave exactly as it did — no picker
   * (not greyed, ABSENT), every capability assumed present, the claude tables
   * as the catalogue, and `backend` stripped from anything that goes on the
   * wire (`launchFor`). Not persisted, and **re-set to null on every
   * `welcome`**: it is a fact about the host on the other end of THIS
   * connection, and a copy that outlived the connection — cached to disk, or
   * merely carried across a reconnect — is a claim about a desktop that may
   * have been downgraded since.
   */
  const [backends, setBackends] = useState<BackendInfo[] | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [meter, setMeter] = useState<MeterSummary | null>(null);
  const updateResultSeenRef = useRef<number>(0);
  return {
    sessionsRaw, setSessions, recent, setRecent, closed, setClosed, repos, setRepos, reposAt, setReposAt, reposFailAt, setReposFailAt,
    intents, setIntents, backends, setBackends, update, setUpdate, meter, setMeter, updateResultSeenRef,
  };
}
