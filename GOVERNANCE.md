# Governance

waterplane is a single-maintainer project: one person decides, and the rules below say how, and
what anyone else can expect. If that changes, this file changes first.

## How decisions are made

- The maintainer decides what is built, what is merged and when a release goes out.
- Features arrive as **intent requests**: an issue that describes the problem and the end state.
  The maintainer accepts one, asks a question on it, or closes it with a reason, in the open, on the
  issue. The flow is in [CONTRIBUTING.md](CONTRIBUTING.md#the-flow).
- Code pull requests are merged only for a failing test that reproduces a bug, or a docs or typo fix.
  [CONTRIBUTING.md](CONTRIBUTING.md#why) says why.
- What the project will and will not do over the next year is in [ROADMAP.md](ROADMAP.md).
- A decision about a security report follows [SECURITY.md](SECURITY.md#what-to-expect), in private
  until the fix is out.

## Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| Maintainer | [Johannes Hoh](https://github.com/JohannesHoh) | Triage issues and intent requests. Review and merge pull requests. Answer security reports. Keep dependencies patched. Cut, sign and publish releases. Keep the docs true to the code. Enforce the [Code of Conduct](CODE_OF_CONDUCT.md). |
| Contributor | Anyone | Open intent requests and bug reports. Send a failing test or a docs fix. Follow [CONTRIBUTING.md](CONTRIBUTING.md) and the Code of Conduct. |
| Security reporter | Anyone | Report privately, as [SECURITY.md](SECURITY.md#reporting-a-vulnerability) describes. Credited unless they ask not to be. |

## Continuity

**Today the project depends on one person.** The maintainer alone holds admin of the GitHub
organisation, publishing rights for the npm package, the release signing key and the waterplane.dev
domain, and no second person can release in their place yet.

If the maintainer stops, the code stays available under the [MIT licence](LICENSE), so anyone can
fork it and carry on. Installed copies keep running, but they stop getting signed updates, because a
fork has to ship under its own key.
