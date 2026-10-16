/**
 * The webview's HintChip. The web app's chip opens a card through `hints.ts` → `storage.ts` and
 * `usage.ts` (localStorage, the host API) — none of which belong in a VS Code webview. This one has
 * the same props and reads the same catalog (`HINTS` from shared, one explanation per subject), but
 * opens inline as a `<details>`: a keyboard-reachable disclosure, no overlay, no state kept.
 * esbuild redirects every `HintChip` import from packages/web/src here.
 */
import { CircleHelp } from "lucide-react";
import { HINTS } from "@waterplane/shared";

export function HintChip({ id, of }: { id: string; of: string }) {
  const h = HINTS[id];
  if (!h) return null;
  return (
    <details className="hint-pop" onClick={(e) => e.stopPropagation()}>
      <summary aria-label={`what ${of} means`} title={h.title}>
        <CircleHelp size={13} aria-hidden />
      </summary>
      <div className="hint-card" role="note">
        <b>{h.title}</b>
        <p>{h.what}</p>
        {h.when ? <p>{h.when}</p> : null}
      </div>
    </details>
  );
}
