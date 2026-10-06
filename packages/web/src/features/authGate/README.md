# authGate — the LAN password gate

When the daemon runs with `WATERPLANE_ALLOW_PUBLIC=1`, a device on the LAN (or on
Tailscale, if `gateTailscale` is on) must present a password before the host
lets its socket in (`host/auth.ts`, SECURITY.md). The host answers such a
connection with `authRequired` and closes it; this feature is the full-screen
"Locked" card that takes over until the password is accepted.

**Owns**

- `store.ts` — `gate`: `{ enabled, kind } | null`, and `useAuthGate()` over it.
  One writer: the `authRequired` handler sets it, the next `welcome` clears it,
  and `unlocked()` (`actions.ts`) clears it the moment `POST /api/auth/login`
  says ok (before the reconnect's welcome lands).
- `AuthGate.tsx` — the card. The password field, its error and its busy flag are
  the component's own `useState` (nothing else reads them). `enabled: false`
  means the host is gated with no password set yet: the card says where to set
  one and offers *retry* instead of a field.

**Wire frames**: `authRequired` (sets), `welcome` (clears). `auth.state` and
`welcome.auth` — the Settings → LAN access section's `authState` — stay in App,
as does the new-password field (`lanPw`): that is settings, not the gate.

**Overlay ids**: none. The gate is not a sheet — App returns it early, before
the overlay table, because nothing behind it may render:
`if (authGate) return <AuthGate reconnect={() => connRef.current.reconnect()} />`.
`reconnect` is a prop because the CoreApi has no reconnect verb; it is the ONE
socket's own, re-dialled.

**Storage keys**: none. The cookie the login sets is the host's.

**Rules that apply**: LAN can never SET the password (the host refuses it);
deny-until-set. Icons are `lucide-react`. The unlock button is never greyed out:
with the field empty a tap SAYS "type the password first", and while a login is
in flight its label reads "checking…" and a second tap does nothing.

**Tests**: no pure logic here, so no unit test. No e2e script boots a host with
`WATERPLANE_ALLOW_PUBLIC=1` and drives this card today; the host side of the gate is
`host/auth.ts`'s.
