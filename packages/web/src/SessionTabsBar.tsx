import { FileText, Layers, Loader, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useBackStep } from "./backStep";
import { askConfirm } from "./Confirm";
import { repoAccentStyle } from "./format";
import { useRepoColors } from "./repoColors";
import { STATUS_LABEL } from "./sessionFacts";
import { FilterBar, SearchBox } from "./kit";
import { useHasKeyboard } from "./ShortcutCard";
import { registerShortcut } from "./shortcuts";
import {
  askTabAttach, askTabClose, askTabFile, filterStrip, isTabsListPress, fileTabKey, fileTabLabel, setFilePinned, tabCloseAsk, tabStripHeight, useSessionTabs,
  type FileTab, type SessionTab, type StripTab, type TabsSnapshot,
} from "./sessionTabs";
import { Sheet } from "./Sheet";
import { showToast } from "./toast";

/**
 * **The session-tab strip** — the third always-on bar, under the connection
 * strip and the local-runner one, and their shape for their reason: `App`
 * returns early once per overlay, so a layer that must be on every screen is
 * mounted beside it in `main.tsx` and talks to it through `sessionTabs.ts`.
 *
 * What it answers is the one question the launcher makes you work for: *what
 * else do I have open, and can I get back to it without leaving this screen?*
 * Everywhere else in this app sessions are a COLUMN grouped by repo — correct
 * for surveying twenty of them, three gestures deep when you are bouncing
 * between two.
 *
 * **The colour is the repo's own** (`format.ts`'s `repoHue`, the same ring and
 * the same pinned answers the launcher headers and every row stripe use),
 * because at three tabs across a phone the label is ~10 characters and the
 * colour is doing most of the identifying. It is a TINT under `--fg` text
 * rather than coloured text: a repo-hued label on a repo-hued ground is the one
 * combination the palette cannot keep readable at 4.5:1 for all 360 hues, and
 * `theme.test.mjs` sweeps the circle for exactly that reason.
 *
 * **The tint is the launcher's own token** (`--repo-fill`, an alpha over
 * whatever is underneath) and the strip's ground is `--bg`, which is the list's
 * ground — so a tab and that repo's group header are not merely the same hue,
 * they are the same colour. They used to be two mixes with two numbers
 * (`--tab-veil` against `--repo-veil`) over two different surfaces, tuned apart
 * and drifting apart, which is what "the colours nearly match" was.
 *
 * Light mode fills HARDER than dark (`--repo-veil-on`), because the same
 * fraction over white washes out to grey while over near-black it is already
 * plain; the WASH stays where it shipped, since that one sits behind text of
 * its own hue on the group header.
 *
 * **The shape says which tab is the front one.** Rounded at the top only,
 * standing on the strip as a rail; the open one is three pixels taller and
 * capped in its own hue. Height rather than brightness alone, because
 * "brightest" is also what a repo with a vivid hue looks like — a selected
 * state that reads as "this tab has a loud colour" is not a selected state.
 *
 * **How many are DRAWN is a second setting, and that one is a limit**
 * (`tabsLimit`, default 10): what it cuts is counted at the strip's end.
 *
 * **How many fit is a setting, and it is not a limit.** `count` is the
 * narrowest a tab gets — `1/N` of the strip, so N of them fill it exactly;
 * everything past N is still there and still reachable — the strip scrolls
 * sideways, and the active tab is scrolled into view when it changes, so a tab
 * opened from the launcher is never off-screen on arrival. With fewer than N
 * open a tab is as wide as its NAME (`.stab`): a fixed `1/N` cut a four-word
 * label off beside an empty half strip, which is the one thing the room was
 * for.
 *
 * **The × asks.** Closing a session ends a running CLI process, which is not
 * something a thumb may do by brushing a 20 px target beside the label it was
 * aiming for — so it goes through `askConfirm` (never `window.confirm`: a
 * native modal blocks the WebView's event loop) and the question names the
 * session and says the conversation is kept.
 *
 * **What each tab is DOING is the launcher's own answer**, not a reading of its
 * own: `sessionFacts.tsx`'s `sessionStatus()` and the five buckets the row
 * badge, the repo roll-up and the status filter already share, wearing the same
 * five colours those badges wear (`--accent` working, `--dead` waiting on you,
 * `--limit` at the limit, `--muted` idle, `--dead` exited). The strip used to
 * hold two booleans of its own, so a session blocked on a question looked
 * exactly like one with nothing left to do.
 *
 * **A running turn SPINS.** The glyph slot carries a dot for the four states
 * that are not going anywhere and the launcher's own `Loader` for the one that
 * is — the same icon `statusPill` puts beside the word *coding*, so the strip
 * and the row say "working" in the same picture. This bar is 34 px of every
 * screen, which is the argument that kept it a static dot: a green dot is a
 * colour among four other colours and reads as a state, not as motion, and
 * "is it still going?" was a question a person answered by leaving the screen.
 * It spins only while a turn actually runs, on the tabs that are actually
 * running one, and `prefers-reduced-motion` stops it dead without taking the
 * mark away — the icon is a different SHAPE from the dot, not only a different
 * behaviour, which is what makes the still version still say something.
 *
 * **Pinned files ride the same strip** (`FileTab`, pinned from the file
 * viewer's header), sorted in among the sessions by the same order
 * (`mergeStrip`) and marked as files: a file icon where a
 * session's state mark goes, a dashed edge where a session's is solid. While
 * one is on screen IT is the front tab, not the session under the viewer.
 *
 * **The list button** at the far left opens the same tabs, in the same order,
 * as a vertical list (`TabsList`): at ~10 characters a tab the strip is for
 * the colour, the list is for READING — whole names, the repo and the state
 * in words, and everything the limit cut from the strip. It sits OUTSIDE the
 * scroller (fixed, the strip padded clear of it), so it never scrolls away and
 * never collides with the strip's sticky scroll cues. It is drawn as a neutral
 * TAB on the strip's baseline with the number of open tabs — a bare list glyph
 * there read as a second burger right above the header's own.
 *
 * **Ctrl+E opens the same list from anywhere** (VS Code's quick open), with a
 * filter box and ↑/↓/Return — and works with the strip switched OFF, so the
 * list and the chord live on `SessionTabsBar`, not on the strip.
 *
 * It renders NOTHING with no sessions and no pins: a strip that is permanently empty is
 * furniture, and the height it publishes goes to zero with it so no screen pads
 * itself clear of a bar that is not there.
 */
