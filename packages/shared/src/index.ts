/**
 * waterplane wire protocol — shared between host daemon and web client.
 *
 * Transport: one WebSocket per browser tab. Messages are JSON, except
 * raw PTY bytes which are framed as { t: "pty", ... } with base64 to keep
 * everything on the single JSON channel (simplicity over micro-perf).
 *
 * This file is the INDEX, not the protocol. Every name below is re-exported, so
 * `import { SessionInfo } from "@waterplane/shared"` keeps working and no call site
 * anywhere needs to know which file a type moved to — which is the whole reason
 * the split is safe to make. What it buys is that the protocol is now legible
 * by subsystem, and that a feature touching one area stops rewriting the file
 * every other feature also edits. It was 1,768 lines and 20 commits deep, which
 * made it, with `App.tsx` and `main.ts`, one of the three permanent
 * merge-conflict surfaces in the project.
 *
 * The DTOs are grouped by what a field is ABOUT; the two message unions are
 * kept apart from them, because a union changes when a MESSAGE is added and a
 * DTO changes when a FIELD is.
 */

/** A drivable session, and everything that describes one of them. */
export * from "./wire/session.js";
/** What a *Recently closed* row may say — clipped, optional, never guessed. */
export * from "./closed.js";
/** The follow-up flag: who set it, what it may say, its one wording. */
export * from "./followup.js";
/** What a conversation bookmark may say (R-conversations-007). */
export * from "./bookmark.js";
/** The emergency halt latch: its state, its receipt and the one refusal sentence. */
export * from "./halt.js";

/** The wire subset of a host-side backend descriptor — what a picker or a
 *  capability check is allowed to know about a backend other than claude. */
export * from "./wire/backend.js";

/** The opt-in second opinion, and the audit of everything typed into a session. */
export * from "./wire/sent.js";
export * from "./plugin.js";
export * from "./pluginfile.js";
export * from "./pluginmaturity.js";
export * from "./wire/updates.js";
export * from "./stream.js";

/** Metering, feature usage, scraped CLI usage, and the desktop's own load. */
export * from "./wire/telemetry.js";
/** Usage readings per source: claude's adapter, the chip's one cut, the long-press words. */
export * from "./usagesources.js";
/** What an arbitrary span cost, by hour, repo and conversation — `GET /api/costwindow`. */
export * from "./wire/costwindow.js";

/** Which notification kinds may fire at all — checked on BOTH ends. */
export * from "./wire/notify.js";
/** The Android background link: which frames a notify-only socket is sent. */
export * from "./wire/notifylink.js";

/** Work the host does on the user's behalf: backlog, builds, fan-out, downloads. */
export * from "./wire/work.js";

/** What got installed on which phone. One desktop, many devices — so the log of
 *  what a build actually landed on lives with the desktop that produced it. */
export * from "./wire/install.js";

/** A picture of a running screen, and the claim the run is ALLOWED to make
 *  about it — "verified" is reserved for an oracle reading, and everything that
 *  was not measured is absent rather than zero. */
export * from "./wire/capture.js";

/** The exposure watch: rows, accepts and the setup-checklist rows built from them — the CLI and
 *  the phone must agree on what is accepted. */
export * from "./exposure.js";

/** A repo or worktree: its git state, its setup verdict, the CLI install behind it. */
export * from "./wire/repo.js";
/** Always-on context: what a conversation's first request carried, and a repo + desktop's every-turn rows. */
export * from "./wire/alwayson.js";

/** The reader view's document — the CLI's own conversation log, parsed. */
export * from "./wire/transcript.js";

/** The first-app onboarding job: plan, consent lines, persisted steps. */
export * from "./wire/onboard.js";

/** The two unions on the wire, `PROTOCOL_VERSION`, and the JSON codec. */
export * from "./wire/messages.js";
/** The shape check on a decoded client frame, ahead of the host's dispatch. */
export * from "./clientframe.js";

// A per-session budget (tokens, dollars, window percent): the verdict, the
// calibration and the one predicate both ends hold a session's sends by.
export * from "./sessionbudget.js";
export * from "./spendwarn.js";

// Send-queue scheduling (offline outbox): the one-send-per-session lane rule.
export * from "./queue.js";
// When a durable send was FIRST put on the wire — what lets a host that lost
// its ack ledger fail closed on a pre-loss re-send.
export * from "./sendstamp.js";

