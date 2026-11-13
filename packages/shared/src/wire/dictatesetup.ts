/**
 * Setting up local dictation from the phone, on the wire.
 *
 * The desktop installs whisper.cpp (macOS brew) and downloads ONE chosen ggml
 * model from upstream on a person's tap — never bundled, never automatic. The
 * model table itself is `dictatemodels.ts`; these are the shapes that cross.
 */

/** A model the person may choose, as the phone draws it (the table's row less
 *  the url and hash: the host holds those). */
export interface DictateModelChoice {
  id: string;
  file: string;
  bytes: number;
  note: string;
  recommended: boolean;
  /** This model's file is already in the model directory at the right size. */
  installed: boolean;
}

/** What `POST /api/host/dictate/setup` takes. */
export interface DictateSetupRequest { model: string }

export type DictateSetupStep = "engine" | "disk" | "download" | "verify";

/** `GET /api/host/dictate/setup`. A failure is a SENTENCE a person can act on;
 *  there is no auto-retry — the next attempt is another POST. */
export type DictateSetupState =
  | { state: "idle" }
  | { state: "running"; model: string; step: DictateSetupStep; bytesDone: number; bytesTotal: number }
  | { state: "done"; model: string }
  | { state: "failed"; model: string; step: DictateSetupStep; reason: string };
