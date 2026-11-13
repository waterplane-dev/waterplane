# Disk space

Shows what is filling this computer's disk, and lets you delete the things that can be rebuilt, such as caches, build output and downloaded AI models. Use it when the desktop runs low on space. It works on a Mac, on Linux, and on Windows when waterplane runs inside WSL. It is experimental, off until you switch it on under Plugins, and spends nothing: no model calls.

On Windows with WSL there are two disks: the Windows drive (C:) and WSL's own virtual disk, which is a file on C:. Every row says which one it is on. Deleting something inside WSL frees space inside WSL only; C: gets that space back once the WSL disk is compacted, and the WSL disk's row under "show only" says how.

A scan lists its rows as soon as they are measured. Build output and node_modules in your code folder come last: while they are still being looked for, a line under "Temporary" says so and since when, and afterwards it says when they were looked for and how long it took.

On Windows, when your code folder is on the Windows drive (for example `C:\dev`), a scan does not look for build output and node_modules there at all. Reading folders on the Windows drive from inside WSL is slow: on one real machine, looking through 38 repos took 29 minutes. Tap **look for them** under "Temporary" when you want them; the rest of the screen keeps working meanwhile, and the rows stay until you tap **look again**. Folders on the Windows side are sized by Windows itself (PowerShell), which is much faster than reading them through WSL. When PowerShell does not answer, a row says it was measured the slow way instead.

## Where to find it
- **Settings, Tools, "disk space"** — a row with the free space from the last scan and a button to open the full screen.
- **Disk space screen** — lists temporary files (with, above the list, a line about build output and node_modules and, on Windows, the **look for them** button), AI models, large things shown for information only, and a button to scan for large files. Each temporary item and model has its own delete button, and one button cleans all temporary files. Every delete asks you to confirm.

## For developers

One sheet on the phone, reached from **Settings › Tools › disk space**, shows what is filling the
desktop's disk and lets you delete what can safely be regenerated. `host/index.mts` picks a
**profile** once — `mac`, `linux`, or `wsl` (Linux with `WSL_DISTRO_NAME`/`WSL_INTEROP` set, or
"microsoft" in the kernel release) — and the lists below follow it. The Mac's lists:

1. **Free / total** of the data volume (`statfs` on the home folder), from the last scan.
2. **Temporary** — regenerable caches and build output, a **delete** button on each row and one
   **clean all temporary** button. The fixed list: `~/.gradle/{caches,wrapper/dists,daemon}`,
   `~/.npm/_cacache`, `~/Library/Caches/{ms-playwright,pip,node-gyp,Homebrew,electron,claude-cli-nodejs}`,
   `~/.cache/puppeteer`, the browser caches (`BraveSoftware`, `com.brave.Browser`, `Google`, `Firefox`
   under `~/Library/Caches`); build output under the code root (`build`, `.next`, `.turbo`, `.vite`
   next to a `package.json` / `build.gradle*` / `settings.gradle*`, **and ignored by git** — a
   tracked `build/` is source); and Claude Code session scratchpads under
   `/private/tmp/claude-<uid>/<project>/<session>` where nothing changed for 24 h (one row).
3. **AI models** — each `~/.cache/huggingface/hub/models--*` (shown as `org/name`) and each
   `ollama list` tag, a delete each. Tags sharing an ID say so: one copy on disk, deleting one frees
   nothing until the others go too.
4. **Show only** — Android system images per API level, `~/Library/Developer/CoreSimulator`,
   `~/.claude/projects`, `~/Downloads`, `~/.ollama`, Docker Desktop's data and `~/.orbstack`, and the 15 biggest
   `node_modules` under the code root. Sizes and how to free each by hand; no delete path exists.
5. **Scan for large files** — on demand, `find $HOME -xdev -type f -size +500M` with the folders above
   pruned (plus `~/Library/Mobile Documents`, `~/.Trash` and other apps' data under
   `~/Library/Containers` and `~/Library/Group Containers`), killed after 120 s and reported as
   partial. No model call, zero tokens. Show-only.

