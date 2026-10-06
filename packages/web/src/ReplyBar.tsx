import { useState } from "react";
import { Bot } from "lucide-react";
import type { AnswerSuggestion } from "@waterplane/shared";
import { suggestionBy } from "./suggestionBy";

/** Editable suggested reply for a free-text question, drafted by a plugin (suggest-only; you confirm/edit). */
export function ReplyBar({ suggestion, onSend, onDismiss }: {
  suggestion: AnswerSuggestion;
  onSend: (text: string) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState(suggestion.reply || "");
  return (
    <div className="approve reply">
      <div className="reply-head">
        <span className="reply-title"><Bot size={14} /> {suggestionBy(suggestion)} suggests a reply</span>
        <span className="reply-conf" title={`how sure ${suggestion.byName} says it is`}>{(suggestion.confidence * 100).toFixed(0)}%</span>
      </div>
      {suggestion.rationale && <div className="reply-why">{suggestion.rationale}</div>}
      <textarea className="reply-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Suggested reply… (edit before sending)" />
      <div className="approve-opts">
        <button className="approve-btn primary" disabled={!text.trim()} onClick={() => onSend(text.trim())}><Bot size={14} /> Send reply</button>
        <button className="approve-esc" onClick={onDismiss}>dismiss</button>
      </div>
    </div>
  );
}
