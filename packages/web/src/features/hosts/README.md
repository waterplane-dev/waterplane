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
- **A switch that runs out of room says so.** A park copies every host key before removing any, so
  it needs the host's words' size again in free localStorage. A `QuotaExceededError` before the
  commit abandons the switch at boot (`hosts.ts` `settleFullSwitch`: marker dropped, half-written
  park copies removed) and the manifest's `boot` toasts `switchFailText` — "Still on <old>" — once.
  Any other throw keeps the marker for the redo. The page dials the ACTIVE ROW's address
  (`hostUrl.ts` `pickSavedBase`), never a `hostBase` a throw left behind, so the header can never
  name one desktop while the requests go to another (2026-11-01).
- `HostMenuItem.tsx` — the launcher menu's host row in the shell: host name (+ route once set),
  a tap opens the switcher. Not in the topbar: a long name took the whole bar.
- `HostSwitchKey.tsx` — the launcher bar's SPLIT host key, last on the bar, only with two or more
  of the person's own desktops (demo excluded): the wide half toggles straight to the next one
  (`nextHostId`: two flip, three go round — park + reload like the switcher), showing a swap glyph
  over the in-use host's ≤6-char name (`shortHostName`); the chevron opens the switcher. Sized to fit
  beside the cog — the word + icon version wrapped onto its own row.
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
  A desktop with both a tailnet and a LAN address offers *no Tailscale on it? show the Wi-Fi QR*: the QR and
  copy rows then hold `lanDeepLink` (a landing URL is unreachable from that phone, and never exists for the LAN).
  A desktop with no tailnet draws the deep link instead of the landing URL (`pairLinkOf`): its
  landing URL is a plain address, and the host burns a code that arrives that way.
- **Adding a desktop** (`../../HostSetup.tsx` in `add` mode, `../../FoundDesktops.tsx`,
  `../../hostDiscover.ts`): "found on your tailnet" rows from `GET /api/tailnet/peers` on the host
  in use (`host/tailnetpeers.ts`: `tailscale status --json`, online peers probed on `/api/health`,
  loopback/Tailscale callers only). A tap probes the address FROM THIS PHONE, then adds + switches
  (`addAndActivate`); a desktop with a password opens the pair form on its address and says to run
  `<slug> pair` there. The typed address stays the fallback. `HostQrSheet` also shows the link and
  the code as selectable text with Copy and (when `navigator.share` exists) Share
  (`../../PairCopyRows.tsx`, `../../pairShare.ts`); no secure context ⇒ a sentence, never a grey.
- **A desktop's encrypted link** (`../../lanLink.ts`, `../../lanRoute.ts`): the Wi-Fi address is typed
  PLAIN (`192.168.0.64` or `http://192.168.0.64:8770`); with a pin the app dials `https://<ip>:8771`
  itself. A typed `https://` bare IP is dialled as written and never matched to the pin, so the screen
  offers "use <ip>" (`hostTestWords.ts` `lanHttpsFix`); an `https` name is left alone. Each row says
  "Encrypted on port 8771", "Not encrypted yet" (the key is learned over Tailscale) or that an old APK
  cannot. A row with a pin on a
  shell that enforces it carries *use plain HTTP* (the shield, `askPlainHttp`), reachable with no
  connection. It sets `tlsOff` and removes the pin, only on a person's tap and through `Confirm.tsx`;
  with a recorded refusal at that address the question leads with the changed key and offers *pair
  by code* first (`pairHostByCode`, the pair form on the row's own address, or its `lan.base` with
  Tailscale known off, the code typed). Paired there with no route left, the form's receipt says so
  and offers *change LAN settings* (`pairedNoRoute`, drawn by `HostSetup`); no setting moves by itself. A row
  on plain HTTP says so and offers the same pairing, which is the only way back. So does the row in
  use while the route reports `trouble`. Pins are keyed by the ROW's id, and `syncShellPins` drops
  one whose row went.
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
  host", then `web-desktops` (browser only: how a second desktop or phone is reached with no app —
  one address each, no code on the tailnet; the README's table says the same), then `pair-phone` and
  `paired-devices` (shell and browser). The QR sheet's foot says the no-app route too.
- **Waiting elsewhere** (R-connection-030): a card on a desktop the phone is NOT switched to (a vault
  approval above all) used to time out unseen. `startElsewherePoll` (`actions.ts`, from the manifest
  `boot`: shell only, two or more of the person's own desktops, never the demo or a passive device)
  asks each OTHER saved desktop `GET /api/attention` (`shared/waiting.ts`, `api.waitingAt`) every 45 s
  while the app is visible, at once on visibility/focus/shell nudge, one desktop after another; a
  failing one backs off to 5 min. The token sent is THAT desktop's parked one, only to its saved
  tailnet origin (`deviceToken.ts` `bearerForSaved`: never its LAN address, never another origin).
  Reads live in the memory-only `elsewhere` store. `ElsewhereChip.tsx` sits beside `HostSwitchKey`
  ("zenbo… · 1 waiting", "2 desktops · 3 waiting", or "… · signed out" on a 401); a tap opens sheet
  `elsewhere` (`ElsewhereSheet.tsx`, not persisted) on exactly the rows `elsewhereRows` counted: one
  card per desktop with "switch to <name>", and each waiting item a row whose tap switches AND lands
  on it — `switchHost(id, open)` writes `LS.hostOpenAfter` beside the switch marker, the next boot
  drains it once (`takeOpenAfter`, only for the desktop switched to) into `window.shellOpen`. The note is a strict allow-list: a session id, `plugin:<id>`, `notif:<json>` (a whole alert, must parse) or `view:notifications` (a multi-item summary lands on the notification list). A
  number is shown only from a read ≤ 90 s old; a desktop that stopped answering says so with its
  last answer's age and no number; one never read is absent. One toast when a desktop's total rises
  (never on its first read). Nothing switches or answers by itself. Gap: with the app off screen
  for over five minutes the WebView is frozen — the APK's native link (stage 2) is what covers that.
- `logic.ts` — `countHostWords`, `wordsText`, `removeLines`, `hostAddress`, `showHostName`,
  `hostRows`, `shortHostName`, `nextHostId`, and for pairing `qrPath`, `codeLeftText`, `deviceRouteText`, `seenAgo`,
  `revokeLines`, `devicesEmptyText`, and for waiting elsewhere `elsewhereRows`, `elsewhereTotal`,
  `elsewhereChipText`, `elsewhereRowText`, `elsewhereSaidText`, `nextRead`, `nextAskIn`; node-tested in `logic.test.mjs`.

**Reads from core**: `nav.open/close`, `conn.info.lanIps` (LAN address suggestions for the active
host), `conn.info.auth.enabled` (whether the ledger can have rows), `say.toast/track`.

- `openEditActiveHost` — the active host's edit form, registered at boot (shell only) as
  `hostRoute.hostRouteEditor` so Connection health's *Link right now* sentence carries a
  "change LAN settings" button; no editor registered (browser) ⇒ no button.

**Rules**: nothing greyed — a verb a row cannot do is not drawn; `askConfirm`, never
`window.confirm`; lucide icons only. Seams: `setHostRoute` (written by `lanLink.ts`, the LAN runtime). A pairing link
never redeems by itself — any app can fire it.
