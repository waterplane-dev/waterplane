/**
 * What this phone is holding, and getting some of it back.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * `SweepSheet` answers this question about the desktop's transport
 * directories. Nothing answered it about the phone: connection health printed
 * `used 340 MB` and stopped there, which tells a person the app is heavy and
 * nothing about which part of it is a thumbnail cache that refills in a
 * second and which part is the only copy of a photo nobody has sent.
 *
 * ── The rules it is built out of ────────────────────────────────────────────
 *
 *  - **Nothing applies itself** (CLAUDE.md). Every cache here already prunes
 *    itself; this screen adds no policy, no timer and no threshold. It is the
 *    reading, plus a way to take the space back before a bound would have.
 *  - **A count is not the decision; bytes are.** Every count on this screen
 *    carries its byte total (`tallyText`), for `SweepSheet`'s reason.
 *  - **Two kinds, never one button.** Caches cost a re-fetch. The rows under
 *    *Only on this phone* are content: scrollback the TUI never put on the
 *    wire, recordings the desktop has not read, photos from sends that died.
 *    *Clear all caches* cannot reach them — `storagePlan.ts` has no function
 *    that returns the two groups' union, which is the structural half of that
 *    promise.
 *  - **A blocked verb is a sentence** (`Unavailable.tsx`), never a dimmed
 *    button. The photos of messages still queued are the case: they are
 *    deleted from the queue, with the words they belong to on screen.
 *  - **Re-read, never edit rows out.** After a clear the whole audit is taken
 *    again, so what is on screen is what is on the device — including
 *    anything that refused to go.
 *
 * ── And the same question about the desktop ─────────────────────────────────
 *
 * Two more sections, both READ over HTTP and both about the machine at the
 * other end of the tunnel (`shared/deskstorage.ts`):
 *
 *  - **The repos**, ranked by what their transport directories hold. The
 *    per-repo sweep is reached from one repo's gallery, so using it meant
 *    already knowing which of fourteen repos was holding 4.5 GB. Each row's two
 *    figures are two tap targets — a count on a control is a filter, and a
 *    combined number could not say which scope it would open.
 *  - **The daemon's own store**, by owner and by bound. Almost all of it is
 *    already bounded by whoever writes it, and saying so per row is the point:
 *    it is what identifies the one file that is not.
 */
import { useEffect, useState } from "react";
import { HardDrive, Loader2, RefreshCw, Server, Trash2 } from "lucide-react";
import {
  HOST_STORE_KIND_LABEL, clearableRows, hostStoreButtonText, hostStoreResultText,
  scopeChipText, surveyHeadText,
  type HostStoreReport, type HostStoreRow, type SweepScope, type TransportSurvey,
} from "@waterplane/shared";
import {
  clearButtonText, clearConfirmText, clearGroupText, clearResultText, fmtBytes,
  groupUses, nativeNoteText, tallyText, totalText,
  type StoreUse, type UseGroup,
} from "./storagePlan";
import { clearRow, dropDownloads, measureStorage, type StorageAudit } from "./storageAudit";
import { SheetHead } from "./Sheet";
import { ConfirmButton } from "./Confirm";
import { Unavailable } from "./Unavailable";
import { Empty } from "./Empty";
import { api } from "./api";
import { useRemoteResource } from "./useRemoteResource";
import { ago } from "./format";
import { Button } from "./kit/Button";
import { Row } from "./kit/Row";
import { Hint } from "./kit/Hint";

interface Props {
  onClose: () => void;
  onToast: (text: string) => void;
  /** Open one repo's transport sweep, on the scope whose figure was tapped.
   *  The sheet comes back here when it closes (`features/images/store.ts`'s `sweepFor.back`). */
  onOpenSweep: (repoId: string, scope: SweepScope) => void;
}

