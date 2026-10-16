/**
 * The session screen's header and the status line under it: the title row,
 * the chips-and-controls row, the typing-room keeps, the burger's menu, and the
 * meter/cost readout.
 *
 * Lifted out of App's session screen unchanged. The header is TWO rows and the
 * break is STATED (`.hdr-row2`, `web-chrome`); the typing keeps stay
 * DIRECT children of the header, because `.screen.typing .topbar >
 * *:not(.hdr-typing-keep)` hides a nested one with its group.
 */
import type { ReactNode } from "react";
import {
  BarChart3, Bell, Bot, Check, ChevronLeft, ChevronsDownUp, Clock, Gauge, Hourglass, List, Loader, Menu, Pencil, Plus,
  Sigma, Sparkles, SquareTerminal, Unplug, X,
} from "lucide-react";
import { repoBranchLabel, trimDefaultBranch, usageChip, usageText, weekShareText } from "@waterplane/shared";
import type { BackendInfo, ClientMessage, RepoTarget, SessionInfo } from "@waterplane/shared";
import type { HeaderCmd } from "../../headerCmds";
import type { Overlay } from "../../routing";
import type { OutboxEntry } from "../../outbox";
import { isLaterId } from "../queue/logic.ts";
import { backendIdOf, backendInfo, backendMark, isShellBackend, sideChannelLine } from "../../backendCaps";
import { sessionSegs } from "../../pairTabs";
import { askTabAttach } from "../../sessionTabs";
import { ContextSparkline, SpendSparkline } from "../../ContextGraph";
import { spendSparkGeom } from "../../contextPlot";
import { dur, fmtTok, repoAccentStyle } from "../../format";
import { SessionUsage } from "../launcher/UsageChip";
import { HintToggle } from "../../HintLayer";
import { contextPill, launchLabel } from "../../sessionFacts";
import { liveLaunch } from "../../liveLaunch";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { pinnedToolbarItems } from "../../toolbar";
import type { Launch } from "../launch/useLaunch";
import { keepFocus } from "../compose/ComposeBar";
import { renameSession } from "./rename";
import { sessionViews } from "../extensionPoints";
import { unpinHeaderView, useHeaderViews } from "./headerViews";
import { budgetTag, contextTag, costTag, limitTag, liveAgentTag, shellsTag, statusTags, tallyTitle, turnTally } from "../sessions/tags";
import { badgeText, openNotifs, useUnread } from "../../features/notifications";
import { useUsageFace, useWeekUsdPerPct } from "../../features/tokens";
import { useLimitAuto } from "../../features/limits";
import { openContext } from "../../features/context";
import { openSessionBudget } from "../../features/sessionBudget";
import { openShellsFor } from "../../features/shells";
import { setToolbarOpen, useToolbarOpen, useUsedOrder } from "../../features/toolbarCfg";
import { HostNameTag } from "../../features/hosts";
import { PeerSessionFacts } from "../../features/peers";
import { ToolbarMenu, renderToolbarItem, type ToolbarCtx } from "./ToolbarMenu";
import type { SessionChrome } from "./useSessionChrome";
import type { Connection } from "../conn/useConnection";
import { StowTray } from "../../Stowable";
import { useSpendWarn } from "../sessions/spendWarn";

const ICON = 16;
/**
 * The spend miniature in the session header, sized to sit in a line of text.
 *
 * The width is the context miniature's own on this line (54), so the two
 * curves in one readout are the same length and can be read against each
 * other; the height is the shorter of the pair for the reason the launcher row
 * gives — the spend curve carries one reference line and no ticks, so it needs
 * less box than the sawtooth does.
 */
const SPEND_SPARK_W = 54;
const SPEND_SPARK_H = 12;

