/**
 * The controls Settings is built from — one component per KIND of decision, so
 * there is exactly one way to switch a thing on and exactly one way to pick
 * from a list.
 *
 * Why this exists. Counted on the screen it replaces, a boolean was spelled
 * eleven different ways: `data saver: on`, `auto-continue on`, a bare `on` with
 * the label only in the section heading, `Return sends` ⇄ `Return newlines`,
 * `remote-control` with no state word at all and only the accent colour to say
 * it was set, `ask every time` ⇄ `use these silently`, `also gating Tailscale` ⇄
 * `gate Tailscale too`, `auto-fire ON` ⇄ `ask me (approve each)`, `weekly
 * ceiling: 90%` ⇄ `weekly ceiling: off`, and two state machines (`Background
 * link: starting…`, `OS push: blocked in browser`) wearing the same button.
 * Picking one of N was four idioms: chips, a `<select>`, a −/+ stepper and a
 * range slider. And an ACTION — `token statistics`, which opens a whole other
 * screen — was drawn as a `.key` with no modifier, which is pixel-identical to
 * a switch that is off. That last one is the real cost: you could not tell a
 * door from a switch without tapping it.
 *
 * So the rule here is that the KIND of a row is visible before you read it:
 *
 *  - `SetSwitch` — two states. Label left, the word `on` or `off` right, always.
 *    The whole row is the button, because a 44px target the width of the screen
 *    is the one thing a thumb cannot miss.
 *  - `SetChoice` — one of a small closed set. A labelled row of chips, the
 *    current one lit. Never a `<select>`: a drop-down hides the alternatives
 *    until you commit to opening it, which is how `localRt`'s third mode was
 *    invisible.
 *  - `SetPick` — one of a LONG or open set (model ids, Gemini models, numeric
 *    caps). This is the one place a `<select>` is right, and it is labelled the
 *    same way a chip row is so the two read as siblings.
 *  - `SetStepper` — a number on a ladder. Absent at the ends, never dimmed.
 *  - `SetSlider` — a percentage. The value is a readout beside it, always.
 *  - `SetAction` — it DOES something. Never wears the active colour, and
 *    carries a chevron when (and only when) it opens another screen.
 *
 * Compactness is the second job. Every row used to carry its full argument as
 * permanently visible prose — several of them four or five sentences — so the
 * screen was about 40 phone-heights long. `SetNote` keeps the first line and
 * folds the rest behind the same `hint-more` disclosure the context sheet uses.
 * What never folds is an ABSENCE or a WARNING (`SetWarn`): the reason a control
 * is missing, or the thing that will bite you, is the sentence that has to be
 * read without being asked for. That is `Unavailable.tsx`'s rule applied to
 * prose, and it is why `SetWarn` is a separate component rather than a flag.
 *
 * Search is the third. Every row declares its `id`; `settingsIndex.ts` says
 * what words find it. A row that does not match the current query returns null
 * — but it counts itself FIRST, so `SetFilterBar` can say "9 of 54" off the
 * same render pass without a second tally that could disagree with the screen.
 */
