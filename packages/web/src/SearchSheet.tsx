import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, BookOpen, CornerUpRight, ListTodo, MessageSquare, Search, Slash } from "lucide-react";
import type { SessionInfo, SessionSearchMatch, SessionSearchResult, SessionSearchScope } from "@waterplane/shared";
import { track } from "./usage";
import { ago } from "./format";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { SessionFacts } from "./sessionFacts";
import type { BackendList } from "./backendCaps";
import { Hint } from "./kit/Hint";
import { FilterChip } from "./kit/FilterChip";

interface Props {
  /** The host's backends, so a session row knows a shell by kind. */
  backends?: BackendList;
  /** Session to scope to (in-CLI find). null = search across all sessions. */
  sessionId: string | null;
  /** Title of the scoped session, shown in the header when sessionId is set. */
  sessionLabel?: string;
  /** Words to open with (the launcher filter's text); searched at once like typed ones. */
  initialQuery?: string;
  /** Results for the last query (null = nothing searched yet). */
  results: SessionSearchResult[] | null;
  /** A request is in flight. */
  loading: boolean;
  /**
   * True while the socket is up.
   *
   * A search is a SOCKET round trip, not an HTTP read, so it cannot go through
   * `useRemoteResource` — but it has the same failure the hook was written
   * about: with the tunnel down the request never leaves, nothing ever answers,
   * and the sheet sat on "Searching…" for ever. That is a screen quietly
   * claiming to be working. Say which nothing it is instead.
   */
  online?: boolean;
  /** Fire a search over the wire (App owns the socket + result state). `archived` also
   *  searches the prompts of archived conversations (all-sessions search only). */
  onSearch: (query: string, scope: SessionSearchScope, archived: boolean) => void;
  /** What the last answer said about the archive (null = no answer yet). */
  archive?: { asked: boolean; searched: boolean; omitted: number } | null;
  /** Open an archived hit in the archive's reader; null when its repo is not one this phone
   *  lists (the row then says so instead of offering a tap that goes nowhere). */
  openArchived?: (r: SessionSearchResult) => (() => void) | null;
  /**
   * The live session list, so a result can say what the launcher row says.
   *
   * A hit used to name a session by title, repo and hit count alone — three
   * strings that do not answer "which of my eleven sessions is this, and what
   * was it doing". The host searches exactly the sessions this list holds
   * (`SessionManager.search` walks its own map), so the facts are already on
   * the phone: no wire change, and one derivation (`sessionFacts.ts`) behind
   * both screens. A result whose session is not in the list still renders —
   * with what the result itself carries, and nothing invented.
   */
  sessions?: SessionInfo[];
  /** Open a session from a result (cross-session search only). */
  onOpenSession: (id: string) => void;
  onClose: () => void;
}

const KIND_ICON = { prompt: MessageSquare, command: Slash, backlog: ListTodo } as const;

/** The three stores, in the order they are offered. */
const SCOPES: [SessionSearchScope, string][] = [
  ["prompts", "my prompts"],
  ["recent", "recent output"],
  ["history", "full history"],
];

/** What each store actually reads — said, because the difference is the feature. `line` is the one
 *  line always on screen; `more` is the rest of the same sentence, behind a closed `Explain`. */
const SCOPE_HINT: Record<SessionSearchScope, { line: string; more: string }> = {
  prompts: { line: "Searches only what was sent in.", more: "Prompts, slash commands and filed backlog items — never the CLI's reply." },
  recent: { line: "Searches the current terminal output.", more: "What's on screen now (plus a shell's scrollback)." },
  history: { line: "Searches the full saved history.", more: "The saved prompt + output of every turn — deepest, may be older." },
};

/** Wrap every case-insensitive occurrence of `q` in the line with <mark>. */
function highlight(line: string, q: string) {
  if (!q) return line;
  const lc = line.toLowerCase(), needle = q.toLowerCase();
  const parts: (string | JSX.Element)[] = [];
  let from = 0, at = lc.indexOf(needle), n = 0;
  while (at !== -1) {
    if (at > from) parts.push(line.slice(from, at));
    parts.push(<mark key={n++}>{line.slice(at, at + q.length)}</mark>);
    from = at + q.length;
    at = lc.indexOf(needle, from);
  }
  if (from < line.length) parts.push(line.slice(from));
  return parts;
}

