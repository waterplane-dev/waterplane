/**
 * What every button MEANS, and when to say so.
 *
 * The app carried ~290 `title=` attributes — several of them two good
 * sentences — and a `title` is a POINTER tooltip. On the phone this whole
 * product exists for, not one of them has ever been rendered: the UI reads as a
 * row of unlabelled icons (↑ ↓ ⧗ + ➤ ↵ 🗑) with the explanation sitting in the
 * markup, invisible. `web/hints.ts` makes them reachable; this file is the half
 * with no DOM in it, so `e2e-hints.mjs` can pin the rules instead of trusting a
 * comment — the same reason `queue.ts` and `promptid.ts` live here.
 *
 * The rule worth pinning is `decideHint`. Getting it wrong is silent in both
 * directions: too eager and a fresh install is a dialog click-through with ~290
 * interruptions in it, too shy and the feature does nothing at all — and
 * neither shows up as an error anywhere.
 */

export interface HintDef {
  /** Head of the card — the action's real name, not its icon. */
  title: string;
  /** What it does. One or two plain sentences. */
  what: string;
  /** When you'd want it, or what it deliberately does NOT do. */
  when?: string;
  /**
   * Explain-then-act on the FIRST tap ever.
   *
   * Curated, and deliberately small: this is the only thing here that
   * interrupts a tap, so it is reserved for actions whose icon genuinely cannot
   * be guessed (hold, re-aim, chain-a-prompt, keep-newest, fork) or whose first
   * tap is expensive to get wrong. Everything else is answered by a long-press,
   * which the user asks for.
   */
  confirm?: boolean;
  /** Destructive or hard to undo — the card says so and goes red. */
  danger?: boolean;
}

/**
 * The curated hints, keyed by the `data-hint` attribute on the button.
 *
 * Ids mirror the `track()` vocabulary (`toolbar:<id>` for toolbar actions) so
 * the two catalogs stay one language: the usage sheet lists what gets used,
 * this lists what it means. A button with no entry here still gets a hint —
 * built from its own `title` — which is what makes the feature cover the whole
 * app rather than the parts somebody remembered.
 */