**Linux** (and the Linux side of WSL) differs in these places: the caches are
`~/.cache/{pip,ms-playwright,node-gyp,electron,puppeteer,google-chrome,chromium,BraveSoftware,mozilla}`,
`~/.npm/_cacache` and the three Gradle folders; scratchpads are under `/tmp/claude-<uid>`; the
Android SDK default is `~/Android/Sdk`; show-only drops the Mac-only rows (CoreSimulator, Docker
Desktop's container, OrbStack) and adds `~/.local/share/docker` when it is readable; the large-file
find prunes the same Linux caches.

**WSL** adds the Windows side. The Windows home is `%USERPROFILE%` asked of `cmd.exe` and turned
into a `/mnt` path by `wslpath -u`, once, time-bounded, cached; when that fails the scan says why
and only the Linux side is listed.

- **Header**: the Windows drive (`C:`) — `statfs` on the `/mnt` mount the Windows home is on, or
  PowerShell's `Get-PSDrive` (15 s bound) when statfs gives no usable figure, else unknown with the
  reason. A second line gives the free space inside WSL.
- **Windows caches** (category `wcache`, anchored at the Windows home): `AppData/Local/npm-cache`,
  `AppData/Local/pip/cache`, `AppData/Local/ms-playwright`, `.gradle/{caches,wrapper/dists,daemon}`,
  `Cache` and `Code Cache` under `User Data/Default` of Chrome, Brave and Edge, and Firefox's
  `Profiles/*/cache2` — one row per real profile folder, each checked on its own.
- **Windows temporary files** (category `wtemp`): entries directly under `AppData/Local/Temp`
  where nothing changed for 7 days (the first 3000 entries looked at), one row. Each entry is
  deleted on its own; one that Windows holds open (`EBUSY`/`EPERM`/`EACCES`) is skipped and
  counted — the receipt says "n removed, m in use and skipped" and never counts a skipped one as
  freed. A folder is removed file by file: when a file inside is held, the files unlinked before
  it are gone, so that folder is counted as skipped *and* as partly cleared, and the receipt says
  so rather than "nothing removed".
- **The WSL disk does not shrink.** Deleting inside WSL frees space in WSL's `ext4.vhdx`, not on
  C:. Every Linux-side row, the delete question, clean all and the receipt say so, and "free space
  rose by" is read on the disk the delete touched: inside WSL for a Linux-side row, C: for a
  Windows-side one. A row's disk follows its path: build output or node_modules under
  `/mnt/<drive>/` (a code root on the Windows drive) is a Windows-side row measured on that drive.
  The header bar's "temporary" and "AI models" slices are only the rows on the bar's own disk. The distro's `ext4.vhdx` (under `AppData/Local/Packages/*/LocalState/` or
  `AppData/Local/wsl/*/`) is a show-only row with the compact instruction
  (`wsl --manage <distro> --set-sparse true`, or `wsl --shutdown` then `Optimize-VHD`/diskpart),
  beside Docker Desktop's `AppData/Local/Docker/wsl` and the Windows `Downloads`.
- **Large files**: the Linux home only (`-xdev` already keeps `find` off `/mnt`, which is pruned by
  name as well); the result says the Windows drive was not searched, because a `find` over `/mnt/c`
  from WSL is too slow to finish in its time bound.

Spends nothing. Everything is `du -skx`, `find`, `git check-ignore`, `ollama list|rm` (and on wsl
`powershell.exe`) by `execFile`/`spawn` — no shell, a time bound each, nothing on the event loop. No poller: a scan runs
when the sheet opens (unless one finished in the last 2 minutes) or on the refresh button, and the
last result is kept in the host's memory with its time, which the sheet prints.

### A scan in two parts

Measured on a real WSL machine (code root `/mnt/c/dev`, 38 repos): a full scan took 1761 s, almost
all of it the code-root walk over drvfs; with an empty code root it still took 259 s, because `du`
on three Windows caches each hit its 120 s bound. So:

- **The fast part first.** Volumes, the fixed caches on both sides, the Windows caches and temp,
  scratchpads, models and the show-only list are measured and the last result is replaced, then
  `changed` is pushed — the phone shows those rows while the **code part** (`walkRoot`: build output
  and the biggest node_modules) runs. `DiskState.phase` says which part runs; `DiskState.code`
  (`CodeWalk`) carries the walk's root, whether it runs, since when, when the listed build /
  node_modules rows were looked for and its sentences. The last walk's rows stay listed through the
  next fast part until a new walk replaces them. Still one scan at a time: a `scan` or `scanCode`
  while one runs joins it (a `scanCode` during the fast part adds the walk to it).
- **On wsl with the code root on the Windows drive** (under `/mnt/<drive>/` or the Windows home —
  `codeOnTap`), a scan never walks it. It runs only on `scanCode`, the **look for them** button
  above the Temporary list, whose line says why. A Mac, plain Linux, or wsl with a Linux-side code
  root walk on every scan as before. Chosen over a smaller walk budget, which would list a
  different arbitrary part of the tree each time and still cost minutes.
- **Windows-side sizes come from one PowerShell call** per part (`measureWindows` in `run.mts`):
  every path of that part under a `/mnt` drive or the Windows home, turned into its Windows form
  (`winPathOf`: `/mnt/c/x` → `C:\x`, what `wslpath -w` answers under the default automount — one
  spawn per path for thousands of `%TEMP%` entries was not worth it; a path with no such form makes
  the part fall back to du), handed over **stdin as ASCII-escaped JSON**, never in the command text
  (`PS_SIZES` is a constant). It sums file lengths, does not follow folder links, and prints one
  numbers-only line per path as it finishes, so a run stopped by its bound (`psTimeoutMs`, 180 s)
  still answers for what it reached; the rest is **size unknown** with the reason, a path with
  unreadable parts is **at least**, one Windows no longer finds is unknown. Lines are read strictly
  (`parsePsSizes`): anything else is ignored, never read as 0. PowerShell missing, or answering no
  usable line: those rows are `du`'d as before and their note says "measured with du from inside
  WSL (slow)" and why. File lengths are not allocated blocks, so a PowerShell size can differ a
  little from `du`'s. Not checked on a real machine yet: whether killing the WSL side of
  `powershell.exe` at the bound also stops the Windows process.

