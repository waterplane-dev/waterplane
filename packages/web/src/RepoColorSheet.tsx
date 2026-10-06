/**
 * **What colour each repo is** — the ring, and the answers a person pins over
 * it.
 *
 * The colour is not decoration here: it is what tells two group headers apart
 * mid-scroll, what a session row carries as a stripe, and what identifies a tab
 * at ~85 px, where the label is one word and an ellipsis. Which makes it the
 * one part of the palette a person has to be able to overrule — everything else
 * in `styles.css` is validated against a contrast floor and picked once, and
 * *which* repo is the blue one is not a thing a stylesheet can know.
 *
 * Three rules, all of them the repo's own:
 *
 *  - **A count on a control is a filter.** *2 repos share a colour* is a
 *    button, and it opens exactly those two.
 *  - **Nothing applies itself.** *Give them separate colours* is a tap, it says
 *    what it will do before it does it, and it never moves a hue somebody
 *    pinned (`spreadRepoColors` refuses to, and the note says so).
 *  - **A blocked verb is a sentence, not a dimmed button** — with one ring's
 *    worth of colours and more repos than that, the strip says so rather than
 *    greying the tap out.
 *
 * Every decision about WHICH hue is `shared/repocolor.ts`'s and node-tested;
 * this file is the swatches and the wording.
 */
import { useMemo, useState } from "react";
import { Check, Palette, RefreshCw, Shuffle, X } from "lucide-react";
import {
  REPO_PALETTES, freeHue, isPinned, paletteById, repoColorClashes, repoHueIn,
  setPalette, setRepoColor, spreadRepoColors, type RepoTarget,
} from "@waterplane/shared";
import { Sheet } from "./Sheet";
import { Empty } from "./Empty";
import { repoColors, saveRepoColors, useRepoColors } from "./repoColors";
import { showToast } from "./toast";
import { track } from "./usage";

/** The swatch a hue is shown as — the colour the app will actually paint, built
 *  the way every other repo-coloured thing builds it (`format.ts`'s inline
 *  style), so a swatch cannot drift from the header it promises. */
const hueStyle = (h: number) => ({
  "--repo-hue": `${h}`,
  "--repo-accent": `hsl(${h} var(--repo-sat) var(--repo-lit))`,
} as React.CSSProperties);

