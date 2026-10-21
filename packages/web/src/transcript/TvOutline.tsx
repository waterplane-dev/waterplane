import { OutlineRows } from "../OutlineSheet";
import type { TvModel } from "./useTranscriptView";
import { Hint } from "../kit/Hint";

export function TvOutline({ m }: { m: TvModel }) {
  const { outline, outlineTurns, q, doc, seenMark, goTurn } = m;
  if (!outline) return null;
  return (
    <div className="tr-outline">
      <Hint>
        {outlineTurns.length} turn{outlineTurns.length === 1 ? "" : "s"}
        {q ? ` matching “${q}”` : ""} · tap to jump
        {/* `"history"` is the ONLY approximate source, and the test is
            written as an equality against it rather than as "not jsonl" for
            exactly that reason: `"opencode"` is the backend's own dated
            record read out of its store — as exact as the CLI's log — and a
            `!== "jsonl"` here would have libelled it as reconstructed
            terminal text. It also means an older phone meeting a source it
            has never heard of reads it as exact, which is correct: the
            approximate one is the one this app builds itself. */}
        {doc?.source === "history" && " · approximate (no conversation log for this session — showing captured terminal text)"}
        {doc?.truncated && " · older turns trimmed"}
      </Hint>
      <OutlineRows turns={outlineTurns} seenMark={seenMark} onJump={goTurn} />
    </div>
  );
}