## The delete gate

**A delete never takes a path from the phone.** The phone sends an opaque id from the last scan
(`<category>:<16 hex>`, `shared/wire.mts` `CANDIDATE_ID_RE`). The host:

1. refuses anything not shaped like that (a path, `../..`, a show-only `show:`/`nm:` id) and any id
   that is not a temp/model row of its own last scan;
2. in the queued job, **recomputes that category freshly** (`host/candidates.mts`) and finds the id
   there — a scratchpad touched since the scan is no longer old, a cache that went is gone. Build
   output is the exception that does not re-walk the code root (minutes on a Windows drive): the
   path the host's own last walk found for that id (kept in the host, never from the phone) is
   re-checked alone by `recheckBuild` — under the code root within the walk's depth, reached only
   through folders the walk opens, named like build output, a real folder next to a
   `package.json`/`build.gradle*`/`settings.gradle*`, ignored by git — and must hash to the same id.
   An id no walk of this host found is refused at step 1;
3. runs `safeToRemove`: the path must be lexically inside its anchor with the category's shape
   (exactly a fixed cache path of this profile; `hub/models--*`; a build name under the code root;
   two levels under the scratch root folder, which must itself be a real folder; on wsl, exactly a
   Windows cache path under the Windows home — a `*` segment matching one folder — or one entry
   directly under the Windows `Temp` (anchored at the Windows home, so a link at `AppData`,
   `Local` or `Temp` refuses too), the only place a file rather than a folder is deleted), not a symlink, and its **realpath** must equal the
   anchor's realpath joined with the same relative path — so a symlink anywhere in between, or one
   swapped in since the scan, refuses;
4. then `fs.rm(recursive)` — or, for ollama, `ollama rm <name>` with the name re-taken from a fresh
   `ollama list` and passed as one argv element.

After a delete that row is re-measured (or dropped) and the free-space header re-read; the sheet
prints the size the scan measured and how far free space actually rose on the disk the delete
touched (a Time Machine local snapshot can keep deleted files on disk until it expires).

A size `du` cannot produce (timeout, no number) is **size unknown** with the reason, never 0; a
`du` that finished but could not read everything is **at least** that much.

## Layout

| path | what |
|---|---|
| `shared/wire.mts` | the methods (`state`, `scan`, `scanCode`, `scanLarge`, `remove`, `cleanTemp`), the one push (`changed`), the row shapes |
| `host/candidates.mts` | every category's fresh resolution, the show-only list, `safeToRemove`, `recheckBuild`, `codeOnTap` |
| `host/engine.mts` | one scan (fast part, then the code walk) / one find at a time, the serial delete queue, the in-memory last result |
| `host/large.mts` | the bounded large-file `find` |
| `host/run.mts` | `execFile` with a time bound, `du` read honestly, the pool, `statfs`, the PowerShell size reader |
| `web/` | the sheet, the Settings › Tools row, the words (`logic.ts`) |
| `test/diskspace.test.mjs` | the host over a fake home, code root and scratch root — and a fake Linux home and WSL home + Windows home, the profile injected through `Roots` (in `npm run test:host`) |
| `web/logic.test.mjs` | the words and sums (in `npm run test:unit`) |

## Switching it on

Ships in the release, **off** (`deploy/ship.json`: `{ "ship": true, "on": false, "experimental":
true }`): it deletes files on this desktop, so a person switches it on under **Plugins › disk space**.

- **This desktop (a dev checkout of this repo)**: there is no `release.json`, so every in-repo
  extension loads, and an `optional` one starts **on** — the same as vault. `npm run restart` builds
  the host half into `packages/host/dist/extensions/diskspace/` and starts it; the web half is in
  the next web build. Nothing else to set.
- **Switched off by hand?** The phone's plugin list has its switch (it is `optional`), which writes
  `"diskspace": false` into `<state dir>/plugins.json` (`~/.local/state/waterplane/plugins.json`).
  Turn it back on there, or set `"diskspace": true` in that file and `npm run restart`.
- **An install from a release** carries it switched off; the plugin list's switch turns it on.

macOS may ask once whether the host's `node` may read `~/Downloads` (or other protected folders)
the first time a scan measures it; a refusal shows that row as "at least" what could be read, or "size unknown".
