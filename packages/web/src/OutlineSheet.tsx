import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Clock, CloudOff, FileCode2, RotateCw, Search, Wrench, X } from "lucide-react";
import type { TranscriptDoc, TranscriptTurn } from "@waterplane/shared";
import { api, isOffline } from "./api";
import { getTranscript } from "./offlineCache";
import { clock, matches, readSeen, turnTs, turnText } from "./transcriptUtil";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";

/**
 * The outline rows themselves — ONE renderer, used by the reader's outline
 * drawer and by the standalone sheet below. Two copies would drift on the next
 * field added to a turn.
 */
export function OutlineRows({ turns, seenMark, onJump }: {
  turns: TranscriptTurn[];
  seenMark: number;
  onJump: (n: number) => void;
}) {
  return (
    <>
      {turns.map((t) => {
        const isNew = seenMark > 0 && turnTs(t) > seenMark;
        return (
          <button className={`tr-ol-row${isNew ? " tr-ol-new" : ""}`} key={t.id} onClick={() => onJump(t.n)}>
            <div className="tr-ol-head">
              <span className="tr-n">#{t.n}</span>
              <span className="row-sub">{clock(t.sentAt)}</span>
              {/* Sent, and the CLI has not taken it yet — see `TranscriptTurn.queued`.
                  The row exists because this list looked wrong without it: the
                  newest thing the person had sent was simply absent for as long
                  as the running turn lasted. */}
              {t.queued && <span className="tag"><Clock size={11} /> waiting</span>}
              {t.toolCount > 0 && <span className="tag"><Wrench size={11} /> {t.toolCount}</span>}
              {t.files.length > 0 && <span className="tag"><FileCode2 size={11} /> {t.files.length}</span>}
              {isNew && <span className="tag new">new</span>}
            </div>
            <div className="tr-ol-prompt">{t.promptLabel}</div>
            {t.queued && <div className="tr-ol-sum">→ the CLI has not started it yet</div>}
            {t.summary && <div className="tr-ol-sum">→ {t.summary}</div>}
            {t.files.length > 0 && <div className="tr-ol-files">{t.files.slice(0, 4).join(" · ")}{t.files.length > 4 ? " …" : ""}</div>}
          </button>
        );
      })}
    </>
  );
}

interface Props {
  sessionId: string;
  title: string;
  /** Jump to that turn in the reader (the caller switches views if needed). */
  onJump: (n: number) => void;
  onClose: () => void;
}

/**
 * The outline as a SHEET — the skimmable table of contents of a conversation,
 * reachable from the terminal as well as from the reader.
 *
 * It was a drawer inside `TranscriptView` only, which meant "where am I in this
 * session?" was answerable exclusively in reader view: from the CLI you first
 * had to swap the whole view to find out, and it could not be pinned to the
 * header at all. It fetches the same `/api/transcript` document the reader does
 * and seeds from the same IndexedDB cache, so it renders offline exactly like
 * the reader's own outline rather than going blank.
 */
export function OutlineSheet({ sessionId, title, onJump, onClose }: Props) {
  const [doc, setDoc] = useState<TranscriptDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offlineAt, setOfflineAt] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const liveRef = useRef(false);
  const aliveRef = useRef(true);
  /** The IndexedDB probe has not answered yet. Same rule as the reader's: the
   *  spinner waits for the CACHE, never for the host — otherwise it covers a
   *  document already on the phone for the length of the fetch fuse. */
  const [probing, setProbing] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.transcript(sessionId);
      if (!aliveRef.current) return;
      liveRef.current = true;
      if (next) setDoc(next);
      setOfflineAt(null);
      setErr(null);
    } catch (e) {
      // Same rule as the reader: keep serving whatever is already on screen (or
      // the cache) flagged as stale, and only show an error when there is truly
      // nothing to show.
      const cached = await getTranscript(sessionId);
      if (!aliveRef.current) return;
      if (cached) { setDoc(cached); setOfflineAt(cached.updatedAt); }
      else if (String(e).includes("404")) setErr("Nothing recorded for this session yet.");
      else setErr(isOffline(e)
        ? "Can't reach the host, and there's no outline saved on this device for this session yet."
        : String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    aliveRef.current = true;
    // Cache first (instant, and the only source with no tunnel), live fetch on
    // top of it — the reader's own seeding rule.
    setProbing(true);
    void getTranscript(sessionId)
      .then((cached) => { if (cached && aliveRef.current && !liveRef.current) setDoc(cached); })
      .finally(() => { if (aliveRef.current) setProbing(false); });
    void load();
    return () => { aliveRef.current = false; };
  }, [sessionId, load]);

  const seenMark = useMemo(() => readSeen(sessionId), [sessionId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `doc?.turns ?? []` is a new array only while no doc is loaded; memoising would change when the filter recomputes
  const turns = doc?.turns ?? [];
  const waiting = turns.filter((t) => t.queued).length;
  const shown = useMemo(
    () => (q ? turns.filter((t) => matches(turnText(t), q)) : turns),
    [turns, q],
  );

  return (
    <div className="sheet">
      <SheetHead title={<>Outline · {title}</>} onClose={onClose}>
        <button className="key" title="refresh" onClick={() => void load()}><RotateCw size={14} /></button>
      </SheetHead>
      <div className="tr-bar">
        <div className="tr-find">
          <Search size={13} />
          <input
            value={q}
            placeholder="find a turn"
            onChange={(e) => { if (!q && e.target.value) track("action:outline.find"); setQ(e.target.value); }}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
          />
          {q && <button className="key" title="clear" onClick={() => setQ("")}><X size={13} /></button>}
        </div>
      </div>
      {offlineAt != null && (
        <div className="tr-status" title="couldn't reach the host just now — showing the transcript saved on this device">
          <CloudOff size={13} />
          <span className="tr-live-what">showing cached transcript — as of {clock(offlineAt)}</span>
        </div>
      )}
      <div className="tr-outline tr-outline-full">
        <div className="form-hint">
          {shown.length} turn{shown.length === 1 ? "" : "s"}{q ? ` matching “${q}”` : ""}
          {/* Counted APART from the turns, because a queued row is not one: it
              is a prompt sitting in that session's composer. Saying "3 turns"
              for two turns and a waiting prompt would make the number the
              thing that is wrong. */}
          {waiting > 0 && ` · ${waiting} waiting`} · tap to jump into the reader
          {doc?.source === "history" && " · approximate (no conversation log for this session — showing captured terminal text)"}
          {doc?.truncated && " · older turns trimmed"}
        </div>
        {/* Only once the cache has been asked and had nothing — see `probing`. */}
        {loading && !doc && !probing && <Empty>Reading the transcript…</Empty>}
        {err && !doc && <Empty><AlertTriangle size={14} /> {err}</Empty>}
        {doc && turns.length === 0 && <Empty>No turns recorded yet.</Empty>}
        <OutlineRows turns={shown} seenMark={seenMark} onJump={onJump} />
      </div>
    </div>
  );
}
