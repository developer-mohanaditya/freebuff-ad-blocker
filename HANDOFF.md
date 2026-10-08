# Handoff

State of the project at the point the Freebuff Cloud workspace was retired.
`README.md` is the permanent documentation; this file is the temporary memory
that would otherwise have lived in the chat. Delete it once the open items below
are closed.

## What this is

Two independent tools for killing ads on freebuff.com, plus the site that
distributes them. No accounts, no backend, no database, no telemetry, no
runtime npm dependencies.

| Piece | Path | Ships as |
| --- | --- | --- |
| Browser extension (MV3) | `extension/` | three zips in `site/downloads/` |
| macOS desktop patch tool | `desktop/` | `site/downloads/freebuff-adblock-desktop*` |
| Install page + policy | `site/` | static `dist/`, deployed to Vercel |

Origin: `https://github.com/developer-mohanaditya/freebuff-ad-blocker`
Site: `https://freebuff-adblocker.vercel.app`
Licence: MIT.

## Where things stand

- **Chrome Web Store** — accepted and live.
- **addons.mozilla.org** — version 1.3.0 submitted, awaiting review.
- **Edge Add-ons** — not submitted.
- **Install page** — live, with the desktop section added.
- **Desktop tool** — committed and pushed in `7d7cef8`, then updated here to
  v1.4.0 and verified locally (57 checks). **The 1.4.0 change set is uncommitted**
  (`git status --porcelain` lists it) and the site has not been redeployed, so
  the live one-liner still serves 1.3.0 until both happen.
- **Desktop tool v1.4.0** — anchors now have a relaxed form, `scan` reports what
  an installed build actually contains, and a write made through a relaxation is
  undone if the check afterwards disagrees. This is the release that makes a
  Freebuff rebuild survivable. Its version is **independent of the extension's**
  (`scripts/build-desktop.mjs` → `DESKTOP_VERSION`), so the tool can ship without
  a browser-store submission: the desktop zip is 1.4.0 while the extension stays
  1.3.0. The tool has not been run against the rebuilt app yet — no bundle to
  inspect from the cloud workspace.

Last verified, in this order, on the tree being handed off:

```
npm run build     # ok — 3 extension zips + desktop tool + desktop zip + dist/
npm run validate  # "All extension checks passed."  (exit 0)
npm test          # 58 content-script + 18 install-page + 57 desktop checks pass  (exit 0)
```

`npm run build` is safe to re-run: it overwrites `dist/` and the four zips, and
leaves `site/downloads/` byte-identical for an unchanged version.

## Commands

```sh
npm install --no-audit --no-fund   # no dependencies; this just makes it a real project
npm i --no-save jsdom              # only for npm test (test-detection.mjs, test-site.mjs)
npm run build                      # packages everything, emits dist/
npm run preview                    # build, then serve dist/ on 0.0.0.0:$PORT (4173)
npm test                           # all three suites
npm run test:desktop               # just the desktop tool, no jsdom, no real bundle
npm run validate                   # static checks that the stores would otherwise fail on
```

`scripts/serve.mjs` binds `0.0.0.0` and honours `$PORT`, defaulting to 4173.

## Open items

1. **Commit and push the 1.4.0 change set, then redeploy the site.** HEAD is
   `7d7cef8`, which already carries the desktop tool as it was in 1.3.0. What is
   uncommitted now is this update: `desktop/freebuff-adblock.sh`,
   `desktop/INSTALL.txt`, `scripts/build-desktop.mjs`, `scripts/build.mjs`,
   `scripts/test-desktop.mjs`, `site/index.html`, `README.md`, this file, and the
   rebuilt `site/downloads/` (the 1.3.0 desktop zip is deleted, the 1.4.0 one is
   new and untracked). Until the site is redeployed, the live one-liner still
   serves a 1.3.0 tool — which is the version that cannot survive a renamed
   anchor. After the push, redeploy so the stamped `desktop` / `desktopZip` /
   `origin` fields reach `version.json`.
2. **Paste the listing URLs into `site/app.js` → `STORE_LINKS`.** Chrome's store
   URL is the one that matters today; `chrome` is still an empty string, so the
   hero shows the developer-install path even though the listing is live. Set
   `firefox` when AMO approves, and `edge` if Edge is submitted.
3. **`site/update.xml` still contains `YOUR_EXTENSION_ID_HERE`.** The auto-update
   feed is inert until the packed extension's real ID goes in and `codebase`
   points at a signed CRX. README explains why an unpacked extension never polls
   it regardless.
4. **1.3.1: make the manifest description browser-neutral.** The current one
   mentions Chromium and Firefox; AMO accepted it but it reads oddly there.
5. **Optional:** a GitHub Actions workflow that tags a release and attaches the
   three built zips, so a version bump is one push instead of a manual upload.
   Needs a `GITHUB_TOKEN` secret in the repo. Not started.

## Traps worth remembering

