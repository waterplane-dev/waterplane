/**
 * The phone's end of `plugin.call`: a typed client for one plugin's host methods.
 *
 * `call` is a LIVE write-shaped question — never re-sent after the link drops (it may have run).
 * `read` is a question whose repeat is harmless — re-asked after a reconnect with the same id.
 * Both resolve (`{ ok:false, error }` in words), never reject, and neither touches the send queue:
 * a write that must be at-most-once across a host restart goes through `handToAgent`'s `key`.
 */
import type { PluginCallResult, PluginMethods } from "@waterplane/shared";
import { pluginCalls } from "../core/pluginCalls.ts";

export interface PluginClient<M extends PluginMethods> {
  call<K extends keyof M & string>(method: K, args: M[K]["args"]): Promise<PluginCallResult<M[K]["result"]>>;
  read<K extends keyof M & string>(method: K, args: M[K]["args"]): Promise<PluginCallResult<M[K]["result"]>>;
}

export function pluginClient<M extends PluginMethods>(pluginId: string): PluginClient<M> {
  return {
    call: (method, args) => pluginCalls().call(pluginId, method, args, false) as Promise<PluginCallResult<M[typeof method]["result"]>>,
    read: (method, args) => pluginCalls().call(pluginId, method, args, true) as Promise<PluginCallResult<M[typeof method]["result"]>>,
  };
}
