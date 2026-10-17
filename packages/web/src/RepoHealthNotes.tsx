/**
 * The repo-health daily notes, folded — split from `RepoHealthCards.tsx` so
 * that frame stays free of `api.ts` and `Markdown` (the VS Code Health view
 * imports it, and has no narrative to fold).
 */
import { copyText } from "./api";
import { Markdown } from "./Markdown";
import { notesSummaryWords } from "./repoHealthWords";

/**
 * The daily notes: ONE closed row, newest first when opened. They used to be
 * a block per day under every chart — the longest thing on the screen, and
 * the least read. Each day is re-joined exactly as the tool wrote it.
 */
export function DailyNotes({ days }: { days: readonly { day: string; body: string }[] }) {
  if (!days.length) return null;
  return (
    <details className="hint-more rh-notes">
      <summary>{notesSummaryWords(days.length)}</summary>
      {days.map((d) => (
        <div className="tr-say rh-doc" key={d.day}>
          <Markdown src={`## ${d.day}${d.body}`} q="" onCopy={(t) => void copyText(t)} />
        </div>
      ))}
    </details>
  );
}
