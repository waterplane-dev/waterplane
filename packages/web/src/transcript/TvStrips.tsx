import { Bot, CloudOff } from "lucide-react";
import { agoText } from "../useRemoteResource";
import { clock } from "../transcriptUtil";
import { since } from "./tvRows";
import type { TvModel } from "./useTranscriptView";

/** The live strip, one row per running agent, and the cached-copy notice. */
export function TvStrips({ m }: { m: TvModel }) {
  const {
    status, live, stale, liveTitle, work, shellFirstWords, now, onOpenShells, asking, onAnswer, agents,
    offlineAt, cachedAt,
  } = m;
  return (
    <>
      {live && (
        /* `tr-live` separates this strip — a readout of what the session is
           doing RIGHT NOW — from the cached-copy notice below, which is an
           honesty marker and stays up in every mode. */
        <div className={`tr-status tr-live tr-${live.kind}${stale ? " tr-linkdown" : ""}`} title={liveTitle}>
          {stale ? <CloudOff size={13} /> : <span className="tr-live-dot" />}
          <span className="tr-live-what">{stale ? `${live.text} — last known` : live.text}</span>
          {work && <span className="tr-live-line">{work.text}</span>}
          {/* The first shell's own sentence — one row of `shellWords`, never
              "hung"/"stuck"/"dead". Every shell, and the door to stop one, is
              the sheet this strip only OPENS. */}
          {live.kind === "shells" && shellFirstWords && <span className="tr-live-line">{shellFirstWords}</span>}
          {status?.lastOutputAt != null && (stale || live.kind === "busy") && (
            <span className="tr-live-ago">out {since(status.lastOutputAt, now)}</span>
          )}
          {live.kind === "shells" && onOpenShells && (
            <button className="tr-live-go" onClick={onOpenShells}>see shells</button>
          )}
          {/* The card is answered where it sits, at the TAIL, and the reader
              scrolls there once when the question appears — so the one state
              this strip cannot leave as a readout is the one where scrolling up
              to read history puts the only control off the screen. The strip is
              already saying "waiting for your answer"; this is the way back to
              it. Never drawn for a question there is nothing to tap on. */}
          {asking && status?.prompt && onAnswer && (
            <button className="tr-live-go" onClick={() => document.getElementById("tr-ask")?.scrollIntoView({ block: "end", behavior: "smooth" })}>
              answer it
            </button>
          )}
        </div>
      )}

      {/* One row per agent, because the COUNT is not the progress: "2 agents
          running" answers how many and nothing about what, and the whole reason
          this view exists is that the terminal's own agent panel is two taps
          and a keystroke away on a phone. Rendered whenever agents are running,
          including through a busy turn (a foreground Task call is the same
          fact) — but never as a claim of freshness: with the link down the
          strip above already says "last known", and these rows are part of that
          same snapshot. */}
      {agents.map((a) => (
        <div className="tr-status tr-agent" key={a.id} title={a.type ? `${a.type}${a.model ? ` · ${a.model}` : ""}` : undefined}>
          <Bot size={13} />
          <span className="tr-live-what">{a.what}</span>
          {a.doing && <span className="tr-live-line">{a.doing}</span>}
          <span className="tr-live-ago">{since(a.startedAt, now)}</span>
        </div>
      ))}

      {/* Sticky, not a one-shot toast — stays up for as long as what's on
          screen is stale, and disappears the moment a fetch actually lands.
          Raised by the cache SEED as well as by a failed fetch: painting a
          saved copy and saying nothing for the twelve seconds the fuse allows
          is a screen quietly claiming to be current, which is the failure the
          rest of this app now refuses everywhere else. The wording splits the
          two facts, because they are two: when this phone SAVED the copy, and
          when the conversation in it last moved. */}
      {(offlineAt != null || cachedAt != null) && (
        <div className="tr-status" title="showing the transcript saved on this device">
          <CloudOff size={13} />
          <span className="tr-live-what">
            {offlineAt != null ? "showing cached transcript" : "cached copy — still asking the host"}
            {cachedAt != null ? ` — saved ${agoText(Date.now() - cachedAt)}` : ""}
            {offlineAt != null ? `, newest turn ${clock(offlineAt)}` : ""}
          </span>
        </div>
      )}
    </>
  );
}