export interface SessionHeaderProps {
  active: SessionInfo;
  /** Every session — for the [Claude | Shell] tabs' other half (`pairTabs`). */
  sessions: readonly SessionInfo[];
  pending: boolean;
  /** The queued create behind a pending screen (`q.pendingEntry`). */
  pendingEntry: OutboxEntry | null;
  status: Connection["status"];
  liveSend(frame: ClientMessage, done: string, blocked?: string): boolean;
  backends: BackendInfo[] | null;
  sessionCan: Launch["sessionCan"];
  sessionRepoName(s: SessionInfo): string;
  repoForCwd(cwd: string): RepoTarget | null;
  setActiveId(id: string | null): void;
  setOverlay(o: Overlay): void;
  removeQueued(ackId: string): void;
  closeSession(s: SessionInfo): void;
  chrome: SessionChrome;
  /** The chips this backend can take (`splitHeaderCmds`'s `shown`), and the whole list for the manage chip. */
  hdrShown: readonly HeaderCmd[];
  headerCmds: readonly HeaderCmd[];
  runHeaderCmd(c: HeaderCmd): void;
  refreshTerminal(): void;
  toolbar: ToolbarCtx;
}

export function SessionHeader(p: SessionHeaderProps): ReactNode {
  const {
    active, sessions, pending, pendingEntry, status, liveSend, backends, sessionCan, sessionRepoName, repoForCwd,
    setActiveId, setOverlay, removeQueued, closeSession, chrome, hdrShown, headerCmds, runHeaderCmd, refreshTerminal,
    toolbar,
  } = p;
  const { chromeHidden, typingMode, typingPeeking, setTypingPeek, setFullScreen } = chrome;
  // The toolbar IS the burger's menu (see the header), and it is shut by
  // default at every width. Persisted (features/toolbarCfg), and
  // `closeToolbarMenu` writes the same key — a choice tapped here is the same
  // fact as a choice tapped on the burger.
  const toolbarOpen = useToolbarOpen();
  // Most-used-first toolbar order (cfg.sort === "used"). SNAPSHOTTED, not live
  // (`useUsedOrderSnapshot`, App's): re-ranking on every tap would move buttons
  // out from under the finger.
  const usedOrder = useUsedOrder();
  const unreadNotifs = useUnread();
  const face = useUsageFace();
  const usdPerWeekPct = useWeekUsdPerPct();
  const spendWarnOf = useSpendWarn();
  // Global auto-continue-on-usage-limit switch (features/limits).
  const limitAuto = useLimitAuto();
  // Does the context readout below print the free share in WORDS ("… · 72%
  // free")? Exactly when it may print numbers and has the figure — the same
  // two conditions its own body tests. Then the percentage pill beside it is
  // the same number a second time, and only the readout is drawn.
  const ctxInWords = sessionCan(active, "contextSeries") && sessionCan(active, "contextMeter") && active.contextLeft != null;
  // The pill's warm colours, carried by the readout's own "% free" so a window
  // running low still reads as low once the pill is gone. Null when the
  // session is not running, exactly as the pill was absent then.
  const ctxWarm = contextPill(active)?.cls ?? null;
  return (
    <>
      {/* `sess-top` on top of `topbar`: the launcher wears the same class and its
          brand is a 32 px logo that must stay beside the menu, while THIS one is
          a title that takes the row. One extra token rather than a second
          header component, because everything else about the two is the same
          bar. */}
      <header className="topbar sess-top" style={repoAccentStyle(sessionRepoName(active))}>
        <button className="back" onClick={() => setActiveId(null)}><ChevronLeft size={24} /></button>
        <div className="brand">{trimDefaultBranch(active.title) || active.title}<span className={`row-sub${backendMark(backends, active.backend) ? " row-foreign" : ""}`}> {launchLabel(liveLaunch(active), backendMark(backends, active.backend), backends)}</span><HostNameTag />
          {/* The name the desktop derived for this session, IN FULL and on its
              own line — the tab strip has ~85 px for it and clips, and this is
              the screen you land on, where the words are worth having whole.
              `Sparkles` because it is the machine's title and not one anybody
              typed (`shared/naming.ts`'s rule wherever a derived name is
              drawn), and absent rather than blank when nothing has been derived
              yet: the line above already says the repo and the branch. It goes
              with the model subtext in a collapsed header — both are context,
              and the collapse exists to give the rows to the output. */}
          {active.tabTitle
            ? <span className="brand-name"><Sparkles size={12} aria-hidden="true" /> {active.tabTitle}</span>
            : null}
        </div>
        {/* The view switch and the two name buttons, as ONE flex child: it sits
            beside the title while the title keeps ~13em, and otherwise breaks
            onto a line of its own, whole, and fills it (`.hdr-view`). With a
            third tab (Desktop) it used to stay beside the title and squeeze it
            into a 120px column, six lines tall. */}
        <div className="hdr-view">
        <PairTabsSeg active={active} sessions={sessions} pending={pending} backends={backends} />
        {/* Name this conversation, now.

            The desktop names a session ONCE, off the first summary that lands,
            because a tab that renames itself is a tab whose position cannot be
            learned (`sessions.ts` `nameTab`). Two hours later that name is
            often about the thing this session opened on and not the thing it is
            doing, and there was no way to ask for a better one. This is that
            ask: a person's tap, at a moment they choose.

            It sits on the title row, beside the name it rewrites, rather than
            in the control group below — that group is this session's verbs, and
            this one is about the words six pixels to its left. It SPENDS, so it says so in its title and its
            receipt is the toast `liveSend` writes. */}
        {!pending && (
          <button className="key hdr-name-btn"
            title={active.tabTitle
              ? "write this session a new name — one cheap call on the desktop"
              : "name this session — one cheap call on the desktop"}
            aria-label="name this session"
            onClick={() => {
              track("action:session.name");
              liveSend({ t: "session.name", id: active.id }, "writing a name for this session…");
            }}>
            <Sparkles size={ICON} />
          </button>
        )}
        {/* …or type one. The desktop's name and a person's land in the same
            field (`record.ts` `renameTab`), so the line above shows either. */}
        {!pending && (
          <button className="key hdr-name-btn" title="type a name for this session" aria-label="rename this session"
            onClick={() => { void renameSession(active, liveSend); }}>
            <Pencil size={ICON} />
          </button>
        )}
        </div>
        {/* User-configured one-tap commands. They live HERE rather than in the
            terminal toolbar because the header is the one bar that survives a
            collapse — a command you fire every few minutes should not cost an
            expand, a sheet or the keyboard. Horizontally scrollable, so a long
            list eats the title's room instead of pushing the view controls off. */}
        {/* ── The second row ───────────────────────────────────────────────
            The chips and the controls, in one child, so the header breaks HERE
            and nowhere else (`.hdr-row2`). It used to be four rows of chrome
            over the output — title, derived name, chips, and the five icon
            buttons that could not fit beside the chips. */}
        <div className="hdr-row2">
        <div className="hdr-cmds">
          {/* The reader's own three (outline, find, refresh) are pins like any
              other now, and read as the READER's verbs while it is up — see
              `runToolbar`. They used to be a fixed strip of `TranscriptView`'s
              own to the right of this one, which is how a pinned `outline` and
              the reader's outline toggle ended up as two identical buttons side
              by side doing different things. The STAR came in the same way. */}
          {pinnedToolbarItems(toolbar.toolbarCfg).filter((t) => t.id !== "outline").map((t) => (
            <span key={t.id} className="hdr-pin">{renderToolbarItem(toolbar, t, true)}</span>
          ))}
          {/* `shown`, not the whole list: a chip whose text starts with `/` is
              Claude's vocabulary, and against a backend that takes no slash
              commands it does not fail — it lands as an ordinary PROMPT asking
              the binary in English to compact itself. It is withheld, not
              deleted (these are synced user data, and the manage sheet still
              edits every one of them) and not dimmed (`Unavailable.tsx`): what
              is missing is counted in the strip below the toolbar instead. */}
          {hdrShown.map((c) => (
            <button key={c.id} className="key hdr-cmd" title={c.text} onClick={() => runHeaderCmd(c)}>{c.title}</button>
          ))}
          <button className="key hdr-cmd hdr-cmd-manage" title="header commands — one-tap chips you configure"
            onClick={() => { track("action:hdrcmd.manage"); setOverlay("hdrcmd"); }}>
            {headerCmds.length ? <Pencil size={12} /> : <><Plus size={12} /> command</>}
          </button>
        </div>
        {/* The reader/CLI toggle USED TO BE HERE, and is now in the corner group
            on the surface it switches (`ScreenCorner`). It was in the
            header because that row survives a collapse — but full screen hides
            the header outright, so the one control that swaps the whole view
            was missing from the layout people read long turns in, and the way
            back was to leave the mode first. A view switch belongs with the
            other two things that decide how the view LOOKS, not in a row of
            session verbs. */}
        {/* ── The control group ──────────────────────────────────────────────
            One flex child holding every icon button, so the header is TWO rows
            instead of four: `.brand` takes the first (it is the only thing on
            it that is worth a row), and the command chips and these controls
            share the second — the chips scroll from a zero basis, so a long
            list eats its own row rather than pushing this group onto a third.
            Measured on the screen this was written for: 4 rows of chrome over
            the terminal became 2.

            The typing-room buttons stay DIRECT children of the header below,
            deliberately: `.screen.typing .topbar > *:not(.hdr-typing-keep)` is
            what hides the rest, and a keep nested in here would be hidden with
            the group it was nested in. */}
        <div className="hdr-ctl">
        <>
        <HintToggle compact />
        <button className="key notif-btn" title="notifications" onClick={openNotifs}>
          <Bell size={ICON} />{unreadNotifs > 0 && <span className="notif-badge">{badgeText(unreadNotifs)}</span>}
        </button>
        {/* Nothing to close on the host yet: what exists is the queued create,
            so the destructive verb here drops THAT — and the prompts written
            behind it are surfaced as failed rows rather than silently binned
            (`removeQueued`). */}
        {pending ? (
          <button className="key danger" title={isLaterId(active.id) ? "close — nothing was queued; a draft stays here for next time"
            : "drop this open — the prompts written for it stay in Activity"}
            onClick={() => { const id = pendingEntry?.ackId; setActiveId(null); if (id) { removeQueued(id); showToast("open dropped"); } }}>
            <X size={ICON} />
          </button>
        ) : (
        <button className="key danger" title={active.running ? "close session — reopen under “Recently closed”" : "remove session"} onClick={() => { closeSession(active); setActiveId(null); }}>
          <X size={ICON} />
        </button>
        )}
        {/* The menu's own switch. It sits HERE, in the header, and not in the
            menu it opens, which would be a button you can only reach when you
            no longer need it. */}
        <button className={`key burger-btn${toolbarOpen ? " active" : ""}`}
          title={toolbarOpen ? "close the menu" : "menu — refresh, slash commands, files, and the rest"}
          aria-label="toolbar" aria-expanded={toolbarOpen}
          onClick={() => setToolbarOpen(!toolbarOpen)}>
          <Menu size={ICON} />
        </button>
        </>
        </div>
        </div>
        {/* The two controls typing mode keeps (see `typingMode`). They are their
            own buttons rather than pinned toolbar actions, because a pin can be
            unpinned and these are the only things on screen above the box while
            the keyboard is up. `keepFocus` is not optional on either: without it
            the pointerdown blurs the box, typing mode ends, and the button is
            gone before its own click can land.

            The outline does ONLY the outline — it deliberately does not end
            typing mode. It used to clear `composeFocused` on the way, which
            brought the whole chrome back with it: a button that says outline and
            un-hides the header is doing the other button's job. */}
        {chromeHidden && !pending && !(toolbar.toolbarCfg.pinned ?? []).includes("outline") && (
          <button className="key hdr-typing-keep hdr-typing-outline" onPointerDown={keepFocus}
            title={`outline — where you are in this session${tallyTitle(turnTally(active))}`}
            onClick={() => toolbar.runToolbar("outline")}>
            <List size={ICON} />{turnTally(active) == null ? null : <> {turnTally(active)}</>}
          </button>
        )}
        {/* …and the way to everything typing room hid, without giving up the
            caret or the keyboard. */}
        {chromeHidden && (
          <button className="key hdr-typing-keep hdr-typing-menu" onPointerDown={keepFocus}
            title={typingMode
              ? "show the header, status and keys again — the keyboard stays up"
              : "leave full screen — the header, status and toolbar come back"}
            aria-label="show hidden controls" aria-expanded={false}
            onClick={() => {
              // Two modes, two ways back, one button: the peek SUSPENDS typing
              // room without giving up the caret, and full screen simply ends.
              // The alternative was a second identical-looking button in the
              // same corner doing a different thing, which is the confusion the
              // reader's outline pair already cost once.
              if (typingMode) { track("action:typing.peek"); setTypingPeek(true); }
              else { track("action:fullscreen.off"); setFullScreen(false); }
            }}>
            <Menu size={ICON} />
          </button>
        )}
        {/* Back to typing room. Only reachable from the peek, and it is on the
            header because in the peek the header is what is covering the
            output. */}
        {typingPeeking && (
          <button className="key hdr-typing-hide" onPointerDown={keepFocus}
            title="hide these again and give the rows back to the output"
            aria-label="hide controls" aria-expanded={true}
            onClick={() => { track("action:typing.hide"); setTypingPeek(false); }}>
            <ChevronsDownUp size={ICON} />
          </button>
        )}
        {/* ── The toolbar, as the burger's MENU ──────────────────────────────
            It used to be a horizontal scroll strip of its own row below the
            status line. Two things were wrong with that on a phone: it cost a
            permanent row of the screen you are reading, and it scrolled
            SIDEWAYS — so the actions past the fourth chip existed only if you
            knew to swipe a strip that gives no sign it continues. A vertical
            list names every action on one axis you already scroll.

            It hangs off the burger and lives INSIDE the header, as a full-width
            flex child (`flex: 0 0 100%`) rather than an absolutely-positioned
            popover — the same markup argument `.nav-more` makes for the
            launcher's menu: this header WRAPS, so a row is the one layout that
            cannot end up off-screen. Being a child of the header also means
            typing room hides it for free (`.screen.typing .topbar > *`),.

            A tap is a menu CHOICE, so it closes the menu (`closeToolbarMenu`) —
            all but the few that mutate in place and are meant to be repeated,
            see `MENU_KEEP_OPEN`. */}
        {toolbarOpen && (
          <ToolbarMenu c={toolbar} usedOrder={usedOrder} refreshTerminal={refreshTerminal} />
        )}
      </header>
      {pending && (
      <div className="sess-status">
        <span className="row-sub">{repoForCwd(active.cwd) ? repoBranchLabel(repoForCwd(active.cwd)!) : active.cwd}</span>
        <span className="row-sub">
          {isLaterId(active.id) ? <><Hourglass size={11} /> starts when its backlog item runs</> : <>
          <Loader size={11} className={pendingEntry?.status === "failed" ? "" : "spin"} />{" "}
          {pendingEntry?.status === "failed" ? "not started"
            : !pendingEntry || pendingEntry.status === "pending" ? "opening…"
            : status === "open" ? "queued" : "queued — waiting for the link"}
          </>}
        </span>
        <StowTray />
      </div>
      )}
      {!pending && (
      <div className="sess-status">
        {statusTags(active, undefined, undefined, backends)}
        {/* The way OUT of "asked you" when the answer did not happen here.
            The badge is recomputed from the CLI's own tail, so it retires on a
            turn starting or a keystroke — both of which mean the question was
            answered in this session. Answer it anywhere else (commit the thing
            yourself, decide it is moot) and there is nothing to type that would
            clear it: the badge, the waiting count and the push keep standing
            over a decision already made. This types NOTHING; it names the
            question it is acknowledging, so a tap on a badge read a minute ago
            cannot silence a different one that replaced it. Absent for the
            other two shapes of waiting — a parsed box and an unparsable dialog
            are both still on screen, and dismissing the WORD would not unblock
            the CLI.

            It sits RIGHT after the status pill it clears, and wears a raised,
            bordered button face with a verb on it: placed after the usage
            windows in the same flat `row-sub` text it read as one more status
            fact ("✓ handled" — as if it already was), a strip away from the
            red badge it acts on. */}
        {active.asking && !active.prompt && !active.awaitingInput && (
          <button className="row-sub ack-asking"
            title={`mark “${active.asking.text}” as handled — clears the “asked you” badge and the waiting count here. Nothing is typed into the session, and the next turn's question raises it again.`}
            onClick={() => {
              track("action:session.ackAsking");
              liveSend({ t: "session.ackAsking", id: active.id, text: active.asking!.text },
                "marked as handled — nothing was typed into the session");
            }}>
            <Check size={12} /> mark handled
          </button>
        )}
        {/* How long the tab has been open, beside the state it qualifies
            ("done · 5m ago", "working · 1m") — it is a time about the
            session's life, and at the end of the strip it sat beside the
            usage windows instead. */}
        {active.createdAt && active.running && <span className="row-sub"><Clock size={11} /> open {dur(active.createdAt)}</span>}
        {/* The usage windows ride on the FIRST line, right after the state and
            its age: those two are short, and the context readout below is long
            enough to need a line of its own. Placed last, the windows wrapped
            onto a third line of their own and left the first line half empty —
            three lines of chrome over the output where two hold it all.

            The account's own windows. Absent for a backend that runs against
            no such account at all — this strip is read as a fact about the
            session in front of you, and two percentages that belong to a
            different binary's quota are a wrong number, not a spare one. The
            same reading is still one tap away under Settings, where it is
            account-wide and says so. */}
        {sessionCan(active, "usageLimits") && face.kind === "windows" && <SessionUsage backend={active.backend} />}
        {/* No windows on this account: the dollar period, or nothing (never `?`). */}
        {sessionCan(active, "usageLimits") && face.kind === "usd" && <span
          className={`row-sub usage-inline${face.chip.hot ? " danger" : ""}`}
          title={`${face.chip.title}\ntap for the token history`}
          onClick={() => { track("overlay:tokens"); setOverlay("tokens"); }}
        >
          <Gauge size={11} /> {face.chip.text}
        </span>}
        {/* The backend's own channel, only when it is DOWN: said in words
            (never a dimmed control). Up and absent draw nothing. */}
        {sideChannelLine(active.sideChannel) && (
          <span className="row-sub act-cant"><Unplug size={11} /> {sideChannelLine(active.sideChannel)}</span>
        )}
        {limitTag(active, limitAuto)}
        {shellsTag(active, () => openShellsFor(active))}
        {/* The percentage pill, only where the readout below does not print
            the same figure: no readout at all (no context series), or a bare
            "context" (no readable gauge). Beside "context … · 72% free" it
            said one number twice, so there the readout keeps the fact and
            the pill's warm colours (`ctxWarm`). */}
        {!ctxInWords && contextTag(active)}
        {/* The readout is the way in to the graph. A tap is the only way to get
            at the shape, and a badge that opens something has to look like it
            does — hence the same `usage-inline` treatment the usage chip uses,
            and a title that says what a tap does. `sess-status` is a plain div,
            so this can be a real button without nesting one.

            TWO gates, and they are not the same question.

            **Whether the chip exists at all** is `contextSeries`: is there a
            history behind this that the graph could draw. Absent — not 0%, not
            an empty graph — when there is not, with the sentence saying so in
            the strip below the toolbar.

            **Whether it may print NUMBERS** is `contextMeter`: did anything
            print a gauge this app can read. A backend can have the first and
            not the second — a readable record, no live readout — and then the
            chip is BARE: the icon and the word, a door to the graph and no
            figure. A number here would be the measurement that never happened,
            which is the one thing this chip must never invent. For claude both
            gates are true and the chip is byte-identical. */}
        {sessionCan(active, "contextSeries") && <button className="row-sub usage-inline" data-hint="session.context"
          title={`${sessionCan(active, "contextMeter") && active.contextTotalTok != null
            ? `context window: ${fmtTok(active.contextUsedTok ?? 0)} of ${fmtTok(active.contextTotalTok)} tokens`
            : "context window"}${usageChip(active.contextSpark?.usageTok)
              ? `\n${usageText(active.contextSpark!.usageTok!, active.contextSpark!.agentTok ?? null)}`
              : ""}\ntap for the graph: how it filled, and where it compacted`}
          onClick={() => { track("overlay:context"); openContext(); }}>
          {sessionCan(active, "contextMeter") && active.contextSpark
            ? <ContextSparkline spark={active.contextSpark} width={54} height={14} />
            : <BarChart3 size={11} />}
          {!sessionCan(active, "contextMeter")
            ? <> context</>
            : active.contextTotalTok != null
              ? <> context {fmtTok(active.contextUsedTok ?? 0)}/{fmtTok(active.contextTotalTok)}{active.contextLeft != null && <> · <CtxFree pct={active.contextLeft} warm={ctxWarm} /></>}</>
              : active.contextLeft != null ? <> context <CtxFree pct={active.contextLeft} warm={ctxWarm} /></> : <> context</>}
          {/* What the whole session has SPENT, beside what its next turn
              re-reads — the same pair the launcher row shows, and now the same
              pair of CURVES. `Σ used 25M` said the figure and nothing about the
              shape behind it: one fan-out turn and a two-day crawl print the
              same total, which is the whole reason the second miniature exists
              on the row. The component is `SpendSparkline`'s, unchanged — it
              carries the `Σ` chip itself, so the words are what it REPLACES
              rather than something drawn beside it. Said twice, one number
              would read as two readings.

              Its axis is this session's own, stated in its title, exactly as
              on the row: the curve here is narrower (54, matching the context
              miniature two elements left) and nothing else differs.

              Gated on `contextSeries` with the rest of the button and NOT on
              `contextMeter`: this one is read off the conversation LOG (the
              turns' own usage blocks plus the subagent logs), never off the
              TUI gauge, so a backend with a readable record and no on-screen
              meter can still say what it spent. A host that sends no `usedPts`
              draws no curve, and this line keeps the words it has always had. */}
          {(() => {
            const sp = active.contextSpark;
            if (sp && spendSparkGeom(sp, SPEND_SPARK_W, SPEND_SPARK_H)) {
              // The total as a share of the week, in the words the turn-cost
              // foot uses for the same dollars — absent without a calibration.
              const week = weekShareText(sp.costUsd, usdPerWeekPct);
              // Past the person's orange/red mark: the triangle replaces the
              // Σ, and the share beside it wears the same colour.
              const warn = spendWarnOf(active);
              return <> · <SpendSparkline spark={sp} width={SPEND_SPARK_W} height={SPEND_SPARK_H} warn={warn} />{week && <> <span className={warn ? `spend-warn-${warn.level}` : undefined}>{week}</span></>}</>;
            }
            return usageChip(sp?.usageTok)
              ? <> · <Sigma size={11} /> used {usageChip(sp?.usageTok)}</>
              : null;
          })()}
        </button>}
        {/* The multiple, AFTER the readout it is derived from and in the same
            order the launcher row groups them — curve, reading, total, then
            the one figure that is a judgement. It was two badges to the left of
            here, on the far side of the context percentage, which is a
            different question wearing similar units. */}
        {costTag(active)}
        {liveAgentTag(active)}
        {/* The session's own cap — a door to its sheet, text not colour. */}
        {budgetTag(active, () => openSessionBudget(null))}
        {/* Peer jobs: the cost split by desktop and one line per job it sent (or, on the peer, why it exists). */}
        <PeerSessionFacts s={active} />
        {/* Strips folded off the screen (`Stowable.tsx`): a line that is here
            anyway, so a fold gives the terminal its height back for nothing. */}
        <StowTray />
      </div>
      )}
    </>
  );
}

