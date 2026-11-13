# Links

Keeps one list of the web addresses that belong to your projects, so you do not have to remember them. It finds the dev servers running on your desktop and your Cloud Run and Firebase Hosting sites, and you pin the ones worth keeping. Each pinned link shows whether it is up or down. Needs the desktop to have `lsof` and, for the cloud sites, `gcloud` signed in. It is off until you switch it on under Plugins, because the cloud search uses that `gcloud` sign-in and looks through every project it can see.

## Where to find it
- **Home menu › Links** — the list: pinned links with up or down, then found links you have not pinned. Tap a link to open it outside the app. The search box and count chips narrow the list. The + beside the search pins an address by hand.
- **Session menu › links** — the same list, from inside a session.
- **Repo row** — a small chip on a repo's title line. It counts that repo's pinned links ("links 3"). If the repo has none pinned, it counts links found for it ("found 2"). A tap opens the list cut to that repo only.


## For developers

One sheet on the phone lists the dev servers, `tailscale serve` front doors and cloud projects that
belong to your repos, so none of it has to be remembered. It is reached from the
**links** line in every session's ☰ menu (pinnable into the header from *customize*), the
**Links** button in the launcher's header row (next to Desktop) and a **links n** chip on every
repo with pins — or, on a repo with none pinned, a **found n** chip counting what was found for it
(hidden rows not counted), so a first-time user is pointed at the sheet from the repo itself. A search box at the top cuts both lists by name, repo, port, project or address;
under it, count chips cut them by **env**, **where** (this desktop / hosted) and — pins only —
**up / down / not checked** (found links are never checked, so that cut empties the found list and
says so). Both lists group by **repo**, **env** or **where**; each group header folds it and says
how many rows it holds and how many are down, and *fold all* collapses every group to its headers:

1. **Pinned** — grouped (repo by default): the link (a tap opens it outside the app), its env tag
   (dev / staging / prod), and an up/down line from one `HEAD` (a `GET` after a 405) the host sends
   when the sheet opens. Any answer below 500 is **up** — a 401/403 says "sign-in", which is a
   Cloud Run service with IAM on, not a dead one. Each row has an edit pencil (name, env, repo), and unpin is in that form.
2. **Found, not pinned** — what the host found and nobody pinned:
   - **running here**: every TCP listener (`lsof -iTCP -sTCP:LISTEN`) whose process's working
     directory is inside a repo under the code root (`WATERPLANE_ROOT`) — so ollama, LM Studio and
     IDE helpers drop out by themselves. Its phone URL is the `tailscale serve` front door that
     proxies to it, else `http://<tailnet ip>:<port>` when it binds every interface, else **none**:
     the row says so and shows the `tailscale serve --bg --https=<free port> http://127.0.0.1:<port>`
     that would make one. Shown, never run. Ports ≥ 32768 (OS-picked) are hidden.
   - **Cloud Run** services and **Firebase Hosting** sites in every project `gcloud projects list`
     shows. A Cloud Function (Cloud Run with `goog-managed-by: cloudfunctions`) and an internal-ingress
     service are found but hidden — the list says "n of N shown" with a button for the rest.
     A project is tied to a repo by its `.firebaserc` first, else by the repo whose tracked files
     mention the project id most (`git grep -o -F`); a tie is **no repo**, never a guess.
3. **Pin a link by hand** (the + beside the search) — a name, an `http(s)://` address, env and repo.

A pin of a running-here row keeps the **port**, not today's URL: the phone URL is looked up again
each time, so a front door added later is used without re-pinning, and a stopped server says
"nothing listens on :5180".

## Where pins live

`<config dir>/links.json` (`~/.config/waterplane/links.json`), `{ "links": [...] }` — readable and
editable by hand; it is re-read on every answer, no restart. A row that does not read as a link is
NAMED on the sheet, and while the file has any such row (or is not JSON) **nothing writes to it** —
a pin, edit or unpin refuses in words instead of dropping what was typed by hand.

## Cost

Spends nothing: `lsof`, `tailscale serve status --json`, `tailscale ip -4`, `gcloud projects list`,
`gcloud run services list` per project (three at a time), `gcloud auth print-access-token` + one
Firebase Hosting API read per project, `git grep` per repo — each `execFile` with a time bound, no
shell. No poller: the local half runs when the sheet opens (reused for 20 s), and once per page load when
the repo chips find the desktop has not looked at all since it started (so **found n** can appear); the cloud half when
its last result is over 10 min old or on the refresh button. Each half pushes `changed` when done.

## Layout

| path | what |
|---|---|
| `shared/wire.mts` | the methods (`state`, `discover`, `probe`, `pin`, `add`, `edit`, `unpin`), the push, the row shapes |
| `host/parse.mts` | the pure readers of lsof, serve status, Cloud Run, Hosting; the project → repo vote |
| `host/engine.mts` | the two discoveries, the probes, the serial pin writes |
| `host/store.mts` | `links.json`: read, validate, refuse to write over a broken file |
| `host/run.mts` | `execFile` with a time bound, the pool |
| `web/` | the sheet, the ☰ line, the launcher button, the repo chip, the words and the search (`logic.ts`) |
| `test/links.test.mjs` | parsers over recorded output, the engine over a fake runner (in `npm run test:host`) |
| `web/logic.test.mjs` | the cuts and words (in `npm run test:unit`) |

## Switching it on

Ships in the release, **off** (`deploy/ship.json`: `{ "ship": true, "on": false,
"experimental": true }`): switch it on under **Plugins › links**. It is off by default because its
cloud discovery runs `gcloud` with this desktop's own sign-in and lists every project that sign-in
can see. Without `gcloud`, or signed out, it lists the local dev servers only and says why. In this
dev checkout it loads and starts on (`optional`, no `release.json`); `npm run restart` builds the
host half, the next web build carries the sheet.
