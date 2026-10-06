# hosts

Several desktops on one phone (Android shell only). Storage, parking and the boot-time switch are
`../../hosts.ts` + `../../hostBoot.ts`; which keys follow the host and which the phone is
`storage.ts`'s `KEY_SCOPE`. This folder is the screens over it.

**Owns**

- `store.ts` — `hosts` (the saved list + active id, re-read after every verb), `view` (the sheet's
  list / add / edit), `route` (how the active host is reached — `null` until the LAN runtime writes
  it through `setHostRoute`). Written only by `actions.ts`.
- Sheet `hosts` (`HostSwitcherSheet.tsx`, not persisted): one row per desktop, the active one marked,
  a tap on any other switches (park, reload, restore at boot). Add and edit reuse `HostSetup.tsx`'s
  form (name, tailnet address, optional LAN address + Wi-Fi names + the "switch to LAN
  automatically" switch, off by default). Remove asks through `Confirm.tsx` and states what STAYS:
  the drafts, pad notes and queued prompts parked under that host are never deleted, and re-adding
  the same address brings them back (`hostsGone`). Removing the host in use switches first.
- **The demo is a row** (`hosts.ts` `DEMO_HOST_ID`, `demoEntry.ts`): entering parks the real host's keys like any switch and leaving
  gives them back; the switcher draws it as "Demo · in use / leave" and a "Try the demo" button when it is absent. Never listed,
  edited or removed like a desktop. Settings has one row: `demo`.
- `HostMenuItem.tsx` — the launcher menu's host row in the shell: host name (+ route once set),
  a tap opens the switcher. Not in the topbar: a long name took the whole bar.
- `HostNameTag.tsx` — the session header's host name, only when more than one host is saved.
- Sheet `pairqr` (`HostQrSheet.tsx`, not persisted): "pair another phone". Mints a single-use code
  on the host IN USE (`POST /api/pair/mint`), draws the landing URL as an inline-SVG QR
  (`qrcode-generator`, dark on `--paper` in both themes), the code as `ABCD-EFGH`, a countdown from
  when this phone got it (never the host's clock) and a "new code" verb once it is spent, plus the
  sentence that the new phone needs Tailscale on the same tailnet (link via `openExternal.ts`).
  Opened from the ACTIVE row of the switcher (QR icon) and from Settings — in the browser PWA too.
  In a browser on Android (never in the shell) it leads with "open the app on this phone": the
  minted `deepLink`, so the app on the same phone opens prefilled — still one tap on "pair" there.
  Laid out as cards (`.pair-*` in styles.css): this phone, then "or on another phone" with the QR,
  the code and its countdown, then the copy rows. A link-filled pair form (`PairForm`) opens as one
  question — this desktop, this code, pair? — with "change address or code" for the fields.
- **Adding a desktop** (`../../HostSetup.tsx` in `add` mode, `../../FoundDesktops.tsx`,
  `../../hostDiscover.ts`): "found on your tailnet" rows from `GET /api/tailnet/peers` on the host
  in use (`host/tailnetpeers.ts`: `tailscale status --json`, online peers probed on `/api/health`,
  loopback/Tailscale callers only). A tap probes the address FROM THIS PHONE, then adds + switches
  (`addAndActivate`); a desktop with a password opens the pair form on its address and says to run
  `<slug> pair` there. The typed address stays the fallback. `HostQrSheet` also shows the link and
  the code as selectable text with Copy and (when `navigator.share` exists) Share
  (`../../PairCopyRows.tsx`, `../../pairShare.ts`); no secure context ⇒ a sentence, never a grey.
- Sheet `devices` (`PairedDevicesSheet.tsx`, not persisted): the host's device ledger
  (`GET /api/devices`) — name, paired date, last seen, route, "this phone" — and revoke through
  `askConfirm` (`POST /api/devices/revoke`); revoking this phone is allowed and says it signs this
  phone out (its own token is dropped too). No password ⇒ a sentence, never a greyed control.
- View `pair` of the switcher: "pair with code" prefilled from a `waterplane://pair` link
  (`askPairFromLink`, registered in the manifest's `boot` via `shellLink.onShellPair`). It only
  ASKS: the form names the address and nothing is sent until "pair". Before any host exists,
  `main.tsx`'s setup screen takes the link instead. The form and the redeem are `../../PairForm.tsx`
  + `../../pairRedeem.ts` (token + LAN identity stored bare for the active host, parked for another).
- `HostsSettings.tsx` — Connection, order -20: the `hosts` row (shell only), which replaced "paired
  host", then `pair-phone` and `paired-devices` (shell and browser).
- `logic.ts` — `countHostWords`, `wordsText`, `removeLines`, `hostAddress`, `showHostName`,
  `hostRows`, and for pairing `qrPath`, `codeLeftText`, `deviceRouteText`, `seenAgo`,
  `revokeLines`, `devicesEmptyText`; node-tested in `logic.test.mjs`.

**Reads from core**: `nav.open/close`, `conn.info.lanIps` (LAN address suggestions for the active
host), `conn.info.auth.enabled` (whether the ledger can have rows), `say.toast/track`.

- `openEditActiveHost` — the active host's edit form, registered at boot (shell only) as
  `hostRoute.hostRouteEditor` so Connection health's *Link right now* sentence carries a
  "change LAN settings" button; no editor registered (browser) ⇒ no button.

**Rules**: nothing greyed — a verb a row cannot do is not drawn; `askConfirm`, never
`window.confirm`; lucide icons only. Seams: `setHostRoute` (written by `lanLink.ts`, the LAN runtime). A pairing link
never redeems by itself — any app can fire it.
