/**
 * The expiry line for a browser certificate (`welcome.tlsName` / `tlsNameUntil`). The host sends both only
 * to a socket that arrived by that certificate's name; this says something only on that hostname and
 * within `CERT_WARN_DAYS` of the end. A missing, wrong or past value says nothing: the host's doctor and
 * the browser's own error page already speak once it has ended.
 */
import { BRAND } from "@waterplane/shared";

export const CERT_WARN_DAYS = 30;
const DAY_MS = 86_400_000;

export interface CertExpiryFacts { tlsName?: unknown; tlsNameUntil?: unknown }

/** The sentence, or null. `hostname` is `location.hostname`; `now` the phone's clock. */
export function certExpiryLine(facts: CertExpiryFacts | null | undefined, hostname: string, now: number): string | null {
  const name = facts?.tlsName, until = facts?.tlsNameUntil;
  if (typeof name !== "string" || !name || typeof until !== "number" || !Number.isFinite(until)) return null;
  if (hostname.toLowerCase() !== name.toLowerCase()) return null;
  if (until <= now || until - now > CERT_WARN_DAYS * DAY_MS) return null;
  const date = new Date(until).toISOString().slice(0, 10);
  return `This address's certificate ends on ${date}. On the desktop run \`${BRAND.slug} lan-cert issue --name ${name}\`, restart ${BRAND.name} there, then trust the new certificate here.`;
}
