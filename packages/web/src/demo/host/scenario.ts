/**
 * The scenario format (plan §3): data only, so one file drives the demo, the
 * docs media and the UI journeys. Recorded from the stub-driven host (WP3),
 * never hand-invented beyond names and summaries.
 */
import type { DemoFaultRule } from "./faults.ts";
import type { DemoStep } from "./model.ts";
import type { DemoState } from "./snapshot.ts";

export interface DemoScenario {
  meta: {
    id: string;
    /** `PROTOCOL_VERSION` the scenario was recorded at; a mismatch refuses it. */
    protocol: number;
    /** Content stamp (stub hash + recording hash). Keys the snapshot, so a
     *  changed scenario never restores state saved from the old one. */
    stamp: string;
  };
  /** The instant the scenario's numbers are true at; the transport pins its
   *  clock here for docs and tests. The core reads only `DemoClock`. */
  clock: { start: number };
  /** The seed. Copied, never mutated. */
  state: DemoState;
  /** Events the desktop "does" on its own, `at` ms after the demo started. */
  script: { at: number; event: DemoScriptEvent }[];
  /** Tests only — see `assertShippable`. */
  faults?: DemoFaultRule[];
}

/** A step the desktop takes on its own (model.ts `DemoStep`): a broadcast
 *  `frame`, PTY `output`, a choice box (`prompt`), a `session` patch or a
 *  `turnEnd`. Session steps in a script must name their `sessionId`. */
export type DemoScriptEvent = DemoStep;
