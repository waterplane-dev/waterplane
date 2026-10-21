/**
 * The masked-field fillers (`SecretFillerDef`, a stored login) for an extension that draws a masked
 * field of its OWN — the live desktop's protected typing — so it offers the same buttons as the
 * compose bar's masked field, from whichever extensions contribute them, naming none.
 *
 * Bound by `core/extensionPoints.ts`, the one registry reader, rather than imported here: the registry
 * imports every extension and every extension imports this SDK (the cycle `ledgers.ts` explains).
 */
import type { SecretFillContext, SecretFillerEntry } from "./types.ts";

let source: (ctx: SecretFillContext) => SecretFillerEntry[] = () => [];

/** `core/extensionPoints.ts`'s, once. */
export function bindSecretFillers(s: (ctx: SecretFillContext) => SecretFillerEntry[]): void {
  source = s;
}

/** The buttons for this masked field's ask, order then registry order; [] where none is installed. */
export const secretFillers = (ctx: SecretFillContext): SecretFillerEntry[] => source(ctx);
