/**
 * The pills and step icons the sheet draws with.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { BookOpen, Bot, Globe, MessageSquare, Pencil, Search, Terminal, Wrench } from "lucide-react";
import type { AssessRun, AssessStepKind, AssessVerdict } from "@waterplane/shared";

export const ICON = 16;

/** The pill on a strip head. `tag-*` are the app's existing state colours;
 *  which verdict is which colour is the only judgement here, and it follows
 *  what each one DOES: three retire something, one queues it, one decided
 *  nothing. */
export const VERDICT_TAG: Record<AssessVerdict, string> = {
  done: "tag tag-done",
  obsolete: "tag tag-done",
  superseded: "tag tag-done",
  merged: "tag tag-running",
  wanted: "tag tag-queued",
  // Amber, not red: "could not tell" is the pile a person has to look at, not a
  // failure. Red here would make the safe direction — the one every downgrade
  // lands on — read as the broken one.
  unclear: "tag queued",
};

export const RUN_TAG: Record<AssessRun["status"], string> = {
  running: "tag tag-running",
  done: "tag tag-queued",
  failed: "tag tag-failed",
  applied: "tag tag-done",
};

/**
 * The icon a step wears — keyed on the step's SHAPE, which is why the wire
 * carries a shape and not the CLI's tool name: a tool this app has never heard
 * of still draws (`Wrench`), and reads as itself in the words beside it.
 *
 * `lucide-react` only; an emoji here would be the repo-wide rule broken in the
 * one list nobody re-reads.
 */
export const STEP_ICON: Record<AssessStepKind, typeof BookOpen> = {
  read: BookOpen,
  search: Search,
  edit: Pencil,
  run: Terminal,
  task: Bot,
  web: Globe,
  say: MessageSquare,
  tool: Wrench,
};