import { createContext, useContext, type ReactNode } from "react";
import { ChevronRight, Loader, Minus, Plus, Search, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { RadioRows } from "./kit/RadioRows";
import { filterSummary, groupShown, nestedMatches, rowShown } from "./settingsIndex";
import { Button } from "./kit/Button";

/** Matches `App.tsx`'s own constant; the icon SCALE setting is applied in CSS
 *  off the `width` attribute, so this is a base size and not a final one. */
const ICON = 16;

/**
 * The live query plus this render's tally.
 *
 * `seen` and `shown` are mutable arrays the settings screen creates fresh each
 * render and every row pushes into. React renders siblings in order within one
 * pass, so a component placed after the rows in the DOM reads the finished
 * counts synchronously — which is why `SetFilterBar` is drawn last and floated
 * to the top with `order: -1` rather than being drawn first off a `useEffect`
 * that would always be one render behind.
 */
interface SettingsCtx {
  query: string;
  /** One row pinned by a door from elsewhere (`settingsFocus.ts`); wins over `query`. */
  only: string | null;
  seen: string[];
  shown: string[];
}

const Ctx = createContext<SettingsCtx | null>(null);

/** Fresh tally arrays for one render pass. Call it in the sheet's body. */
export function newSettingsTally(query: string, only: string | null = null): SettingsCtx {
  return { query, only, seen: [], shown: [] };
}

export function SettingsScope({ value, children }: { value: SettingsCtx; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Count this row, then say whether it survives the query.
 *
 * The count happens for every row whether or not it matches — that is the whole
 * point: `seen` is the denominator, and it is the number of rows this screen
 * can currently show, not the length of the catalogue (a third of which is
 * conditional on the host, the shell or another switch).
 */
function useRowVisible(id: string | undefined): boolean {
  const ctx = useContext(Ctx);
  if (!ctx) return true; // rendered outside a scope: never hide anything
  // No id: a control nested INSIDE another row (the six notification kinds sit
  // under one searchable row). It is neither counted nor hidden on its own —
  // its parent already answered both questions for it.
  if (!id) return true;
  ctx.seen.push(id);
  const ok = rowShown(id, ctx.query, ctx.only);
  if (ok) ctx.shown.push(id);
  return ok;
}

/**
 * Whether a piece NESTED inside row `parentId` (one plugin's section inside
 * `plugins`) survives the query: all of them when the parent's catalogued
 * words answer it, else only the ones whose `words` do (`nestedMatches`).
 * Neither counted nor pinned on its own — its parent already was.
 */
export function useNestedShown(parentId: string, words: string): boolean {
  const ctx = useContext(Ctx);
  if (!ctx || ctx.only) return true;
  return nestedMatches(parentId, words, ctx.query);
}

/* ── prose ───────────────────────────────────────────────────────────── */

/**
 * A row's explanation: one line always, the rest on request.
 *
 * `children` is the line that stays. `more` is everything that was worth
 * writing and is not worth re-reading every time you come here to change
 * something else.
 */
export function SetNote({ children, more }: { children?: ReactNode; more?: ReactNode }) {
  if (!children && !more) return null;
  if (!more) return <div className="set-note">{children}</div>;
  // The LINE ITSELF is the disclosure. A separate "why" control underneath cost
  // a whole extra line and a 36px tap target on every one of thirty rows, which
  // on a screen whose entire problem was length is most of a phone-height spent
  // on the affordance for hiding text. Tapping the sentence you are already
  // reading to get the rest of it needs no control of its own.
  return (
    <details className="set-note set-more">
      <summary>{children}</summary>
      <div className="set-more-body">{more}</div>
    </details>
  );
}

/**
 * A sentence that must be read: a warning, or the reason something is missing.
 *
 * Never folds, never dims, never becomes a `title`. `tone` picks the colour;
 * `bad` is the one that means "this will cost you something".
 */
export function SetWarn({ tone = "bad", icon: Icon, children }: {
  tone?: "bad" | "plain"; icon?: LucideIcon; children: ReactNode;
}) {
  return (
    <div className={`set-note${tone === "bad" ? " oracle-warn" : ""}`}>
      {Icon && <Icon size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />}
      {children}
    </div>
  );
}

/* ── groups ──────────────────────────────────────────────────────────── */

/**
 * A section, with its heading.
 *
 * It always renders its CHILDREN. A group that decided for itself whether the
 * query touched it stopped its rows from rendering at all, so they never
 * counted themselves and the filter bar's denominator silently became "rows in
 * groups that survived" — it read "1 of 8" on a screen holding 54.
 *
 * So the rows are always drawn and always hide themselves, and only the SECTION
 * is hidden here. Two rules do that, and they cover different cases: `gone` is
 * the query excluding every row this group has (exact, and it works on a
 * WebView with no `:has()`), and the `:has()` rule in `styles.css` is for the
 * case the catalogue cannot see — every row in the group conditional on the
 * host and absent right now.
 */
export function SetGroup({ id, title, icon: Icon, children }: {
  id: string; title: string; icon?: LucideIcon; children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  const gone = !!ctx && !groupShown(id, ctx.query, ctx.only);
  return (
    <section className={`set-group${gone ? " gone" : ""}`} data-group={id}>
      <h3 className="set-title">
        {Icon && <Icon size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />}
        {title}
      </h3>
      {children}
    </section>
  );
}

/* ── the controls ────────────────────────────────────────────────────── */

interface RowBase {
  /** Absent only for a control nested inside another row — see `useRowVisible`. */
  id?: string;
  label: ReactNode;
  icon?: LucideIcon;
  note?: ReactNode;
  more?: ReactNode;
  /** Drawn under the note and never folded — an `Unavailable`, a warning. */
  children?: ReactNode;
}

/**
 * Two states, one spelling.
 *
 * `on`/`off` are the only words this control says about itself. A row whose
 * two states have genuinely different MEANINGS (Return sends vs. inserts a
 * newline) says that in its note, where a sentence has room to be true — not in
 * the label, where it made the same control look like a different one depending
 * on which way it was set.
 *
 * `state` exists for the two rows that are not really booleans: the background
 * link, which can be `starting…`, and OS push, which can be blocked by the
 * browser. They still draw as this control, and the extra word replaces `on`
 * rather than being bolted onto the label.
 */
export function SetSwitch({ id, label, icon: Icon, on, onChange, state, tone, note, more, children }: RowBase & {
  on: boolean;
  onChange: () => void;
  /** Overrides the word `on`/`off` when the truth is neither. */
  state?: string;
  /** `danger` for a state that is a problem (push blocked, link errored). */
  tone?: "danger";
}) {
  if (!useRowVisible(id)) return null;
  return (
    <div className="set-item">
      <button
        className={`set-sw${on ? " on" : ""}${tone === "danger" ? " danger" : ""}`}
        aria-pressed={on}
        onClick={onChange}
      >
        {Icon && <Icon size={ICON} className="set-ico" />}
        <span className="set-lbl">{label}</span>
        <span className="set-state">{state ?? (on ? "on" : "off")}</span>
      </button>
      <SetNote more={more}>{note}</SetNote>
      {children}
    </div>
  );
}

export interface ChoiceOption<T> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  /** Per-chip inline style — the text-size chips are drawn at the size they set. */
  style?: React.CSSProperties;
  title?: string;
}

/**
 * One of a small closed set, as chips.
 *
 * The current value is said once — by the lit chip — and not repeated in a
 * state pill beside the label, which is the same fact twice and the first thing
 * to go stale when somebody adds an option.
 */
export function SetChoice<T extends string | number>({ id, label, icon: Icon, value, options, onChange, note, more, radio, children }: RowBase & {
  value: T;
  options: ChoiceOption<T>[];
  onChange: (v: T) => void;
  /** WORDED options, exactly one chosen: draw radio rows (a dot and a sentence) instead of chips.
   *  Opt-in per row — bare numbers, units and previews (text size) stay chips. */
  radio?: boolean;
}) {
  if (!useRowVisible(id)) return null;
  return (
    <div className="set-item">
      <div className="set-lead">
        {Icon && <Icon size={ICON} className="set-ico" />}
        <span className="set-lbl">{label}</span>
      </div>
      {radio ? (
        <RadioRows<string>
          label={typeof label === "string" ? label : undefined}
          value={String(value)}
          options={options.map((o) => ({ key: String(o.value), label: o.label, title: o.title }))}
          onChange={(k) => { const o = options.find((x) => String(x.value) === k); if (o) onChange(o.value); }}
        />
      ) : (
      <div className="set-chips">
        {options.map((o) => (
          <Button
            key={String(o.value)}
            className={value === o.value ? "active" : ""}
            style={o.style}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <o.icon size={ICON} />} {o.label}
          </Button>
        ))}
      </div>
      )}
      <SetNote more={more}>{note}</SetNote>
      {children}
    </div>
  );
}

/**
 * SEVERAL of a small closed set, as chips that latch.
 *
 * `SetChoice`'s shape deliberately, because it is the same question asked about
 * more than one answer, and a column of switches for a list of twenty-odd
 * languages is twenty rows of chrome for one decision. A lit chip is IN; the
 * row's note — never a dimmed chip — is where the rule about an empty pick is
 * said, because what an empty list falls back to is a sentence and not a state
 * a control can wear (`Unavailable.tsx`'s reason: a `title` is invisible on a
 * phone).
 */
export function SetMulti<T extends string>({ id, label, icon: Icon, value, options, onChange, note, more, children }: RowBase & {
  value: readonly T[];
  options: ChoiceOption<T>[];
  onChange: (next: T[]) => void;
}) {
  if (!useRowVisible(id)) return null;
  const on = new Set(value);
  return (
    <div className="set-item">
      <div className="set-lead">
        {Icon && <Icon size={ICON} className="set-ico" />}
        <span className="set-lbl">{label}</span>
      </div>
      <div className="set-chips">
        {options.map((o) => (
          <Button
            key={String(o.value)}
            className={on.has(o.value) ? "active" : ""}
            aria-pressed={on.has(o.value)}
            title={o.title}
            onClick={() => onChange(options.map((x) => x.value).filter((v) => (v === o.value ? !on.has(v) : on.has(v))))}
          >
            {o.icon && <o.icon size={ICON} />} {o.label}
          </Button>
        ))}
      </div>
      <SetNote more={more}>{note}</SetNote>
      {children}
    </div>
  );
}

/**
 * One of a long or open set — a model id, a Gemini version, a numeric cap.
 *
 * A `<select>` is right exactly here and nowhere else on this screen: twenty
 * model ids as chips is a wall, and the list is not closed (a host can name
 * models this app has never heard of). The label sits where `SetChoice`'s does
 * so the two read as the same kind of question asked at two different sizes.
 *
 * `control` takes the raw element because two of these are `ModelField`, which
 * owns rules of its own about aliases, versions and a stored id the catalogue
 * does not name.
 */
export function SetPick({ id, label, icon: Icon, control, note, more, children }: RowBase & {
  control: ReactNode;
}) {
  if (!useRowVisible(id)) return null;
  return (
    <div className="set-item">
      <div className="set-lead">
        {Icon && <Icon size={ICON} className="set-ico" />}
        <span className="set-lbl">{label}</span>
        <span className="set-pick">{control}</span>
      </div>
      <SetNote more={more}>{note}</SetNote>
      {children}
    </div>
  );
}

/**
 * A number on a ladder, stepped.
 *
 * At either end the button is ABSENT and the readout names the end — the
 * corner-zoom pair's rule, for its reason: a dimmed control says "not now",
 * and a tap that changes nothing says nothing at all.
 *
 * The readout is prose, never a `.key`: a span wearing the button styling
 * between two real buttons is the exact confusion `Unavailable.tsx` exists
 * about.
 */
export function SetStepper({ id, label, icon: Icon, readout, onLess, onMore, lessLabel = "smaller", moreLabel = "bigger", extra, note, more, children }: RowBase & {
  /** What the value IS, including the word for an end of the ladder. */
  readout: ReactNode;
  /** Null at the bottom of the ladder — the button is then not drawn. */
  onLess: (() => void) | null;
  /** Null at the top. */
  onMore: (() => void) | null;
  lessLabel?: string;
  moreLabel?: string;
  /** A third button, e.g. "back to default". */
  extra?: ReactNode;
}) {
  if (!useRowVisible(id)) return null;
  return (
    <div className="set-item">
      <div className="set-lead">
        {Icon && <Icon size={ICON} className="set-ico" />}
        <span className="set-lbl">{label}</span>
      </div>
      <div className="set-chips">
        {onLess && <Button onClick={onLess}><Minus size={ICON} /> {lessLabel}</Button>}
        <span className="set-readout" aria-live="polite">{readout}</span>
        {onMore && <Button onClick={onMore}><Plus size={ICON} /> {moreLabel}</Button>}
        {extra}
      </div>
      <SetNote more={more}>{note}</SetNote>
      {children}
    </div>
  );
}

/**
 * A percentage with a thumb.
 *
 * Kept for the budget ceilings and nothing else: they are the one setting here
 * that is genuinely continuous, and a slider is the only control that takes a
 * coarse number from a thumb without opening a keyboard over the sheet. The
 * value is always printed beside it — a slider with no readout is a control you
 * cannot report the state of.
 */
export function SetSlider({ id, label, icon: Icon, value, min, max, step, readout, onInput, onCommit, note, more, children }: RowBase & {
  value: number;
  min: number; max: number; step: number;
  readout: ReactNode;
  onInput: (v: number) => void;
  onCommit: () => void;
}) {
  if (!useRowVisible(id)) return null;
  return (
    <div className="set-item">
      <div className="set-lead">
        {Icon && <Icon size={ICON} className="set-ico" />}
        <span className="set-lbl">{label}</span>
        <span className="set-state">{readout}</span>
      </div>
      <input
        type="range" className="set-range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <SetNote more={more}>{note}</SetNote>
      {children}
    </div>
  );
}

/**
 * A button that DOES something, drawn so it cannot be mistaken for a switch.
 *
 * Never wears the active colour. A chevron is drawn when and only when the tap
 * opens another screen, so "opens a sheet" and "acts here and now" are two
 * shapes rather than one.
 *
 * `cant` replaces the button with its reason. That is the `Unavailable.tsx`
 * rule, and it is a change of behaviour on three rows that used to grey out
 * instead — push-to-host with no link, "explain them again" with nothing
 * dismissed, a key test while it runs. `busy` is the separate case: a
 * verb that IS running says so in its own glyph, and the tap is swallowed.
 */
export function SetAction({ id, label, icon: Icon, onClick, opens, cant, busy, tone, compact, title, note, more, children }: Omit<RowBase, "label"> & {
  label: ReactNode;
  onClick: () => void;
  /** True when the tap opens another screen. Draws the chevron. */
  opens?: boolean;
  /** Why it cannot be done — drawn INSTEAD of the button, as a sentence. */
  cant?: ReactNode;
  /** Running right now: a glyph, not a disabled attribute. */
  busy?: boolean;
  tone?: "danger" | "warn" | "primary";
  /**
   * A door in a rack of doors — sized to its label and laid out by a
   * `.set-doors` parent rather than taking a full row of its own. The
   * diagnostics group is nine of these; nine full-width rows with a paragraph
   * each is the shape this whole change is against. It still declares its id,
   * so search still finds it.
   */
  compact?: boolean;
  title?: string;
}) {
  if (!useRowVisible(id)) return null;
  if (compact) {
    return (
      <button className={`set-door${tone ? ` ${tone}` : ""}`} title={title} onClick={onClick}>
        {Icon && <Icon size={ICON} />} {label}
      </button>
    );
  }
  return (
    <div className="set-item">
      {cant ? (
        <div className="set-lead set-cant">
          {Icon && <Icon size={ICON} className="set-ico" />}
          <span className="set-lbl">{label}</span>
          <span className="set-cant-why">{cant}</span>
        </div>
      ) : (
        <button
          className={`set-act${tone ? ` ${tone}` : ""}${busy ? " busy" : ""}`}
          title={title}
          onClick={() => { if (!busy) onClick(); }}
          aria-busy={busy || undefined}
        >
          {busy ? <Loader size={ICON} className="set-ico spin" /> : Icon && <Icon size={ICON} className="set-ico" />}
          <span className="set-lbl">{label}</span>
          {opens && !busy && <ChevronRight size={ICON} className="set-go" />}
        </button>
      )}
      <SetNote more={more}>{note}</SetNote>
      {children}
    </div>
  );
}

/**
 * A row whose controls are genuinely bespoke — the LAN password field, the
 * plugin sections (a plugin's fields are dynamic, so they nest inside one
 * catalogued row), the row of diagnostic doors.
 *
 * It still declares an `id`, so it is still searchable and still counted. The
 * escape hatch is deliberate and deliberately plain: anything that grows a
 * second copy of a switch or a chip row belongs in one of the controls above.
 */
export function SetCustom({ id, label, icon: Icon, children, note, more }: RowBase) {
  if (!useRowVisible(id)) return null;
  return (
    <div className="set-item">
      {label != null && label !== "" && (
        <div className="set-lead">
          {Icon && <Icon size={ICON} className="set-ico" />}
          <span className="set-lbl">{label}</span>
        </div>
      )}
      {children}
      <SetNote more={more}>{note}</SetNote>
    </div>
  );
}

/* ── search ──────────────────────────────────────────────────────────── */

/** The box. Lives above the scroll, so it does not scroll away from you. */
export function SetSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="set-search">
      <Search size={ICON} className="set-search-ico" />
      <input
        type="search"
        placeholder="search settings"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
      />
      {value !== "" && (
        <button className="set-search-x" aria-label="clear the search" onClick={() => onChange("")}>
          <X size={ICON} />
        </button>
      )}
    </div>
  );
}

/**
 * What the query is hiding, and the way out of it.
 *
 * Drawn LAST in the markup and floated to the top by `order: -1`, so it reads
 * the tally the rows filled in during this same render rather than the last
 * one. `n of N` against the rows the screen can actually show — see
 * `filterSummary` for why the catalogue's own length is the wrong denominator.
 */
export function SetFilterBar({ tally, onClear }: { tally: SettingsCtx; onClear: () => void }) {
  if (!tally.only && !tally.query.trim()) return null;
  return (
    <div className="filter-bar set-filter-bar">
      <span className="filter-bar-txt">{filterSummary(tally.shown.length, tally.seen.length, tally.query, tally.only)}</span>
      <button className="filter-bar-clear" onClick={onClear}><X size={13} /> clear</button>
    </div>
  );
}