export function SessionTabsBar() {
  const enabled = useSessionTabs((s) => s.enabled);
  const any = useSessionTabs((s) => s.tabs.length > 0 || s.files.length > 0);
  const h = tabStripHeight(enabled, any);
  const show = h > 0;

  // The strip's height, published once for every screen to pad itself clear of
  // — `.screen` and `.sheet` add it to their top padding, exactly as they do
  // for the two strips above. A variable rather than a per-screen component, so
  // a sheet written next year clears it without being told.
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-tabs-h", `${h}px`);
    return () => { document.documentElement.style.removeProperty("--ui-tabs-h"); };
  }, [h]);

  const [listOpen, setListOpen] = useState(false);
  useBackStep(listOpen, () => setListOpen(false));
  // How the list was opened (a keyboard press focuses its filter even where no
  // keyboard was known yet), and each further press while it is up.
  const [viaKey, setViaKey] = useState(false);
  const [kick, setKick] = useState(0);
  const anyRef = useRef(any);
  anyRef.current = any;
  // The last tab closed under the open list: shut it, or its Back step stays.
  useEffect(() => { if (!any) setListOpen(false); }, [any]);
  const openRef = useRef(listOpen);
  openRef.current = listOpen;

  // Ctrl+E from anywhere, VS Code's quick open. Capture phase on `window`, so
  // a focused xterm or compose box does not take the press first (the CLI's
  // own ^E, end of line, is the price — the same trade VS Code's terminal
  // makes). Stands down while an in-app dialog (a close confirm) owns the keys,
  // and with nothing open at all. Lives HERE, not in the strip: the strip can
  // be switched off in Settings, and the chord still finds a tab.
  useEffect(() => {
    const free = () => anyRef.current && !document.querySelector(DIALOGS);
    const onKey = (e: KeyboardEvent) => {
      if (!isTabsListPress(e) || !free()) return;
      e.preventDefault();
      e.stopPropagation();
      if (openRef.current) { setKick((k) => k + 1); return; }
      setViaKey(true);
      setListOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    const off = registerShortcut({
      id: "tabs.list", mods: ["ctrl"], key: "E",
      what: () => (openRef.current ? "next tab in the list" : "find an open tab"),
      when: free,
    });
    return () => { window.removeEventListener("keydown", onKey, true); off(); };
  }, []);

  return (
    <>
      {show && <Strip listOpen={listOpen} onList={() => { setViaKey(false); setListOpen((o) => !o); }} />}
      {listOpen && <ListLayer viaKey={viaKey} kick={kick} onClose={() => setListOpen(false)} />}
    </>
  );
}

