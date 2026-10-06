/**
 * The `search` overlay: `SearchSheet.tsx` wired to this feature's store — the
 * prop list `App.tsx`'s `overlayViews.search` used to spell out.
 */
import { useCore, useStore } from "../../sdk";
import { SearchSheet } from "../../SearchSheet";
import { search } from "./store";
import { fireSearch } from "./actions";

export function SessionSearchSheet() {
  const c = useCore();
  const { scope, results, loading } = useStore(search);
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
      onOpenSession={(id) => { const s = sessions.find((x) => x.id === id); if (s) c.nav.attach(s); else c.nav.close("search"); }}
      onClose={() => c.nav.close("search")} />
  );
}
