/**
 * The WSL half of the preflight — pure, so every verdict is testable from
 * injected facts and nothing here reads the real machine.
 *
 * WSL2 is a Linux VM, and four things that are free on macOS and plain Linux
 * are not free there: the VM has its own network (no Tailscale IP unless
 * mirrored networking or an in-distro Tailscale), it only runs systemd when
 * asked, it is shut down when idle, and `/mnt/c` is the Windows disk behind a
 * slow, watch-less bridge. The worst of them is invisible: a Windows `claude`
 * picked up through the PATH interop spawns, then fails in ways that look like
 * the app's. `doctor.ts` collects the facts and calls `wslChecks`; the probe
 * that asks Windows for a keep-alive task is injected into `findKeepTask`.
 * Also the Windows side's own pieces: the launcher's task names
 * (`launcherTaskName`) and the one row native win32 gets (`nativeWindowsCheck`).
 */
import { BRAND, envName } from "@waterplane/shared";
import type { Check } from "./doctor.js";

/** Facts about the machine, injected. Anything unreadable is null. */
export interface WslFacts {
  /** Contents of `/proc/version`. */
  procVersion: string | null;
  /** `os.release()`. */
  release: string;
  /** Contents of `/proc/1/comm`. */
  pid1Comm: string | null;
  tailscaleIp: string | null;
  /** The configured repo root. */
  root: string;
  /** Where `claude` resolved to, null if it did not. */
  claudePath: string | null;
  /**
   * The Windows scheduled task found holding WSL up (`keepTaskNames`), null when Windows said
   * none of them exists, undefined when Windows could not be asked (interop off, timeout).
   */
  keepTask?: string | null;
  /** The command that registers that task for THIS install — `keepAliveCommand`. */
  keepAliveCmd: string;
  /**
   * Can Windows programs be run from inside WSL (`interopFromProbe`)? Absent or "unknown" ⇒ no
   * `wsl-interop` row: not knowing is never a verdict.
   */
  interop?: Interop;
}

export type Interop = "ok" | "off" | "unknown";

/** The Windows program the interop probe EXECUTES (`cmd.exe /d /c exit 0`) — by its path, so a Windows PATH WSL did not append cannot hide it. */
export const INTEROP_PROBE = "/mnt/c/Windows/System32/cmd.exe";

/**
 * What running `INTEROP_PROBE` says about interop. Measured on the owner's box (2026-10-09): with
 * interop gone from the running distro, every `.exe` dies with "Exec format error" — the kernel no
 * longer knows how to run a PE file. So that (ENOEXEC from the spawn, exit 126 from a shell
 * fallback, or the words) is "off"; success is "ok"; no file (ENOENT: no `/mnt/c`, automount off)
 * and anything else (a timeout) is "unknown". Never read off `/proc/sys/fs/binfmt_misc/WSLInterop`:
 * newer WSL registers `WSLInterop-late` instead, so its absence proves nothing.
 */
export function interopFromProbe(r: { ok: true } | { code?: unknown; message?: unknown; stderr?: unknown }): Interop {
  if ("ok" in r) return "ok";
  if (r.code === "ENOEXEC" || r.code === 126) return "off";
  if (/exec format error/i.test(`${String(r.message ?? "")}\n${String(r.stderr ?? "")}`)) return "off";
  return "unknown";
}

/**
 * The scheduled task the Windows launcher's `autostart` registers, per install kind. A checkout
 * keeps the name it always had (a box that registered it needs no migration); an npm install
 * gets its own, so the two on one machine never replace each other's task. Two CHECKOUTS on one
 * machine still share one name — the second `autostart` takes the task over.
 */
export function launcherTaskName(kind: "checkout" | "npm"): string {
  return kind === "npm" ? `${BRAND.slug}-host-npm` : `${BRAND.slug}-host`;
}

/**
 * The task names that count as keeping WSL up: the two the Windows launcher's `autostart`
 * registers (checkout, npm), and the two `service install` prints for a person to create by hand.
 */
export function keepTaskNames(): string[] {
  return [launcherTaskName("checkout"), launcherTaskName("npm"), BRAND.name, `${BRAND.name} keepalive`];
}

/**
 * How to register a keep-alive task for the install the host runs from: a Windows checkout
 * or a Windows npm install (`root` on a Windows drive) has the launcher's `autostart`, run
 * in PowerShell; an install inside the distro has `service install`, which prints the
 * Windows line itself.
 */
