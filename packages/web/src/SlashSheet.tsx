import { useMemo, useState } from "react";
import { CircleAlert, CloudOff, Loader2 } from "lucide-react";
import { api, type SlashCommand } from "./api";
import { getSlashCacheEntry, putSlashCache } from "./offlineCache";
import { useRemoteResource, agoText } from "./useRemoteResource";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";
import { Unavailable } from "./Unavailable";

interface Props {
  cwd: string;
  onPick: (name: string, runNow: boolean) => void;
  /**
   * Why there is no palette here — passed only when the session's backend does
   * not understand slash commands at all (`backendCaps.ts`).
   *
   * The sheet then shows the sentence and reads NOTHING: a host round-trip for
   * a repo's `.claude/commands` would answer honestly and still be about the
   * wrong thing, and its empty state ("No matches", "this repo's commands")
   * would be a claim about the repo rather than about the binary in the PTY.
   * Words, never a greyed-out list (`Unavailable.tsx`).
   */
  unsupported?: string;
  onClose: () => void;
}

/** Slash-command palette. Tap inserts into the compose box; ⏎ runs it now. */
export function SlashSheet({ cwd, onPick, unsupported, onClose }: Props) {
  const [q, setQ] = useState("");
  /**
   * One host read, told honestly (`useRemoteResource`).
   *
   * This sheet hand-rolled it: a `cmds` seeded from the cache, a `loading`, a
   * `stale`, and a `.catch` that collapsed "the host said no" into the same
   * grey "cached list" as "the tunnel is down". Those are different next
   * actions — one is a repo the daemon refused to read, the other is a tunnel —
   * and telling them apart is what the hook is for. The cache is still the
   * palette's own (`offlineCache.ts`), keyed per repo; only the five states and
   * the age label are now shared.
   */
  const res = useRemoteResource<SlashCommand[]>(cwd, () => api.slash(cwd), {
    // Not even asked for a backend that has no such concept — see `unsupported`.
    enabled: !unsupported,
    fromCache: async () => getSlashCacheEntry(cwd),
    toCache: (list) => putSlashCache(cwd, list),
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `res.data ?? []` is a new array only while nothing has loaded; memoising would change when the filter recomputes
  const cmds = res.data ?? [];

  const filtered = useMemo(
    () => cmds.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || (c.description ?? "").toLowerCase().includes(q.toLowerCase())),
    [cmds, q],
  );

  if (unsupported) {
    return (
      <div className="sheet">
        <SheetHead title={"Slash commands"} onClose={onClose} />
        <Unavailable cants={[{ label: "slash commands", reason: unsupported }]} />
      </div>
    );
  }

  return (
    <div className="sheet">
      <SheetHead title={"Slash commands"} onClose={onClose}>
        {res.state === "loading" && <span className="gallery-meta"><Loader2 size={12} className="spin" /> loading…</span>}
        {/* Cached rows ALWAYS say how old they are — the one promise this
            palette used to make with the word "cached" and no number. */}
        {res.state === "cached" && res.age != null && <span className="gallery-meta"><CloudOff size={12} /> cached · {agoText(res.age)}</span>}
        {res.state === "offline" && <span className="gallery-meta"><CloudOff size={12} /> offline</span>}
        {res.state === "error" && <span className="gallery-meta"><CircleAlert size={12} /> host refused</span>}
      </SheetHead>
      <div className="btw-row">
        <button className="btw" onClick={() => onPick("/btw ", false)}>
          /btw — queue a note without interrupting
        </button>
      </div>
      <input className="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="list">
        {filtered.map((c) => (
          <div key={c.name} className="cmd-row">
            <button className="cmd-name" onClick={() => onPick(c.name + " ", false)}>
              <span className="mono">{c.name}</span>
              <span className={`src src-${c.source}`}>{c.source}</span>
            </button>
            {c.description && <span className="cmd-desc">{c.description}</span>}
            <button className="run" onClick={() => onPick(c.name, true)}>run</button>
          </div>
        ))}
        {/* Four states, one worded ladder (`Empty.tsx`). The way out — typing
            the command by hand — holds whatever the state is, which is why it
            is a `note` and not part of any one sentence. */}
        <Empty res={res} empty={filtered.length === 0} thing="this repo’s commands" noun="palette"
          note="You can still type any command.">
          No matches.
        </Empty>
      </div>
    </div>
  );
}
