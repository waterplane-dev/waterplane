import { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import type { DictateModelChoice, DictateSetupState, DictateSetupStep, DictateStatus } from "@waterplane/shared";
import { SetCustom, SetNote, SetWarn } from "./SettingsKit";
import { askConfirm } from "./Confirm";
import { Button } from "./kit/Button";
import { api } from "./api";
import { showToast } from "./toast";
import { track } from "./usage";
import { dictateStatusChanged } from "./useVoice";

const POLL_MS = 1500;
const mb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

const STEP_WORDS: Record<DictateSetupStep, string> = {
  engine: "Installing whisper-cpp on the desktop",
  disk: "Checking the desktop has room",
  download: "Downloading the model",
  verify: "Checking the download",
};

/** The progress sentence for a running setup. Pure, so a test can hold it. */
export function setupProgressWords(s: Extract<DictateSetupState, { state: "running" }>): string {
  if (s.step === "download" && s.bytesTotal > 0) return `${STEP_WORDS.download}: ${mb(s.bytesDone)} of ${mb(s.bytesTotal)}`;
  return `${STEP_WORDS[s.step] ?? "Setting up"}…`;
}

/** What the confirm says it will do — the download size and the brew install, before anything starts. */
export function setupConfirmLines(m: DictateModelChoice): string[] {
  return [
    `Downloads the ${m.id} model (${mb(m.bytes)}) to the desktop.`,
    "If whisper-cpp is missing, it also runs brew install whisper-cpp there.",
    "Dictation then runs on the desktop instead of the phone's recogniser.",
  ];
}

/**
 * Settings › Writing & reading › Local dictation: the desktop's whisper, and a
 * tap to set it up. The setup starts only from the confirmed tap; the desktop
 * does the work and this row only reports it (polled while it runs).
 */
export function DictateLocalRow({ id }: { id: string }) {
  const [status, setStatus] = useState<DictateStatus | null>(null);
  const [setup, setSetup] = useState<DictateSetupState | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const live = useRef(true);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const readStatus = useCallback(async () => {
    const s = await api.dictateStatus();
    if (live.current) setStatus(s);
    return s;
  }, []);

  const poll = useCallback(async () => {
    const st = await api.dictateSetupState();
    if (!live.current) return;
    setSetup(st);
    if (st?.state === "running") running.current = true;
    // A failed read while a setup runs is a blip, not the end: keep asking until done/failed or unmount.
    if (st?.state === "running" || (st === null && running.current)) { timer.current = setTimeout(() => void poll(), POLL_MS); return; }
    running.current = false;
    if (st?.state === "done") {
      const s = await readStatus();
      if (s.available) dictateStatusChanged();
    }
  }, [readStatus]);

  useEffect(() => {
    live.current = true; running.current = false;
    void readStatus().then((s) => { if (!s.available && s.canSetup) void poll(); });
    return () => { live.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [readStatus, poll]);

  const models = status?.models ?? [];
  const chosen = models.find((m) => m.id === pick) ?? models.find((m) => m.recommended) ?? models[0];

  const start = async () => {
    if (!chosen || starting) return;
    setStarting(true);
    const ok = await askConfirm({
      title: "Set up local dictation on this desktop?", lines: setupConfirmLines(chosen),
      confirmLabel: "Set up", tone: "info",
    });
    if (!ok) { setStarting(false); return; }
    track("action:voice.localSetup");
    const r = await api.dictateSetupStart(chosen.id);
    if (live.current) setStarting(false);
    // A refusal (a job another phone started is "already running") still shows whatever job is there.
    if (!r.ok) { showToast(`Setup did not start: ${r.error}`); void poll(); return; }
    showToast("Setting up local dictation on the desktop.");
    void poll();
  };

  const label = "local dictation";
  if (!status) return <SetCustom id={id} label={label} icon={Mic} note="Asking the desktop…" />;

  if (status.available) {
    return (
      <SetCustom id={id} label={label} icon={Mic}
        note={`The microphone uses ${status.engine ?? "the desktop's whisper"}${status.model ? ` with ${status.model}` : ""}.`} />
    );
  }

  if (!status.canSetup) {
    return (
      <SetCustom id={id} label={label} icon={Mic}>
        <SetWarn tone="plain">{status.reason ?? "The desktop cannot transcribe yet."}</SetWarn>
      </SetCustom>
    );
  }

  if (setup?.state === "running") {
    return (
      <SetCustom id={id} label={label} icon={Mic} note={setupProgressWords(setup)}>
        {setup.step === "download" && setup.bytesTotal > 0 && <progress max={setup.bytesTotal} value={setup.bytesDone} style={{ width: "100%" }} />}
      </SetCustom>
    );
  }

  return (
    <SetCustom id={id} label={label} icon={Mic}
      note="The microphone is using the phone's own recogniser, which is weaker on code words and mixed languages. The desktop can run whisper instead.">
      {setup?.state === "failed" && <SetWarn>{setup.reason}</SetWarn>}
      {setup?.state === "done" && <SetWarn>{status.reason ?? "The setup finished, but the desktop still cannot transcribe."}</SetWarn>}
      <div className="set-chips">
        {models.map((m) => (
          <Button key={m.id} className={chosen?.id === m.id ? "active" : ""} onClick={() => setPick(m.id)}>
            {m.id} · {mb(m.bytes)}{m.recommended ? " · recommended" : ""}
          </Button>
        ))}
      </div>
      {chosen && <SetNote>{chosen.note}{chosen.installed ? " Already downloaded." : ""}</SetNote>}
      <Button variant="primary" onClick={() => { if (!starting) void start(); }}>
        {starting ? "Starting…" : setup?.state === "failed" ? "Try again" : "Set up on this desktop"}
      </Button>
    </SetCustom>
  );
}