/** "72% free", in the context pill's colour when the window runs low. */
function CtxFree({ pct, warm }: { pct: number; warm: string | null }): ReactNode {
  return <span className={warm ? `ctx-free ${warm}` : "ctx-free"}>{pct}% free</span>;
}

/**
 * `[Claude | Shell]`: the CLI ↔ companion-shell pair as two tabs on the title
 * row, the one on screen lit. It used to be one orange button in the
 * terminal's corner group that named only where a tap would GO; two tabs say
 * where you are as well, and sit with the title they switch. The decision is
 * `sessionSegs` (pure, tested — `pairTabs` plus the views); a tap is
 * `askTabAttach` — the session strip's own verb — so neither half is a new path.
 * With no companion yet there are no tabs: the burger's "companion shell" makes
 * one. The lit tab is a label, not a button: tapping where you already are has
 * nothing to do.
 *
 * Extensions add VIEWS after the pair (`SessionViewDef`, the live desktop), and
 * a session with a view but no companion gets its own tab lit before them
 * (`[Claude | Desktop]`, `[Shell | Desktop]`). A view gets its tab only once
 * it was opened from the ☰ menu, and its × takes the tab down again
 * (`headerViews.ts`) — like the Shell tab, never a standing offer. With no view
 * contributed (or none opened) this draws exactly what it always did. An unavailable view is drawn like the
 * others and its tap SAYS why — never a greyed segment.
 *
 * Kept in a collapsed header — it is the switch between the two screens, not
 * context — and hidden with the rest of the chrome in typing room and full
 * screen.
 */