// Where "the host" is when the app is NOT served by it — the Android shell
// (packages/app) loads its UI out of the APK, so `/api` and `/ws` need aiming.
export * from "./hosturl.js";

// Several desktops on one phone: the saved-host list, its migration from the
// one `hostBase`, the key parking a host switch does, and the per-host IDB.
export * from "./hosts.js";
// LAN or tailnet: the three ANDed gates and the sentence for each verdict,
// plus the Android `ShellNet` plugin's `NetState` contract.
export * from "./lanroute.js";
// Pairing a new phone by QR: code format, deep link / landing URL, redeem DTOs.
export * from "./pairing.js";
// The paired-device ledger as the phone sees it.
export * from "./devices.js";
export * from "./passive.js";
// Ask rules: the permission rules every claude launch is given as `permissions.ask`.
export * from "./askrules.js";

// Question identity — what makes an answer typed OFFLINE safe to deliver later.
export * from "./promptid.js";

// Which localStorage keys follow the USER rather than the browser, and why.
export * from "./settings.js";

// What colour a repo is: the ring the hue comes from, the hash that picks one,
// and the answer a person may pin over it.
export * from "./repocolor.js";

// What every button MEANS, plus the one rule that decides when to say so.
export * from "./hints.js";

/** The HTTP fuse (see netfuse.ts) — here, not in `web`, so a node e2e can point
 *  it at a server that never answers and prove the client gives up. */
export * from "./netfuse.js";
/** What the phone records when an HTTP request stalls (see netstall.ts). */
export * from "./netstall.js";

/** Scheduled prompts — a wall-clock rule, its zone, and the lead time before an
 *  anchor (the weekly usage reset) that the rule is actually tracking. */
export * from "./schedule.js";

/** Reconstructed alt-screen scrollback — the only history a phone has when the
 *  scroll it would otherwise send to the TUI can't reach it. */
export * from "./screenlog.js";

/** Gallery listings the phone can still answer with the tunnel down — what a
 *  cached listing is allowed to be re-filtered into, and what it is not. */
export * from "./gallery.js";

/** Clearing OUT a transport directory: the age ladder, the cut, and the
 *  sentences. Plans and describes — it deletes nothing and schedules nothing. */
export * from "./sweep.js";

/** The same clearing-out, cut by BUILD FAMILY rather than by age — the by-hand
 *  half of `artifacts.ts`' automatic prune, over the same `familyKey`. */
export * from "./sweepfamilies.js";

/** What the DESKTOP is holding, as the phone reads it: the cross-repo
 *  transport survey, and the daemon's own store by owner and by bound. */
export * from "./deskstorage.js";

/** What the LOCAL model runner is holding — the wire shapes, and the pure
 *  "will a second model fit" sentence the phone says under the picker. */
export * from "./wire/localrt.js";
export * from "./wire/sysstat.js";
export * from "./localrt.js";
export * from "./wire/localusage.js";
export * from "./localusage.js";

/** A backend's own token ledger (`GET /api/tokenstats/<id>`) — never summed with claude's. */
export * from "./wire/backendtokens.js";

/** The seam a backend hands a fact over through, beside its screen reader. */
export * from "./backendsources.js";
/** One rule for what a 2.2 source slot may answer — the host's consumers and the plugin testkit both ask it. */
export * from "./sourceshape.js";
/** `caps.launchModes` (2.2): the modes a session can START in, one rule for host and phone. */
export * from "./launchmodes.js";
/** The conversation-binding ladder a backend plugin calls (plugin contract 2.0). */
export * from "./bindconv.js";

/** What became of the FILES a queued prompt names — the difference between a
 *  prompt that is sendable as written and one that points at nothing. */
export * from "./attach.js";

/** A session the HOST is holding until the files its first prompt names have
 *  landed — the handover that stops a bad tunnel from killing a whole plan. */
export * from "./launch.js";

/** Several pictures as ONE picture — the arrangement, so a mark can span the
 *  screens it is about. Pure geometry; the canvas half lives in web. */
export * from "./collage.js";

/** The pad's per-note merge and its tombstones — what stops a synced pad from
 *  deleting notes behind your back — plus the words the sheet says. */