- **The desktop patch anchors move between Freebuff releases.** The originals
  were found and verified against Freebuff Desktop **0.0.155**; `1.4.0` can also
  match a renamed gate or helper, but only when it appears the expected number of
  times *and* ad code sits within 320 bytes of every hit. On a rebuilt app:

  ```sh
  sh desktop/freebuff-adblock.sh scan     # what this build has - writes nothing
  sh desktop/freebuff-adblock.sh install
  ```

  A patch reading `not found` or `ambiguous` is the tool refusing to guess. The
  `scan` report (`~/freebuff-patch-backups/orchestrator-scan.<version>.txt`) is
  the payload for re-anchoring: it lists each candidate site with surrounding
  code plus counts for stable tokens.  Send that file rather than a screenshot.
  A legacy hand patch leaves no markers, so a zero-anchor `status` there means
  "restore the pristine file first", not "the tool is broken".
- **`TEST_AGENTIC_ADS` is a trap.** The env-var route into the app's test ads
  throws unless `NODE_ENV !== "production"` *and* the environment is `dev`, and
  it is called at module load, so setting it crashes the app instead of
  unmuting anything. The patch deliberately does not use it.
- **Patching needs macOS App Management to allow the writing app.** System
  Settings → Privacy & Security → App Management → enable Terminal (or whatever
  ran it), quit and reopen that app. The tool detects this and prints the path
  rather than failing halfway. It never uses `sudo`.
- **The app has to be quit completely (⌘Q) and reopened.** The orchestrator is
  read once at launch; bringing the window forward is not enough.
- **Every Freebuff update replaces `Resources/`,** so the patch reverts. The
  backup is kept per version, so reverting an older one still works.
- **The desktop UI bundle has a second ad stack** in
  `Resources/orchestrator/ui/assets/*.js` (`adPolicy`, `sponsored_task`,
  `sponsored-proposal`, `spotlight`, `ad-showcase`, `adBreakEvent`). The tool
  only patches `orchestrator.js`, and `scan` only reads `orchestrator.js`. A new
  slot added in a newer desktop build is the most likely thing to live here, so
  if an ad still renders after a successful patch, this is the next place to
  look — and one command says which bundle carries it:

  ```sh
  d=/Applications/Freebuff.app/Contents/Resources/orchestrator
  grep -l -E 'adPolicy|sponsored|spotlight|ad-showcase|adBreak' "$d"/*.js "$d"/ui/assets/*.js 2>/dev/null
  ```

  Send that output rather than a screenshot; the anchors get found the same way
  the orchestrator ones were.
- **Hosting deploys are Node-only and uploaded files lose their executable
  bit**, so invoke scripts as `sh ./scripts/foo.sh`, never `./scripts/foo.sh`.
- **Shell heredocs were blocked in the cloud sandbox** — fixtures were generated
  from a Node script instead. May not apply to the desktop workspace.

## State that lives only on your Mac

- `~/freebuff-patch-backups/orchestrator.js.<version>.orig` — the pristine
  original that `revert` restores. The tool creates it on first install.
- `~/Downloads/freebuff-ads-off.sh` — the first hand-made patch script, from
  before the tool existed. **It leaves no `FBD-ADS-OFF` markers**, so if it was
  ever run, `status` will report the anchors as zero and the tool will refuse.
  Fix: restore the pristine file, or reinstall the app to get a clean bundle,
  then run `install`.
- Unanswered: whether that legacy patch is still applied on this machine. To
  find out:

  ```sh
  f=/Applications/Freebuff.app/Contents/Resources/orchestrator/orchestrator.js
  echo "tool markers: $(grep -o 'FBD-ADS-OFF' "$f" | wc -l)"
  echo "anchors:      $(grep -o 'localAgenticTestCampaign(process.env)' "$f" | wc -l)"
  ls -l ~/freebuff-patch-backups/
  ```

  The first number is the raw `FBD-ADS-OFF` count (`4` once the tool is on).
  `0` markers + `2` anchors means pristine and `install` just works. `0` + `0`
  means the legacy patch is still there. Then run
  `sh desktop/freebuff-adblock.sh status`: all three patches (`render 2`,
  `post 1`, `request 1`) reading `applied` means the tool is in place.

## Working preferences

- No `Generated with Codebuff` / `Co-Authored-By` trailers in commit messages.
- Commit and push are the user's call; don't do them unprompted.
- Keep the zero-dependency property. Nothing here needs a package to run.

## First week checklist

1. `npm install --no-audit --no-fund`
2. `npm run build && npm run validate && npm test` — clean on a fresh clone of
   `7d7cef8` plus jsdom; the 1.4.0 tool changes need committing before that stays
   true for the current tree
3. `npm run preview` and click through `/` — hero, `#install`, `#desktop`,
   `#updates`, `/privacy`
4. Close open item 1, then 2
5. Run `sh desktop/freebuff-adblock.sh scan` against the current desktop build,
   then `install`. `scan` writes nothing, so it is the safe first move on a
   build the tool has not seen.
