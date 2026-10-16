/** The one door to the extension host: `acquireVsCodeApi()` may be called ONCE per webview. */
import { useEffect, useRef, useState } from "react";
import type {
  CorpusDoc, HealthDoc, HealthRunState, PromptDef, SessionDoc, SessionSummary, TabId, ToExtension, ToWebview, WeightDoc,
} from "../src/protocol";

interface VsCodeApi {
  postMessage(m: ToExtension): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi = acquireVsCodeApi();

export const post = (m: ToExtension): void => api.postMessage(m);

/** The state this webview keeps across hides: the selected tab and nothing else. */
export function loadTab<T extends string>(valid: readonly T[], fallback: T): T {
  const s = api.getState() as { tab?: string } | undefined;
  return valid.find((t) => t === s?.tab) ?? fallback;
}
export const saveTab = (tab: string): void => api.setState({ tab });

// ── the extension's state, one subscription for the panel's App ──

export interface HealthState { doc: HealthDoc | null; why?: string; run: HealthRunState | null }

export interface ExtensionState {
  session: { folder: string; doc: SessionDoc | null; why?: string; following: boolean } | null;
  /** The folder's recently active sessions (the panel's header reads the selected row); `selected` is the drilled-in one. */
  sessions: { folder: string; rows: SessionSummary[]; selected: string | null; older: number; capped: number; automated: number; following: boolean } | null;
  corpus: { doc: CorpusDoc | null; why?: string; scanning?: { done: number; total: number } } | null;
  weight: { doc: WeightDoc | null; why?: string } | null;
  prompts: { list: PromptDef[]; terminal: string | null };
  folders: { list: string[]; active: string };
  /** Keyed by folder: a health reading belongs to one folder and only that one. */
  health: Record<string, HealthState>;
}

/** Subscribes to the extension's messages and says `ready`. `onTab` fires on a `tab` message (tree → panel round trip). */
export function useExtension(onTab?: (id: TabId) => void): ExtensionState {
  const [session, setSession] = useState<ExtensionState["session"]>(null);
  const [sessions, setSessions] = useState<ExtensionState["sessions"]>(null);
  const [corpus, setCorpus] = useState<ExtensionState["corpus"]>(null);
  const [weight, setWeight] = useState<ExtensionState["weight"]>(null);
  const [prompts, setPrompts] = useState<ExtensionState["prompts"]>({ list: [], terminal: null });
  const [folders, setFolders] = useState<ExtensionState["folders"]>({ list: [], active: "" });
  const [health, setHealth] = useState<ExtensionState["health"]>({});
  const tabCb = useRef(onTab);
  tabCb.current = onTab;

  useEffect(() => {
    const on = (e: MessageEvent<ToWebview>) => {
      const m = e.data;
      if (!m || typeof m !== "object") return;
      switch (m.t) {
        case "session": setSession({ folder: m.folder, doc: m.doc, why: m.why, following: m.following }); break;
        case "sessions": setSessions({ folder: m.folder, rows: m.rows, selected: m.selected, older: m.older, capped: m.capped, automated: m.automated, following: m.following }); break;
        case "corpus": setCorpus({ doc: m.doc, why: m.why, scanning: m.scanning }); break;
        case "weight": setWeight({ doc: m.doc, why: m.why }); break;
        case "prompts": setPrompts({ list: m.list, terminal: m.terminal }); break;
        case "folders": setFolders({ list: m.list, active: m.active }); break;
        case "health": setHealth((h) => ({ ...h, [m.folder]: { doc: m.doc, why: m.why, run: m.run } })); break;
        case "tab": tabCb.current?.(m.id); break;
      }
    };
    window.addEventListener("message", on);
    post({ t: "ready" });
    return () => window.removeEventListener("message", on);
  }, []);

  return { session, sessions, corpus, weight, prompts, folders, health };
}
