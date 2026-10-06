import { Loader, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { askConfirm } from "./Confirm";
import { repoAccentStyle } from "./format";
import { useRepoColors } from "./repoColors";
import { STATUS_LABEL } from "./sessionFacts";
import {
  TAB_STRIP_H, askTabAttach, askTabClose, tabCloseAsk, useSessionTabs,
  type SessionTab, type TabsSnapshot,
} from "./sessionTabs";

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
 * **How many fit is a setting, and it is not a limit.** `count` sizes each tab
 * to `1/N` of the strip so N of them fill it exactly; everything past N is
 * still there and still reachable — the strip scrolls sideways, and the active
 * tab is scrolled into view when it changes, so a tab opened from the launcher
 * is never off-screen on arrival.
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
 * It renders NOTHING with no sessions: a strip that is permanently empty is
 * furniture, and the height it publishes goes to zero with it so no screen pads
 * itself clear of a bar that is not there.
 */
export function SessionTabsBar() {
  const enabled = useSessionTabs((s) => s.enabled);
  const any = useSessionTabs((s) => s.tabs.length > 0);
  const show = enabled && any;

  // The strip's height, published once for every screen to pad itself clear of
  // — `.screen` and `.sheet` add it to their top padding, exactly as they do
  // for the two strips above. A variable rather than a per-screen component, so
  // a sheet written next year clears it without being told.
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-tabs-h", show ? `${TAB_STRIP_H}px` : "0px");
    return () => { document.documentElement.style.removeProperty("--ui-tabs-h"); };
  }, [show]);

  return show ? <Strip /> : null;
}

function Strip() {
  const s = useSessionTabs<TabsSnapshot>((x) => x);
  // Subscribed for the RE-RENDER, not the value: the hue itself is read inside
  // `repoAccentStyle` off `format.ts`'s module state. This strip is mounted
  // beside `App` and does not re-render when its settings do, so without this a
  // palette change repainted the launcher and left the tabs on the old colours
  // until the next session list arrived.
  useRepoColors();
  const ref = useRef<HTMLDivElement | null>(null);

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
    const el = s.activeId ? strip.querySelector<HTMLElement>(".stab.on") : null;
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    else strip.scrollLeft = 0;
  }, [s.activeId, s.order, s.tabs.length]);

  return (
    <div className="sess-tabs" ref={ref} role="tablist" aria-label="open sessions"
      style={{ ["--stab-n" as string]: String(s.count) }}>
      {s.tabs.map((t) => <Tab key={t.id} t={t} active={t.id === s.activeId} />)}
      {/* What the limit cut, said rather than dropped. Words, not a control:
          every one of them is in the launcher, and a count that opened the
          unfiltered list would break the count-is-a-filter rule. */}
      {s.hidden > 0 && (
        <span className="stab-more" title={`${s.hidden} more open — see the launcher, or raise “most tabs shown” in Settings`}>
          +{s.hidden}
        </span>
      )}
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
