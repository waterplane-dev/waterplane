/**
 * The `search` overlay: `SearchSheet.tsx` wired to this feature's store — the
 * prop list `App.tsx`'s `overlayViews.search` used to spell out.
 */
import { useCore, useStore } from "../../sdk";
import { SearchSheet } from "../../SearchSheet";
import { search } from "./store";
import { fireSearch } from "./actions";
import { openArchivedConversation } from "../../archiveOpen";

export function SessionSearchSheet() {
  const c = useCore();
  const { scope, results, loading, archive } = useStore(search);
  const sessions = c.world.sessions;
  return (
    <SearchSheet
      sessionId={scope}
      sessionLabel={scope ? sessions.find((s) => s.id === scope)?.title : undefined}
      results={results}
      loading={loading}
      online={c.conn.status === "open"}
      sessions={sessions}
      backends={c.world.backends}
      onSearch={fireSearch}
      archive={archive}
      // An archived hit opens in the archive's reader, under the repo whose folder it ran in —
      // only a repo this phone lists, since the archive sheet is per repo.
      openArchived={(r) => {
        const repo = c.world.visibleRepos.find((x) => x.worktreePath === r.cwd);
        if (!repo) return null;
        return () => openArchivedConversation(repo.id, { id: r.id, cwd: r.cwd, title: r.title, mtime: r.matches[0]?.turn?.sentAt ?? 0, size: 0 });
      }}
      onOpenSession={(id) => { const s = sessions.find((x) => x.id === id); if (s) c.nav.attach(s); else c.nav.close("search"); }}
      onClose={() => c.nav.close("search")} />
  );
}
