/**
 * The real `plugin.call` channel: `createPluginCalls` (`pluginCall.ts`, pure) wired to the one socket,
 * `newAckId` and `setTimeout`. Lazy, because nothing here may run before App has bound the core.
 */
import { newAckId } from "../outbox.ts";
import { core } from "./api.ts";
import { createPluginCalls, type PluginCalls } from "./pluginCall.ts";

let calls: PluginCalls | null = null;
export function pluginCalls(): PluginCalls {
  return (calls ??= createPluginCalls({
    status: () => core().conn.status,
    trySend: (f) => core().conn.trySend(f),
    mintId: newAckId,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }));
}