function Snippet({ m, q }: { m: SessionSearchMatch; q: string }) {
  return (
    <div className="srch-snip">
      {m.turn && (
        <div className="srch-turn">
          {(() => { const I = KIND_ICON[m.turn.kind]; return <I size={11} />; })()}
          <span className="srch-turn-text">{m.turn.text || m.turn.kind}</span>
          <span className="srch-turn-ago">{ago(m.turn.sentAt)}</span>
        </div>
      )}
      <pre className="srch-lines">
        {m.before.map((l, i) => <div key={`b${i}`} className="srch-ctx">{l || " "}</div>)}
        <div className="srch-hit">{highlight(m.hit, q)}</div>
        {m.after.map((l, i) => <div key={`a${i}`} className="srch-ctx">{l || " "}</div>)}
      </pre>
    </div>
  );
}

/**
 * Word search over terminal text, read-in-place (no jumping into the terminal —
 * claude's alt-screen has no scrollback to jump into, and it's a phone anyway).
 * Scoped to one session (in-CLI find) or all sessions (main-screen search).
 *
 * THREE stores, because "what did I ask for" is a different question from "what
 * came back": my prompts = the recorded prompts alone, recent output = the
 * current rendered terminal text, full history = the persisted prompt AND
 * output of every turn. `full history` answered the first question by burying
 * it — a word common to a prompt and the reply to it matches the CLI's own
 * output hundreds of times over the one line somebody typed.
 */