export function keepAliveCommand(kind: string, root: string): string {
  if (onWindowsDrive(root) && kind === "checkout") return "`node scripts/windows/host.mjs autostart` in PowerShell, in the checkout";
  if (onWindowsDrive(root) && kind === "npm") return `\`${BRAND.slug} autostart\` in PowerShell`;
  return `\`${BRAND.slug} service install\` inside WSL, then the Windows task it prints`;
}

/**
 * Which keep-alive task Windows says exists, asked through `ask` (doctor.ts: `schtasks /query
 * /tn` through interop, by name then by its full path). A "yes" names the task; every name
 * "no" is null; any other outcome — no interop, `schtasks.exe` off PATH, a timeout — is
 * "could not ask" (undefined), never "none".
 */
export async function findKeepTask(ask: (bin: string, name: string) => Promise<"yes" | "no" | "unknown">): Promise<string | null | undefined> {
  const names = keepTaskNames();
  for (const bin of ["schtasks.exe", "/mnt/c/Windows/System32/schtasks.exe"]) {
    const answers = await Promise.all(names.map((n) => ask(bin, n)));
    const hit = answers.indexOf("yes");
    if (hit !== -1) return names[hit];
    if (answers.every((a) => a === "no")) return null;
  }
  return undefined;
}

/**
 * Native Windows (cmd, PowerShell, Git Bash — `process.platform` is `win32`; WSL reports `linux`)
 * runs no session at all: there is no tmux. Every other row would then be about the Windows side
 * — its missing `claude`, git and curl — and a person fixes those for nothing. So on win32 this
 * is the WHOLE report: one failure that names the route that works — the Windows launcher
 * (`cli/windows.ts`: `<slug> …` for an npm install, `scripts/windows/host.mjs` in a checkout),
 * which runs the host in WSL (and which `npm run doctor` on Windows goes through, so only a direct
 * `node …/main.js --doctor` lands here). Here, not in `doctor.ts`: it is the Windows half of the
 * preflight, and as pure as the rest of this file.
 */
export function nativeWindowsCheck(platform: NodeJS.Platform): Check | null {
  if (platform !== "win32") return null;
  return {
    id: "platform",
    status: "fail",
    detail: "native Windows cannot run the host — it runs inside WSL2 (sessions need tmux, which has no Windows build)",
    fix: `Installed with npm: \`${BRAND.slug} setup\`, then \`${BRAND.slug} start\` — they run the host in WSL from the same install. ` +
      "From a checkout in PowerShell: `node scripts/windows/host.mjs setup`, then `npm run restart` and `npm run doctor`. " +
      "Either way WSL needs a distro first (`wsl --install -d Ubuntu-24.04` in an admin PowerShell, once). " +
      "Or clone inside WSL (`~/dev`, faster than `/mnt/c`) and follow the Linux steps there.",
  };
}

/** Running under WSL: the kernel says "microsoft" or "WSL" in either place. */
export function isWsl(procVersion: string | null, release: string): boolean {
  return /microsoft|wsl/i.test(`${procVersion ?? ""}\n${release}`);
}

/** Under a Windows drive mount (`/mnt/c`, `/mnt/d/…`) — a letter, not `/mnt/wsl`. */
export function onWindowsDrive(p: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(p);
}

/** PID 1 is systemd, which is what a user-level background service needs. */
export function pid1IsSystemd(comm: string | null): boolean {
  return (comm ?? "").trim() === "systemd";
}

