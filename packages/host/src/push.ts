/**
 * Web Push (VAPID) so the phone gets notified — even with the app backgrounded
 * or closed — when a session needs a Yes/No, finishes its turn, or a backlog
 * item completes. iOS supports this only for an installed (Add-to-Home-Screen)
 * PWA on 16.4+.
 *
 * Keys and subscriptions persist under <STATE_DIR> so they survive restarts.
 */
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonGuarded, readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";
import webpush, { type PushSubscription } from "web-push";
import { env } from "./env.js";
import { BRAND } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";

export interface PushPayload {
  title: string;
  body: string;
  /** Optional session id to focus when the notification is tapped. */
  sessionId?: string;
  tag?: string;
  /** When set, tapping opens this image straight into the annotator. */
  image?: { repoId: string; relPath: string };
  /** When set, tapping downloads this artifact (outbox file). */
  file?: { repoId: string; relPath: string; name: string; size: number; mtime?: number };
  /**
   * Auto-download: the pull-queue id this notification is about. The service
   * worker treats its presence as "start fetching `file` now" rather than "wait
   * for a tap" — which is the whole point of auto-pull, since the app is
   * normally closed when the artifact lands. The notification still shows.
   */
  pull?: string;
  /** Id of the plugin that posted this; a tap opens that plugin's screen. */
  plugin?: string;
}

export class PushManager {
  private subs: PushSubscription[] = [];
  private keys: { publicKey: string; privateKey: string };
  private subsPath: string;
  private keysPath: string;

  constructor(root: string) {
    const dir = hostStateDir(root);
    this.subsPath = join(dir, "push-subs.json");
    this.keysPath = join(dir, "vapid.json");
    mkdirSync(dir, { recursive: true });

    // Guarded: a truncated vapid.json used to throw out of this constructor and
    // take the whole daemon down at boot. A corrupt file is moved aside
    // (`jsonstore.ts`) and a fresh pair minted — written atomically and 0600,
    // because the private key is a secret.
    const isKeys = (v: unknown): boolean =>
      !!v && typeof (v as { publicKey?: unknown }).publicKey === "string" && typeof (v as { privateKey?: unknown }).privateKey === "string";
    const read = readJsonGuardedDetail<{ publicKey: string; privateKey: string } | null>(this.keysPath, null, isKeys);
    let regenerated = false;
    if (read.value) {
      this.keys = read.value;
      // A key file written before this was 0600 keeps its old, wider mode
      // otherwise; tighten it in place (best effort, never fatal).
      try { if ((statSync(this.keysPath).mode & 0o077) !== 0) chmodSync(this.keysPath, 0o600); } catch { /* best effort */ }
    } else {
      this.keys = webpush.generateVAPIDKeys();
      regenerated = !!read.corrupt;
      try { writeJsonAtomic(this.keysPath, this.keys, { mode: 0o600, space: 2 }); } catch (e) {
        console.error(`[push] could not save VAPID keys (${(e as Error).message}); push works until restart`);
      }
    }
    // Some push services (notably some FCM/APNs-fronting endpoints) reject a
    // non-resolvable VAPID contact like `mailto:waterplane@localhost`. Default to a
    // valid-looking placeholder; override with a real address via env.
    const vapidContact = env("VAPID_CONTACT") || `mailto:${BRAND.slug}@example.com`;
    webpush.setVapidDetails(vapidContact, this.keys.publicKey, this.keys.privateKey);

    this.subs = readJsonGuarded<PushSubscription[]>(this.subsPath, [], Array.isArray);
    if (regenerated && this.subs.length) {
      // Every stored subscription was made against the LOST public key and can
      // never be delivered to again; each phone re-subscribes when it next opens.
      console.error(`[push] VAPID keys were regenerated; dropping ${this.subs.length} subscription(s) bound to the old key`);
      this.subs = [];
      this.save();
    }
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  subscribe(sub: PushSubscription): void {
    if (!sub?.endpoint) return;
    if (this.subs.some((s) => s.endpoint === sub.endpoint)) return;
    this.subs.push(sub);
    this.save();
  }

  unsubscribe(endpoint: string): void {
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    this.save();
  }

  async notify(payload: PushPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const dead: string[] = [];
    await Promise.all(
      this.subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, body);
        } catch (err: any) {
          // 404/410 ⇒ subscription gone; drop it.
          if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(sub.endpoint);
        }
      }),
    );
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.endpoint));
      this.save();
    }
  }

  private save(): void {
    try { writeJsonAtomic(this.subsPath, this.subs, { space: 2 }); } catch { /* non-fatal */ }
  }
}