export * from "./pad.js";

/** The usage BUDGET — the ceiling that stops automatic work BEFORE the CLI's
 *  own limit banner, and lets it start again when the window resets. */
export * from "./budget.js";

/** Budget PERIODS (rolling, calendar month/week/day, span), the one `periodBounds`
 *  that decides their edges, and the pacing maths over a period's spend. */
export * from "./period.js";

/** The billing profile (subscription / api / cloud / unknown) and the pure
 *  classifier the host's probe feeds. */
export * from "./billing.js";

/** The health of every point where this app reads a CLI it does not own — the
 *  rule that makes degrading to null stop being quiet. */
export * from "./clihealth.js";

/** How big a model's context window is — the one number that makes every
 *  session's context graph share a y axis instead of each inventing its own. */
export * from "./ctxwindow.js";

/** How much of a small model's window Claude Code's own prompt takes — the
 *  picker's sentence, from two measured numbers or none. */
export * from "./windowadvice.js";

/** What one more turn in a session costs against a fresh one — the reminder
 *  behind the cost chip, the context sheet's top panel and the one toast. Pure,
 *  and deliberately produces sentences and never a refusal. */
export * from "./sessioncost.js";

/** What a repo costs to have open before anyone types — CLAUDE.md plus the
 *  skill descriptions, which are the always-loaded half. Behind the repo-setup
 *  checklist's context-weight row. */
export * from "./contextweight.js";
/** Every agent-instruction file in a folder, who reads it (Claude Code, Copilot) and when; the repeats between them. */
export * from "./agentfiles.js";
/** What this desktop adds to every session, whatever the repo; and the always-on rows and sentences both ends word alike. */
export * from "./desktopfiles.js";
export * from "./alwaysonwords.js";

/** Which `autoCompactWindow` a spawned session would see, and from where —
 *  env > repo local > repo > user. Behind the checklist's auto-compact row. */
export * from "./autocompact.js";

/** Opt-ins: the advanced things a repo can turn on — one catalog, a probe per
 *  offer on the host, three states the person controls, counted in nothing. */
export * from "./optins.js";

/** What a pile of token counts MEANS — the derived figures and the words for
 *  them, including why a single "tokens used" number is 96% cache reads. */
export * from "./tokens.js";

/** What those tokens WOULD have cost at Anthropic's published list prices — a
 *  counterfactual, not a bill, and the module says so at length. */
export * from "./pricing.js";

/** The durable Intent — one "do this, there, when that is true", owned by the
 *  HOST, and the one ladder that decides whether it may run yet. */
export * from "./intent.js";
export * from "./fanoutruns.js";

/** The cost window read both ways: the hour bucket, launches, ranked repos,
 *  dollars-per-weekly-point (a refusal when it cannot be calibrated), and the
 *  burn rate's reset-cut stretch and push words. */
export * from "./costwindow.js";
export * from "./burn.js";

/** "Of the work still standing, what is actually still worth doing?" — the
 *  rules that stop a confident-sounding assessment from retiring real work. */
export * from "./assess.js";

/** What a machine may CALL somebody else's words — the four kinds, the author
 *  stamp that says whether a title may be overwritten, and the one display rule
 *  deciding whose name is on a row. */
export * from "./naming.js";

/** The change brief: the focus list both ends word alike, and its answer's shape. */
export * from "./changebrief.js";

/** The files an item's words name — images anywhere and the inbox/outbox
 *  transport by full path (the row's thumbnails; anything folding two items
 *  into one must keep every one). */
export * from "./itempaths.js";

// A URL the terminal GRID broke across rows, put back together — what makes a
// `/login` link on a phone something you can tap instead of transcribe.
export * from "./urls.js";
export * from "./slash.js";
/** The slash sheet's answer (`GET /api/slash`), a backend's own list included (2.2 `commands`). */
export * from "./wire/slash.js";

/** What a repo can already build, read out of its own manifests — the free half
 *  of the Build sheet's "set up", for adding one more command without spending
 *  a turn on it. */
export * from "./buildscan.js";

/** Cleaning, merging and wording the install log — the half that must not lose
 *  or duplicate a history when a phone re-reports everything on every connect. */
export * from "./installlog.js";

