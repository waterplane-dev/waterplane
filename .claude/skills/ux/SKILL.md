---
name: ux
description: waterplane's interaction rules for the phone UI, across every screen — how a control explains itself (long press, the `?` chip, `Explain`, explain mode), first-run aids such as a worded label or a one-time ask, and the rule that anything which changes its own look or disappears tells the person at that moment and names the way back. Also how a refusal, an empty list, a confirm and a receipt are worded. Load BEFORE adding or changing a label, a hint, a toast, a first-run or one-time behaviour, or any control whose look depends on state.
---

# waterplane UX — one grammar for what the phone says and shows

The area skills (`web-*`) hold each module's rules. This one holds the rules that
cut across all of them, so two screens never teach the same thing two ways. The
reasoning is in [web.md](../../../docs/notes/web.md), *Chrome that changes itself says so*.

The always-on rules in `CLAUDE.md` still apply and are not repeated here: no greyed
buttons, a count is a filter, no emoji icons, no `window.confirm`, never overwrite
typed words.

## 1. A control changes itself only out loud

Some chrome is meant for the first time and then gets out of the way. The person
learns its first look, so **a change they did not ask for reads as a bug or a lost
button.** Anything that changes its own look or goes away without the person
choosing it:

1. **Says so when it changes, on the screen they are on.** A toast for a change of
   look; a one-time ask (a hint card with two answers) when a CONTROL is removed.
   Never just at some later render.
2. **Says what it becomes**, in its new form's words, or that it is
   gone and **where it comes back** ("Settings › Writing & reading brings it back").
3. **Uses ONE predicate** for "show the aid" and "say it retired". The label and
   the sentence key off the same function, as the count and the cut do.
4. **Ask when removing, tell when restyling.** Taking away a control is the
   person's decision (the `?` chip asks). Dropping a word from a button that stays
   is a notice.

Where it already holds, as patterns to copy:

| aid | when it changes | what it says | way back |
|---|---|---|---|
| header `?` (`HintToggle`, `HintLayer.tsx`) | first exit from explain mode | one-time ask: *keep it / remove it* | Settings › Writing & reading, toast names it |
| first-use hint card (`hints.ts` `confirm` set) | after it explained once | card foot: *"Explained once. The next tap on this button just does it."* | long press; explain mode |
| reader → terminal hold (`TermArea.tsx`, `SessionInfo.cliSetup`) | claude not signed in, CLI in its first-launch setup | toast `CLI_SETUP_HOLD`, then `CLI_SETUP_DONE` when it lets go | automatic: the first hook clears it |
| first-run card (`features/onboard`) | first session; *not now* | *not now*'s `title` says "until the app reloads" | reload |

## 2. Explaining a control: pick one route, never write the words twice

- **Long press, everywhere, free.** Delegated in `hints.ts`, falls back to the
  element's `title`. A good `title` is the floor for every button. It is NOT seen
  on a phone without that press, so it is never the only place a reason lives.
- **`HintChip`**: a `?` for a TERM (a percentile, a rate). Text in the shared
  catalog (`shared/hints.ts`), checked by `e2e-hints.mjs`. No catalog entry = no chip.
- **`Explain`**: a `?` for a sentence about THIS screen's state. Closed by default.
- **Explain mode** (header `?`): the relearn route once everything was dismissed.
- **A refusal is never a hint.** A verb that cannot run says why in text, always
  (`Unavailable.tsx`).
- **A first-run aid is a word, not a tour.** Put the word on the control itself
  (`+ now`) rather than a coach mark pointing at it. A card that says "tap the X"
  must name the X exactly as drawn ("tap + now on one of your repos below").

## 3. Every tap ends in something visible

- A screen opening, a row changing, or a toast. Never nothing (`liveSend` /
  `liveAsk`, eslint `no-silent-send`; web.md *No tap may be silent*).
- A toast's clock is the length of its words (`toastMs`) and it is logged in
  *On this phone*. One sentence. It is a receipt, not a manual.
- Empty, loading, offline and error are four different sentences (`Empty.tsx`,
  `useRemoteResource`). Cached data says how old it is.
- "Are you sure?" goes through `Confirm.tsx` and disarms after `ARM_MS`.

## 4. Words

- Verbs on buttons, lower case, short: *new*, *keep it*, *remove it*, *done*, *not now*.
- Settings paths with `›`: *Settings › Writing & reading*. Name the real section.
- Name things as drawn. If the button shows `+ now`, the sentence says `+ now`,
  not "the plus" and not "a repo".
- What the person controls is *you*; the desktop is *the desktop*; the CLI is
  `claude`. No "we".
- Icons are `lucide-react`, one icon per meaning: two verbs never share a glyph.

## 5. Phone room

- Design for 390 px. Repo header buttons are 38×40 (`.focus-btn`); an idle repo's
  name keeps a 7em floor. A worded button costs ~70 px, so put words on one
  control at a time and keep them short (`new`, not `new session`).
- 44 px is the platform touch minimum; next to a destructive button it is a rule.
- A state that changes a control's width moves its neighbours. Do it when the
  person caused it, not mid-glance.

## Checklist before you ship a visible change

- [ ] Does anything here change its look or vanish on its own? → §1: said, when, way back.
- [ ] Does every new control have a `title`, and a hint or `Explain` if its glyph is a guess?
- [ ] Does every tap end in a visible result, offline included?
- [ ] Do the words name controls exactly as drawn?
- [ ] Does it fit 390 px without wrapping the header onto a third line?
