# appLock — the fingerprint lock on the Android app

An optional lock on this phone alone: the app asks for the fingerprint (and, on a
shell with `authenticate`, offers the phone's PIN) when it starts, on every reload,
and when the person comes back after more than a minute away. It guards against a
person holding an unlocked phone. Nothing on the desktop changes.

**Owns**

- `store.ts` — `locked`, and `useAppLock()` over it. One writer: `actions.ts`.
- `lockActions.ts` — `appLockAdapter` (`path`, `enable`, `confirm`, `reread`, `forget`),
  `appLockOn()`, the hidden clock (`hiddenAt`, memory only), `prompted()` and `lockRefused()`,
  which applies a refusal's verdict. Under `tokenSealActions.ts` and `actions.ts`, which both run a sheet.
- `actions.ts` — `armAppLock()`, `noteWake()` and `tryUnlock()`.
- `tokenSealActions.ts` — the sealed sign-ins on the phone: the cold-start gate (`armTokenSeal`,
  `tryUnseal`, `openWithoutTokens`), and what the Settings row and other screens call:
  `sealTokens()`, `unsealTokens()` (each a typed `SwitchResult` with the row's `words`),
  `unlockSignIns()`, `rewrapAfterPair()`, `sealLostNote()`.
- `logic.ts` — the same flows over ports, node-tested, with `cardActions`, the words, and every
  count of sheets. `sealGate` in `store.ts` is one writer: `tokenSealActions.ts`.
- `AppLockGate.tsx` — `SealGate`, the card alone before `App` exists; and the wake listeners; while locked, `#root` is `inert`, focus is
  dropped (the keyboard goes with it), Back belongs to the shell (`holdBack`) and
  keys are swallowed. The card is a portal to `body`, because `#root` is inert.
- `LockScreen.tsx` — the card. The sheet opens by itself once, when the app is
  visible; then the *unlock* button re-asks.
- `AppLockSettings.tsx` — Settings › Connection › *lock this app*, native shell only. One authentication each way; the pref is written only after the sheet passed; `lockRowCant` says why it cannot be turned on (never a dimmed switch); a lock that is on always shows its switch.
- `TokenSealSettings.tsx` — Settings › Connection › *lock the desktop sign-ins*, native shell only: the saved desktops under the switch in both states, the cost for them on the confirm card, the receipts. Its words and `sealRowCant` are `src/tokenSealWords.ts` (test beside it).
- Pure half: `src/appLock.ts` — `pickLockPath`, `shouldLockOnWake`, `lockVerdict`,
  `lockWords`. Test: `src/appLock.test.mjs`. The store order: `src/tokenVault.ts`.

**Two paths, by feature detection** (`pickLockPath`, never a version): `authenticate`
is the shell's keyless prompt, plus `lockStatus`. `sentinel` works on an APK without
them: `wrap` random bytes at enable, `unwrap` them at unlock, so the fingerprint
sheet is what guards it. A new enrolment invalidates that key, which is why the
sentinel path can report `keyInvalidated`.

**The sealed sign-ins** are a second switch beside the lock, independent of it, sharing one prompt.
With them on (`LS.tokenSealOn`) the tokens are one Keystore blob on disk and a map in memory
(`deviceToken.ts`), and a cold start goes like this:

| | app lock off | app lock on |
|---|---|---|
| start | the card alone, `App` not mounted, the socket does not dial (tokenless HTTP, the OTA check, still runs) | same |
| the sheet passes | tokens held, app opens. One sheet | same: that sheet was the lock's too |
| `cancelled`, `lockout`, `busy`, `failed`, unknown | stays; *open without the sign-ins* is on the card | stays; no way past |
| `plainRoute`, `noHardware` (any time), `noneEnrolled` the reread does not confirm | stays, with that button | the lock's own sheet runs; passed, the button appears; refused, stays |
| `keyInvalidated`, `noKey`, `badInput`, `noneEnrolled` the reread confirms | seal off, blob set aside in `tokenSealDead`, app opens, toast names the desktops | same, but the app opens UNDER the lock card, which asks by itself |
| blob this build cannot read (`blob-unreadable`) | card says the bytes are kept and to update; only *open without the sign-ins* | *unlock* is the lock's own sheet, then that button. The bytes are never deleted |

*Open without the sign-ins* mounts the app with the blob and the flag as they were: a desktop with
no password works, a gated one shows `AuthGate`'s *unlock the sign-in*. Queued words stay on disk
and flush on the first `onopen`. No keystore at all (a downgrade): no card, the blob stays, a toast.

The card sits in `#root`, not a portal, or `armBootTrap` reads an empty root as a failed boot. A
hard reset keeps every key here (`resetKeys.ts`), so a crash screen in front of the card is no way
past it: the reload locks again.

A pairing while sealed: the token goes to memory and `rewrapNow` adds it with the existing key. If
the blob was not opened this run it opens it first, a second sheet, since a pair code is single
use; refused, the blob is untouched, and the form stays put because the switch's reload would lose
the token. A LAN mint stays in memory and is re-minted next start.

**Wire frames**: none. **Host routes**: none. **Overlay ids**: none: the card is not
a sheet, and `App` must stay mounted under it.

**Storage keys**: `LS.appLock` ("1"/"0") and `LS.appLockBlob` (`{ ct, nonce }`, not
secret), and `LS.tokenSeal`/`LS.tokenSealOn`/`LS.tokenSealDead`/`LS.tokenSealAuth` (`tokenVault.ts`), all `device` scope, never synced,
never in `UI_RESET_KEYS`, all kept by the hard reset.

**Rules that apply**

- **It fails closed, and the seal's rule is not the lock's.** The lock (`lockVerdict`) has nothing
  to lose: a refusal opens the app and turns the switch off for `keyInvalidated`, `noKey` and
  `badInput`, and for `noHardware`/`noneEnrolled` when a fresh read confirms them. The seal
  (`sealVerdict`) holds the only copy of the tokens under a key that lives on the screen lock, not on
  a sensor, so `noHardware` NEVER retires it, confirmed or not (a PIN-only phone reads
  `hardware: false` for ever). `noneEnrolled` retires it only on a new shell's `lockStatus()` with
  neither `enrolled` nor `screenLock`, or on an old APK's `status()` with `hardware: true,
  enrolled: false` (every fingerprint removed, a biometric key's end); `enrolled: false` alone proves
  nothing. `failed` stays at any repeat count: it is the shell's default branch, it includes what a
  wet finger causes, and a dead key an OEM words its own way lands there too (forget, below, is the
  way out). There is no failure counter. A read that disagrees or throws stays, and so does an
  unknown code.
- Anything that opens says what happened and names the way back (ux §1).
- `armAppLock()` runs before the first render, so a locked app paints no frame of itself.
- One prompt, never two, for the lock and the seal at a cold start. A second sheet appears only
  where the first never did.
- *Open without the sign-ins* never gets past the app lock: `cardActions` withholds it and
  `openWithoutTokens` checks again. It never turns sealing off.
- Mounted only in `main.tsx`'s full-mode return: pairing and the passive screen never
  lock. `path()` is null in the demo.
- While one of our sheets is up, visibility is ignored and the away clock does not
  start: below API 30 the PIN screen is a separate activity, and coming back from it
  must not lock. A page still hidden when the sheet settles starts the clock then.

**Stated residuals**

- The page stays mounted behind an opaque card. The recents thumbnail, and the frame
  the WebView shows before the wake's JS runs, are the app's last screen.
- Old APK, a sensor that is really gone or persistently faulty: stays locked, since
  `status()` cannot prove it. The way out is a newer APK or clearing the app's data.

- Old APK on a plain-HTTP LAN route: `unwrap` is sealed there (`nativeKeystore.ts`
  `sealedCall`), so the card stays until the route is the tailnet or HTTPS, and says
  so. `authenticate` uses no key and is not sealed, so a newer shell unlocks anywhere.
- The same APK with the app lock on, the sign-ins sealed and a plain SAVED address: nothing on the
  card would open it, because the lock's own sheet is refused too and leaving the Wi-Fi does not
  change a saved address. Each switch refuses to turn on over a plain saved address (`lockRowCant`,
  the seal row), and the host setup form refuses to save one while old APK + app lock + seal all
  hold (`hostEditGuard.ts`). A plain address that got in some other way (an older build, restored
  storage) is still stranding; the way in is a newer APK or *forget the locked sign-ins*.
- A seal that will not open has one way off, by hand: once a refusal about the seal (not a cancel, a
  lockout, another sheet or a plain route) or an unreadable blob, the row offers *forget the locked
  sign-ins*, behind `Confirm.tsx` and the lock's own sheet when the lock is on. It drops held tokens
  too rather than write plaintext with no key sheet. Sign-ins opened this run take it away.
- `retireSeal` moves the blob to `LS.tokenSealDead` so a wrong verdict destroys nothing, but nothing
  restores it yet, and the next seal's `generate` replaces the key that could open it: the set-aside
  copy is then unreadable for good.
- Nothing dials before the unseal is true of the socket only. Tokenless HTTP leaves first:
  `passiveApi.status()` and the OTA update check run from `Root`'s effects while the card is up.
  No token goes with them.
- A seal made before `tokenSealAuth` existed reads kind null: the words say "if its sheet offers one".
- The sign-ins lost leaves a toast and `sealLostNote()`, memory only: gone at the next start.

**Tests**: `src/appLock.test.mjs` and `logic.test.mjs` cover every decision. The real sheet, lockout,
enrolment changes, and `visibilitychange` on a recents switch need a device.
