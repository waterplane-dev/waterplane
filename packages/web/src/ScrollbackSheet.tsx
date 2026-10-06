import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CloudOff, Monitor, Search, X } from "lucide-react";
import { api } from "./api";
import { screenLogFor } from "./screenlog";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";
import { ZoomPair } from "./ZoomPair";
import { nextReaderZoom, readerScale, scrollbackZoom, setScrollbackZoom, textScale } from "./uiScale";

interface Props {
  sessionId: string;
  title: string;
  /** The grid as it is right now — appended so the history runs up to "live". */
  live: string[];
  /** Socket state, only to label how current this is. */
  linkUp: boolean;
  onClose: () => void;
}

/**
 * Scrollback for the CLI view, from the DESKTOP where one can be had.
 *
 * Panning up in the terminal is a wheel event *for the TUI*, so it needs the
 * socket; with the tunnel down the gesture did nothing at all and the screen
 * just sat there. This sheet is where that pan goes instead.
 *
 * **Two sources, and they are not equally good.** The host has the session's
 * raw PTY bytes and one real VT to replay them through, so what it answers
 * (`/api/scrollback`) IS what a terminal showed — nothing inferred. This device
 * also keeps a copy (`screenlog.ts`), built by diffing one settled grid against
 * the previous one, and that copy is a RECONSTRUCTION: a view switch repaints
 * the whole grid, which cannot be told from an enormous scroll, so the outgoing
 * screen is archived whole and turns up a second time on the way back, while
 * anything painted with the app closed was never captured at all. Duplicated
 * blocks and missing ones — which is exactly how it reads.
 *
 * So the desktop's copy is asked for first and the device's is the FALLBACK,
 * for the case the whole sheet exists for: no link. Which one is on screen is
 * said in words, never left to be guessed from the content.
 *
 * It opens at the BOTTOM, where the terminal was, so scrolling up continues the
 * gesture that opened it rather than teleporting to the oldest line on record.
 */