/** What already owns the keyboard: an in-app dialog (`primaryKey.ts`'s set). */
const DIALOGS = ".bl-modal-backdrop, [role=dialog][aria-modal=true]";

function Strip({ listOpen, onList }: { listOpen: boolean; onList: () => void }) {
  const s = useSessionTabs<TabsSnapshot>((x) => x);
  // Subscribed for the RE-RENDER, not the value: the hue itself is read inside
  // `repoAccentStyle` off `format.ts`'s module state. This strip is mounted
  // beside `App` and does not re-render when its settings do, so without this a
  // palette change repainted the launcher and left the tabs on the old colours
  // until the next session list arrived.
  useRepoColors();
  const ref = useRef<HTMLDivElement | null>(null);
  const fileOn = !!s.fileActive && s.files.some((f) => fileTabKey(f) === s.fileActive);

  // Keep the open session on screen. A tab opened from the launcher, or the
  // eleventh one in the order, is otherwise scrolled past the right edge on
  // arrival — the strip would then be saying nothing about the session you are
  // actually looking at.
  //
  // With NO open session (the launcher, a sheet over it) the strip goes back to
  // its left edge. Nothing else ever resets it, so after the APK's restart into
  // a new bundle the launcher came back with the strip parked mid-way — tabs
  // cut at both edges and the first ones, the ones you were looking at, gone.
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const el = s.activeId || s.fileActive ? strip.querySelector<HTMLElement>(".stab.on") : null;
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    else strip.scrollLeft = 0;
  }, [s.activeId, s.fileActive, s.order, s.strip.length]);

  // The list button grows with its count (215 open is real), and the strip is
  // padded clear of whatever width that is — one number, set on both.
  const allW = { ["--stab-all-w" as string]: `${38 + 7 * String(s.all.length).length}px` };
  return (
    <>
    <button className="stab-all" aria-label="list all open tabs" title="all open tabs as a list" style={allW}
      aria-expanded={listOpen} onClick={onList}>
      <Layers size={14} aria-hidden="true" />
      <span className="stab-all-n">{s.all.length}</span>
    </button>
    <div className="sess-tabs" ref={ref} role="tablist" aria-label="open sessions"
      style={{ ...allW, ["--stab-n" as string]: String(s.count) }}>
      {/* A pinned file on screen is the front tab; the session under the
          viewer is not, or two tabs would both claim to be the one you see. */}
      {s.strip.map((x) => x.kind === "session"
        ? <Tab key={x.tab.id} t={x.tab} active={!fileOn && x.tab.id === s.activeId} />
        : <FileTabView key={fileTabKey(x.file)} f={x.file} active={fileTabKey(x.file) === s.fileActive} />)}
      {/* What the limit cut, said rather than dropped. Words, not a control:
          every one of them is in the launcher, and a count that opened the
          unfiltered list would break the count-is-a-filter rule. */}
      {s.hidden > 0 && (
        <span className="stab-more" title={`${s.hidden} more open — see the launcher, or raise “most tabs shown” in Settings`}>
          +{s.hidden}
        </span>
      )}
    </div>
    </>
  );
}

