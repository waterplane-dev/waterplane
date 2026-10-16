/**
 * Which `session.mode` switches are on the wire, per session — so the model
 * wheel's mode rows can say "switching…" until `session.moded` answers, and
 * say the host never did when it does not within `MODE_SWITCH_MS`.
 *
 * A module store, not component state: the reply lands seconds later, often
 * after the popover closed, and its toast (the receipt — the refusal is the
 * half that matters) must land either way. `useHostFrames` hands every
 * `session.moded` to `noteModed`.
 */
import { useSyncExternalStore } from "react";
import type { PermissionMode } from "@waterplane/shared";
import { MODE_SWITCH_MS, modedText, modeTimeoutText } from "../../modePick";
import { showToast } from "../../toast";

interface InFlight { mode: PermissionMode; timer: number }

const flying = new Map<string, InFlight>();
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };

/** Mark `id` as switching to `mode`. A second tap replaces the first: the
 *  target is a state, so only the newest ask is the one to wait for. */
export function beginModeSwitch(id: string, mode: PermissionMode): void {
  const prev = flying.get(id);
  if (prev) window.clearTimeout(prev.timer);
  const timer = window.setTimeout(() => {
    if (flying.get(id)?.timer !== timer) return;
    flying.delete(id);
    emit();
    showToast(modeTimeoutText(mode));
  }, MODE_SWITCH_MS);
  flying.set(id, { mode, timer });
  emit();
}

/** The host's answer. Always toasted — a late one after the timeout too, since
 *  it is still the truth about what the footer shows. */
export function noteModed(msg: { id: string; mode?: PermissionMode; reason?: string }): void {
  const f = flying.get(msg.id);
  if (f) { window.clearTimeout(f.timer); flying.delete(msg.id); emit(); }
  showToast(modedText(msg));
}

/** The mode `id` is being switched to right now, or null. */
export function useModeSwitch(id: string): PermissionMode | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => flying.get(id)?.mode ?? null,
  );
}
