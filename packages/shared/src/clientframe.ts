import type { ClientMessage } from "./wire/messages.js";

/**
 * Is this decoded value shaped like a client frame at all: a non-null,
 * non-array object with a string `t`? The ONE check the host makes on a
 * WebSocket frame before dispatch — `decode` is a cast, and `null`, a string
 * or `{}` off the socket used to throw at `msg.t`.
 *
 * It deliberately does NOT check that `t` is a type this end knows: an unknown
 * `t` is a versioned no-op (`routes/index.ts`), never an error, and each
 * handler still validates its own fields.
 */
export function isClientFrame(x: unknown): x is ClientMessage {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    && typeof (x as { t?: unknown }).t === "string";
}