export function RepoColorSheet({ repos, onClose }: { repos: RepoTarget[]; onClose: () => void }) {
  const cfg = useRepoColors();
  /** Which repo's swatch row is open. One at a time: twelve swatches per repo
   *  over fourteen repos is a wall of colour nobody can read a name out of. */
  const [openFor, setOpenFor] = useState<string | null>(null);
  /** The clash cut. `null` = every repo; a list = exactly the ones that share a
   *  colour, because a count on a control is a filter. */
  const [cut, setCut] = useState<string[] | null>(null);

  // One row per repo NAME — worktrees of the same repo are the same repo to the
  // person looking at them, and they already share a colour by construction.
  const names = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of repos) if (!seen.has(r.repoName)) { seen.add(r.repoName); out.push(r.repoName); }
    return out.sort((a, b) => a.localeCompare(b));
  }, [repos]);

  const clashes = useMemo(() => repoColorClashes(names, cfg), [names, cfg]);
  const clashed = useMemo(() => new Set(clashes.flat()), [clashes]);
  const ring = paletteById(cfg.palette);
  const shown = cut ? names.filter((n) => cut.includes(n)) : names;
  /** More repos than the ring has hues: some of them MUST share. Said as a
   *  sentence, because it is a fact about the ring and not a refusal. */
  const crowded = names.length > ring.hues.length;

  function pick(name: string, hue: number | null) {
    saveRepoColors(setRepoColor(repoColors(), name, hue));
    track(hue == null ? "action:repocolor.clear" : "action:repocolor.pick");
    showToast(hue == null ? `${name} — back to the ring’s colour` : `${name} recoloured`);
  }

  return (
    <Sheet title="Repo colours" icon={<Palette size={18} />} onClose={onClose}>
      <div className="sheet-scroll">
        <div className="set-row">
          {REPO_PALETTES.map((p) => (
            <button key={p.id} className={`key ${cfg.palette === p.id ? "active" : ""}`}
              onClick={() => {
                saveRepoColors(setPalette(repoColors(), p.id));
                track(`action:repocolor.palette.${p.id}`);
                showToast(`repo colours: ${p.label}`);
              }}>
              {p.label}
            </button>
          ))}
          <div className="rc-ring" aria-hidden="true">
            {ring.hues.map((h) => <span key={h} className="rc-dot" style={hueStyle(h)} />)}
          </div>
          <span className="set-note">
            {ring.note}{" "}
            A repo’s colour is a hue out of this ring, picked by its name — the same on every device
            and in every list, and two repos are either the same colour or a clearly different one.
            {" "}How light and how saturated it is drawn stays the theme’s answer, swept over all
            360 hues, so <b>nothing you pick here can make a name unreadable</b>.
            {" "}A colour you pin below <b>survives a change of ring</b>: you chose that colour, not
            a slot.
          </span>
        </div>

        <div className="set-row">
          {clashes.length > 0 ? (
            <>
              {/* The count IS the cut. */}
              <button className={`key ${cut ? "active" : ""}`}
                onClick={() => { setCut(cut ? null : clashes.flat()); track("action:repocolor.clashcut"); }}>
                <Shuffle size={14} /> {clashed.size} repos share a colour
              </button>
              <button className="key" onClick={() => {
                const next = spreadRepoColors(names, repoColors());
                saveRepoColors(next);
                track("action:repocolor.spread");
                const left = repoColorClashes(names, next).flat().length;
                showToast(left ? `separated — ${left} still share a colour` : "every repo has its own colour");
              }}><RefreshCw size={14} /> give them separate colours</button>
              <span className="set-note">
                {clashes.map((g) => g.join(" + ")).join(" · ")} land on the same hue.
                {" "}Separating them <b>moves only the ones that collide</b>: a repo already alone on
                its colour keeps it, and a colour you pinned yourself is never moved — so the repos
                you already recognise stay recognisable.
                {crowded ? <> With {names.length} repos and {ring.hues.length} hues in this ring, some
                  of them must share whatever it does; a wider ring or a hue pinned by hand is the
                  only way past that.</> : null}
              </span>
            </>
          ) : (
            <span className="set-note">
              <Check size={13} /> Every repo has a colour of its own.
            </span>
          )}
        </div>

        {cut ? (
          <div className="filter-bar">
            <span>Showing the {shown.length} of {names.length} that share a colour.</span>
            <button className="key" onClick={() => setCut(null)}><X size={14} /> clear</button>
          </div>
        ) : null}

        {names.length === 0 ? (
          <Empty thing="repos">Nothing to colour until the desktop has listed a repo.</Empty>
        ) : null}

        <div className="list">
          {shown.map((name) => {
            const hue = repoHueIn(name, cfg);
            const pinned = isPinned(name, cfg);
            const open = openFor === name;
            return (
              <div key={name} className="rc-row" style={hueStyle(hue)}>
                <div className="rc-head">
                  <button className="rc-swatch rc-swatch-lg" aria-label={`change ${name}’s colour`}
                    title={`${name} — hue ${Math.round(hue)}°${pinned ? ", pinned by you" : ", from the ring"}`}
                    onClick={() => setOpenFor(open ? null : name)} />
                  <div className="rc-gist">
                    <div className="rc-name">{name}</div>
                    <div className="rc-sub">
                      {pinned ? "your colour" : "from the ring"}
                      {clashed.has(name) ? " · shared with another repo" : ""}
                    </div>
                  </div>
                  {pinned ? (
                    <button className="key rc-act" title="use the ring’s colour for this repo again"
                      onClick={() => pick(name, null)}><RefreshCw size={14} /></button>
                  ) : null}
                  <button className="key rc-act" title="a colour no other repo here is using"
                    onClick={() => pick(name, freeHue(names, cfg, name))}><Shuffle size={14} /></button>
                </div>
                {open ? (
                  <div className="rc-swatches">
                    {ring.hues.map((h) => (
                      <button key={h} className={`rc-swatch${Math.round(h) === Math.round(hue) ? " on" : ""}`}
                        style={hueStyle(h)} aria-label={`hue ${h}`} title={`hue ${h}°`}
                        onClick={() => { pick(name, h); setOpenFor(null); }} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
