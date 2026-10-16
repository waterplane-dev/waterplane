/**
 * The host-tools sheets' pure half — no React, no DOM — so `logic.test.mjs`
 * runs it under `node --test`.
 *
 * Mostly the feature-usage CATALOG, moved here from `App.tsx` with the sheet
 * that reads it (`features`, `UsageSheet.tsx`). It is still the one list of
 * every id `track()` can emit: keep it in sync when adding a `track()` call,
 * wherever that call now lives.
 */
import { ASSESS_VERDICTS, type SessionInfo } from "@waterplane/shared";

// ── Feature-usage catalog ────────────────────────────────────────────
// Every id `track()` can emit, so the usage sheet can list features with ZERO
// uses (the delete list) — a counter only appears once it fires, so unused
// features are invisible without this. Keep in sync when adding a track() call.
export const OVERLAY_IDS = [
  "slash", "image", "swipe", "gallery", "new", "backlog", "git", "model", "text", "toolbar", "history",
  "secret", "setup", "speedtest", "branches", "decisions", "settings", "notifications", "snippets",
  "build", "search", "features", "nethealth", "fanout", "pad", "send", "activity", "pull", "hdrcmd", "sentlog", "questions", "outline", "limits", "schedule", "scrollback", "browse", "collage", "archive",
  "clihealth", "assess", "capture", "localrt", "hostedack",
  // `context`, `queue` and `tokens` are tracked at their call sites but were
  // never listed here, so the usage sheet could not show them at zero uses —
  // which is the one reading a usage sheet exists for. Listed with `sweep`.
  "sweep", "context", "queue", "tokens", "apps", "repohealth", "storage",
];
export const ACTION_IDS = [
  "compose.send", "voice", "snippet.insert", "snippet.save",
  // `session.read` is the launcher's own way in: straight to the reader with the
  // outline up, tracked apart from `session.attach` because "opened to LOOK" and
  // "opened to WORK" are different uses of the same list.
  "session.attach", "session.read", "session.new", "session.resume", "session.close", "session.close.all", "session.close.stale", "session.close.custom", "session.rename", "session.name", "session.star", "session.followup", "session.followup.closed", "session.pin", "session.reorder", "session.order.reset", "session.filter.wait", "session.filter.limit", "session.filter.coding", "session.filter.done", "session.filter.exited", "session.filter.starred", "session.filter.followup",
  "repo.build.header", "repo.files.header", "repo.close.all", "repo.close.stale", "repo.close.custom", "repo.collapse", "repo.collapse.all", "repo.expand.all", "repo.new.header", "repo.new.offline", "repo.new.project", "repo.new.bare", "repo.clone", "repo.more", "repo.focus", "repo.setup", "repohealth.refresh", "repohealth.ask", "repohealth.askall", "repohealth.scope", "repohealth.help", "repo.branch", "repo.build", "repo.capture", "repo.hide", "repo.inbox", "repo.git",
  // A box answered by tapping, from the READER's card (`PromptAnswer.tsx`).
  // The approve bar's size counters (`prompt.mini`/`expand`/`hide`/`show`,
  // `prompt.detail`) are gone with the bar: they were measuring how often the
  // card had to be got out of the way, which is not a question any more.
  "prompt.answer", "prompt.esc", "prompt.submit",
  // The questions sheet — the same card, off the session and answerable with no
  // link at all. Tracked apart from `prompt.*` on purpose: "answered from the
  // sheet" vs "answered in the session" is what says whether the offline route
  // is the one being used.
  "questions.answer", "questions.esc", "questions.submit", "questions.open",
  // The resume queue. "who resumed first" is a decision the user makes maybe
  // twice a week, so the counters are what say whether the sheet earns its
  // place — and whether the steering is ever used at all, or the default order
  // is simply right.
  "limit.first", "limit.auto", "limit.resumeone", "limit.resumeall", "limit.starredonly", "limit.global", "limit.session", "limit.mode",
  // `backlog.add` is gone with the add form that emitted it — the sheet's one
  // way in is `backlog.send`, which lands in the Send sheet like everything
  // else. The list is not exhaustive (thirty-odd ids predate it), but an id
  // missing from it can never report zero, and these are the ones that say
  // whether the reworked sheet is being used the way it was rebuilt to be.
  "backlog.send", "backlog.fire", "backlog.refire", "backlog.done", "backlog.remove",
  // The backlog's own cut. Enumerated for the reason the assess ids are: an id
  // `UsageSheet` does not know reads as noise, and these three are how "is the
  // list still being read, or is it being filtered" gets answered.
  "backlog.filter.status", "backlog.filter.age", "backlog.filter.clear",
  "git.stage", "git.commit", "git.pull", "git.push", "git.sync", "git.branch", "git.diff",
  // The desktop drafting the commit message (host `commitmsg.ts`). Counted
  // apart from `git.commit`: how often a drafted message is actually committed
  // is the only reading that says whether the draft is any good.
  "git.message",
  // The file browser. `files.save` is the one worth watching: "edit from the
  // phone" was specified as a rare case, and a counter that climbs says the
  // editor stopped being a fallback and became a workflow.
  "files.open", "files.edit", "files.save", "files.search", "files.download",
  "gallery.delete", "gallery.annotate", "gallery.download", "gallery.more", "gallery.fullres", "gallery.pick", "gallery.combine", "image.send", "image.queue", "newimg.open", "newimg.ref", "swipe.download",
  // Several pictures as one. `collage.separate` is the counter that says whether
  // this sheet is a step in the way: if it is what people press, the offer
  // belongs behind a button rather than in front of every multi-image pick.
  "collage.combine", "collage.separate", "collage.layout", "collage.reorder",
  // The build sheet's two answers to an empty field: `build.setup` spends an
  // agent turn on the whole repo, `build.suggest.*` is the free scan of its
  // manifests. Counted apart because the question they answer together — "did
  // anybody ever need the expensive one for a single command?" — is the one
  // that says whether the scan was worth building.
  // `build.one` is the third answer and the one to watch: a wand scoped to ONE
  // entry, against `build.setup`'s whole-repo turn. `build.ask` counts the taps
  // that opened a parameterised build's form rather than starting a build.
  "build.run", "build.save", "build.artifact", "build.setup", "build.suggest.open", "build.suggest.use",
  "build.one", "build.ask",
  // Verified capture. `capture.filter` vs `capture.filter.clear` is the usual
  // pair, but `capture.run` against `capture.artifact` is the one worth having:
  // a capture whose FRAMES are always downloaded is one whose verdict line is
  // not doing its job, and the whole point of the sidecar is that an agent —
  // and often a person — never needs the picture.
  // `capture.watch` is counted apart from `capture.run` for the reason the two
  // verbs exist apart: one is a snapshot, the other is a feedback loop somebody
  // leaves running while they work, and only the second number says whether
  // anybody actually codes against it.
  "capture.run", "capture.watch", "capture.save", "capture.artifact", "capture.filter", "capture.filter.clear",
  "fanout.run", "fanout.followup", "fanout.followup.open", "fanout.preset", "fanout.presets.edit", "fanout.presets.save", "fanout.schedule",
  // Scheduled prompts: the counters say whether a schedule is set once and left
  // alone (the intent) or re-driven by hand every week (the feature failing).
  // The verbs that leave this sheet for somewhere else are counted too
  // (`spent` opens Activity, `session`/`reposession` open a CLI, `skipnext`
  // spends one occurrence): a button nobody presses is exactly what this list
  // exists to surface, and one missing from it can never report zero.
  "schedule.new", "schedule.save", "schedule.edit", "schedule.runnow", "schedule.toggle", "schedule.remove",
  "schedule.skipnext", "schedule.session", "schedule.reposession", "schedule.spent",
  "pull.auto", "pull.enable", "pull.supersede", "pull.retry", "pull.pause", "pull.resumeall", "pull.save", "pull.clearall", "gallery.pull", "gallery.pullsave",
  "search.recent", "search.history", "read.toggle", "read.find", "read.outline", "read.fileref", "outline.find", "outline.jump", "scrollback.find", "scrollback.reachback",
  // `setup.fix` patches; `setup.remedy` opens a prompt. Counted apart because a
  // checklist whose findings are mostly remedies is one whose checks have
  // outgrown being auto-fixable, which is a different thing to know.
  "speedtest.run", "secret.set", "setup.fix", "setup.remedy", "datasaver", "upload.scale", "install.app", "outbox.retry",
  "queue.manage", "queue.sendall", "queue.sendone", "queue.edit", "queue.remove", "queue.restore", "queue.addprompt",
  // The three halves of "this never went — deal with it": open the editor, send
  // the rewritten message, throw it away. Counted separately from `queue.sendone`
  // because a queue where the RETRY is what people press is a queue whose sends
  // are merely unlucky, and one where this is what they press is a queue whose
  // sends go stale — different bug, different fix.
  "queue.resend", "resend.reattach", "resend.replace",
  // The one send surface. `send.post` is the counter that says whether the
  // collapsed rows are enough — a sheet whose *To* or *When* is expanded on
  // every send is one whose defaults are wrong.
  // `send.after` is the chained send — the third anchor, and the only one that
  // leaves this sheet as an `intent.post`. Counted apart from `send.post` (which
  // every send bumps) because "does anybody express a dependency, or do they go
  // on guessing a clock far enough out" is the one question the addition was
  // made to answer, and an id missing from this list can never report zero.
  "send.post", "send.after", "send.discard", "send.addprompt", "send.attach", "send.attachfile", "send.browse",
  // Activity: one counter per action id, because "which button does anyone
  // press on the screen you open when something went wrong" is the question
  // that says whether this list is a ledger or a control panel.
  "activity.sendNow", "activity.hold", "activity.retarget", "activity.edit", "activity.fix",
  "activity.retry", "activity.answer", "activity.open", "activity.runNow", "activity.cancel",
  "activity.toggle", "activity.download", "activity.save", "activity.discard",
  "activity.filter.all", "activity.filter.needsYou", "activity.filter.failed", "activity.filter.running",
  "activity.filter.waiting", "activity.filter.scheduled", "activity.filter.done", "activity.filter.dismissed",
  // Triage. These are the counters that say whether this screen is usable at
  // the size it actually reaches — 217 rows on one real phone, 84 of them
  // failed. If `bulk.dismiss` and `bulk.refire` never fire while `filter.failed`
  // does, the list is being READ and not cleared, which is the state that
  // produced eighty-four of them in the first place.
  "activity.select", "activity.selectall", "activity.selectnone", "activity.group",
  "activity.sort", "activity.debris", "activity.expand",
  "activity.bulk.refire", "activity.bulk.dismiss", "activity.bulk.restore",
  "queue.confirm.send", "queue.confirm.review", "queue.confirm.hold",
  // `queue.handtodesktop` is what *when it's free* on the next-prompt strip
  // does now: the entry is re-aimed into the desktop's own queue instead of
  // being parked on this phone. Counted apart from `queue.hold` (which is left
  // to the one lane the desktop cannot hold) because the split between them is
  // what says whether the second holder is really gone.
  "queue.retarget", "queue.hold", "queue.handtodesktop", "compose.options",
  // The rescue nobody asked for: a prompt whose session died, re-aimed at that
  // repo's work items. Counted because it is the LAST word on "session not
  // available" — the failure this queue produced most often, and the one the
  // deleted give-ups ledger existed to list after the fact.
  "queue.rescue",
  // CLI mode. Counted in both directions on purpose: "turned on 40 times,
  // turned off 40 times" is a mode people visit, "on 40, off 3" is one they
  // get stuck in — and the second reading means the composer is the thing
  // that needs fixing, not this.
  "cli.on", "cli.off",
  // Typing room's two escapes. Counted in both directions for `cli.on`/`cli.off`'s
  // reason: a peek that is opened often and never closed means the chrome being
  // hidden is the wrong default on that device, not that the button is missing.
  "typing.peek", "typing.hide",
  "pad.new", "pad.save", "pad.remove", "pad.send", "pad.queue", "pad.fanout", "pad.start",
  "session.newprompt", "attach.file", "attach.paste", "outbox.auto",
  "https.switch", "hostSetup", "hosts.switch", "hosts.remove",
  "appUpdate.check", "appUpdate.download", "appUpdate.apply", "appUpdate.auto", "appUpdate.revert",
  "hdrcmd.send", "hdrcmd.manage", "hdrcmd.save",
  // The three size knobs (`uiScale.ts`). Enumerated for `assess.*`'s reason:
  // an id the usage sheet does not know about reads as noise, and a size
  // control nobody ever touches is exactly the kind of thing that list is for.
  "uiscale.text", "uiscale.icon", "uiscale.term", "uiscale.reader",
  // Full screen by hand — typing room's layout without the keyboard. Counted
  // in both directions for `cli.on`/`cli.off`'s reason: "on 40, off 3" means
  // people are getting stuck in it, which is a fact about the way out.
  "fullscreen.on", "fullscreen.off",
  // Button hints: how often an explanation is actually read through to the
  // action, and how often explain mode gets switched on — the two numbers that
  // say whether the icons are still unreadable.
  "hint.proceed", "hints.explain",
  // The assessment sheet. Enumerated rather than left as unknown ids, because
  // `UsageSheet`'s list is how a button nobody presses gets found — an id it
  // does not know about reads as noise rather than as a feature.
  ...["run", "apply", "clear", "plan", "discard", "merge", "leave", "open", "accept.new"].map((a) => `assess.${a}`),
  ...ASSESS_VERDICTS.flatMap((v) => [`assess.bulk.${v}`, `assess.strip.${v}`, `assess.accept.${v}`]),
  "backlog.assess",
];
/** Every known id, prefixed as `track()` records it. The toolbar ids are
 *  handed in (`toolbar.ts`'s `TOOLBAR_ITEMS`), which keeps this file free of
 *  the icon imports that module carries. */
export function knownFeatureIds(toolbarIds: readonly string[]): string[] {
  return [
    ...toolbarIds.map((t) => `toolbar:${t}`),
    ...OVERLAY_IDS.map((o) => `overlay:${o}`),
    ...ACTION_IDS.map((a) => `action:${a}`),
  ];
}

/** Conversation ids that are open RIGHT NOW as live sessions. The archive
 *  shows every conversation on disk, including the ones already on screen —
 *  those rows must offer a jump, never a second `--resume` of the same chat
 *  (two claudes in one conversation is how a turn gets lost). */
export function liveConversationIds(sessions: readonly Pick<SessionInfo, "claudeSessionId">[]): Set<string> {
  return new Set(sessions.map((s) => s.claudeSessionId).filter((x): x is string => !!x));
}

/** Which repo the archive opens on: the one in context, else the first one
 *  listed; "" when there is none (the sheet then says so). */
export function archiveStartRepo(activeRepoId: string | null | undefined, visibleRepoIds: readonly string[]): string {
  return activeRepoId ?? visibleRepoIds[0] ?? "";
}
