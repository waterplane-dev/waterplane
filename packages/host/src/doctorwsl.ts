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
 * the app's. `doctor.ts` collects the facts and calls `wslChecks`.
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

  out.push(f.tailscaleIp
    ? { id: "wsl-tailscale", status: "ok", detail: `Tailscale IP ${f.tailscaleIp} is visible inside WSL` }
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

  out.push({
    id: "wsl-idle",
    status: "warn",
    detail: "WSL shuts its VM down when idle — the host and every session stop with it",
    fix: `Keep it alive with a Windows startup task running \`wsl.exe -d $WSL_DISTRO_NAME -e ${BRAND.slug}-host start\`, `
      + "or set a long/disabled `vmIdleTimeout` under `[wsl2]` in %UserProfile%\\.wslconfig (see Microsoft's .wslconfig docs for the value your Windows build accepts).",
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