export function ScrollbackSheet({ sessionId, title, live, linkUp, onClose }: Props) {
  // Snapshotted on open: the log keeps growing while this is up, and content
  // appearing above the reader's scroll position would shift the text under the
  // user's thumb. Closing and reopening shows the newest.
  const local = useMemo(() => {
    const known = screenLogFor(sessionId);
    // The live grid is usually the log's own `screen`, already at the end —
    // append it only when it isn't, so nothing is doubled. Trailing blank rows
    // are dropped on both sides (the log trims them; a raw grid does not).
    const tail = trimTrailingBlanks(live);
    return endsWith(known, tail) ? known : known.concat(tail);
  }, [sessionId, live]);

  /** The desktop's own copy, once it answers. `null` while it is being asked or
   *  after it failed — there is no third state to draw, because the fallback is
   *  already a complete answer and a spinner over it would hide readable text. */
  const [host, setHost] = useState<{ lines: string[]; bounded: boolean } | null>(null);
  /** The desktop answered, but with nothing this device does not already have.
   *  Its own words, because "the desktop has no history for this session" and
   *  "the desktop could not be reached" are different facts. */
  const [hostThin, setHostThin] = useState(false);
  const [asking, setAsking] = useState(linkUp);
  useEffect(() => {
    // Once, per successful read. `linkUp` is in the deps so a tunnel that
    // comes back mid-sheet still gets asked — but `host` short-circuits it, or
    // every flap would refetch and re-anchor the list under the reader's
    // thumb, which is the snapshot-on-open property this sheet is built on.
    if (!linkUp || host) { setAsking(false); return; }
    // `alive`, not `live` — the prop of that name is the visible grid.
    let alive = true;
    setAsking(true);
    api.scrollback(sessionId)
      .then((d) => {
        if (!alive || !d.lines.length) return;
        // **A host answer only WINS when it is actually more.** The desktop
        // cannot replay what scrolled away — the CLI draws in the alternate
        // screen — so it answers from a recording that begins when the daemon
        // starts watching. Restart it and that recording is one screen, while
        // this device may have been archiving the same session for an hour.
        // Taking the host's copy on principle threw that away and left a sheet
        // with nothing to scroll, which is exactly what was reported.
        if (d.history || d.lines.length > local.length) setHost({ lines: d.lines, bounded: d.bounded });
        else setHostThin(true);
      })
      .catch(() => { /* the device's own copy is the answer; the strip says so */ })
      .finally(() => { if (alive) setAsking(false); });
    return () => { alive = false; };
  }, [sessionId, linkUp, host, local.length]);

  const lines = host ? host.lines : local;

  const [q, setQ] = useState("");
  const [hit, setHit] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * How big this history is drawn — the terminal's corner pair, on the sheet
   * that shows what the terminal scrolled past.
   *
   * The want is the one the corner buttons answer, and it arrives here HARDER:
   * these lines were wrapped once already by an 80-column grid, so a phone
   * narrower than that wraps every one of them a second time and a sentence
   * arrives in three pieces. Smaller text is what puts a terminal line back on
   * one line.
   *
   * Its own stored value (`uiScale.ts`), not the console's: zooming the console
   * resizes the live GRID — the host is told the new cols/rows and the PTY is
   * resized — and reading an hour of history is not a reason to reshape the
   * session that wrote it. The mechanism is the reader's, because this is HTML:
   * one `--ui-font` override on the body, one repaint, no re-render of a
   * thousand lines.
   *
   * State mirrored so the buttons re-render; ends of the ladder drop the button
   * and say the word (`Unavailable.tsx` — never a dimmed one).
   */
  const [zoom, setZoom] = useState(() => scrollbackZoom());
  const txt = textScale();
  const smaller = nextReaderZoom(zoom, -1, txt);
  const bigger = nextReaderZoom(zoom, 1, txt);
  function applyZoom(v: number) {
    track("action:uiscale.scrollback");
    setZoom(v);
    setScrollbackZoom(v);
  }

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [] as number[];
    const out: number[] = [];
    lines.forEach((l, i) => { if (l.toLowerCase().includes(needle)) out.push(i); });
    return out;
  }, [q, lines]);

  // Open where the terminal was: at the newest line — and land there AGAIN if
  // the desktop's copy arrives and replaces the one already painted. Without
  // the second pass the list silently grows a few hundred lines above the
  // reader's thumb and the bottom of the history is no longer under it.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [host]);

  // A new search starts at the NEWEST match. The reader is parked at the bottom
  // of the history, so jumping to the oldest hit would throw away the position
  // the user came in with.
  useEffect(() => { setHit(Math.max(0, matches.length - 1)); }, [q, matches.length]);

  // Follow the current match.
  useEffect(() => {
    if (!matches.length) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-ln="${matches[hit]}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [hit, matches]);

  function step(dir: 1 | -1) {
    if (!matches.length) return;
    setHit((h) => (h + dir + matches.length) % matches.length);
  }

  const empty = lines.length === 0;
  return (
    <div className="sheet">
      <SheetHead title={<>Scrollback · {title}</>} onClose={onClose}>
        <span className="row-sub">{lines.length} line{lines.length === 1 ? "" : "s"}</span>
      </SheetHead>
      <div className="tr-bar">
        <div className="tr-find">
          <Search size={13} />
          <input
            value={q}
            placeholder="find in scrollback"
            onChange={(e) => { if (!q && e.target.value) track("action:scrollback.find"); setQ(e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
          />
          {q && <button className="key" title="clear" onClick={() => setQ("")}><X size={13} /></button>}
        </div>
        {q && (
          <div className="sb-hits">
            <span className="row-sub">{matches.length ? `${hit + 1}/${matches.length}` : "no match"}</span>
            <button className="key" title="previous match" disabled={!matches.length} onClick={() => step(-1)}><ArrowUp size={14} /></button>
            <button className="key" title="next match" disabled={!matches.length} onClick={() => step(1)}><ArrowDown size={14} /></button>
          </div>
        )}
        {/* Last in the bar and anchored right, the corner group's rule: the
            find field takes the slack, so these two sit at a fixed place and
            only slide when one of them drops off the end of its ladder. */}
        <div className="sb-zoom">
          <ZoomPair smaller={smaller} bigger={bigger} onZoom={applyZoom}
            smallerHint=" — fits more of each terminal line on one line"
            biggerHint=" — fewer characters across, so lines wrap more" />
        </div>
      </div>
      {/* WHICH copy this is, always — the two differ in what they can be
          trusted to contain, so leaving it to be inferred from the content is
          the one thing this sheet must not do. */}
      <div className="tr-status" title={host
        ? "recorded on the desktop, which watches this session whether or not the app is open"
        : hostThin
          ? "the desktop answered, but its recording of this session starts later than this device's — it only holds what it has watched since the daemon last started"
          : "the desktop could not be asked — this is the history this device reconstructed from what it displayed"}>
        {host ? <Monitor size={13} /> : <CloudOff size={13} />}
        <span className="tr-live-what">
          {/* Never "the whole session": what the desktop keeps is a bounded
              ring and a bounded replay, and the only thing that can be SHOWN
              is that one of those bounds was reached. Absent, the honest claim
              is simply where the text came from. */}
          {host
            ? (host.bounded ? "from the desktop — as far back as it kept" : "from the desktop")
            : asking ? "asking the desktop…"
            : hostThin ? "this device's own copy — the desktop has recorded less"
            : "this device's own copy — reconstructed"}
        </span>
      </div>
      {/* The zoom, as the reader applies it: one custom property on the body,
          which every size inside already multiplies by. */}
      <div className="sb-body" ref={bodyRef}
        style={{ ["--ui-font" as string]: String(readerScale(txt, zoom)) }}>
        {empty ? (
          <Empty>{asking ? "Asking the desktop for this session's scrollback…" : "Nothing recorded on this device yet — history starts the next time this session paints."}</Empty>
        ) : (
          <>
            <div className="form-hint sb-top">
              {host
                ? "Recorded on the desktop, which watches this session whether or not this app is open. It begins when the daemon does and what it keeps is bounded — ask the reader view for anything older."
                : "Reconstructed from what this device displayed — output that scrolled by while the app was closed was never here, and a view switch can leave a block in twice. Ask the session itself (or the reader view) for anything older."}
            </div>
            {lines.map((l, i) => (
              <div className={`sb-line${matches.length && matches[hit] === i ? " sb-hit" : ""}`} data-ln={i} key={i}>{l === "" ? " " : l}</div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}

function endsWith(hay: string[], tail: string[]): boolean {
  if (tail.length === 0) return true;
  if (tail.length > hay.length) return false;
  const off = hay.length - tail.length;
  for (let i = 0; i < tail.length; i++) if (hay[off + i] !== tail[i]) return false;
  return true;
}
