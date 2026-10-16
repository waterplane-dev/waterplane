/**
 * The passive-device calls (`passiveMode.ts`, host `passive.ts`). Status and
 * state are background reads — the passive screen polls them, and a poll must
 * not blink the activity bar; unlock, lock and the PIN are taps.
 */
import type { PassiveAuthFields, PassiveStateResponse, PassiveUnlockResponse } from "@waterplane/shared";
import { bgJson } from "./api";
import { jpost, jpostOk } from "./webapi/webapiFetch";

export const passiveApi = {
  status: () => bgJson<PassiveAuthFields & { authed?: boolean }>("/api/auth/status"),
  state: () => bgJson<PassiveStateResponse>("/api/passive/state"),
  unlock: (pin: string) => jpost<PassiveUnlockResponse>("/api/auth/unlock", { pin }),
  lock: () => jpostOk<{ ok: boolean; locked: boolean }>("/api/auth/lock", {}),
  setPin: (pin: string | null) => jpostOk<{ ok: boolean; pinSet: boolean }>("/api/auth/pin", { pin }),
};
