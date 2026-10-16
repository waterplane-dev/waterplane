import { useEffect, useMemo, useRef, useState } from "react";
import { CornerUpRight, ListTodo, MessageSquare, Search, Slash } from "lucide-react";
import type { SessionInfo, SessionSearchMatch, SessionSearchResult, SessionSearchScope } from "@waterplane/shared";
import { track } from "./usage";
import { ago } from "./format";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { SessionFacts } from "./sessionFacts";
import type { BackendList } from "./backendCaps";

interface Props {
  /** The host's backends, so a session row knows a shell by kind. */
  backends?: BackendList;
  /** Session to scope to (in-CLI find). null = search across all sessions. */
  sessionId: string | null;
  /** Title of the scoped session, shown in the header when sessionId is set. */
  sessionLabel?: string;
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
  /** Fire a search over the wire (App owns the socket + result state). */
  onSearch: (query: string, scope: SessionSearchScope) => void;
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
export function SearchSheet({ sessionId, sessionLabel, results, loading, online = true, sessions, backends, onSearch, onOpenSession, onClose }: Props) {
  const [q, setQ] = useState("");
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
    timer.current = window.setTimeout(() => { setShown(query); track(`action:search.${scope}`); onSearch(query, scope); }, 300);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounced on the query and scope; `onSearch` is a parent callback, not guaranteed stable
  }, [q, scope]);

  const totalHits = useMemo(() => (results ?? []).reduce((n, r) => n + r.total, 0), [results]);
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
      <div className="form-hint">
        {SCOPE_HINT[scope].line}
        <Explain of="what this search reads">{SCOPE_HINT[scope].more}</Explain>
      </div>

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
                <div className="form-hint">{totalHits} match{totalHits === 1 ? "" : "es"} in {results.length} session{results.length === 1 ? "" : "s"}{loading ? " · updating…" : ""}</div>
                {results.map((r) => (
                  <div key={r.id} className="srch-sess">
                    {!sessionId && (() => {
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
      </div>
    </div>
  );
}
