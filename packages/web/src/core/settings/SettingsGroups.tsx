/**
 * The bodies of three Settings groups that are all device preferences — what
 * this screen looks like, how typing and reading behave, and what happens with
 * no link. Each is a component so its `usePref` reads re-render only it; the
 * `<SetGroup>` tags themselves stay in `SettingsSheet.tsx`, because the group
 * ORDER is that file's to say (`settingsIndex.test.mjs` reads it there).
 */
import type { MutableRefObject, ReactNode } from "react";
import {
  Activity, ArrowDownToLine, Bot, Siren, ArrowDownWideNarrow, BatteryMedium, BookOpen, Check, ChevronsDownUp, Command, CornerDownLeft, Cpu, HelpCircle, Images, Keyboard, Languages, Layers,
  ListOrdered, Moon, Palette, Radio, RotateCw, SendHorizontal, Smartphone, SpellCheck, Sun, SunMoon,
  Hourglass, Terminal as TerminalIcon, Type as TypeIcon, type LucideIcon,
} from "lucide-react";
import {
  DICTATE_AUTO, DICTATE_TERMS_MAX, dictateLangChoices, dictateLangOffered, dictateLangTitle, dictateTermsDropped,
  parseDictateTerms,
} from "@waterplane/shared";
import { SetAction, SetChoice, SetCustom, SetMulti, SetSlider, SetStepper, SetSwitch, SetWarn } from "../../SettingsKit.tsx";
import { BG_FRESH_STEPS, bgFreshLabel, bgFreshNote } from "../term/bgFresh.ts";
import { core } from "../api.ts";
import { applyTermZoom, prefs, setPref, usePref } from "../prefs.ts";
import { resolvedTheme, type ThemeChoice } from "../../theme.ts";
import { ICON_STEPS, TEXT_STEPS, nextTermZoom, termFontPx } from "../../uiScale.ts";
import { TAB_COUNT_MAX, TAB_COUNT_MIN, TAB_LIMIT_MAX, TAB_LIMIT_MIN, TAB_ORDERS, TAB_ORDER_LABEL } from "../../sessionTabs.ts";
import { LOCAL_RT_MODES, LOCAL_RT_MODE_LABEL } from "../../localRt.ts";
import { AGENT_WARN_STEPS, type AgentWarnCfg } from "../../agentCount.ts";
import { REPO_ORDERS, REPO_ORDER_LABEL } from "../launcher/model.ts";
import type { ReaderToolsMode } from "../../transcriptUtil.ts";
import { hintSeenCount, resetHints, setExplainMode, type HintMode } from "../../hints.ts";
import { deviceLangTag } from "../../dictateLang.ts";
import { isIosSafari } from "../../platform.ts";
import { showToast } from "../../toast.ts";
import { askConfirm } from "../../Confirm.tsx";
import { LS, lsDel } from "../../storage.ts";
import { UI_RESET_KEYS } from "../../resetKeys.ts";
import { track } from "../../usage.ts";
import { useHostPush } from "../../features/hostTools";
import { useHasKeyboard } from "../../ShortcutCard.tsx";

const ICON = 16;

// ── Appearance ──────────────────────────────────────────────────────────────