/** What a build leaves behind and what it is called: the collect-into-the-outbox
 *  policy, the versioned name, `familyKey` ("which artifact IS this"), the fold
 *  that stops one APK arriving twice, and what a prune may remove. */
export * from "./artifacts.js";

/** What a build button ASKS before it runs — one command against one member of
 *  a monorepo, instead of forty near-identical buttons. Substitution, the env
 *  copy, and the refusal that stops an unattended run guessing a value. */
export * from "./buildparams.js";

/** The geometry a PTY may be given, and the floor under it — a grid too small
 *  for the CLI to draw its composer in is a grid no delivery can be confirmed
 *  against, so neither end accepts one. */
export * from "./ptysize.js";

/** The CLI's own working line, read off raw PTY bytes — what the agent is doing
 *  right now. One matcher for the phone's reader and the host's turn-end
 *  verification, because they are one question. */
export * from "./working.js";

/** The keys the CLI's footer and pickers tell a person to press, and the
 *  bytes each one is — the host reads the hints, the phone offers the keys. */
export * from "./keyhint.js";

/** A key with Ctrl / Alt / Shift held, as xterm's bytes — the phone's sticky
 *  modifiers and its Keys sheet send through this one encoding. */
export * from "./chord.js";

/** Dictation's wire shape: the audio format the phone writes and the host
 *  reads, the caps in seconds, and the one wording for a clip that is refused
 *  — so a person is told the same thing whichever end noticed. */
export * from "./dictate.js";
export * from "./dictateterms.js";

/** The zero-token repo-health series: where the tool and its artifacts live,
 *  the shapes a status and a plot arrive as, and the sentence for every state
 *  that has nothing to draw. */
export * from "./repohealth.js";

/** The other half of the same subject: the parsers that stop the host and the
 *  phone reading one line of the engine's output two different ways. Split out
 *  because a dropped field and a wrong sentence fail differently — and because
 *  the one file was at the lint cap. */
export * from "./repohealthread.js";
/** The health index: the one layer over the repo-health series that takes a
 *  side (an absolute 0–100 score per week), with its move test and wording. */
export * from "./healthindex.js";
/** The whole index answer from a series file, for the host route and the VS Code view alike. */
export * from "./healthindexresponse.js";
/** The context one request carried, per week, for the line beside the score. */
export * from "./healthspend.js";
/** A repo's requirements list: the prompt filter, the item format, the preset. */
export * from "./requirements.js";
/** Where the claude CLI keeps its private dir (CLAUDE_CONFIG_DIR) and its project-folder slug rule. */
export * from "./claudeconfig.js";
export * from "./statedir.js";

/** A live session running an older `claude` than the installed one, and the
 *  words for restarting it onto the new binary in the SAME conversation. */
export * from "./clirestart.js";

/** What a background shell under a session is DOING, in words: the bucket a
 *  reading falls into, the sentence for it, the chip and the close-confirm
 *  line — pure, over the raw facts `host/shells.ts` reads off the process
 *  table. */
export * from "./shells.js";

/** Which product this is — every brand-bearing identifier, current and past —
 *  and the pure readers that fall back through the past ones. */
export * from "./brand.js";
export * from "./envresolve.js";
export * from "./brandmigrate.js";

/** Peer desktops: delegate a job to another host and take its report back —
 *  the wire DTOs, the address and remote-identity rules, the report prompt. */
export * from "./peer.js";
export * from "./claudeversion.js";

/** The oldest Node the host runs on (engines, doctor, the early refusal). */
export * from "./nodemin.js";

/** The terminal background/foreground per theme: the phone grid and the
 *  host answer to the tmux client colour queries. */
export * from "./termpalette.js";
/** The caps and pure folds every conversation reader shares (claude's jsonl and a plugin's store reader). */
export * from "./transcriptfold.js";

/** A fork's `<config dir>/theme.json`: colour tokens, terminal palette, display name. */
export * from "./themeoverlay.js";

/** The code folder: `GET/POST /api/host/root` and whether the first-start dialog asks. */
export * from "./rootchoice.js";

/** The week-end burn: when to start spending the rest of a week, when to stop,
 *  the once-a-week nudge, and the words — one reading for host and phone. */
export * from "./weekburn.js";
