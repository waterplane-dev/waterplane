# Google Play: what is automated, and the one-time setup

`npm run release:play` publishes the `play` flavor (`dev.waterplane.app`) without Play Console.
How it works and why it has no dependency: `docs/notes/distribution.md`, *Google Play*.
Everything below is dry run unless `--yes`.

```bash
npm run release:play -- status                               # every track, next versionCode
npm run release:play -- --yes                                # build + upload to internal testing
npm run release:play -- --yes --track production --rollout 10%
npm run release:play -- promote --to production --rollout 10% --yes   # same bundle, no rebuild
npm run release:play -- rollout --track production --rollout 100% --yes
npm run release:play -- listing --yes                        # store text + images from listings/
```

## Files here

| path | goes to |
|---|---|
| `listings/<locale>/title.txt` (≤30), `short-description.txt` (≤80), `full-description.txt` (≤4000) | Main store listing, with `listing` or `upload --listing` |
| `listings/<locale>/{icon,featureGraphic,phoneScreenshots,…}/*.png` | Graphics of that type, replaced as a set, in file-name order |
| `listings/en-US/{phoneScreenshots,icon,featureGraphic}/*` | Made by `node scripts/media/play-shots.mjs` from the demo (screenshots 1080×2160 with a caption band, the app icon, a 1024×500 graphic); re-run after a UI change |
| `release-notes/<locale>.txt` (≤500) | "What's new" of every upload. `--notes "…"` overrides it with one en-US text |

The en-US texts are a **draft** written from the Play checklist: read them before the first
`listing --yes`. Over-long text is refused before anything is sent, never cut.

## One-time setup (the parts Google keeps in the web UI)

1. **Upload key.** `npm run release:play -- keygen` → `~/.config/waterplane-release/play-upload.jks`
   and `packages/app/android/keystore-play.properties` (both gitignored, 0600). Back both up.
2. **Service account** (Google Cloud console, any project):
   - enable *Google Play Android Developer API*;
   - IAM → Service accounts → create one (no Cloud roles needed) → Keys → add JSON key;
   - save it as `~/.config/waterplane-release/play-service-account.json` (`chmod 600`), or point
     `WATERPLANE_PLAY_SA` at it.
3. **Play Console → Users and permissions → Invite** the service account's e-mail, app
   permissions for this app: *View app information*, *Release to production…*, *Release apps to
   testing tracks*, *Manage testing tracks*, *Manage store presence* (for `listing`).
4. **Create the app** in Play Console (name, default language, app, free). Accept Play App Signing.
5. **First bundle by hand:** `npm run release:play -- build`, then Test and release → Internal
   testing → Create release → drop in the `.aab` it names. Until this, the API answers
   `Package not found`.
6. **App content** declarations (privacy policy, app access with Demo mode, ads, content rating,
   target audience, data safety, the `REQUEST_INSTALL_PACKAGES` and foreground-service forms):
   answers drafted in the Play checklist (`.claude/outbox/play-console-checklist.md`).
7. **New personal developer account:** a closed test with ≥12 testers for 14 days before
   production unlocks. `--track alpha` is the closed track.

Then `npm run release:play -- status` should list the internal release, and every later release is
the one command above. While the app has never been published, Play takes only `--draft` releases.
