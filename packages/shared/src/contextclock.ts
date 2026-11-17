// The three clocks an always-on figure can be read on. A number is never printed without the
// clock it was taken on, and the clocks are never reconciled: the gap between them is the reading.

export const CONTEXT_CLOCK = {
  /** The files as they are on disk now (the Setup check's reading). */
  tree: "in the working tree",
  /** The last commit the weekly series measured. Followed by its short sha. */
  commit: "at the last commit measured",
  /** What a running session actually carries, off its own gauge. */
  live: "in this session now",
} as const;

export type ContextClock = keyof typeof CONTEXT_CLOCK;
