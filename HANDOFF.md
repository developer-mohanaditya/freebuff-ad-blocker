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

- **Chrome Web Store** — live: `hgkegdgnihnifjmgnihohlaemaafhlgm`.
- **addons.mozilla.org** — live: `freebuff-ad-block`.
- **Edge Add-ons** — not submitted, so `STORE_LINKS.edge` stays empty and an Edge
  reader gets no store button. Submitting it is free and lights the button up.
- **Install page** — live, with the desktop section added, the two store listings
  wired into the hero, and a three-way platform switch in the desktop section
  (macOS selectable; Windows and Linux `disabled` until a build exists).
- **Desktop tool, re-anchored for Freebuff Desktop 0.0.164 (unreleased).**
  0.0.164 dropped one of the two render gates (`displayAd` is gone; `auction`'s
  gate remains, once) and the ad client grew to ten `/api/v1/ads/*` endpoints,
  all reached through a single `request` helper. The anchors now say exactly
  that: `render` expects **1**, `request` matches the ad client's own signature,
  and the old `post` anchor is **gone** — in 0.0.164 it matched the break-event
  telemetry poster and the `/api/logs` shipper, so it could only break logging
  while blocking no ads. Verified against fixtures built from the windows
  0.0.164's own `scan` printed, decoys included.
- **One version for the whole product: v1.4.1, not yet deployed.** The extension
  and the desktop tool are inspected and released together, so
  `extension/manifest.json` is the only version there is: it names the three
  browser packages, the desktop package and the tool's own stamp, `update.xml`
  and the tag on the site (navbar, footer, zip meta). There is no
  `DESKTOP_VERSION` any more, and no `desktopVersion` in `version.json`. It is
  1.4.1 rather than 1.4.0 because the **live** one-liner already serves a 1.4.0
  that cannot patch 0.0.164: one number for two different tools is the drift the
  single version exists to prevent. The live site still serves the older build,
  and the stores are still on 1.3.0, so their first upload can simply be 1.4.1.

Last verified, in this order, on the tree being handed off:

```
npm run build     # ok — 3 extension zips + desktop tool + desktop zip + dist/
npm run validate  # "All extension checks passed."  (exit 0)
npm test          # 58 content-script + 58 install-page + 81 desktop checks pass  (exit 0)
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

1. **Submit to Edge Add-ons, then paste the URL into `STORE_LINKS.edge`.** Free,
   and it is the one browser that currently gets no hero button: `edge` is an
   empty string, and the button is removed rather than pointed at the Chrome Web
   Store, because an Edge reader clicking "Add to Edge" into Google's store is
   worse than no button. Everything else is wired — see `STORE_LINKS` for the two
   that are live.
2. **`site/update.xml` still contains `YOUR_EXTENSION_ID_HERE`.** The ID is now
   known — `hgkegdgnihnifjmgnihohlaemaafhlgm`, from the Chrome Web Store URL — but
   the feed also needs `codebase` to point at a signed CRX, and a store-installed
   extension is updated by the store anyway. So the placeholder stays until the
   self-hosted/forcelist route is actually wanted. README explains why an unpacked
   extension never polls it regardless.
3. **In 1.4.1, make the manifest description browser-neutral.** The current one
   mentions Chromium and Firefox; AMO accepted it but it reads oddly there. It is
   a manifest field, so it needs the version bump to reach the stores - the rest
   of a release needs none.
4. **Optional:** a GitHub Actions workflow that tags a release and attaches the
   three built zips, so a version bump is one push instead of a manual upload.
   Needs a `GITHUB_TOKEN` secret in the repo. Not started.

## Traps worth remembering

- **Re-anchoring is a report plus a count, and it never needs the 9 MB bundle.**
  A build whose anchors moved reads `ambiguous` (the shape exists, the count does
  not) or `not found`, and the tool writes nothing. Get the report from the
  installed app itself, then the counts that decide the anchor:

  ```sh
  curl -fsSL <origin>/downloads/freebuff-adblock-desktop.sh | sh -s scan
  grep -c '<candidate anchor text>' <orchestrator.js>
  grep -o 'async request([^)]*)' <orchestrator.js> | sort | uniq -c
  ```

  The piped form is the one to give anyone who ran the one-liner install: they
  have no local copy of the script, so `sh freebuff-adblock.sh scan` cannot work
  for them. `sh -s scan` passes `scan` through as the command; that path is now
  covered by a test, not just a promise in the docs.

  **Worked example — 0.0.164.** `render` went 2 → 1, because the `displayAd` gate
  is gone. `request` was re-pointed at the ad client's own signature, which is
  unique among the seven `async request(` definitions in that build, and matched
  name-agnostically in its second argument because that local is minifier output
  (`path27`). `post` was **deleted rather than re-pointed**: both of its matches
  are non-ad helpers. The rule that came out of it: never point an anchor at a
  literal that matches two unrelated things, because a count cannot tell you
  which one you meant.
- **The desktop patch anchors move between Freebuff releases.** The originals
  were found and verified against Freebuff Desktop **0.0.155**. Since our own
  v1.4.0 the tool can also match a renamed gate or helper, but only when it
  appears the expected number of times *and* ad code sits within 320 bytes of
  every hit. On a rebuilt app:

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
- **The version tag is on every page, and it is one number.** `site/privacy.html`
  once kept a stale literal after the install page had been updated, which is why
  the build now stamps every `.html` in `site/` and `npm run validate` fails if a
  page hardcodes a version in its navbar or footer, drops the stamp, or offers a
  download whose filename is not the current version. The tag, the file names and
  `update.xml` all come from `extension/manifest.json`: bumping it is the whole
  release, and no page, package or script may carry a version of its own.
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
   `56c6407` plus jsdom (58 content-script + 58 install-page + 81 desktop)
3. `npm run preview` and click through `/` — hero, `#install`, `#desktop`,
   `#updates`, `/privacy`
4. Close open item 1 (the Edge listing) when it is worth $0 and twenty minutes
5. Run `sh desktop/freebuff-adblock.sh scan` against the current desktop build,
   then `install`. `scan` writes nothing, so it is the safe first move on a
   build the tool has not seen.
