# hostTools

Things about the desktop and the link rather than about a session: the host's CPU/memory load
(toolbar `cpu`), a desktop screenshot straight into the annotator (toolbar `shot`), the sign-in
code paste (the login bar — deliberately the RAW, undurable path), the two alert switches (Web Push
on this document, the APK's background link) and the ways to reach this host (`serveCmd`,
`endpoints`).

**Owns**

- `store.ts` — `push` (`PushStatus`) and `shellLink` (`ShellLinkStatus | null`, null wherever the
  link cannot exist), written only by `actions.ts`; read by `useHostPush()` / `useShellLink()`.
- Commands `cpu`, `shot`. No sheets, no wire frames of its own (`session.input` for the code goes
  through `core().conn.liveSend`).
- `boot`: the first `pushStatus()`. `useShellLinkPoll(on)` reads the link whenever
  `on` changes and polls it every 3 s while `on` is true; `HostNotifySettings` calls it with
  `true`, so the link is read exactly while the Settings rows are on screen (the only place it is
  drawn), and not at all elsewhere.
- `logic.ts` — `hostStatText`, `serveCmd`, `endpoints`, `loginCodeProblem`, node-tested.

**Settings rows** (`HostSettings.tsx`): `HostNotifySettings` (Notifications, order 20 —
`notif-push`, `notif-shell-link`, `notif-shell-battery`) and `HostConnectionSettings` (Connection,
order -10 — `app-version`, `endpoints`; the host list itself is `features/hosts`' `hosts` row at -20). The two doors
`tool-host-stat` and `tool-screenshot` sit mid-rack in the core sheet, which calls `showHostStat`
and `takeShot` from this index.

**Reads from core**: `conn.liveSend`/`send`, `conn.info` (the tailnet name `serveCmd` and
`endpoints` are built from), `nav.open`, `world.activeRepo`, `files.annotateUrl` (the screenshot
lands in the annotator), `say`.