/** Every WSL check, in report order. Empty when not running under WSL. */
export function wslChecks(f: WslFacts): Check[] {
  if (!isWsl(f.procVersion, f.release)) return [];
  const out: Check[] = [];

  const interopOff = f.interop === "off";
  // The IP is read off the interfaces, which interop does not touch; the Windows `tailscale.exe`
  // (MagicDNS name, serve URL) is EXECUTED, which it does. With interop off the row says so instead
  // of sending a person to edit a .wslconfig that may well be right.
  out.push(f.tailscaleIp
    ? {
        id: "wsl-tailscale", status: "ok",
        detail: `Tailscale IP ${f.tailscaleIp} is visible inside WSL`
          + (interopOff ? " — but the Windows tailscale.exe cannot be run with interop off, so its MagicDNS name and serve link are unknown here (wsl-interop)" : ""),
      }
    : interopOff
      ? {
          id: "wsl-tailscale",
          status: "warn",
          detail: "no Tailscale IP is visible inside WSL, and WSL interop is off (wsl-interop) — the phone cannot reach this host",
          fix: "Fix interop first: `wsl --shutdown` in Windows also re-reads %UserProfile%\\.wslconfig. Run the doctor again then; only an IP still missing after that is a networking setting.",
        }
      : {
          id: "wsl-tailscale",
          status: "warn",
          detail: "no Tailscale IP is visible inside WSL — the phone cannot reach this host",
          fix: "Either enable WSL mirrored networking (Windows 11 22H2+): put `[wsl2]` and `networkingMode=mirrored` on two lines in "
            + "%UserProfile%\\.wslconfig, then run `wsl --shutdown` in Windows — or install Tailscale inside this WSL distro and sign in.",
        });

  out.push(pid1IsSystemd(f.pid1Comm)
    ? { id: "wsl-systemd", status: "ok", detail: "systemd is running (PID 1)" }
    : {
        id: "wsl-systemd",
        status: "warn",
        detail: `PID 1 is ${(f.pid1Comm ?? "").trim() || "unknown"}, not systemd — the background service cannot be registered`,
        fix: "Add `[boot]` and `systemd=true` on two lines to /etc/wsl.conf, then run `wsl --shutdown` in Windows and reopen the distro.",
      });

  if (f.interop === "ok") out.push({ id: "wsl-interop", status: "ok", detail: "WSL interop is on — Windows programs run from inside WSL" });
  else if (interopOff) {
    out.push({
      id: "wsl-interop",
      status: "warn",
      detail: "WSL interop is off — no Windows program runs from inside WSL (\"Exec format error\"). Lost with it: the Windows Tailscale CLI "
        + "(MagicDNS name and the `tailscale serve` URL — the phone's HTTPS link), the keep-alive task check below, a phone-driven "
        + "`npm run restart` of a /mnt/<drive> checkout, and copying the git identity from Git for Windows in setup",
      fix: "From Windows: `wsl --shutdown` (EVERY WSL session stops, the host with it; the autostart task or `npm run restart` brings the host back) — "
        + "or, as root inside this distro, without stopping anything: `sudo sh -c 'echo :WSLInterop:M::MZ::/init:PF > /proc/sys/fs/binfmt_misc/register'`.",
    });
  }

  out.push(f.keepTask
    // Only the task's EXISTENCE is asked — not whether it is enabled, nor which install it starts — so the sentence says no more.
    ? { id: "wsl-idle", status: "ok", detail: `a Windows task named "${f.keepTask}" exists to keep WSL, and the host with it, up` }
    : {
        id: "wsl-idle",
        status: "warn",
        detail: "WSL shuts its VM down when idle — the host and every session stop with it"
          + (f.keepTask === null ? "; no Windows task keeps it up"
            : interopOff ? "; Windows could not be asked whether a task keeps it up, because WSL interop is off (wsl-interop)"
            : "; Windows could not be asked whether a task keeps it up"),
        fix: `Register one: ${f.keepAliveCmd}. `
          + "Or set a long/disabled `vmIdleTimeout` under `[wsl2]` in %UserProfile%\\.wslconfig (see Microsoft's .wslconfig docs for the value your Windows build accepts).",
      });

  if (onWindowsDrive(f.root)) {
    out.push({
      id: "wsl-root",
      status: "warn",
      detail: `${envName("ROOT")} ${f.root} is on a Windows drive — file access is slow and file watching is unreliable`,
      fix: `Keep your repos inside the Linux filesystem (e.g. ~/dev) and point ${envName("ROOT")} there.`,
    });
  } else {
    out.push({ id: "wsl-root", status: "ok", detail: `${f.root} is on the Linux filesystem` });
  }

  if (f.claudePath && onWindowsDrive(f.claudePath)) {
    out.push({
      id: "wsl-claude",
      status: "fail",
      detail: `claude resolves to ${f.claudePath} — the Windows binary, which cannot drive a Linux PTY`,
      fix: "Install Claude Code inside WSL (https://docs.anthropic.com/en/docs/claude-code) so a Linux `claude` comes first on PATH.",
    });
  } else if (f.claudePath) {
    out.push({ id: "wsl-claude", status: "ok", detail: `claude is the Linux binary (${f.claudePath})` });
  }
  return out;
}