export function SearchSheet({ sessionId, sessionLabel, initialQuery, results, loading, online = true, sessions, backends, onSearch, archive, openArchived, onOpenSession, onClose }: Props) {
  // Seeded from the launcher's quick filter: "search what they said" carries the typed words.
  const [q, setQ] = useState(initialQuery ?? "");
  /**
   * Also search ARCHIVED conversations — every closed one the CLI still has a log of. Off by
   * default: the open sessions are what this sheet is for, and the archive is thousands of
   * conversations. What it reads there is the person's PROMPTS alone, whatever the scope, because
   * the logs themselves are far too big to scan per keystroke — the hint says so when it is on.
   */
  const [withArchive, setWithArchive] = useState(false);
  const archiveOn = withArchive && !sessionId;
  /**
   * The default is the question the surface is FOR, and the two surfaces are
   * not asking the same one.
   *
   * Across sessions the search is "where did I say that" — the words are the
   * user's own and they are the thing being looked for, so `prompts` opens.
   * Inside one session this sheet IS the CLI's find, opened from the terminal
   * toolbar over what is on the screen; defaulting that to prompts would answer
   * a question nobody asked there.
   */
  const [scope, setScope] = useState<SessionSearchScope>(sessionId ? "recent" : "prompts");
  // The query that produced the currently-shown results, so highlighting matches
  // what the host actually searched (not what's mid-typing in the box).
  const [shown, setShown] = useState("");
  const timer = useRef<number | undefined>(undefined);

  // Debounce: search 300ms after typing settles (≥2 chars); scope flip searches now.
  useEffect(() => {
    clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) return;
    timer.current = window.setTimeout(() => {
      setShown(query); track(`action:search.${scope}${archiveOn ? ".archived" : ""}`); onSearch(query, scope, archiveOn);
    }, 300);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounced on the query, scope and archive switch; `onSearch` is a parent callback, not guaranteed stable
  }, [q, scope, archiveOn]);

  const totalHits = useMemo(() => (results ?? []).reduce((n, r) => n + r.total, 0), [results]);
  const archivedCount = useMemo(() => (results ?? []).filter((r) => r.archived).length, [results]);
  const liveCount = (results?.length ?? 0) - archivedCount;
  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);

  return (
    <div className="sheet">
      <SheetHead title={<><Search size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />
          {sessionId ? `Search · ${sessionLabel ?? "session"}` : "Search all sessions"}</>} onClose={onClose} />
      {/* Words to find, not a command: the UI font, like the fields around it. */}
      <input
        className="search"
        placeholder={sessionId ? "Find a word in this CLI…" : "Find a word in any session…"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      <div className="segmented srch-scope">
        {SCOPES.map(([key, label]) => (
          <button key={key} className={scope === key ? "seg on" : "seg"} onClick={() => setScope(key)}>{label}</button>
        ))}
      </div>
      <Hint>
        {SCOPE_HINT[scope].line}
        <Explain of="what this search reads">{SCOPE_HINT[scope].more}</Explain>
      </Hint>
      {!sessionId && (
        <div className="srch-archive">
          <FilterChip on={withArchive} title="also search the conversations you closed" onClick={() => setWithArchive((v) => !v)}>
            <Archive size={13} /> archived conversations
          </FilterChip>
        </div>
      )}
      {archiveOn && (
        <Hint>
          Archived conversations: your prompts only, never the replies.
          <Explain of="what the archived search reads">
            The desktop reads the CLI's own prompt history (every prompt typed into a session), because the
            conversation logs are far too big to search as you type. A headless run's prompts are not in it.
            Open a hit to read the whole conversation, and resume it from there.
          </Explain>
        </Hint>
      )}

      <div className="list">
        {q.trim().length < 2 && <Empty>Type at least 2 characters.</Empty>}
        {/* A search is not a `useRemoteResource` read — it is a socket
            request per keystroke-batch — so the state is hand-held here and
            only the WORDING is shared. `offline` and a plain empty result stay
            separate for the reason the hook keeps them separate. */}
        {q.trim().length >= 2 && !online && results == null && (
          <Empty res={{ state: "offline" }} thing="the sessions being searched" />
        )}
        {q.trim().length >= 2 && online && loading && results == null && <Empty>Searching…</Empty>}
        {results != null && q.trim().length >= 2 && (
          totalHits === 0
            ? <Empty>No matches for “{shown}”.</Empty>
            : <>
                <Hint>
                  {totalHits} match{totalHits === 1 ? "" : "es"} in {liveCount} session{liveCount === 1 ? "" : "s"}
                  {archivedCount > 0 && <> and {archivedCount} archived conversation{archivedCount === 1 ? "" : "s"}</>}
                  {loading ? " · updating…" : ""}
                </Hint>
                {results.map((r) => (
                  <div key={r.id} className="srch-sess">
                    {!sessionId && r.archived && (() => {
                      const open = openArchived?.(r) ?? null;
                      const head = (
                        <span className="srch-sess-line">
                          <span className="srch-sess-title">{r.title}</span>
                          <span className="srch-sess-repo">{r.repoLabel} · archived</span>
                          <span className="srch-sess-count">{r.total}</span>
                          {open && <BookOpen size={13} />}
                        </span>
                      );
                      return open
                        ? <button className="srch-sess-head" onClick={open} title="read this conversation">{head}</button>
                        : <div className="srch-sess-head">{head}<Hint>Its folder is not one of this phone's repos, so it cannot be opened from here.</Hint></div>;
                    })()}
                    {!sessionId && !r.archived && (() => {
                      const s = byId.get(r.id) ?? null;
                      return (
                        <button className="srch-sess-head" onClick={() => onOpenSession(r.id)} title="open this session">
                          <span className="srch-sess-line">
                            <span className="srch-sess-title">{r.title}</span>
                            <span className="srch-sess-repo">{r.repoLabel}{!s && !r.running ? " · exited" : ""}</span>
                            <span className="srch-sess-count">{r.total}</span>
                            <CornerUpRight size={13} />
                          </span>
                          {/* Everything the launcher row says about this
                              session — status, launch, open-for, first … last
                              prompt — when the list has it. When it does not,
                              the header above is all we honestly know. */}
                          {s && <SessionFacts s={s} backends={backends} />}
                        </button>
                      );
                    })()}
                    {r.matches.map((m, i) => <Snippet key={i} m={m} q={shown} />)}
                    {r.total > r.matches.length && (
                      <div className="srch-more">+{r.total - r.matches.length} more match{r.total - r.matches.length === 1 ? "" : "es"} (refine the search)</div>
                    )}
                  </div>
                ))}
              </>
        )}
        {results != null && q.trim().length >= 2 && archive?.asked && !archive.searched && (
          <Hint>Archived conversations were not searched: this desktop runs an older version, or keeps no prompt history to read.</Hint>
        )}
        {results != null && q.trim().length >= 2 && archive?.searched && archive.omitted > 0 && (
          <div className="srch-more">+{archive.omitted} more archived conversation{archive.omitted === 1 ? "" : "s"} match (refine the search)</div>
        )}
      </div>
    </div>
  );
}