/** The list with its own subscription — it opens with the strip off too. */
function ListLayer(p: { viaKey: boolean; kick: number; onClose: () => void }) {
  const s = useSessionTabs<TabsSnapshot>((x) => x);
  useRepoColors();
  const fileOn = !!s.fileActive && s.files.some((f) => fileTabKey(f) === s.fileActive);
  return <TabsList s={s} fileOn={fileOn} {...p} />;
}

/**
 * Every open tab, top to bottom in the strip's left-to-right order, uncut by
 * the limit — the strip made READABLE: the whole name wraps instead of
 * ellipsizing, with the repo and the state in words under it. A tap opens it
 * exactly as the tab would; the × asks exactly as the tab's does.
 *
 * **A filter above the list** (`filterStrip`: every typed word, anywhere in
 * what the row says), and with it the keyboard: ↑/↓ (or Ctrl+N/P, or Ctrl+E
 * again) move a highlight, Return opens it, Esc closes. The box takes focus
 * only where a keyboard is known — a fine pointer, a hardware key seen, or the
 * Ctrl+E that opened it — because focus on a touch phone is a soft keyboard
 * over half the list nobody asked to type into.
 */
function TabsList({ s, fileOn, viaKey, kick, onClose }: {
  s: TabsSnapshot; fileOn: boolean; viaKey: boolean; kick: number; onClose: () => void;
}) {
  const keyboard = useHasKeyboard();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => filterStrip(s.all, query, (st) => STATUS_LABEL[st]), [s.all, query]);
  const isOn = (x: StripTab) => x.kind === "file" ? fileTabKey(x.file) === s.fileActive : !fileOn && x.tab.id === s.activeId;
  // The highlight starts on the tab you are on, so the first ↓ is "the next one".
  const [at, setAt] = useState(() => Math.max(0, s.all.findIndex(isOn)));
  const listRef = useRef<HTMLUListElement | null>(null);
  const kicked = useRef(kick);

  const step = (d: number) => setAt((i) => (rows.length ? (i + d + rows.length) % rows.length : 0));
  useEffect(() => { if (kick !== kicked.current) { kicked.current = kick; step(1); } });
  useEffect(() => { if (query) setAt(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  function open(x: StripTab) {
    onClose();
    if (x.kind === "file") askTabFile(x.file); else askTabAttach(x.tab.id);
  }
  async function close(t: SessionTab) {
    const ask = tabCloseAsk(t.label, t.status !== "exited");
    if (await askConfirm(ask)) askTabClose(t.id);
  }
  function onKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const k = e.key.toLowerCase();
    if (e.key === "ArrowDown" || (ctrl && k === "n")) { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp" || (ctrl && k === "p")) { e.preventDefault(); step(-1); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[at]) open(rows[at]); }
    // preventDefault: the wide layout's Esc (`escape.ts`) steps Back unless
    // the press was already answered — this close IS that Back.
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  const hidden = s.all.length - rows.length;
  return (
    <div className="stab-list-layer">
      <Sheet title={`open tabs · ${s.all.length}`} onClose={onClose}>
        <div className="stab-list-find">
          <SearchBox className="grow" value={query} placeholder="type to find a tab"
            autoFocus={viaKey || keyboard} role="combobox" aria-expanded="true" aria-controls="stab-list"
            aria-activedescendant={rows[at] ? `stab-row-${at}` : undefined}
            enterKeyHint="go" spellCheck={false} autoCapitalize="off" autoComplete="off"
            onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          {(viaKey || keyboard) && <span className="stab-list-keys">↑ ↓ to choose · Return opens · Esc closes</span>}
        </div>
        {hidden > 0 && (
          <FilterBar onClear={() => setQuery("")}>{rows.length} of {s.all.length} match “{query.trim()}”</FilterBar>
        )}
        <ul className="stab-list" id="stab-list" role="listbox" ref={listRef}>
          {rows.length === 0 && <li className="stab-list-none">No open tab matches “{query.trim()}”.</li>}
          {rows.map((x, i) => {
            const sel = i === at ? " sel" : "";
            const on = isOn(x) ? " on" : "";
            const common = { "data-i": i, id: `stab-row-${i}`, role: "option", "aria-selected": i === at, onClick: () => open(x) };
            if (x.kind === "file") {
              const f = x.file;
              return (
                <li key={fileTabKey(f)} {...common} className={`stab-row stab-file${on}${sel}`} style={repoAccentStyle(f.repo)}>
                  <FileText size={16} className="stab-fico" aria-hidden="true" />
                  <span className="stab-row-text">
                    <span className="stab-row-label">{fileTabLabel(f.path)}</span>
                    <span className="stab-row-sub">{f.repo || "file"} · pinned file · {f.path}</span>
                  </span>
                </li>
              );
            }
            const t = x.tab;
            return (
              <li key={t.id} {...common} className={`stab-row${on}${sel}`} data-state={t.status} style={repoAccentStyle(t.repo)}>
                {t.status === "coding"
                  ? <Loader size={16} className="spin stab-spin" aria-hidden="true" />
                  : <span className="stab-led" aria-hidden="true" />}
                <span className="stab-row-text">
                  <span className="stab-row-label">{t.label}</span>
                  <span className="stab-row-sub">{t.repo} · {STATUS_LABEL[t.status]}</span>
                </span>
                <button className="stab-x" aria-label={`close ${t.label}`} title="close this session"
                  onClick={(e) => { e.stopPropagation(); void close(t); }}>
                  <X size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </div>
  );
}

/**
 * One tab. The state words in the title are `STATUS_LABEL`'s — the same ones
 * the launcher's filter chips use — so a tab and the badge it stands for never
 * describe one session in two vocabularies.
 */
function Tab({ t, active }: { t: SessionTab; active: boolean }) {
  async function close(e: React.MouseEvent) {
    // The × sits inside the tab's own tap target, so the stop is what keeps a
    // close from also attaching the session it is closing.
    e.stopPropagation();
    const ask = tabCloseAsk(t.label, t.status !== "exited");
    if (await askConfirm(ask)) askTabClose(t.id);
  }
  return (
    <div
      className={`stab${active ? " on" : ""}`}
      data-state={t.status}
      style={repoAccentStyle(t.repo)}
      role="tab"
      aria-selected={active}
      data-hint="session.tabs"
      title={`${t.label} — ${t.repo} · ${STATUS_LABEL[t.status]}`}
      onClick={() => askTabAttach(t.id)}
    >
      {/* One glyph slot, five states. The spinner is the launcher badge's own
          icon and only a turn that is actually running gets it; everything
          else is a dot in that state's colour. */}
      {t.status === "coding"
        ? <Loader size={11} className="spin stab-spin" aria-hidden="true" />
        : <span className="stab-led" aria-hidden="true" />}
      <span className="stab-label">{t.label}</span>
      <button className="stab-x" aria-label={`close ${t.label}`} title="close this session" onClick={close}>
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * One pinned file. A tap opens the viewer on it; the × unpins WITHOUT asking —
 * nothing ends and nothing is lost (the file is where it was) — and the toast
 * names the way back, because a tab that vanishes must say where it went.
 */
function FileTabView({ f, active }: { f: FileTab; active: boolean }) {
  const label = fileTabLabel(f.path);
  function unpin(e: React.MouseEvent) {
    e.stopPropagation();
    setFilePinned(f, false);
    showToast(`unpinned ${label} — pin it again from the file's header`);
  }
  return (
    <div
      className={`stab stab-file${active ? " on" : ""}`}
      style={repoAccentStyle(f.repo)}
      role="tab"
      aria-selected={active}
      data-hint="session.tabs"
      title={`${f.path} — ${f.repo || "file"} · pinned file`}
      onClick={() => askTabFile(f)}
    >
      <FileText size={11} className="stab-fico" aria-hidden="true" />
      <span className="stab-label">{label}</span>
      <button className="stab-x" aria-label={`unpin ${label}`} title="unpin this file" onClick={unpin}>
        <X size={12} />
      </button>
    </div>
  );
}