export function AppearanceRows() {
  const theme = usePref("theme");
  const txtScale = usePref("txtScale");
  const icScale = usePref("icScale");
  const tZoom = usePref("tZoom");
  const tabsOn = usePref("tabsOn");
  const tabsN = usePref("tabsN");
  const tabsSort = usePref("tabsSort");
  const tabsMax = usePref("tabsMax");
  const netPulse = usePref("netPulse");
  const unfoldToEnd = usePref("unfoldToEnd");
  const repoSort = usePref("repoSort");
  const localRtBar = usePref("localRtBar");
  const agentWarn = usePref("agentWarn");
  const smaller = nextTermZoom(tZoom, -1, txtScale);
  const bigger = nextTermZoom(tZoom, 1, txtScale);
  const setTabsN = (n: number) => { setPref("tabsN", n); showToast(`${n} tabs across the strip`); };
  const setTabsMax = (n: number) => { setPref("tabsMax", n); showToast(`at most ${n} session tabs`); };
  return (
    <>
      <SetChoice
        id="theme" radio label="theme" icon={SunMoon}
        value={theme}
        options={([
          ["system", "follow device", SunMoon],
          ["light", "light", Sun],
          ["dark", "dark", Moon],
        ] as [ThemeChoice, string, LucideIcon][]).map(([v, label, icon]) => ({ value: v, label, icon }))}
        onChange={(m) => { setPref("theme", m); showToast(`theme: ${m === "system" ? `following this device (${resolvedTheme()})` : m}`); }}
        note={theme === "system"
          ? `Following this device — it is ${resolvedTheme()} right now, and switches with it.`
          : `Always ${theme} on this device, whatever its OS says.`}
        more={<p>Per device, not per account: the phone in a dark room and the desktop under a window want different answers, and “follow device” is how each one gets its own.</p>}
      />

      <SetChoice
        id="text-size" label="text size" icon={TypeIcon}
        value={txtScale}
        options={TEXT_STEPS.map((st) => ({
          value: st.value, label: st.label, icon: TypeIcon,
          // A PLAIN px, deliberately not the `calc()` the stylesheet
          // uses: an inline style beats that rule outright, so the chip
          // shows the size it SETS rather than that size times whatever
          // is already in force. Previewing 1.45 through a 1.45 that is
          // already applied is how a preview lies.
          style: { fontSize: `${Math.round(14 * st.value)}px` },
        }))}
        onChange={(v) => { track("action:uiscale.text"); setPref("txtScale", v); }}
        note="Everywhere — the lists, the sheets and the terminal."
        more={<p>The buttons are drawn at the size they set, so the one you can read comfortably is the one to press.</p>}
      />

      <SetChoice
        id="icon-size" label="icon size" icon={Images}
        value={icScale}
        options={ICON_STEPS.map((st) => ({
          value: st.value, label: st.label,
          // Same trap, same escape: the icon rules key on the `width`
          // ATTRIBUTE, so a scaled `size` would be scaled again. An
          // inline style is not an attribute.
        }))}
        onChange={(v) => { track("action:uiscale.icon"); setPref("icScale", v); }}
        note="Separately from the text — an icon too small to hit is not the same complaint as text too small to read."
        more={<p>Wanting big text with compact chrome is not a contradiction. Charts and graphs are left alone — scaling those would move the data rather than enlarge it.</p>}
      />

      {/* The console, on its own ladder and under the two it
          multiplies. Asked for as "let me see more text on screen",
          which is not the text-size question above it: this one buys
          COLUMNS AND ROWS for the CLI, and the grid it makes is what
          the host is then told to resize the PTY to. */}
      <SetStepper
        id="terminal-zoom" label="terminal size" icon={TerminalIcon}
        readout={<>
          {termFontPx(txtScale, tZoom)}px
          {smaller == null ? " · smallest" : bigger == null ? " · biggest" : ""}
        </>}
        onLess={smaller != null ? () => applyTermZoom(smaller) : null}
        onMore={bigger != null ? () => applyTermZoom(bigger) : null}
        lessLabel="smaller" moreLabel="bigger"
        extra={tZoom !== 1 && (
          <button className="key" onClick={() => applyTermZoom(1)}
            title={`back to the text size on its own — ${termFontPx(txtScale, 1)}px`}><RotateCw size={ICON} /> default</button>
        )}
        note="Terminal only, on top of the text size above — a smaller console font is a BIGGER grid."
        more={<p>So the CLI gets more columns and rows to draw in and a wide diff stops wrapping. The desktop is told the new size the moment you tap. The same two buttons float in the terminal's top-right corner, which is where they are worth using: you can see what you are changing while you change it.</p>}
      />

      {/* Which colour each repo is. Its own sheet: it is a list as long
          as the repo list, and a swatch grid per row. */}
      <SetAction
        id="repo-colours" label="repo colours" icon={Palette} opens
        onClick={() => { track("action:repocolor.open"); core().nav.open("repocolor"); }}
        note="Every repo gets a colour of its own — the group header, the row stripes and the session tab all wear it."
        more={<p>Pick the <b>ring</b> the colours come from (including one that survives colour blindness), <b>pin a colour</b> to a repo by hand, and see which repos ended up sharing one. Synced: a repo recognised by one colour on the phone and another on the desktop is not recognised at all.</p>}
      />

      <SetSwitch
        id="tabs" label="session tabs" icon={Layers}
        on={tabsOn}
        onChange={() => {
          const on = !tabsOn;
          setPref("tabsOn", on);
          track(`action:sessiontabs.${on ? "on" : "off"}`);
          showToast(on
            ? `session tabs on — ${tabsN} fit this screen, the rest scroll sideways`
            : "session tabs off");
        }}
        note="A row of the sessions you have open, above every screen, each one coloured by its repo."
        more={<p>It answers the question the launcher makes you work for: what else is open, and can I get back to it without leaving this screen. Each tab is named in four words or fewer by the desktop, once, off the summary it already writes — until then it wears the repo and branch it has everywhere else. The × closes that session and asks first; the conversation is kept either way.</p>}
      />

      {/* How many FIT — never how many exist. Everything past this
          number is still on the strip, one flick to the right; what the
          setting decides is how wide a tab is, which is how much of its
          name you can read. */}
      {tabsOn && (
        <SetStepper
          id="tabs-count" label="tabs that fit" icon={Layers}
          readout={<>
            {tabsN} tabs
            {tabsN === TAB_COUNT_MIN ? " · widest" : tabsN === TAB_COUNT_MAX ? " · narrowest" : ""}
          </>}
          onLess={tabsN > TAB_COUNT_MIN ? () => setTabsN(tabsN - 1) : null}
          onMore={tabsN < TAB_COUNT_MAX ? () => setTabsN(tabsN + 1) : null}
          lessLabel="wider" moreLabel="narrower"
          note={`The narrowest a tab gets, between ${TAB_COUNT_MIN} and ${TAB_COUNT_MAX} across. Fewer open, each is as wide as its name. It hides nothing.`}
          more={<p>Up to the limit below, every open session is on the strip and the rest scroll sideways; what this decides is the narrowest a tab gets once the strip fills, and therefore how much of its name you can read then. With fewer open, each tab is as wide as its name.</p>}
        />
      )}

      {tabsOn && (
        <SetStepper
          id="tabs-limit" label="most tabs shown" icon={Layers}
          readout={<>{tabsMax} tabs{tabsMax === TAB_LIMIT_MAX ? " · most" : tabsMax === TAB_LIMIT_MIN ? " · fewest" : ""}</>}
          onLess={tabsMax > TAB_LIMIT_MIN ? () => setTabsMax(tabsMax - 1) : null}
          onMore={tabsMax < TAB_LIMIT_MAX ? () => setTabsMax(tabsMax + 1) : null}
          lessLabel="fewer" moreLabel="more"
          note="How many sessions the strip draws, in the order below. The rest are counted at its end."
          more={<p>Past this number the strip stops and says how many it left off — every session is still in the launcher. The one you are in is always drawn, even when the order would put it past the cut.</p>}
        />
      )}

      {tabsOn && (
        <SetChoice
          id="tabs-order" radio label="tab order" icon={Layers}
          value={tabsSort}
          options={TAB_ORDERS.map((o) => ({ value: o, label: TAB_ORDER_LABEL[o] }))}
          onChange={(o) => {
            setPref("tabsSort", o);
            track(`action:sessiontabs.order.${o}`);
            showToast(`session tabs: ${TAB_ORDER_LABEL[o]}`);
          }}
          note="Three orders, three different things to want."
          more={<p><b>In the order opened</b> never moves, so a tab's position is something you learn and reach without reading it. <b>Most opened first</b> keeps the ones you actually go back to under your thumb. <b>Last opened first</b> answers “where was I” instead — the one order that moves under you. Both counts are kept on this device only, and tabs that tie keep the order they were started in, so nothing shuffles on its own.</p>}
        />
      )}

      <SetChoice
        id="repo-order" radio label="repo order" icon={ArrowDownWideNarrow}
        value={repoSort}
        options={REPO_ORDERS.map((o) => ({ value: o, label: REPO_ORDER_LABEL[o] }))}
        onChange={(o) => {
          setPref("repoSort", o);
          track(`action:reposort.${o}`);
          showToast(`repos: ${REPO_ORDER_LABEL[o]}`);
        }}
        note="The launcher's repo list. Most open sessions first breaks ties alphabetically. Per device."
        more={<p><b>Alphabetical</b> never moves, so a repo's place is something you learn. <b>Most open sessions first</b> keeps the repos you are working in on top — and moves a repo when a session in it starts or ends.</p>}
      />

      <SetSwitch
        id="unfold-to-end" label="unfolding a repo shows its last row" icon={ArrowDownToLine}
        on={unfoldToEnd}
        onChange={() => {
          const on = !unfoldToEnd;
          setPref("unfoldToEnd", on);
          track(`action:unfoldtoend.${on ? "on" : "off"}`);
          showToast(on ? "unfolding a repo scrolls to its last row" : "unfolding a repo scrolls to its header");
        }}
        note="On the launcher, tapping a repo's chevron scrolls down until the last revealed row is on screen. Off, it scrolls to the repo's header instead. Per device."
      />

      <SetSwitch
        id="net-pulse" label="connection strip" icon={Activity}
        on={netPulse}
        onChange={() => {
          const on = !netPulse;
          setPref("netPulse", on);
          track(`action:netpulse.${on ? "on" : "off"}`);
          showToast(on ? "connection strip on — pings every 3s while the app is open" : "connection strip off");
        }}
        note="A permanent bar: a state dot, the last ~90 seconds of round-trip times as a graph, and the current number."
        more={<>
          <p>It exists because every other connection readout here is retrospective — the banner appears once the socket is already gone, the activity strip once a request is already slow, and connection health only when you go and open it. None of them answers “is it bad right now, or is the app just being slow?”, which is the question you have while looking at a screen that has not changed.</p>
          <p>A graph rather than a number because an average cannot tell a steady 250 ms apart from 30 ms with every fourth ping lost, and only one of those is the link that eats prompts — unanswered pings are drawn as their own red marks, never averaged away.</p>
          <p>Costs one extra ping every 3 seconds, only while the app is in the foreground, and it only ever watches: a missed probe is drawn and nothing else, never a reconnect. Tap the bar for the full history.</p>
        </>}
      />

      {/* THREE states, not two. `off` / `while a model is loaded` /
          `always on` — one chip each rather than a cycling button,
          because a cycle makes you tap twice to find out what the third
          option even is. `always on` is its own choice and not a
          stronger `auto`: auto's vanishing act makes it impossible to
          watch a model NOT be there, which is exactly what somebody
          debugging a slow local session is doing. */}
      <SetChoice
        id="local-rt" radio label="desktop strip" icon={Cpu}
        value={localRtBar}
        options={LOCAL_RT_MODES.map((m) => ({ value: m, label: LOCAL_RT_MODE_LABEL[m] }))}
        onChange={(m) => {
          setPref("localRtBar", m);
          track(`action:localrt.${m}`);
          showToast(m === "off" ? "desktop strip off" : `desktop strip: ${LOCAL_RT_MODE_LABEL[m]}`);
        }}
        note="A line for the desktop: how busy its CPU and GPU are and how much memory is left — and, while a local model is loaded, that model up front."
        more={<>
          <p><b>“While a model is loaded” still polls</b> — it cannot know whether to draw itself without asking — so what it saves is a line of screen, not battery and not the desktop's work. Pick “always on” to keep it pinned, which is the only way to watch a model <i>not</i> be there.</p>
          <p>It exists for the one question a hosted model never raises and a local one raises constantly — “is the thing I am talking to still resident, or is the desktop swapping?” With no model loaded it is the machine itself — CPU, GPU, memory available, amber when memory is tight. Tap it for the full readout.</p>
        </>}
      />

      {/* The parallel-agent count's two marks (`agentCount.ts`). Synced: how
          many agents at once is too many is about the desktop and the
          account, not this phone. Each mark steps through one ladder with
          "off" past its top; a stepper end is ABSENT, never greyed. */}
      <AgentMark id="agent-warn" label="warn above this many agents" icon={Bot} cfg={agentWarn} k="warn"
        note={<>The desktop strip's agent count turns amber, and says so once, when more than this many agents run at once — sessions mid-turn plus their subagents.</>} />
      <AgentMark id="agent-alarm" label="alarm above this many agents" icon={Siren} cfg={agentWarn} k="alarm"
        note={<>…and red, with a second notice, above this many. Nothing is stopped or refused at either mark.</>}
        more={<>
          <p><b>What counts.</b> Every session on this desktop whose turn is running, plus every subagent (the Agent/Task tool) running under any session, background ones included. A session that is idle while its subagents work counts once per subagent, never also for itself.</p>
          <p><b>Where it shows.</b> On the desktop strip, between the CPU and the GPU. Past a mark the strip shows itself even when it is switched off above; its × hides it until the count passes your next mark. Tap the number for the count over time and which sessions hold the agents.</p>
        </>} />

      {/* One way back from every look-and-layout choice on this phone at
          once, for the switches that hide things (the `?` chip first among
          them). Device look only — `UI_RESET_KEYS` says what, and its test
          holds it off words and synced choices. Asks first: it is a reset. */}
      <SetAction
        id="ui-reset" label="reset UI settings to default" icon={RotateCw}
        onClick={() => { void (async () => {
          if (!await askConfirm({
            title: "Reset UI settings?",
            lines: [
              "Theme, text and icon size, zooms, the strips, session tabs, layout switches and the ? button go back to their defaults on this phone.",
              "Drafts, queued prompts, header commands, pins and everything synced stay as they are.",
            ],
            confirmLabel: "Reset and reload",
          })) return;
          track("action:settings.uiReset");
          for (const k of UI_RESET_KEYS) lsDel(LS[k]);
          location.reload();
        })(); }}
        note="Everything about how this phone draws the app, back to how it shipped. Your words and synced choices are kept."
      />
    </>
  );
}

// ── Writing & reading ───────────────────────────────────────────────────────

/** What the compose bar's microphone can do on this phone — `useVoice`'s. */
export interface VoiceFacts { supported: boolean; engine: "host" | "browser" | null }

export function WritingRows({ voice }: { voice: VoiceFacts }) {
  const enterSends = usePref("enterSends");
  const dictLang = usePref("dictLang");
  const dictLangCodes = usePref("dictLangCodes");
  const dictTerms = usePref("dictTerms");
  const typingRoom = usePref("typingRoom");
  const closeKbOnSend = usePref("closeKbOnSend");
  const shortcutCard = usePref("shortcutCard");
  const hasKeyboard = useHasKeyboard();
  const btwToCli = usePref("btwToCli");
  const busySend = usePref("busySend");
  const toolsMode = usePref("toolsMode");
  const hintCfg = usePref("hints");
  const hintChip = usePref("hintChip");
  const offered = dictateLangOffered(dictLangCodes, dictLang, deviceLangTag());
  const terms = parseDictateTerms(dictTerms);
  const dropped = dictateTermsDropped(dictTerms);
  return (
    <>
      {/* Two chips, not a switch: these are two different MEANINGS for
          one key, and the old control flipped its own label between
          them — so the same row read as two different settings
          depending on which way it was set. */}
      <SetChoice
        id="enter-sends" radio label="the Return key" icon={CornerDownLeft}
        value={enterSends ? "send" : "newline"}
        options={[{ value: "send", label: "sends" }, { value: "newline", label: "inserts a newline" }]}
        onChange={(v) => setPref("enterSends", v === "send")}
        note={enterSends
          ? "Return sends the message (the key is labelled “send”). Shift/Ctrl/⌘+Return inserts a newline."
          : "Return inserts a newline; only the Send button sends."}
      />

      {/* Dictation's language, where it can be decided BEFORE the
          microphone opens. The pill beside the mic is the same choice
          made mid-recording; it is drawn only while recording, which is
          why the standing answer has to live somewhere a person can
          reach with nothing running. Absent where this phone cannot
          dictate at all — `Unavailable.tsx`'s rule needs no sentence
          for a feature that has no button anywhere either. */}
      {voice.supported && (
        <SetChoice
          id="dictate-lang" radio label="dictation is read as" icon={Languages}
          value={dictLang}
          options={offered.map((c) => ({
            value: c.code,
            label: c.code === DICTATE_AUTO ? "auto" : c.label,
            title: dictateLangTitle(c.code),
          }))}
          onChange={(v) => { track("action:voice.lang"); setPref("dictLang", v); }}
          note={dictateLangTitle(dictLang)}
          more={<>
            <p>The phone used to send its own system language, and whisper <b>told</b> a language does not transcribe another one — it translates into it. English spoken into a German phone came back as fluent German prose.</p>
            <p><b>auto</b> is the answer for anybody who works in two languages: the transcriber detects what was said. Pin one where a short clip or a sentence full of English identifiers gets detected wrong.</p>
            {voice.engine === "browser" && <p>This phone is using the <b>browser's</b> recogniser, which has no auto-detect and is given its language when the recording starts — so <b>auto</b> here means this device's own language, and a change applies to the next recording.</p>}
          </>}
        />
      )}

      {/* WHICH of them the mic lists. The pill is tapped one-handed
          between two sentences, so its list is three long by default
          rather than the whole catalogue; this is where that is a
          decision instead of a guess. */}
      {voice.supported && (
        <SetMulti
          id="dictate-langs" label="languages on the microphone" icon={Languages}
          value={offered.map((c) => c.code)}
          options={dictateLangChoices(deviceLangTag()).map((c) => ({
            value: c.code,
            label: c.code === DICTATE_AUTO ? "auto" : c.label,
          }))}
          onChange={(next) => { track("action:voice.langs"); setPref("dictLangCodes", next); }}
          note={`The picker beside the microphone lists these — ${offered.length} of ${dictateLangChoices(deviceLangTag()).length}.`}
          more={<>
            <p>Turn them all off and it goes back to <b>auto</b>, English and German: a picker with nothing in it is a dead tap. The language in use is always listed, whether or not it is lit here.</p>
            <p>Every language here is one the desktop's transcriber knows. Your phone's own language is in the list even when this app does not otherwise name it.</p>
          </>}
        />
      )}

      {/* Words the transcriber keeps getting wrong. Synced, unlike the
          language: a term is misheard the same way on every device.
          Written on every keystroke — this box is the only copy of
          what was typed, and the settings push debounces it. */}
      {voice.supported && (
        <SetCustom
          id="dictate-terms" label="words dictation should know" icon={SpellCheck}
          note={terms.length
            ? `${terms.length} term${terms.length === 1 ? "" : "s"}: ${terms.slice(0, 6).map((t) => t.term).join(", ")}${terms.length > 6 ? ", …" : ""}${dropped ? ` — ${dropped} more past the limit of ${DICTATE_TERMS_MAX} are not used` : ""}`
            : "None yet. One per line, e.g. BA3 — optionally followed by what it comes out as: BA3: bee a three, be a 3"}
          more={<>
            <p>One term per line. After a colon, what it keeps coming back as, comma-separated: <b>BA3: bee a three, be a 3</b>. A line starting with # is a comment.</p>
            {voice.engine === "host"
              ? <p>The desktop's transcriber is <b>told</b> these words before it listens, which is what makes it spell them your way. Whatever still comes out wrong is corrected afterwards from the list after the colon.</p>
              : <p>This phone is using the <b>browser's</b> recogniser, which cannot be told words in advance — here the list only corrects what comes out, so the part after the colon does the work.</p>}
            <p>A term that arrives split (<b>BA 3</b>, <b>B.A.3</b>) is joined back without being listed, and one with a digit or an inner capital is re-cased (<b>ba3</b> → <b>BA3</b>). An ordinary word is never re-cased, so <b>Go</b> leaves "go" alone.</p>
          </>}
        >
          <textarea
            className="guardrail-text" rows={4} value={dictTerms}
            placeholder={"BA3: bee a three, be a 3\nTiptoi"}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => setPref("dictTerms", e.target.value)}
          />
        </SetCustom>
      )}

      <SetSwitch
        id="close-kb-on-send" label="close the keyboard after Send" icon={Keyboard}
        on={closeKbOnSend}
        onChange={() => setPref("closeKbOnSend", !closeKbOnSend)}
        note={closeKbOnSend
          ? "Once a message goes, the keyboard drops so the answer gets the whole screen. Tap the box to type again."
          : "The keyboard stays up after a send, ready for the next message."}
      />

      {/* Only where a physical keyboard is known (a fine pointer, or a
          hardware key seen): a touch-only phone never meets the card, so a
          switch for it there would be a control for nothing. */}
      {hasKeyboard && (
        <SetSwitch
          id="shortcut-card" label="hold Ctrl to see shortcuts" icon={Command}
          on={shortcutCard}
          onChange={() => setPref("shortcutCard", !shortcutCard)}
          note={shortcutCard
            ? "Hold Ctrl, ⌘ or Alt alone for half a second and a card lists what each key does with it right now. Letting go hides it."
            : "Holding a modifier shows nothing. The shortcuts themselves still work."}
        />
      )}

      <SetChoice
        id="busy-send" radio label="Send while it works" icon={Hourglass}
        value={busySend}
        options={[
          { value: "", label: "ask" },
          { value: "now", label: "send now" },
          { value: "idle", label: "when it's free" },
        ]}
        onChange={(v) => setPref("busySend", v)}
        note={busySend === "now"
          ? "Send on a session that is still working types the words into the running turn straight away."
          : busySend === "idle"
            ? "Send on a session that is still working hands the words to the desktop, which sends them when the turn ends."
            : "Send on a session that is still working asks: send now, or when it's free."}
      />

      <SetChoice
        id="btw-to-cli" radio label="/btw from the reader" icon={TerminalIcon}
        value={btwToCli}
        options={[
          { value: "", label: "ask" },
          { value: "switch", label: "switch to the CLI" },
          { value: "stay", label: "stay" },
        ]}
        onChange={(v) => setPref("btwToCli", v)}
        note={btwToCli === "switch"
          ? "A /btw sent from the reader switches to the CLI, where its answer is — the reader cannot show it."
          : btwToCli === "stay"
            ? "A /btw sent from the reader stays in the reader; its row has an open the CLI button for the answer."
            : "After a /btw sent from the reader, asks whether to switch to the CLI, where its answer is."}
      />

      <SetSwitch
        id="typing-room" label="typing room" icon={ChevronsDownUp}
        on={typingRoom}
        onChange={() => setPref("typingRoom", !typingRoom)}
        note={typingRoom
          ? "While the caret is in the box, everything above it is hidden except the output and the outline button."
          : "The header, status line, key row and file strips stay up while you type."}
        more={<p>On, the keyboard costs the terminal nothing — tap the terminal to get the header back. Measured: with all the chrome up, a phone keyboard left two lines of output.</p>}
      />

      <SetChoice
        id="reader-tools" radio label="tool calls in the reader" icon={BookOpen}
        value={toolsMode}
        options={([["fold", "fold runs"], ["list", "one row each"], ["full", "download details"]] as [ReaderToolsMode, string][])
          .map(([v, label]) => ({ value: v, label }))}
        onChange={(m) => setPref("toolsMode", m)}
        note={toolsMode === "fold"
          ? "A run of tool calls collapses into one “N tool calls” line, so the conversation stays on screen."
          : toolsMode === "list"
            ? "Every tool call gets its own row."
            : "Tool inputs and results come down with the transcript — everything is there offline."}
        more={toolsMode === "full"
          ? <p>At the cost of a much bigger download and a much bigger offline cache, which is what makes a long conversation slow to load on a phone.</p>
          : <p>What a call ran and what came back stays on the host until you open one. Tap a folded run to see the calls, tap one to load it.</p>}
      />

      <SetChoice
        id="hints-mode" radio label="button hints" icon={HelpCircle}
        value={hintCfg.mode}
        options={([["first", "explain once"], ["press", "long-press only"], ["off", "off"]] as [HintMode, string][])
          .map(([v, label]) => ({ value: v, label }))}
        onChange={(m) => setPref("hints", { mode: m, seen: hintSeenCount() })}
        note={hintCfg.mode === "first"
          ? "The handful of actions whose icon can't be guessed explain themselves the first time you tap them, then never again."
          : hintCfg.mode === "press"
            ? "Nothing interrupts a tap. Long-press any button to read what it does."
            : "No hints at all — not even on long-press."}
        more={<p>Hold, re-aim, fork, fan out and keep-newest are the ones that cannot be guessed from an icon. A long press never fires the button it explains.</p>}
      />

      <SetAction
        id="hints-explain" label="explain mode" icon={HelpCircle}
        onClick={() => { setExplainMode(true); core().nav.close("settings"); }}
        note="Turns every tap into an explanation until you leave it — the way back after everything has been dismissed."
        more={<p>Also on the “?” chip in the launcher and session headers.</p>}
      />

      <SetSwitch
        id="hints-chip" label="? button in the headers" icon={HelpCircle}
        on={hintChip !== "hidden"}
        onChange={() => setPref("hintChip", hintChip === "hidden" ? "asked" : "hidden")}
        note={hintChip === "hidden"
          ? "Removed from the launcher and session headers. Long-press any button, or explain mode above, still explains it."
          : "The ? in the launcher and session headers turns on explain mode. Leaving it the first time asks whether it can go."}
      />

      {/* Was `disabled` when nothing had been dismissed, which is a grey
          button standing in for a sentence. The sentence is the app's
          own rule (`Unavailable.tsx`) and it also happens to be the more
          useful answer: it says what the count IS. */}
      <SetAction
        id="hints-reset" label="explain them again" icon={RotateCw}
        cant={hintCfg.seen === 0 ? "nothing has been dismissed yet" : undefined}
        onClick={() => { resetHints(); prefs.reload("hints"); showToast("hints reset"); }}
        note={hintCfg.seen === 0
          ? "Dismissals follow you to your other devices."
          : `${hintCfg.seen} dismissed. This makes them all first-time again, on every device.`}
      />
    </>
  );
}

// ── Offline & data ──────────────────────────────────────────────────────────

/** The install offer: App catches `beforeinstallprompt`, this row spends it. */
export interface InstallFacts {
  installed: boolean;
  canInstall: boolean;
  /** The deferred `beforeinstallprompt` event; null once spent. */
  evt: MutableRefObject<any>;
  /** The offer was taken — App drops `canInstall`. */
  taken(): void;
}

/** The queue's reconnect question, which the `confirm-queue` switch answers
 *  when it is turned off. */
export interface ReconnectFacts {
  holdRef: MutableRefObject<boolean>;
  setReconnectAsk(v: boolean): void;
  flush(): void;
}

export function OfflineRows({ install, reconnect }: { install: InstallFacts; reconnect: ReconnectFacts }) {
  const push = useHostPush();
  const autoSend = usePref("autoSend");
  const serialSessions = usePref("serialSessions");
  const confirmQueue = usePref("confirmQueue");
  const saver = usePref("saver");
  const fresh = usePref("bgFresh");
  const queuedSends = core().queue.entries.filter((e) => e.status === "queued");
  return (
    <>
      {/* lucide, never an emoji/dingbat glyph — repo-wide icon rule. */}
      {install.installed ? (
        <SetCustom id="install" label="install this app" icon={Check}
          note="Running as an installed app." />
      ) : push === "insecure" ? (
        <SetCustom id="install" label="install this app" icon={Smartphone}>
          <SetWarn>
            Installing needs a secure context — you're on {location.protocol}//{location.host}, and a
            service worker can't register over plain HTTP. Front the host with TLS (the command under
            Notifications), reopen on the HTTPS name, then install from here.
          </SetWarn>
        </SetCustom>
      ) : install.canInstall ? (
        <SetAction
          id="install" label="install this app" icon={Smartphone}
          onClick={async () => {
            track("action:install.app");
            const e = install.evt.current;
            if (!e) { showToast("install offer expired — reload and try again"); return; }
            install.evt.current = null; install.taken();
            try { e.prompt(); await e.userChoice; } catch { showToast("install cancelled"); }
          }}
          note="Adds it to your home screen and runs it full-screen, without browser chrome."
        />
      ) : isIosSafari() ? (
        <SetCustom id="install" label="install this app" icon={Smartphone}
          note={<>To install: tap Share, then <b>Add to Home Screen</b>. iOS has no in-app install button.</>} />
      ) : (
        <SetCustom id="install" label="install this app" icon={Smartphone}
          note="No install offer from this browser right now — it may already be installed, or the browser needs another visit first." />
      )}

      <SetSwitch
        id="auto-send" label="auto-send the queue" icon={SendHorizontal}
        on={autoSend}
        onChange={() => {
          setPref("autoSend", !autoSend);
          showToast(!autoSend ? "queued messages will send themselves" : "queued messages wait for “Send now”");
        }}
        note={<>Messages sent while the link is down go out the moment the host is reachable again.{queuedSends.length > 0 ? ` ${queuedSends.length} waiting now.` : ""}</>}
        more={<p>They are kept in this browser, so a reload or the phone killing the tab doesn't lose them — Return included. Several messages for the SAME session go out one at a time, in order, each waiting for the one before it to be submitted. The host de-duplicates delivery receipts, so a re-send can never type the same prompt twice. Off holds them until you tap “Send now”.</p>}
      />

      <SetSwitch
        id="serial-sessions" label="one session at a time per repo" icon={ListOrdered}
        on={serialSessions}
        onChange={() => {
          setPref("serialSessions", !serialSessions);
          showToast(!serialSessions ? "queued work runs one session at a time per repo" : "queued work all starts at once");
        }}
        note="On, a queued open waits until every session in that directory has finished its turn."
        more={<p>Queue five prompts for one repo on a train and, with this off, all five open their own agent the second the link is back: one account's usage limit spent five ways in parallel, five half-finished turns when it runs out, and five agents editing the same working tree. A worktree counts as its own directory — that is what makes running work in parallel safe in the first place. Only opens that carry a prompt are held (a bare terminal runs nothing), and “Send this one now” always overrides it.</p>}
      />

      <SetSwitch
        id="confirm-queue" label="ask on reconnect" icon={Radio}
        on={confirmQueue}
        onChange={() => {
          // Turning the question off answers any question currently open:
          // the queue must not stay held by a prompt that no longer exists.
          if (confirmQueue) { reconnect.holdRef.current = false; reconnect.setReconnectAsk(false); reconnect.flush(); }
          setPref("confirmQueue", !confirmQueue);
          showToast(!confirmQueue ? "you'll be asked before the queue goes out" : "the queue drains without asking");
        }}
        note="Text typed offline was written against what the session looked like THEN — ask before it goes out."
        more={<p>Send it, review and edit it first, or hold it. Off = it just goes (subject to auto-send above). A message you send with the link UP is never held by this.</p>}
      />

      {queuedSends.length > 0 && (
        <SetAction
          id="queue-manage" label={`manage ${queuedSends.length} queued`} icon={ListOrdered} opens
          onClick={() => { track("action:queue.manage"); core().nav.open("queue"); }}
        />
      )}

      <SetSwitch
        id="data-saver" label="data saver" icon={Radio}
        on={saver}
        onChange={() => {
          const on = !saver;
          setPref("saver", on); track("action:datasaver");
          showToast(on ? "data saver on — smaller images, slower polling" : "data saver off");
        }}
        note="For a roaming or hotel link: smaller image copies, slower background polling. Per device."
        more={<p>Asks the host for smaller images in the grids and the full-screen viewer — “full res” is always one tap away — and slows the reader view's background polling.</p>}
      />

      <SetSlider
        id="bg-fresh" label="in the background" icon={BatteryMedium}
        min={0} max={BG_FRESH_STEPS.length - 1} step={1}
        value={Math.max(0, BG_FRESH_STEPS.indexOf(fresh))}
        readout={bgFreshLabel(fresh)}
        onInput={(i) => setPref("bgFresh", BG_FRESH_STEPS[i] ?? fresh)}
        onCommit={() => track("action:bgfresh")}
        note={bgFreshNote(fresh)}
        more={<p>Battery against how recent the screen is that you can read with no signal. Left is fresher, right saves more. Takes effect the next time the app goes to the background. Per device.</p>}
      />
    </>
  );
}

/** One of the parallel-agent marks as a stepper over `AGENT_WARN_STEPS`, with
 *  "off" (0) past the top. */
function AgentMark({ id, label, icon, cfg, k, note, more }: {
  id: string; label: string; icon: LucideIcon; cfg: AgentWarnCfg; k: keyof AgentWarnCfg; note: ReactNode; more?: ReactNode;
}) {
  const steps: readonly number[] = [...AGENT_WARN_STEPS, 0];
  const v = cfg[k];
  let i = steps.indexOf(v);
  if (i < 0) i = steps.findIndex((s) => s > v);
  if (i < 0) i = steps.length - 2;
  const set = (n: number) => { track(`action:agentWarn.${k}`); setPref("agentWarn", { ...cfg, [k]: n }); };
  return (
    <SetStepper id={id} label={label} icon={icon}
      readout={v === 0 ? "off" : String(v)}
      onLess={i > 0 ? () => set(steps[i - 1]) : null}
      onMore={i >= 0 && i < steps.length - 1 ? () => set(steps[i + 1]) : null}
      lessLabel="fewer" moreLabel={steps[i + 1] === 0 ? "off" : "more"}
      note={note} more={more} />
  );
}
