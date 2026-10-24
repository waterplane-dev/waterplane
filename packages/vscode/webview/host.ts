/** The one door to the extension host: `acquireVsCodeApi()` may be called ONCE per webview. */
import { useEffect, useRef, useState } from "react";
import type {
  CorpusDoc, HealthDoc, HealthRunState, LiveState, PromptDef, SessionDoc, SessionSummary, TabId, ToExtension, ToWebview, WeightDoc,
} from "../src/protocol";

interface VsCodeApi {
  postMessage(m: ToExtension): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi = acquireVsCodeApi();

export const post = (m: ToExtension): void => api.postMessage(m);

// ── the desktop reads: one ask per `get`, answered by id (`hostlink.ts` on the other side) ──

let nextAsk = 1;
const asks = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();

/** One GET of the waterplane desktop on this machine, through the extension host. Rejects with its sentence. */
export function get(path: string, ms?: number): Promise<unknown> {
  const id = nextAsk++;
  return new Promise((ok, fail) => {
    asks.set(id, { ok, fail });
    post({ t: "get", id, path, ...(ms != null ? { ms } : {}) });
  });
}

window.addEventListener("message", (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (!m || typeof m !== "object" || m.t !== "ledgerAnswer") return;
  const a = asks.get(m.id);
  if (!a) return;
  asks.delete(m.id);
  if (m.ok) a.ok(m.value); else a.fail(new Error(m.error));
});

/** The state this webview keeps across hides: the selected tab and the Health view's x axis. */
interface Kept { tab?: string; healthAxis?: string }
const kept = (): Kept => (api.getState() as Kept | undefined) ?? {};
const keep = (k: Kept): void => api.setState({ ...kept(), ...k });

/** The views the panel can show; the remembered one is only honoured when it is still one of these. */
export const TAB_IDS: readonly TabId[] = ["session", "all", "always-on", "health", "prompts"];

export function loadTab<T extends string, F extends T | null>(valid: readonly T[], fallback: F): T | F {
  return valid.find((t) => t === kept().tab) ?? fallback;
}
export const saveTab = (tab: string): void => keep({ tab });

/** The repo-health x axis, as the phone keeps it per device (`healthAxis`): `weeks` unless chosen. */
export const loadHealthAxis = (): "weeks" | "commits" => (kept().healthAxis === "commits" ? "commits" : "weeks");
export const saveHealthAxis = (axis: "weeks" | "commits"): void => keep({ healthAxis: axis });

// ── the extension's state, one subscription for the panel's App ──

export interface HealthState { doc: HealthDoc | null; why?: string; run: HealthRunState | null }

export interface ExtensionState {
  session: { folder: string; doc: SessionDoc | null; why?: string; following: boolean } | null;
  /** The folder's recently active sessions (the panel's header reads the selected row); `selected` is the drilled-in one. */
  sessions: { folder: string; rows: SessionSummary[]; selected: string | null; older: number; capped: number; automated: number; following: boolean } | null;
  corpus: { doc: CorpusDoc | null; why?: string; scanning?: { done: number; total: number } } | null;
  /** The waterplane desktop's live account facts, or why there are none; null before the first answer. */
  live: LiveState | null;
  weight: { doc: WeightDoc | null; why?: string } | null;
  prompts: { list: PromptDef[]; terminal: string | null };
  folders: { list: string[]; active: string };
  /** Keyed by folder: a health reading belongs to one folder and only that one. */
  health: Record<string, HealthState>;
}

/** Subscribes to the extension's messages and says `ready`. `onTab` fires on a `tab` message (tree → panel round trip). */
export function useExtension(onTab?: (id: TabId, ledger?: string) => void): ExtensionState {
  const [session, setSession] = useState<ExtensionState["session"]>(null);
  const [sessions, setSessions] = useState<ExtensionState["sessions"]>(null);
  const [corpus, setCorpus] = useState<ExtensionState["corpus"]>(null);
  const [live, setLive] = useState<ExtensionState["live"]>(null);
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
        case "live": setLive(m.live); break;
        case "weight": setWeight({ doc: m.doc, why: m.why }); break;
        case "prompts": setPrompts({ list: m.list, terminal: m.terminal }); break;
        case "folders": setFolders({ list: m.list, active: m.active }); break;
        case "health": setHealth((h) => ({ ...h, [m.folder]: { doc: m.doc, why: m.why, run: m.run } })); break;
        case "tab": tabCb.current?.(m.id, m.ledger); break;
      }
    };
    window.addEventListener("message", on);
    post({ t: "ready", tab: loadTab(TAB_IDS, null) });
    return () => window.removeEventListener("message", on);
  }, []);

  return { session, sessions, corpus, live, weight, prompts, folders, health };
}