export const HINTS: Record<string, HintDef> = {
  // ── The send queue ────────────────────────────────────────────────
  "queue.hold": {
    title: "Hold until the session can take it",
    what: "Keeps this message in the queue until that session's turn has ended, no question box is open and it isn't blocked on a usage limit — then it goes on its own.",
    when: "Text typed at a working agent lands in its composer mid-answer; text typed at an open question box answers the box instead of running. Holding avoids both. Exact for sessions that report turn boundaries, a guess from silence otherwise.",
    confirm: true,
  },
  "queue.sendnow": {
    title: "Send it now, without waiting",
    what: "Types the next queued message into this session immediately, instead of waiting for the turn to end. It drops the park on that message \u2014 and on anything queued AHEAD of it in the same session, because a session's queue is delivered in order and a held message behind it would hold this one too.",
    when: "For when the turn has gone somewhere you did not expect and the follow-up is worth typing in mid-answer. It is refused, in words, when that session has a question box open or is blocked on a usage limit \u2014 prose typed into a dialog answers the dialog instead of running.",
    confirm: true,
  },
  "queue.serial": {
    title: "Wait for this repo's other sessions",
    what: "This row opens a session AND runs a prompt in it. With this on, it doesn't start until every other session in the same directory has finished its turn.",
    when: "Several prompts queued for one repo would otherwise all open their own agent at once — one account's usage limit spent in parallel, nothing finished, and several agents editing the same files. Off means this one starts regardless. “Send this one now” also overrides it.",
    confirm: true,
  },
  "queue.serialall": {
    title: "One session at a time per repo",
    what: "The default for newly queued prompts that open a session: run them one after another within a repo, rather than all together.",
    when: "Turn it off when you actually want the fan-out — usually you don't, because a fan-out belongs in separate worktrees, which this rule treats as separate repos anyway.",
  },
  "queue.retarget": {
    title: "Aim it at another session",
    what: "Keeps the words, changes the destination — another live session, or a repo's backlog.",
    when: "For when the session it was written for died, or the thought belongs to a different repo now. A fresh receipt id is minted, so it cannot collide with a verdict the host already recorded for the old one.",
    confirm: true,
  },
  "queue.addprompt": {
    title: "Queue another prompt behind this one",
    what: "This row OPENS a session. Prompts added here run inside it, one at a time — each delivered only after the one before has finished its turn.",
    when: "Writing a plan with no link: “read the failing test” → “fix it” → “commit”. Queued as a chain rather than concatenated into one prompt.",
    confirm: true,
  },
  "queue.restore": {
    title: "Put the text back in the message box",
    what: "Takes it out of the queue and drops the words back into the composer, so you can rework them and send again.",
    when: "Messages only. An action (fan out, run a build) and an answer to a question have no text worth pasting, so it is disabled for those.",
  },
  "queue.resend": {
    title: "Rewrite it and send it again",
    what: "Opens the message in an editor, checks every file it names against the repo, the send queue and this phone, and sends it as a NEW message once you are happy with it.",
    when: "For a send that gave up. Retrying re-sends the same words to the same place with the same attachments — which is exactly what already failed. By the time a link is back the words are often half wrong, and the photo behind them may have been dropped from the queue underneath, leaving text that points at a file nobody is sending.",
    confirm: true,
  },
  "queue.sendone": {
    title: "Send this one now",
    what: "Releases this message — and anything queued ahead of it for the SAME session, because one session is delivered strictly in order.",
    when: "Other sessions stay held. If an attempt already failed, this is the retry.",
  },
  "queue.sendall": {
    title: "Send everything queued",
    what: "Releases every message in the queue. Each session still takes them one at a time, in the order shown.",
  },
  "queue.retryall": {
    title: "Try every failed message again",
    what: "Puts every message that gave up back in the queue with a fresh retry budget. Works with the link down — they go out when it is back.",
    when: "A tunnel down for longer than a message is allowed to wait expires the whole backlog on the first reconnect, so the list is red all at once. Messages that were typed into a live session but never seen to submit are left out: re-sending one of those could type it twice, so it stays a per-message decision.",
  },
  "queue.remove": {
    title: "Discard this message",
    what: "Drops it from the queue. It is never sent, and the text is gone unless you put it back in the message box first.",
    danger: true,
  },
  "queue.more": {
    title: "The other actions",
    // "hold until it can be taken" was a fourth name for one WHEN that the
    // composer calls *when it's free*; four names for one decision is how a
    // person ends up believing there are four decisions.
    what: "Reorder within this session, hold it until this session is free, aim it somewhere else, or put the text back in the box.",
    when: "They live behind “⋯” because eight icons beside the message would leave no room to read the message.",
  },
  "queue.moveup": { title: "Move earlier", what: "Sends it sooner within this session. Order only matters inside one session — different sessions are delivered at the same time." },
  "queue.movedown": { title: "Move later", what: "Sends it after the next one in this session." },

  // ── Compose bar ───────────────────────────────────────────────────
  "compose.idle": {
    title: "Send when the agent is free",
    what: "Queues the prompt and delivers it once this session's turn has ended — instead of typing it into a session that is mid-answer.",
    when: "Same rule as the queue's hourglass. The plain send button delivers immediately, which is what you want when you are interrupting on purpose.",
    confirm: true,
  },
  // `compose.queue` used to sit here — *"Queue as a work item … the backlog
  // runs its items one at a time, in its own session"* — describing the retired
  // shared per-repo conversation, in the retired vocabulary, under a key no
  // `data-hint` has named since the composer's own button took the job. Both
  // halves of its sentence were false (every item opens a session of ITS own,
  // and they do not queue behind one another), and a hint nothing renders
  // cannot be found and corrected by using the app. Deleted rather than
  // reworded: the catalog tolerates unused entries, which is what let this one
  // rot in place.
  "compose.options": {
    title: "Where and when this goes",
    what: "Opens the send sheet with what you have typed already in it: which session, a fresh session or a set of repos it is aimed at, and — in five answers — when it goes: now, when that session is free, at a time you pick, after another item finishes, or once its files have arrived. The button at the bottom always restates the whole decision before you press it.",
    when: "Whenever \u201csend\u201d is not quite what you mean. The plain Send button stays one tap for the ordinary case; everything the old start, resend and schedule sheets used to ask lives here now, in the order you would ask it.",
  },

  "activity.open": {
    title: "Everything you have posted",
    what: "One row per piece of work, for its whole life \u2014 waiting on this phone, held on the desktop, running, scheduled, finished, or failed. A row never disappears when its state changes; it changes what it says. Each one carries the repo its words were written for, so sending it again asks you nothing.",
    when: "When you want to know what became of something. This replaces hunting through the queue, the backlog, the schedules and the network sheet for the same answer.",
  },

  "compose.cli": {
    title: "Type straight at the CLI",
    what: "Turns the message box into a keyboard wired to the session: every key goes through as you press it, and the CLI echoes it on the screen above. Tap the terminal to bring the keyboard back up.",
    when: "For driving the TUI — picking a file in /resume, walking a menu, answering a free-text box, typing “y”. Nothing is queued, confirmed or resent, so with the link down the keys are simply lost; a prompt you care about wants the normal send.",
    confirm: true,
  },

  // ── Toolbar ───────────────────────────────────────────────────────
  "toolbar:fork": {
    title: "Fork this conversation",
    what: "Opens a SECOND session that continues this exact conversation from where it stands. The original keeps running and is untouched.",
    when: "Trying a risky direction without losing the thread you already have.",
    confirm: true,
  },
  "toolbar:select": {
    title: "Copyable text",
    what: "Dumps what is on the terminal screen into a plain text sheet you can select and copy. In reader view there is no terminal, so it dumps the conversation instead \u2014 from the offline cache, so it works with the link down.",
    when: "A terminal grid fights text selection on a phone; this is the way out.",
  },
  "toolbar:clip": { title: "Send to the desktop clipboard", what: "Puts this phone's clipboard contents onto the DESKTOP host's clipboard." },
  "toolbar:shot": { title: "Screenshot the desktop", what: "Captures the host's whole screen and shows it here." },
  "toolbar:ctx": { title: "Context window", what: "Runs /context in this session — how much of the model's window this conversation is using." },
  "toolbar:usage": { title: "Cost", what: "Runs /cost in this session." },
  "toolbar:cpu": { title: "Desktop load", what: "CPU and memory of the machine running the agent, as a toast." },
  "toolbar:teleport": { title: "Teleport", what: "Runs the CLI's /teleport command in this session." },
  "toolbar:remote": { title: "Remote control", what: "Runs the CLI's /remote-control command in this session." },
  "toolbar:tasks": { title: "Tasks", what: "Runs the CLI's /tasks command in this session." },
  "toolbar:outline": { title: "Outline", what: "A table of contents for this conversation: one row per prompt, with what it did and which files it touched. Tapping a row jumps there in the reader." },
  "toolbar:sent": {
    title: "Sent commands",
    what: "Everything this app typed into this session, when, whether the app or you decided it, and whether delivery actually worked.",
    when: "Automation types through the same terminal a person does, so the scrollback alone cannot tell you who sent what.",
  },
  "toolbar:find": { title: "Find in this session", what: "Searches the visible output, and separately the prompts recorded for this session." },
  "toolbar:scrollback": { title: "Scrollback", what: "Earlier terminal output, kept ON THIS DEVICE. Panning up in the terminal scrolls the agent's own screen and needs the connection; this reads the copy saved here, so it works with the tunnel down. Only as far back as this phone was watching." },
  "toolbar:diff": { title: "Git", what: "Status, diffs, staging, commit and push for this repo." },
  "toolbar:files": { title: "Files", what: "The gallery: what the agent has produced in this repo, and what you have sent it." },
  "toolbar:browse": {
    title: "Browse the repo",
    what: "The worktree as a folder tree — every file, not just the deliverables the gallery lists. Open one to read it, and edit it in place when that is quicker than asking.",
    when: "A save carries the version you opened, so a file the agent rewrote in the meantime is refused rather than overwritten — and saving needs the link, since a write held until later would land on a file that has moved on.",
  },
  "toolbar:build": { title: "Builds", what: "Named build commands for this repo, run WITHOUT a session — the way to still produce an APK while the agent is rate-limited." },
  "toolbar:model": { title: "Model", what: "Relaunches this session on a different model, resuming the same conversation." },
  // ── The resume queue (several sessions blocked on the same limit) ──
  "limit.open": {
    title: "Sessions at the usage limit",
    what: "Lists every session blocked on a usage limit, in the order the host will resume them — one at a time, not all at once.",
    when: "A plan limit is an account fact, so sessions hit it as a group and all read the same reset time. This is where you say which one matters.",
  },
  // ── Scheduled prompts ─────────────────────────────────────────────
  "compose.later": {
    title: "Run it at a time you pick",
    what: "Hands the prompt to the schedule editor instead of sending it. It runs in THIS repo's backlog at the time you set — once, or every week.",
    when: "The prompt box still holds your text until you save the schedule, so cancelling loses nothing. A scheduled prompt is aimed at the repo, not at this session: session ids do not survive a host restart.",
    confirm: true,
  },
  "fanout.schedule": {
    title: "Run this sweep later",
    what: "Takes the repos and the prompt you just composed into a schedule — once at a time you pick, or every week.",
    when: "For the sweep that should run while you are asleep, or two hours before your weekly usage window rolls over and the leftover quota evaporates.",
  },
  "schedule.runnow": {
    title: "Run it now",
    what: "Fires the schedule immediately — the same sweep, off the clock.",
    when: "It does NOT use up the next scheduled run: testing Thursday's sweep on Tuesday still leaves Thursday armed.",
  },
  "schedule.session": {
    title: "Open the session this ran in",
    what: "Jumps to the session this occurrence used, so you can read what it actually did.",
    when: "Only where there IS one session to go to — a fan-out ran in N of them, and that is the fan-out view's job.",
  },
  "schedule.backlogitems": {
    title: "The items this rule has written",
    what: "Opens the Backlog on exactly the rows this schedule created, however many runs ago.",
    when: "The other direction of the link a row already shows (\u201cfrom the schedule \u2026\u201d). The number is the filter \u2014 a tap opens those rows and says what it is hiding, never the whole list. Rows written before this link existed do not count towards it.",
  },
  "schedule.skipnext": {
    title: "Skip the next run",
    what: "Lets one armed occurrence go by; everything after it stays on the clock.",
    when: "Different from pausing, and the difference is who has to remember: a pause waits for you to come back, a skip does not. Never offered on a one-off — skipping the one run it has would be deleting it.",
  },
  "schedule.toggle": {
    title: "Arm or disarm this schedule",
    what: "Stops it running without deleting it, and arms it again later.",
    when: "Re-arming computes the next run from now — a run missed while it was off is not caught up.",
    confirm: true,
  },
  "schedule.edit": {
    title: "Edit the schedule",
    what: "Change the time, the lead, the repos or the prompt. Saving replaces the same schedule rather than adding a second one.",
  },
  "schedule.remove": {
    title: "Delete this schedule",
    what: "Removes it for good. Anything it already started keeps running.",
    danger: true,
  },
  "limit.first": {
    title: "Resume this one first",
    what: "Moves this session to the front of the resume queue. Otherwise the order is starred sessions first, then whichever has been blocked longest.",
    when: "When the limit lifts, the first session through gets the fresh window. Marking two keeps the order you marked them in.",
    confirm: true,
  },
  "limit.auto": {
    title: "Auto-continue for this session",
    what: "Whether this session resumes by itself once the limit resets. Off takes it out of the queue entirely — it waits for you.",
    when: "The way to say “these three, not that one” when everything is blocked on one limit.",
  },
  "limit.resumeone": {
    title: "Resume this one now",
    what: "Stops waiting for the reset time and tries this session immediately, ahead of the queue.",
    when: "Also the way past the hold-off after a failed resume — an explicit tap overrules the clock. If the limit really has not reset, the attempt is spent for nothing.",
    confirm: true,
  },
  "limit.resumeall": {
    title: "Start the queue now",
    what: "Stops waiting for the clock for every queued session. They still go one at a time, in the order shown.",
    when: "For a reset time the banner got wrong, or a plan that was just upgraded.",
  },
  "limit.starredonly": {
    title: "Only starred sessions resume",
    what: "Turns auto-continue on for the starred blocked sessions and off for the rest, in one tap.",
    when: "When the limit resets into a window worth spending on two sessions rather than eleven.",
    confirm: true,
  },
  "limit.mode": {
    title: "How many resume at once",
    what: "One at a time, one per repo, or all at once. The first session always goes alone whatever this says: if it comes back still blocked, nothing else spends an attempt proving the same thing.",
    when: "“One per repo” is the middle answer — two agents must not edit one checkout, but two worktrees are not each other's business. “All at once” spends the fresh window broadly.",
  },
  "term.fullscreen": { title: "Full screen", what: "Hides the header, the status line and the toolbar and gives those rows to whatever you are reading — the same layout typing room gives you, without the keyboard taking half the screen. The Esc/Tab/arrow row stays, because with no keyboard it is the only way to answer the CLI. Tap again, or the menu button in the corner, to come back." },
  "term.read": { title: "Reader / terminal", what: "Swaps the whole view: the live CLI screen, or the scrollable, searchable transcript of the conversation. It sits here rather than on the header because full screen hides the header — and this is the control you want most in the layout you read a long turn in." },
  "term.modelwheel": { title: "Model · effort wheel", what: "Picks model and effort on one wheel: a spoke per model, effort from low at the centre to max at the rim. A tap only selects — the sentence above the wheel says what Apply will do, and only a change the CLI cannot make live relaunches the session. The prompt cache belongs to one model, so a switch makes the next turn re-write the context; the line under the wheel prices it. The chips below choose which models are spokes." },
  "term.zoom": { title: "Zoom this screen", what: "How big the terminal — or, in the reader, the conversation — is drawn, on top of the app's text size. In the terminal, smaller is a BIGGER grid: the desktop resizes the session to the new columns and rows, so more of what the CLI prints fits on the phone. The two surfaces remember their own zoom. At either end of the range that button is simply not there, and the readout says which end." },
  "limit.global": {
    title: "Auto-continue, globally",
    what: "The master switch: whether any session resumes itself after a usage limit resets. Per-session settings override it.",
  },
  "toolbar:limit": { title: "Auto-continue", what: "Whether this session resumes by itself once a usage limit resets. Tapping cycles: inherit the global setting → on → off." },
  "toolbar:image": { title: "Attach a photo", what: "Picks an image, uploads it into this repo's inbox and puts its path in the message box, so the prompt can point at it." },
  "toolbar:file": { title: "Attach a file", what: "Any kind — PDF, zip, audio, source. Uploaded into this repo's inbox with its path put in the message box." },
  "toolbar:backlog": { title: "Backlog", what: "This repo's waiting work: what is queued, what is running, and why anything queued has not started yet." },
  "toolbar:history": { title: "History", what: "The prompts recorded for this session — resend one, pin it as the overview label, or copy it." },
  "toolbar:cmd": { title: "Slash commands", what: "The CLI's built-in commands plus this repo's own, in a list you can tap instead of typing." },

  // ── Launcher / sessions / repos ───────────────────────────────────
  "session.star": { title: "Star", what: "Marks a session as one you are waiting on. A starred session that finishes a turn while you are elsewhere gets a “new” flag. Works with the link down — the star is kept on this phone and sent to the desktop when the connection is back." },
  "session.context": {
    title: "Context window",
    what: "How full this conversation's window has been over time, with a mark where it was compacted and a shaded band over every stretch the account refused to serve. Read off the CLI's own conversation log, which is dated — the badge beside it can only say where you are NOW.",
    when: "The window size is not written to that log, so no ceiling is drawn unless the CLI has printed one on screen; the dashed line is then where a compaction was last seen to fire, which is a measurement rather than a setting.",
  },
  "session.pin": { title: "Pin a line", what: "Replaces the session's second summary line with text you choose, so a long-lived session says what it is FOR rather than what it last did." },
  "session.close.all": {
    title: "Close sessions",
    what: "Opens a sheet over every listed session (or one repo's): tick facets — state, idle time, open time, what is still running underneath, unsent words, whether the conversation ever started, repo — to narrow which rows one tap ends. The conversations are kept and can be reopened later; the running processes are not — anything mid-turn is cut off where it stands, and a background shell under a closed session is stopped too, fully.",
    when: "The list, not this device: every phone and tab loses the closed sessions together. Star a session to spare it by default — the sheet's own toggle can include it anyway.",
    // No `confirm`: the sheet already shows the exact rows in scope, with a
    // per-row keep toggle, before its own foot button (itself a two-tap
    // ConfirmButton) sends anything.
    danger: true,
  },
  "session.close.stale": {
    title: "Idle for",
    what: "Two facets, \"idle for\" and \"open for\", cut the close sheet's list by how long a session has gone quiet or how long it has existed — tick more than one edge (>1h, >6h, >1d, >3d) and they OR together; combine with another facet (state, underneath, …) and it ANDs.",
    when: "\"Idle\" is measured from the last output, so a session paused on a question still counts as quiet by that clock — the sheet flags any row waiting on a box separately. A session with no readable activity record measures its quiet time only since the last desktop restart, and the sheet says so when that applies.",
  },
  "repo.hide": { title: "Hide this repo", what: "Removes it from the launcher list on THIS device only. Nothing on disk changes; unhide it from Settings." },
  "repo.focus": { title: "Focus this repo", what: "Filters the whole launcher down to one repo. The header keeps an X to leave." },
  "fanout.run": {
    title: "Fan out",
    what: "Runs ONE prompt in every selected repo — a fresh session each, all at once.",
    when: "The sweep that is otherwise N taps and N retypings (“/init everywhere”, “what did this cost this month?”). Each target is a real agent process, so pick the repos deliberately.",
    confirm: true,
  },
  "fanout.followup": {
    title: "Follow up",
    what: "Sends a second instruction into the sessions this run ALREADY opened.",
    when: "It never spawns: a target whose session is gone is reported failed rather than restarted from scratch, because a fresh session would run “now commit that” against a repo that never did step one.",
    confirm: true,
  },

  // ── Backlog ───────────────────────────────────────────────────────
  // Every item opens a session of its own now (the shared per-repo backlog
  // conversation is retired), so this used to promise the opposite of what
  // happens. It is the single-row skip-the-queue promise — a BULK release
  // never reaches this verb (`intent.waive` lifts the budget only).
  "backlog.fire": {
    title: "Run this item now",
    what: "Starts it this second in a session of its own (or in the session it is aimed at) — skipping the queue: the budget, the smart pick, one at a time and wait until free.",
    when: "For the one item you want now — it is the manual override, and one tap fires it past every hold. Several at once are several agents; if another agent is already working in this checkout, the row says so and the tap starts a second beside it.",
    confirm: true,
  },
  "backlog.queuehere": {
    title: "When that session is free",
    what: "Aims the item at the session on screen and marks it to fire on its own when that session is next idle \u2014 at the BOTTOM of that repo's queue, so tapping several items runs them in the order you tapped them.",
    when: "For building a run of work against a session you are already driving. Tap it again to take the item back off; nothing is deleted either way.",
  },
  "backlog.refire": { title: "Run it again", what: "Re-delivers an item that already ran, this second and in a session of its own — skipping the queue like fire. The agent sees the instruction a second time." },
  "backlog.openholder": {
    title: "The session this item waits behind",
    what: "Only one automatic job codes in a checkout at a time. This item is waiting for the one named here — working, on a usage limit, or with a question open that only you can answer. Opens that session.",
    when: "When the row says it is waiting for your answer: answer it there and this item starts next. Fire skips the wait entirely.",
  },
  // Its sibling, and the distinction IS the hint: `re-fire` promises "now",
  // this one promises "in turn". A failed row is otherwise a gravestone —
  // nothing in the machinery ever looks at one again — so without this verb
  // the only way back into the queue was to retype the words.
  "backlog.runagain": {
    title: "Put it back in the queue",
    what: "Puts a failed item back among the waiting ones, keeping its words, its place and the failure it had. It runs again in a new session of its own when its turn comes \u2014 one at a time in this repo, with auto and the smart pick taking it from there.",
    when: "For work that failed for a reason that has passed. Nothing starts this second: \u201cre-fire\u201d beside it is the verb for that. The old failure stays on the row, so an item that keeps failing says so rather than looking new.",
    confirm: true,
  },
  "backlog.name": {
    title: "Name these items",
    what: "Reads the words of the items shown here \u2014 nothing else, no repo, no code \u2014 and writes each one a short title and a kind: bug, feature, enhancement or chore. It leaves out any item you titled yourself, and any it cannot name honestly stays without one.",
    when: "For a list of long prompts that all look alike. One short call on the cheap model, so it costs little; it names only what is in the cut you are looking at, and running it again on the same rows changes nothing. A title it writes is yours to edit, and once you edit one nothing writes over it again.",
  },
  "backlog.done": { title: "Mark done", what: "Closes the item off by hand, without running it." },
  "backlog.smartpick": {
    title: "Look over this repo before each item starts",
    what: "With this on, the moment this repo is about to start its next waiting item, something reads everything still waiting first: it picks which one goes next, merges items that turn out to be the same job, and puts the rest in an order. It then does all three by itself — there is nothing to approve.",
    when: "Per repo, because a list of two a week and a list of fifty want different answers. What it merges is kept: the originals go to archived with their own words, and the row that replaced them carries an undo. Anything you dragged into place is never moved. And if the look fails, or takes too long, the item runs in the order you already had. A few seconds each time, and the strip on the repo bar says what that look cost; nothing at all while this is off.",
    confirm: true,
  },
  "backlog.smartpickrepos": {
    title: "Which repos take a look first",
    what: "Says how many repos have the look switched on, and opens the list of them.",
    when: "The count is the filter: tapping it shows exactly those repos rather than the whole list for you to pick them out of again. Off everywhere, the look costs nothing at all \u2014 not a completion, not a git call.",
  },
  "backlog.mergedfrom": {
    title: "Show the items this was written from",
    what: "Opens exactly the items that were folded into this row and nothing else — they are under archived, with every word still theirs. Clear the filter to get the list back.",
    when: "For reading what the merged wording actually came from, before you decide whether to keep it.",
  },
  // Its `when` used to read *"Only while it is still waiting: once it has
  // started … the originals stay under archived for you to bring back one at a
  // time."* That is the retired bring-one-back-by-hand sentence, attached to
  // the very button that replaced it — false against the host (the message is
  // accepted in every state but offline) and false against the row, which draws
  // `put them back` on a row that has already run. The whole point of the
  // button is the person the notification WAKES, and they always meet a row
  // that has started.
  "backlog.unmerge": {
    title: "Undo / put them back",
    what: "Returns the items this row was made from to the list, at the positions they had, and takes the row itself away. Nothing typed is lost either way — the words on this row were written by machinery, and the originals never left.",
    when: "Any time. While it is still waiting this is a true undo — nothing ran, and the button says “undo”. Once it has started it queues the originals again, as they were, and the row that ran is kept under archived rather than deleted; a session already running it is NOT stopped. The same merge is never proposed again afterwards.",
  },

  // ── Files / downloads ─────────────────────────────────────────────
  "gallery.pull": {
    title: "Download",
    what: "Fetches the file to this phone through the resumable queue — the bytes survive a dead tunnel, a reload and the app being killed — and hands it to the phone's own Downloads by itself when it lands.",
    when: "The same button everywhere: already fetching, a tap opens Downloads rather than starting a second copy; already here, it saves the file out again. Watch or pause it in Downloads.",
    confirm: true,
  },
  "gallery.fullres": { title: "Full resolution", what: "Re-fetches this image at its original size. The viewer shows a screen-sized copy by default, which is a fraction of the bytes." },
  "pull.supersede": {
    title: "Keep only the newest",
    what: "When a rebuild writes a new file of the same kind, the older queued one is dropped instead of being downloaded first.",
    when: "An APK named with its build hash is a new file every build — without this an afternoon of builds queues five of them and the phone downloads all five to reach the one you wanted.",
    confirm: true,
  },
  "pull.pause": { title: "Pause", what: "Stops this download and KEEPS what has arrived. Resuming continues from that byte; it does not start over." },
  "pull.retry": { title: "Retry", what: "Tries again from the bytes already here." },
  "pull.clearall": { title: "Clear the queue", what: "Drops every download still waiting — the desktop's own queue and the ones asked for from this phone. Files already fully downloaded stay on the phone.", danger: true },
  "pull.auto": { title: "Auto-download", what: "Whether files matching this repo's rule start downloading by themselves as soon as the agent produces them. A file YOU tapped is fetched whatever this says — the switch governs unattended work, not a person." },

  // ── The permanent connection strip ────────────────────────────────
  "net.pulse": {
    title: "Connection strip",
    what: "Live round-trip time to the desktop: a state dot, the last ~90 seconds as a graph, and the current number. Red marks are pings that got no answer at all — they are drawn rather than averaged in, because a link that loses one ping in four feels nothing like a slow one and only that one eats prompts. In the middle, how old what you are looking at is: while the link is down it counts up from the last thing the desktop actually said, and while it is up it is the age of the last full sync — the session list AND the repo listing, whichever is older. On the right, how much data this phone has moved: the down and up rates while something is actually transferring, and the running totals either way.",
    when: "It only watches — a missed ping here never reconnects anything. Tap any part of it for that part's detail, or turn it off in Settings › Tools.",
  },
  "net.pulse.graph": {
    title: "Round trip",
    what: "How long a ping to the desktop takes, drawn as the last ~30 probes. A second, dimmer number appears when the newest probe is far off the median, so one slow ping can't be the only figure on screen.",
    when: "Tap for the window it is drawn from: last and median ping, how many probes are in it, and how many got no answer.",
  },
  "net.pulse.route": {
    title: "Route",
    what: "How this phone reaches the desktop: LAN (its address on your Wi-Fi, used only after it proved it is this desktop) or the tailnet, the route that works anywhere.",
    when: "Tap for the sentence saying why this route — the Wi-Fi name, the check that failed, or that a password is needed on the host before LAN can be used.",
  },
  "activity.group": {
    title: "One row per distinct message",
    what: "Collapses rows that say the same thing into one strip: how many copies there are, how old the oldest is, and \u2014 the part that decides \u2014 whether one of those copies ALREADY RAN. Tap the chevron to see them all.",
    when: "Always, on a long list. Unresolved sends are mostly repeated re-sends of the same few texts, because that is what a person does when the app says their prompt did not run.",
  },

  "activity.debris": {
    title: "Hide one-word replies",
    what: "Hides \u201ccontinue please\u201d, \u201cdone?\u201d, a bare /cost \u2014 words that mean nothing away from the screen they were typed on. Nothing is deleted; tap again to see them.",
    when: "When you are reading a long failed list and want only the rows with a subject in them.",
  },

  "activity.bulkDismiss": {
    title: "File these away as dealt with",
    what: "Marks the selected rows read-and-not-wanted. NOT a delete: they keep their words, their verdict and their buttons under the \u201cdismissed\u201d chip, and \u201cbring back\u201d returns them to the list.",
    when: "After you have decided a batch is obsolete. It is what makes the list shrink.",
    confirm: true,
  },

  "activity.bulkRefire": {
    title: "Send these again",
    // Not "as a work item \u2026 in that repo's own session": the shared per-repo
    // conversation is retired, so every one of these opens a session of its
    // own, and the desktop's slot cap \u2014 not a queue \u2014 is what decides how many
    // run at once. The old sentence described behaviour that stopped existing.
    what: "Posts each selected row's words again in the repo they were written for \u2014 no picker, no retyping. Each one opens its own session when the desktop has room, and their old rows are filed away.",
    when: "For the survivors of a triage pass: the ones that never ran and still make sense.",
    confirm: true,
  },

  "net.pulse.sends": {
    title: "Sends that gave up",
    what: "Prompts written on this phone that never made it into a session — the queue tried, ran out of tries, and stopped. Nothing ran, and nothing here retries itself. The words are kept: the queue row holds them for as long as it takes, and nothing retires it.",
    when: "Tap for the list, with each one's words, what stopped it, and the repo it was written for — “send again” puts it back in that repo's backlog, with no picking and no retyping. This slot used to count unanswered PINGS; those are drawn in the graph instead, because a lost ping costs nothing and this does.",
  },
  "net.pulse.saved": {
    title: "Is it on the desktop yet?",
    what: "The one reading on this strip that is about your words rather than the link. A green check means everything written on this phone \u2014 queued prompts, armed schedules, notes, settings \u2014 has reached the desktop and been stored there, so nothing is waiting on this device. A count instead means that many things are still only here; they go as soon as the link allows.",
    when: "Look before putting the phone away. It stays blank until this phone has actually had something in flight, and it yields to the red slot when a send has given up \u2014 \u201call saved\u201d beside \u201c1 send stuck\u201d would be a contradiction, and the red one is the one to believe.",
  },
  "net.pulse.when": {
    title: "How current this is",
    what: "With the link down, how long since the desktop last said anything — the app keeps drawing from saved copies, and this is their age. With it up, how long since the last full refresh of both the session list and the repo listing; the older of the two is the one shown, because that is when everything on screen was last true.",
    when: "Tap for the exact times, and for which half is still missing when it says it is syncing.",
  },
  "net.pulse.data": {
    title: "Data moved",
    what: "How much this phone has downloaded and uploaded since the counter was last reset. A speed appears beside the arrow only while something is actually transferring, so no speed means nothing is moving.",
    when: "Tap for the totals in full and for exactly what is and isn't counted.",
  },

  // ── The feature explaining itself ─────────────────────────────────
  "hints.toggle": {
    title: "Explain mode",
    what: "While it is on, tapping any button says what that button does instead of doing it. Tap it again to leave.",
    when: "Long-pressing a button does the same thing one at a time, at any moment, without switching anything on.",
  },

  "schedule.spent": {
    title: "One-offs that have been and gone",
    what: "A one-off schedule that has already fired — or that was missed — is not a schedule any more: there is no instant left for it to run at and it cannot be re-armed. So it stops being a row on this sheet and becomes a row in Activity, where every piece of posted work is kept for its whole life.",
    when: "Tap to open exactly those rows in Activity, filtered — not the whole list for you to find them in. Run it now still works on one from there: the host revives a spent one-off and fires it.",
  },
  // ── The desktop strip (`LocalRtBar.tsx`) ────────────────────────────────

  "localrt.bar": {
    title: "How hard this desktop is working",
    what: "A live readout of the machine: CPU busy and its recent line, GPU busy, and memory available — amber when memory is tight. While a local model is loaded, that model takes the front of the strip: its name, the bytes it holds and their line. It watches — it never starts, stops or evicts anything.",
    when: "A hosted model costs money on somebody's invoice; a local one costs this machine, and so does a build or twenty sessions — all invisible from a phone otherwise. Tap any reading for the full sheet; switch the strip off in Settings.",
  },
  "localrt.models": {
    title: "The models resident right now",
    what: "Each model the runner is currently holding, with the bytes it occupies. Empty means the runner answered and is holding nothing, which is a different fact from the runner not answering at all — the strip words those two apart.",
    when: "Tap for the full list: per-model size, how much of it is on the GPU, and when the runner intends to evict it.",
  },
  "localrt.graph": {
    title: "Held memory over the last few minutes",
    what: "One mark per sample of the total bytes resident. A sample where the runner did not answer is drawn as its own full-height mark rather than averaged in or bridged over — those are a different kind of event, not a small number.",
    when: "This is what a model being loaded or evicted looks like: a step, not a slope. It is the last hundred-odd samples, not a time axis — nothing is measured while the phone is in a pocket.",
  },
  "localrt.cpu": {
    title: "The desktop's CPU",
    what: "How busy the machine is, from the operating system — not from the model. With no model loaded the strip leads with it, and the line beside it is the last few minutes of it. A local model generating text pins this; a model sitting loaded and idle does not.",
    when: "Tap for the detail. Tokens per second is deliberately not shown anywhere here: nothing this app can read publishes it, and an estimate would be wrong in both directions that matter.",
  },
  "localrt.memory": {
    title: "Memory available on the desktop",
    what: "What a new program could actually get, from the operating system — the file cache counts as available, because it is handed back on demand. It is the number a second local model would have to fit into. Amber when less than a tenth is left or the swap file is nearly full.",
    when: "Good enough to warn on, nowhere near good enough to refuse work on, which is why nothing in this app ever blocks a launch over it.",
  },
  // ── The session-tab strip (`SessionTabsBar.tsx`) ────────────────────────

  "session.tabs": {
    title: "A session you have open",
    what: "One tab per live session, coloured by its repo — the same colour that repo wears on the launcher's group header and down the side of every one of its rows, so a tab is recognised before it is read. The taller tab with a cap of colour on it is the one you are in. The mark beside the name is what that session is doing, in the launcher’s own five words and five colours: a turning ring while a turn is running, a red dot waiting on an answer from you, an orange one at the usage limit, a grey one with nothing left to do, and a red one on a process that has exited.",
    when: "Tap to go straight there from wherever you are — everywhere else in the app the sessions are a column you scroll. The × closes that session and asks first; the conversation itself is kept either way. How many tabs fit, what order they sit in, and which colour each repo gets are all in Settings.",
  },

  // ── The repo readings ─────────────────────────────────────────────
  // Every metric on that sheet, keyed `repohealth.<series key>` so the tile
  // can find its own without a lookup table. These explain a TERM, not a
  // button: what was counted, over what, and what moves it. None of them says
  // whether a number is good — the tool has no threshold anywhere in it, and a
  // hint is the easiest place for one to sneak back in as an adjective.
  // `tools/repohealth.test.mjs` fails if a series the tool emits has no entry
  // here, because a help chip that is present on five tiles and missing on the
  // sixth reads as "that one is self-explanatory".
  "repohealth.size.p95": {
    title: "p95 file length",
    what: "The length of the file at the 95th percentile: 95 out of 100 source files in the tree are shorter than this. Counted in lines, over the source set — whichever file kinds this repo's own detected languages count as source, minus their tests, minus build and vendor directories. The sheet names which languages it found.",
    when: "A mean would be a number about the single biggest file and almost nothing else — one outsized file can carry a large share of every source line on its own. The p95 describes what a large file looks like with that kind of outlier already inside the 5% being ignored, so it moves when MANY files grow and barely twitches when one does. The tape at the foot of the sheet names the longest file and its length.",
  },
  "repohealth.retouch.rate": {
    title: "The re-touch rate",
    what: "Over a trailing window of days, the share of file touches that were re-touches: the same file edited again soon after — soon in HOURS, or within a couple of commits that are also close in time. Sweep commits touching most of the tree are left out of both halves of the fraction. The touches it is a share of, and the three most re-touched files, are printed beside it. The exact window, hour and commit distance are pre-registered in the tool, not written down on this phone.",
    when: "A file edited once and left alone is a decision that held; a file edited again two days later is one that did not. It is also the one number here that does not fall simply because more code was written, which is why the sheet plots it at all. Read it with its denominator: 1.00 over 6 touches and 0.69 over 36 are different claims.",
  },
  "repohealth.hatches.perKloc": {
    title: "Escape hatches per kLOC",
    what: "How many places a rule was switched off on purpose, per thousand source lines. Each detected language has its own marks — TypeScript's `as any` and `@ts-ignore`, Kotlin's `!!` and `@Suppress`, Python's `# type: ignore` and a bare `except:` — plus TODO and FIXME, which count the same way in every language. Counted as OCCURRENCES, so two on one line count twice.",
    when: "Per kLOC rather than raw, or it would mostly plot how fast the repo is growing. Whether any single hatch was the right call is a judgment and this tool never makes one: there is no threshold anywhere in it, and no colour on this number. Only the marks a detected language knows about are counted — the sheet lists which languages are active.",
  },
  "repohealth.context.claudeMdChars": {
    title: "CLAUDE.md, in characters",
    what: "The size of this repo's CLAUDE.md at the commit that was measured. It is re-sent on every turn of every session in this repo, so it is paid per TURN, not per session.",
    when: "The repo-setup sheet weighs the same file and can disagree with this: that row measures the WORKING TREE as it stands, this one the last commit. An uncommitted edit to CLAUDE.md is exactly the gap between them, and neither is corrected to match the other.",
  },
  "repohealth.context.descChars": {
    title: "The always-on skill descriptions",
    what: "The one-line description of every skill this repo ships, added up. Descriptions are always in the window — that is how the agent knows a skill exists at all. Skill BODIES are loaded on demand and are not counted here.",
    when: "Moving prose out of CLAUDE.md into a skill body takes it out of both numbers. Splitting one skill into six adds six descriptions, so a tidy-up that reads as a reduction can raise this half while lowering the other.",
  },
  "repohealth.context.skillCount": {
    title: "The count of skills",
    what: "How many skills this repo ships at the commit that was measured — the same set the descriptions above are the descriptions OF, so the two can never describe different populations. It counts skills, not their size: a body is loaded on demand and weighs nothing here.",
    when: "The one tile with no percentile and no arrow under it, and that is deliberate. A rise can be reference leaving CLAUDE.md for a skill that loads only when it is needed, and a rise can be one skill split finer than its subject divides — the count is identical either way, so the tool draws the shape and takes no position. Read it beside the other two: those move in opposite directions when reference is relocated, and this says how many pieces it landed in.",
  },
  "repohealth.untested.count": {
    title: "Modules no test names",
    what: "Source modules that no test file names, by whatever counts as naming one in the detected language — an import path in TypeScript or Python, a package path in Kotlin. A mention has to carry at least one DIRECTORY segment, never a bare word on its own: a bare name is also ordinary prose, and matching it alone would mark most of the tree tested for no reason.",
    when: "A count and not a percentage, because a ratio rises when you add a tested feature and falls when you add an untested one, which mostly plots growth. Nobody can write a test for 27%; a list can be closed one line at a time. It says a test NAMES the module, never that the module is covered — and a language with no naming rule of its own sits outside this count rather than inside it, neither tested nor untested. In a language whose own tests sit beside what they test rather than importing it, a test that needs no import names nothing, so this count reads high there even where the tests do exercise the code.",
  },
  "repohealth.reading": {
    title: "The percentile and the arrow",
    what: "Under every tile: where today's value sits among that series' own recent readings, and the direction of a straight line fitted through them. Too short a history and both are withheld, and the tile says so rather than guessing. How long the window is and how short is too short are the tool's, carried on the wire and printed in the caption under the tiles — this card does not keep a second copy to go stale.",
    when: "The comparison is always a series against ITS OWN past — never another repo, never a target, and never a threshold. The arrow carries no colour because rising lines and rising escape hatches are opposite news and a hue would have to decide which.",
  },
  "repohealth.weight": {
    title: "Always-on weight over time",
    what: "CLAUDE.md and the skill descriptions stacked, so the top edge is the total that every turn of every session re-sends. Zero-based, unlike the tiles above, because it is a quantity rather than a position.",
    when: "A day where either half went unmeasured is a gap in BOTH bands, never a shortened top edge: the sum is the one mark a reader takes off this chart, and a total quietly short by an unknown amount would be read as a real drop.",
  },
  "repohealth.areas": {
    title: "What a change carries, per area",
    what: "On the latest reading only. The hollow end is what an edit in that area usually carries — CLAUDE.md, every skill description, the area's router and the sub-skills that area's own files claim. The solid end is the same with every one of that area's skill bodies loaded.",
    when: "Re-partitioning the skills moves the near end and cannot move the far one; deleting prose moves both. One scale across every row, zero at the left, so the areas are comparable to each other. This exists only in a repo that splits its skills into a router and sub-skills named after it; elsewhere there is nothing to draw here, and the repo-wide weight above still does.",
  },
  "repohealth.packages": {
    title: "Lines of source by group",
    what: "Source lines per source group, stacked over the series, so the top edge is the whole tree. A group is a top-level slice the tool derives from where the files sit — `packages/web`, `app`, `service`, or `.` for files at the root — never an npm workspace list, so it draws the same way whatever this repo's package manager is, if it has one at all. That is why there is no separate total-lines curve beside it — one quantity, one mark.",
    when: "A colour follows a group by NAME and never by its size today, so one group overtaking another does not swap their bands and re-colour the whole history. A group with no files on a day that WAS measured is a zero, not a hole.",
  },
  "repohealth.types": {
    title: "Lines of source by file type",
    what: "The same source lines the chart above stacks by group, cut by what the code is instead: one band per file extension the detected languages claim, with the language pack that claims it named beside it. The top edge is therefore the same total drawn twice — one quantity, two questions.",
    when: "A group says which part of the tree grew; a type says what grew in it, and in a repo where one app is one language those two answers look identical until the day they are not. The chips above the chart are a filter: tapping types off redraws the stack over only those, and the caption then says how many types and how many lines the top edge is standing for.",
  },
  "repohealth.classics.files": {
    title: "Source files",
    what: "How many source files live in the tree, over time — the source set the sheet's detected languages count, minus their tests, minus build and vendor directories. A size, not a reading: nothing compares it to anything, which is why no percentile and no arrow appears beside it.",
    when: "It is part of what the percentiles above are percentiles OF. A position in a window means nothing without a feel for the magnitude being positioned.",
  },
  "repohealth.classics.deps": {
    title: "Production dependencies",
    what: "Runtime dependencies declared in the manifests a detected language knows how to read — a `package.json`, a `requirements*.txt`, the `[project]` table of a `pyproject.toml` — added up across the tree. devDependencies are counted apart and never summed into this: one ships and is in the attack surface, the other is a build-time cost that can be swapped on a Tuesday.",
    when: "Some languages decline this on purpose rather than guess: a Gradle build script is a program and not a list, and a `pubspec.yaml` mixes shapes a plain count would misread — so where nothing in the tree is a manifest this tool knows how to read, the reading is ABSENT rather than zero. Absent means nobody counted, never that nothing is depended on. Where it does read, it moves in single steps and each step is a decision somebody made, which is what makes the shape of this curve readable at a glance in a way a line count is not.",
  },
  "repohealth.table": {
    title: "The readings, as numbers",
    what: "The tail of the series as a table — p95 file length, the longest file, file count, lines per group, dependencies — oldest first, the same direction the charts run. Its own caption says how many day-rows it shows and out of how many.",
    when: "Two of the band colours sit under 3:1 contrast on a light screen, so the split has to be readable without them. And a crosshair answers for one day at a time: this is the only place on the sheet where a day can be held against the day beside it.",
  },
  "repohealth.longest": {
    title: "The longest file, over time",
    what: "The length of the single longest source file at every reading, one hue per file. Where a different file takes the top spot the line changes hue and a ring marks the reading it happened on, joined to the old holder by a thin step. Drag across the curve for a day's length, file and commit; the legend lists each file that held the spot and for how many readings.",
    when: "A tree whose biggest file only grows is one where every change keeps landing in the same place. A split shows up here as the curve dropping and a new name taking over; a file that is merely renamed shows up the same way, so the name is printed rather than inferred.",
  },
  "repohealth.classics.tape": {
    title: "The longest files",
    what: "One bar per file for the longest source files in the tree, tallest first, drawn to scale against each other. Tap or drag across a bar to name its file under the chart, with an open button that shows the file itself; tap the same bar again to let go. The caption names how many were taken and out of how many.",
    when: "This is the feel-for-the-magnitude picture the rest of the sheet is measured against: a shape, not a lookup. It is a slice of the tail, so its middle bar is not the repo's median file and no median is printed for it.",
  },
};

