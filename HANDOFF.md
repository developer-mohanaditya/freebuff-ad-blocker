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
- **Desktop tool** — built, tested and verified locally (32 checks), but the
  files were never committed, so the published one-liner does not exist yet.
  See the first open item.

Last verified, in this order, on the tree being handed off:

```
npm run build     # ok — 3 extension zips + desktop tool + desktop zip + dist/
npm run validate  # "All extension checks passed."  (exit 0)
npm test          # 58 content-script + 18 install-page + 32 desktop checks pass  (exit 0)
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

1. **Commit and push the desktop tool.** HEAD was `810cc8e` and the working
   tree carried the whole desktop tool, the edited docs and site, and this file
   — all uncommitted (`git status --porcelain` lists the current set). Five
   paths exist nowhere else: `desktop/`, `scripts/build-desktop.mjs`,
   `scripts/test-desktop.mjs`, `site/downloads/freebuff-adblock-desktop.sh` and
   `site/downloads/freebuff-adblock-desktop-1.3.0.zip`. Until they are pushed, a
   clone of the repo has no desktop tool and the one-liner on the install page
   404s. After pushing, redeploy the site so the stamped `desktop` /
   `desktopZip` / `origin` fields reach `version.json`.
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

- **The desktop patch anchors are version-specific.** They were found and
  verified against Freebuff Desktop **0.0.155**. If the rebuilt desktop app
  renamed anything, every count drops to zero and the tool refuses to write —
  that is the designed outcome, not a bug — but the anchors have to be found
  again. Run `sh desktop/freebuff-adblock.sh status` first on the new build.
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
  only patches `orchestrator.js`. If an ad still renders in the app after a
  successful patch, that bundle is the next place to look.
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
2. `npm run build && npm run validate && npm test` — should be clean on a fresh
   clone once the pending files are pushed
3. `npm run preview` and click through `/` — hero, `#install`, `#desktop`,
   `#updates`, `/privacy`
4. Close open item 1, then 2
5. Run `sh desktop/freebuff-adblock.sh doctor` against the current desktop build
