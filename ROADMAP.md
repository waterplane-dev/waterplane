# Roadmap

What waterplane intends to do, and not do, through the end of 2027. It is a statement of direction
from a one-person project, not a schedule. Last reviewed 2026-11-06.

## What it will do

- **Keep up with the CLIs it drives.** Each agent CLI's terminal shifts between versions. Detection
  has to keep working, and a reading it cannot make stays absent rather than wrong.
- **Make the first ten minutes easier.** Fewer steps from install to a paired phone, and clearer
  answers when a step fails.
- **Let work survive the phone being closed.** More of what the phone coordinates moves to the
  desktop, so the phone stays an input device and a viewport.
- **Tighten the loop from build to device.** One tap from a finished build to an installed app.
- **Give a better overview of several agents.** Which are working, which need a person, which are
  blocked, and why.
- **Reach more stores.** Google Play for the Android app, then an F-Droid build. Open VSX for the
  VS Code extension.
- **Earn the OpenSSF Best Practices Silver badge.** That means measuring statement coverage and
  raising it, and removing the single-person dependency that [GOVERNANCE.md](GOVERNANCE.md#continuity)
  describes.

## What it will not do

- **Re-implement an agent CLI.** It drives the real binary in a PTY, so every slash command and
  prompt keeps working.
- **Run a cloud service or relay.** Your desktop is the server, and code does not leave it.
- **Add telemetry** to the app or the host.
- **Bind a public interface by default.** The network boundary in [SECURITY.md](SECURITY.md) stays.
- **Support several users on one host.** The single-user boundary is what keeps the security model
  simple.
- **Sandbox what an authorised device can do.** Driving the desktop is the product.
- **Grow feature breadth for its own sake.** Something that belongs outside the core is a
  [plugin](docs/plugins.md).