/**
 * `first` — the curated hints explain once each, then get out of the way.
 * `press` — nothing interrupts a tap; long-press still explains.
 * `off`   — no hints at all.
 */
export type HintMode = "first" | "press" | "off";

/** What should happen to a tap. */
export type HintAction =
  /** Let it through untouched. */
  | "act"
  /** Show the card and run nothing — the tap is spent on the question. */
  | "explain"
  /** Show the card, and run the action only if they say go ahead. */
  | "explainThenAct";

/**
 * The one decision, kept away from the DOM so it can be pinned.
 *
 * `explain` (explain mode) beats everything, including `off`: it is switched on
 * deliberately, seconds before the tap, and a mode the user just enabled that
 * silently did nothing would be worse than no feature. Otherwise only the
 * curated `confirm` entries interrupt, only once each, and only in `first`.
 */
export function decideHint(opts: {
  mode: HintMode;
  /** Explain mode is on — every tap is a question. */
  explain: boolean;
  /** The hint for the tapped button, if it has one at all. */
  def?: HintDef;
  /** This hint has already been explained and dismissed. */
  seen: boolean;
}): HintAction {
  if (!opts.def) return "act";
  if (opts.explain) return "explain";
  if (opts.mode !== "first") return "act";
  if (!opts.def.confirm) return "act";
  if (opts.seen) return "act";
  return "explainThenAct";
}