function PairTabsSeg({ active, sessions, pending, backends }: {
  active: SessionInfo;
  sessions: readonly SessionInfo[];
  pending: boolean;
  backends: BackendInfo[] | null;
}): ReactNode {
  // A pending screen's id is synthetic: no view is asked about it (`sessionSegs` draws nothing there).
  // Only the views opened from the ☰ menu have a tab (`headerViews.ts`); the × takes one down.
  const pinned = useHeaderViews();
  const views = pending ? [] : sessionViews(active.id).filter((v) => pinned.includes(v.key));
  const segs = sessionSegs(active, sessions, { pending, shell: isShellBackend(backends, active.backend) }, views);
  if (!segs) return null;
  let agent = active;
  for (const g of segs) if (g.kind === "cli" && !g.on) agent = g.target;
  const agentName = backendIdOf(agent) === "claude" ? "Claude" : backendInfo(backends, agent.backend)?.label ?? "CLI";
  const cliTab = <><Bot size={14} aria-hidden="true" /> {agentName}</>;
  const shellTab = <><SquareTerminal size={14} aria-hidden="true" /> Shell</>;
  return (
    <div className="pair-tabs" role="tablist" aria-label={views.length ? "session, its shell or a view of it" : "session or its shell"} data-hint="hdr.pair">
      {segs.map((g) => {
        if (g.kind === "view") {
          const v = g.view;
          const Icon = v.icon;
          return (
            <span key={v.key} className="pair-view">
              <button className="pair-tab" role="tab" aria-selected="false" onPointerDown={keepFocus}
                title={v.unavailable ?? `open ${v.label}`}
                onClick={() => {
                  track(`action:view.${v.key}`);
                  // Unavailable is a SENTENCE on the tap, never a grey segment (CLAUDE.md).
                  if (v.unavailable) showToast(v.unavailable);
                  else v.open();
                }}>
                <Icon size={14} aria-hidden="true" /> {v.label}
              </button>
              {/* Takes the tab down; the ☰ menu's line brings it back. */}
              <button className="pair-tab pair-view-x" onPointerDown={keepFocus}
                aria-label={`close the ${v.label} tab`} title={`close the ${v.label} tab — ☰ menu opens it again`}
                onClick={() => { track(`action:view.${v.key}.unpin`); unpinHeaderView(v.key); }}>
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          );
        }
        const tab = g.kind === "cli" ? cliTab : shellTab;
        if (g.on) return <span key={g.kind} className="pair-tab on" role="tab" aria-selected="true">{tab}</span>;
        const target = g.target;
        return g.kind === "cli"
          ? (
            <button key="cli" className="pair-tab" role="tab" aria-selected="false" onPointerDown={keepFocus}
              title="back to the CLI session this shell belongs to"
              onClick={() => { track("action:companion.to.cli"); askTabAttach(target.id); }}>
              {tab}
            </button>
          )
          : (
            <button key="shell" className="pair-tab" role="tab" aria-selected="false" onPointerDown={keepFocus}
              title="switch to this session's companion shell"
              onClick={() => { track("action:companion.to.shell"); askTabAttach(target.id); }}>
              {tab}
            </button>
          );
      })}
    </div>
  );
}
