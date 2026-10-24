import { useEffect, useState } from "react";
import { BRAND } from "@waterplane/shared";
import type { TabId } from "../src/protocol";
import { loadTab, post, TAB_IDS, saveTab, useExtension } from "./host";
import { SessionView } from "./SessionView";
import { OverviewView } from "./OverviewView";
import { WeightView } from "./WeightView";
import { HealthView } from "./HealthView";
import { PromptsView } from "./PromptsView";
import { ViewHead } from "./ViewHead";

const IDS = TAB_IDS;

/**
 * The panel: one view at a time, picked in the activity-bar tree (it sends `tab`). No tab bar and no
 * session list here — those live in the tree, so the same list is never on screen twice.
 */
export function App() {
  const [tab, setTab] = useState<TabId>(() => loadTab(IDS, "all"));
  const [turn, setTurn] = useState<number | null>(null);
  // A ledger tab All sessions was asked to open on (the tree's Copilot row); every tree click sets it anew.
  const [ledger, setLedger] = useState<string | null>(null);
  const choose = (id: TabId) => { setTab(id); saveTab(id); };
  // The tree asked for a view: it arrives after `ready`, so it wins over the remembered one.
  const { session, sessions, corpus, live, weight, prompts, folders, health } = useExtension((id, led) => { if (IDS.includes(id)) { choose(id); setLedger(led ?? null); } });

  // A selected prompt belongs to one session; another session's numbers mean nothing.
  const sessionId = session?.doc?.id;
  useEffect(() => setTurn(null), [sessionId]);

  // The Health view reads (status + plot, cached by the extension) whenever it comes on screen or the folder changes.
  const folder = session?.folder ?? folders.active;
  useEffect(() => {
    if (tab === "health" && folder) post({ t: "healthRead", folder });
  }, [tab, folder]);

  const h = folder ? health[folder] : undefined;

  return (
    <div className="app">
      <ViewHead tab={tab} folder={folder} following={session?.following ?? true} scannedAt={corpus?.doc?.scannedAt ?? null} post={post}
        row={sessions && sessions.folder === folder ? sessions.rows.find((r) => r.id === (session?.doc?.id ?? sessions.selected)) ?? null : null} />

      <main id={`panel-${tab}`} tabIndex={-1}>
        {tab === "session" && (
          <SessionView doc={session?.doc ?? null} why={session ? session.why : "Waiting for the extension…"}
            prompts={prompts.list} terminal={prompts.terminal} selectedTurn={turn} onSelectTurn={setTurn} post={post} />
        )}
        {tab === "all" && <OverviewView doc={corpus?.doc ?? null} why={corpus ? corpus.why : "Waiting for the extension…"} scanning={corpus?.scanning} live={live} post={post} askedLedger={ledger} />}
        {tab === "always-on" && (
          <WeightView doc={weight?.doc ?? null} why={weight ? weight.why : "Waiting for the extension…"}
            prompts={prompts.list} terminal={prompts.terminal} post={post} />
        )}
        {tab === "health" && (
          folder ? (
            <HealthView folder={folder} doc={h?.doc ?? null} why={h ? h.why : "Waiting for the extension…"} run={h?.run ?? null}
              prompts={prompts.list} terminal={prompts.terminal} post={post} />
          ) : (
            <div className="empty absent" role="note">No folder is open, so there is no history to measure.</div>
          )
        )}
        {tab === "prompts" && (
          <PromptsView list={prompts.list} terminal={prompts.terminal} selectedTurn={turn}
            have={{ session: !!session?.doc, weight: !!weight?.doc, health: !!h?.doc?.plot, rising: !!h?.doc?.plot?.series.some((s) => s.reading?.slope === "rising") }} post={post} />
        )}
      </main>

      <footer>
        <button type="button" className="link-btn" onClick={() => post({ t: "open", url: `https://${BRAND.domain}` })}>
          drive these sessions from your phone → {BRAND.domain}
        </button>
      </footer>
    </div>
  );
}
