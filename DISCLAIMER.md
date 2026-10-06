# Disclaimer

Read this before you run waterplane, and before you point it at anything you care about.

waterplane is a tool for driving a coding agent on your own desktop from your own phone. It is not a
managed service, it has no operator, and nobody is monitoring it on your behalf. Everything below is
a consequence of what it does, not a legal formality bolted on afterwards.

**Nothing here is legal advice, and none of it is a warranty.** waterplane is provided as-is, without
warranty of any kind, express or implied. You run it at your own risk and you are responsible for
what it does on your machines and to your data.

---

## 1. It executes arbitrary code, by design

The waterplane host daemon spawns a coding-agent CLI (`claude`, `opencode`) in a pseudo-terminal and types
into it. That agent reads, writes and deletes files, runs shell commands, and installs things. That
is the entire point of the product — it is not a bug and it cannot be sandboxed away without
removing the feature.

The practical consequence: **anything that can reach the daemon's port can run arbitrary code as
your user.** There is no permission model between the network and the shell strong enough to change
that sentence.

- The daemon binds a Tailscale address or loopback by default, and **must not be bound to a public
  interface.** See [`SECURITY.md`](SECURITY.md) for the full boundary, the origin checks, and the
  LAN password gate.
- Network identity is the boundary. If your Tailnet is compromised, so is the machine running waterplane.
- Exposing the port through a reverse proxy, a tunnel, a port-forward or a cloud shell is a decision
  to let whoever reaches it run commands on your desktop.

## 2. Your prompts and your code leave the machine when you choose a hosted model

waterplane can drive a local model (one running on your own hardware) or a hosted one (one running on
somebody else's servers). The picker labels which is which **where the desktop can tell** — when it
cannot determine a provider's locality it says nothing rather than guessing, and the list is
unlabelled. This is why the distinction matters:

**With a hosted model, the prompt and the contents of every file the agent reads into it are
transmitted to that operator and processed on their hardware, under their terms — not waterplane's.**

That includes source code, configuration, logs, screenshots, and anything else the agent opens while
working. An agent decides what to read on its own; you do not get to review the list first.

waterplane deliberately **does not restate any operator's data policy.** Those terms change without
notice, and an application that has baked one in will eventually assert, in its own voice, something
untrue about data that has already been sent. Go and read the terms of the provider you select.

**Free tiers are not free of cost.** A no-charge coding tier is commonly paid for with data:
providers of such tiers frequently retain prompts and completions and use them to train models, and
some state outright that confidential data must not be submitted to them. If a model costs nothing
in money, find out what it takes instead, before you point it at a private repository.

**Paid tiers cost money.** Metered models bill per token against whatever key you configured. waterplane
neither enforces nor estimates a spending cap for third-party providers, and an agent in a loop can
spend a great deal quickly.

## 3. It reads your secrets, and it does not send them anywhere you did not choose

waterplane loads environment files (`.env`) so that API keys can live on disk rather than in a shell
profile. Keys are used only to spawn the backend you selected, and are never transmitted to any
other destination by waterplane itself.

This is **not** a promise about the backend. Once a key is handed to a CLI, what that CLI does with
it is that CLI's business. The same applies to anything an agent chooses to read and send.

waterplane refuses to serve `.env` files over its own file APIs and keeps path-containment guards on every
route that names a file. Those guards are asserted by tests. They are not a substitute for not
running the thing on a machine you would mind losing.

## 4. Deletion is real

waterplane can delete files — artifacts and uploads in the transport directories, and archived
conversations. Those deletions are immediate and permanent. There is no trash, no undo, and no
backup taken on your behalf. The transport directories are gitignored, which means their contents
are frequently the only copy in existence.

## 5. The readouts are best-effort, and say so

Much of what waterplane displays is scraped from a terminal: context percentages, usage limits, whether a
turn has ended, whether a prompt was delivered. These readings degrade to *absent* rather than to a
wrong number, on purpose — but absent is still a thing you may be looking at when you wanted an
answer.

Do not build an unattended process on the assumption that a status on this screen is authoritative.

## 6. It is not multi-user and has no authorisation model

Everyone who can reach a waterplane daemon gets the same, complete access to every repository under its
root. There are no accounts, no roles, and no audit trail of who did what. The LAN password gate is
a gate, not an identity system.

---

## If you are redistributing waterplane

You inherit all of the above and you are telling somebody else to run it. At minimum, keep this file
and `SECURITY.md` intact and prominent, do not remove the in-app disclaimers on hosted models, and do
not represent waterplane as audited, supported or safe to expose to an untrusted network.