export function StorageSheet({ onClose, onToast, onOpenSweep }: Props) {
  const [audit, setAudit] = useState<StorageAudit | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try { setAudit(await measureStorage()); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  /** One row's clear: act, say what happened, then re-read. */
  async function runRow(row: StoreUse) {
    setBusy(true);
    try {
      const before = row.bytes;
      const r = await clearRow(row);
      setSaid(clearResultText({
        label: row.label,
        count: r.ok ? row.count : 0,
        bytes: r.ok ? before : 0,
        failed: r.ok ? [] : [row.label],
      }) + (r.note ? ` ${r.note}` : ""));
      await load();
    } finally { setBusy(false); }
  }

  /**
   * Every cache at once — and only caches. The list is built from the rows on
   * screen, so the button clears exactly what the group's own byte total was
   * counted over, and a row with a `cant` is skipped here as well as there.
   */
  async function runCaches(g: UseGroup) {
    setBusy(true);
    try {
      const doomed = g.rows.filter((r) => r.count > 0 && !r.cant);
      const failed: string[] = [];
      let count = 0;
      let bytes = 0;
      for (const row of doomed) {
        const r = await clearRow(row);
        if (r.ok) { count += row.count; bytes += row.bytes ?? 0; } else failed.push(row.label);
      }
      setSaid(clearResultText({ label: "the caches", count, bytes, failed }));
      await load();
    } finally { setBusy(false); }
  }

  async function runDownloads(ids: string[], what: string) {
    setBusy(true);
    try {
      const r = await dropDownloads(ids);
      // Said as bytes freed rather than files deleted: the records stay, and
      // every one of them is still one tap from being here again.
      onToast(`freed ${fmtBytes(r.bytes)} — ${r.count} download${r.count === 1 ? "" : "s"} ${what}`);
      setSaid(`Dropped the bytes of ${tallyText(r.count, r.bytes, "download")}. The rows are still in Downloads — tap one to fetch it again.`);
      await load();
    } finally { setBusy(false); }
  }

  // ── The desktop's two readings ────────────────────────────────────────────
  // Through `useRemoteResource` so a cached row says how old it is and offline
  // is a sentence rather than an empty list. `bump` moves the key, which is how
  // this app re-reads without blanking what somebody is looking at.
  const [bump, setBump] = useState(0);
  const survey = useRemoteResource<TransportSurvey>(`storage.transport.${bump}`, () => api.transportSurvey());
  const store = useRemoteResource<HostStoreReport>(`storage.host.${bump}`, () => api.hostStore());

  /**
   * Clear one row of the DESKTOP's store.
   *
   * Carries the instant that report was read, never a path — the host owns
   * every filename (`host/hoststore.ts`), and `at` is what keeps the clear
   * inside the reading on screen.
   */
  async function runHostRow(row: HostStoreRow, at: number) {
    setBusy(true);
    try {
      const out = await api.hostStoreClear(row.id, at);
      if (out.error) { setSaid(out.error); return; }
      setSaid(hostStoreResultText(row.label, out));
      setBump((n) => n + 1);
    } catch {
      setSaid("The desktop didn’t answer, so nothing here says whether it ran — re-read to see what is still there.");
    } finally { setBusy(false); }
  }

  const groups = audit ? groupUses(audit.rows) : null;
  const dl = audit?.downloads;
  const nativeNote = dl ? nativeNoteText(dl.nativeCount, dl.nativeBytes) : null;

  return (
    <div className="sheet">
      <SheetHead title="Storage on this phone" onClose={onClose}>
        {loading && <Loader2 size={13} className="spin" />}
      </SheetHead>

      <Hint>
        {audit ? totalText(audit.named, audit.estimate, audit.quota) : "Measuring…"}
      </Hint>
      {nativeNote && <Hint>{nativeNote}</Hint>}

      <div className="annot-tools">
        <Button onClick={() => { void load(); setBump((n) => n + 1); }}>
          <RefreshCw size={14} /> re-measure
        </Button>
      </div>

      {said && <Hint>{said}</Hint>}

      {/* ── Downloads ─────────────────────────────────────────────────────
          Its own section and not a cache row: these are the gigabytes, the
          bytes may sit outside IndexedDB entirely, and the two halves differ
          in what dropping them costs. */}
      {dl && (
        <section className="set-group">
          <h3 className="set-title">Downloads</h3>
          <Hint>
            Finished downloads keep their bytes for a week and then drop them by themselves.
            Dropping one now keeps its row: fetching it back is a tap.
          </Hint>

          <Row>
            <span className="sweep-path">already saved out</span>
            <span className="sweep-meta">{tallyText(dl.savedIds.length, dl.savedBytes, "file")}</span>
          </Row>
          {dl.savedIds.length > 0 ? (
            <ConfirmButton className="send" confirm={`Yes — free ${fmtBytes(dl.savedBytes)}`}
              disabled={busy} onConfirm={() => void runDownloads(dl.savedIds, "already saved out")}>
              <Trash2 size={14} /> Drop bytes of {dl.savedIds.length} saved · {fmtBytes(dl.savedBytes)}
            </ConfirmButton>
          ) : (
            <Unavailable className="form-hint" cants={[{
              label: "free saved downloads",
              reason: "nothing finished here has been saved out to the phone yet.",
            }]} />
          )}

          <Row>
            <span className="sweep-path">never saved out</span>
            <span className="sweep-meta">{tallyText(dl.unsavedIds.length, dl.unsavedBytes, "file")}</span>
          </Row>
          {dl.unsavedIds.length > 0 ? (
            <>
              {/* Honest about the one way this is not free: the desktop prunes
                  old builds (`artifacts.ts` keeps 3 of each), so "fetch it
                  again" is a promise about the build, not about the file. */}
              <Hint>
                These were never saved to the phone. They come back as a tap only while the desktop
                still has that build — it keeps the newest few of each.
              </Hint>
              <ConfirmButton className="send danger" confirm={`Yes — free ${fmtBytes(dl.unsavedBytes)}`}
                disabled={busy} onConfirm={() => void runDownloads(dl.unsavedIds, "not saved out")}>
                <Trash2 size={14} /> Drop bytes of {dl.unsavedIds.length} unsaved · {fmtBytes(dl.unsavedBytes)}
              </ConfirmButton>
            </>
          ) : (
            <Unavailable className="form-hint" cants={[{
              label: "free unsaved downloads",
              reason: "every finished download here has been saved out already.",
            }]} />
          )}
        </section>
      )}

      {/* ── Caches ────────────────────────────────────────────────────────── */}
      {groups && (
        <section className="set-group">
          <h3 className="set-title">
            Caches — {tallyText(groups.caches.count, groups.caches.bytes, "entry")}
          </h3>
          <Hint>
            Everything here can be read from the desktop again. Clearing costs a request each,
            and leaves these screens blank until the tunnel is back.
          </Hint>
          <StoreRows rows={groups.caches.rows} busy={busy} onClear={runRow} />
          {groups.caches.rows.some((r) => r.count > 0 && !r.cant) ? (
            <ConfirmButton className="send" confirm={`Yes — clear ${fmtBytes(groups.caches.bytes ?? 0)}`}
              disabled={busy} onConfirm={() => void runCaches(groups.caches)}>
              <HardDrive size={14} /> {clearGroupText({ ...groups.caches, kind: "cache" })}
            </ConfirmButton>
          ) : (
            <Unavailable className="form-hint" cants={[{ label: "clear caches", reason: "they are all empty." }]} />
          )}
        </section>
      )}

      {/* ── The only copy ─────────────────────────────────────────────────
          No group control, by construction: see the module note. */}
      {groups && (
        <section className="set-group">
          <h3 className="set-title">
            Only on this phone — {tallyText(groups.keep.count, groups.keep.bytes, "entry")}
          </h3>
          <Hint>
            The desktop cannot send these back. Each one goes on its own, and says what it takes with it.
          </Hint>
          <StoreRows rows={groups.keep.rows} busy={busy} onClear={runRow} />
        </section>
      )}

      {/* ── The desktop: every repo's transport directories ────────────────
          Ranked, because the per-repo sweep is reached from one repo and using
          it meant already knowing which of fourteen was holding 4.5 GB. */}
      <section className="set-group">
        <h3 className="set-title"><Server size={13} /> On the desktop — repos</h3>
        {survey.data ? (
          <>
            <Hint>{surveyHeadText(survey.data)}</Hint>
            <Empty res={survey} empty={!survey.data.repos.length} thing="No repos on the desktop." noun="survey" />
            <div className="list">
              {survey.data.repos.map((r) => (
                <div key={r.repoId} className="row sweep-row storage-row">
                  <div className="storage-row-head">
                    <span className="sweep-path">{r.repoName}</span>
                    <span className="sweep-meta">{r.branch}</span>
                  </div>
                  {/* Two tap targets, never one combined figure: each number
                      opens exactly the sweep it is the count for, and a merged
                      one could not say which scope it meant. An uncounted or
                      empty scope is drawn as a sentence, not as a dead chip. */}
                  <div className="annot-tools">
                    {(["outbox", "inbox"] as const).map((scope) => {
                      const t = scope === "outbox" ? r.outbox : r.inbox;
                      return t && t.count > 0 ? (
                        <Button key={scope} onClick={() => onOpenSweep(r.repoId, scope)}>
                          {scope} · {scopeChipText(t)}
                        </Button>
                      ) : (
                        <span key={scope} className="sweep-meta">{scope} · {scopeChipText(t)}</span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty res={survey} thing="Couldn’t read the desktop’s repos." noun="survey" />
        )}
      </section>

      {/* ── The desktop: the daemon's own store ─────────────────────────────
          Almost every row here carries a `cant` naming its own bound, and that
          is the reading — it is what identifies the one store that has none. */}
      <section className="set-group">
        <h3 className="set-title"><Server size={13} /> On the desktop — the app’s own store</h3>
        {store.data ? (
          <>
            <Hint>
              <span className="mono">{store.data.dir}</span> —{" "}
              {store.data.total == null
                ? "part of it could not be measured."
                : `${fmtBytes(store.data.total)} in all. Most of it is already bounded by whatever writes it.`}
              {" "}Read {ago(store.data.at)}.
            </Hint>
            <div className="list">
              {store.data.rows.map((r) => (
                <div key={r.id} className="row sweep-row storage-row">
                  <div className="storage-row-head">
                    <span className="sweep-path">{r.label}</span>
                    <span className="sweep-meta">{tallyText(r.count, r.bytes, "file")}</span>
                  </div>
                  <Hint>{HOST_STORE_KIND_LABEL[r.kind]} — {r.cost}</Hint>
                  {r.cant ? (
                    <Unavailable className="form-hint" cants={[{ label: `clear ${r.label}`, reason: r.cant }]} />
                  ) : r.count > 0 ? (
                    <ConfirmButton className="key" confirm={`Yes — clear ${tallyText(r.count, r.bytes, "file")}`}
                      disabled={busy} onConfirm={() => void runHostRow(r, store.data!.at)}>
                      <Trash2 size={13} /> {hostStoreButtonText(r)}
                    </ConfirmButton>
                  ) : (
                    <Hint>Nothing here.</Hint>
                  )}
                </div>
              ))}
            </div>
            {!clearableRows(store.data.rows).length && (
              <Unavailable className="form-hint" cants={[{
                label: "clear anything here",
                reason: "the two clearable stores are empty; everything else is a record or in use.",
              }]} />
            )}
          </>
        ) : (
          <Empty res={store} thing="Couldn’t read the desktop’s store." noun="report" />
        )}
      </section>
    </div>
  );
}

/** One row per store: what it holds, how much, what clearing costs, and either
 *  the button or the sentence saying why there is none. */
function StoreRows({ rows, busy, onClear }: { rows: StoreUse[]; busy: boolean; onClear: (r: StoreUse) => void }) {
  return (
    <div className="list">
      {rows.map((r) => (
        <div key={r.id} className="row sweep-row storage-row">
          <div className="storage-row-head">
            <span className="sweep-path">{r.label}</span>
            <span className="sweep-meta">{tallyText(r.count, r.bytes, "entry")}</span>
          </div>
          <Hint>{r.cost}</Hint>
          {r.cant ? (
            <Unavailable className="form-hint" cants={[{ label: `clear ${r.label}`, reason: r.cant }]} />
          ) : r.count > 0 ? (
            <ConfirmButton className={`key ${r.kind === "keep" ? "danger" : ""}`} confirm={clearConfirmText(r)}
              disabled={busy} onConfirm={() => onClear(r)}>
              <Trash2 size={13} /> {clearButtonText(r)}
            </ConfirmButton>
          ) : (
            // Empty is an answer, and it is said rather than drawn as a
            // control that would do nothing.
            <Hint>Nothing here.</Hint>
          )}
        </div>
      ))}
    </div>
  );
}
