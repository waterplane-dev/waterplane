import { CornerDownRight, Flag, Pin } from "lucide-react";
import { promptPairParts } from "./promptPairParts";

/** First prompt and latest prompt, verbatim, as two stacked parts. The one
 *  place a session row's hint text is drawn (live rows, search/close sheets,
 *  recently closed). Renders nothing when neither prompt is known. */
export function PromptPair(o: { firstPrompt?: string; lastPrompt?: string; pinnedPrompt?: string; className?: string }) {
  const p = promptPairParts(o);
  if (!p.first && !p.now) return null;
  return (
    <span className={`prompt-pair${o.className ? ` ${o.className}` : ""}`}>
      {p.first && (
        <span className="pp-part pp-start">
          <span className="pp-label"><Flag size={11} /> Started</span>
          <span className="pp-text">{p.first}</span>
        </span>
      )}
      {p.now && (
        <span className="pp-part pp-now">
          <span className="pp-label">
            {p.nowKind === "pinned" ? <Pin size={11} /> : <CornerDownRight size={11} />} {p.nowKind === "pinned" ? "Pinned" : "Latest"}
          </span>
          <span className="pp-text">{p.now}</span>
        </span>
      )}
    </span>
  );
}
