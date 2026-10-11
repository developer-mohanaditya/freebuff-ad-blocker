# Handoff

State of the project at the point the Freebuff Cloud workspace was retired.
`README.md` is the permanent documentation; this file is the temporary memory
that would otherwise have lived in the chat. Delete it once the open items below
are closed.

## What this is

Three tools for killing ads on freebuff.com, plus the site that distributes them.
No accounts, no backend, no database, no telemetry, no runtime npm dependencies.

| Piece | Path | Ships as |
| --- | --- | --- |
| Browser extension (MV3) | `extension/` | three zips in `site/downloads/` |
| macOS desktop patch tool | `desktop/freebuff-adblock.sh` | `freebuff-adblock-desktop.sh` + a zip |
| Windows desktop patch tool | `desktop/freebuff-adblock.ps1` | `freebuff-adblock-desktop.ps1` + a zip |
| Linux desktop patch tool | `desktop/freebuff-adblock-linux.sh` | `freebuff-adblock-desktop-linux.sh` + a zip |
| Install page + policy | `site/` | static `dist/`, deployed to Vercel |

Origin: `https://github.com/developer-mohanaditya/freebuff-ad-blocker`
Site: `https://freebuff-adblocker.vercel.app`
Licence: MIT.

## Where things stand

- **Chrome Web Store** — live: `hgkegdgnihnifjmgnihohlaemaafhlgm`.
- **addons.mozilla.org** — live: `freebuff-ad-block`.
- **Edge Add-ons** — not submitted, so `STORE_LINKS.edge` stays empty and an Edge
  reader gets no store button. Submitting it is free and lights the button up.
- **Install page** — live, and offering all three platforms. The desktop section's
  switch has macOS, Windows **and** Linux selectable, and `app.js` opens it on the
  platform the page is being read on. Each panel has its own one-liner with a copy
  button, its own zip as an inline link in the fine print, and its own "after you
  run it" steps. The Windows panel carries the `Unblock-File` /
  `-ExecutionPolicy Bypass` note for a file downloaded by hand; the Linux one
  leads with the AppImage fact, because it changes what the reader has to do.
- **The Linux tool exists as of 1.6.0 (this tree), and the build shapes the tool.**
  Freebuff for Linux ships as an **AppImage only** — no `.deb`, no `.rpm`, no
  fixed install directory, and the inner files live in a read-only SquashFS mount
  at launch. So there is nothing in place to patch, and the tool's job became:
  extract the image with the runtime the image itself carries (no FUSE, no
  `squashfs-tools`, no root), patch that copy under
  `~/.local/share/freebuff-adblock/<version>/`, never write to the user's
  download, and print the path to start instead of the image. `--app` pointed at
  a directory patches in place, exactly like macOS, which is also how the suite
  drives it.
- **The Linux anchors are the macOS ones, and that was measured, not assumed.**
  The real **0.0.164** AppImage was downloaded (154 MB) and opened in this
  workspace: both anchors are a **single literal hit** in
  `resources/orchestrator/orchestrator.js`, the same counts as the macOS bundle,
  and the patch applies and reverts byte-identically. The **0.0.87** image still
  served on the appimage download path does **not** match (zero literal hits, both
  anchors) and is refused by name — so "it doesn't work" from a Linux user is
  answered first by asking which version they have. Electron resources are
  platform-independent, which is why one anchor set covers all three tools; the
  shared anchors are asserted byte-identical by `npm run validate`.
- **Do not put a `.btn` inside a `.panel`.** A primary "Download for Windows"
  button was tried in the Windows panel and shipped broken: `.panel a` sets the
  accent colour at a specificity above `.btn-primary`, so the label was painted
  accent-on-accent and the button rendered as an empty orange pill, with nothing
  failing anywhere. The download went back to the macOS panel's inline link, and
  `site/styles.css`'s `.panel a:not(.btn)` plus a `test-site.mjs` check that no
  `.btn` sits in any panel keep it from recurring. If a panel ever needs a real
  button, that guard is what makes it possible - verify the label is legible.
- **Desktop tools, both anchored to Freebuff Desktop 0.0.164.** One render gate
  (`displayAd` is gone; `auction`'s gate remains, once), and the ad client's
  single `request` helper that reaches all ten `/api/v1/ads/*` endpoints. The old
  `post` anchor is **gone** — in 0.0.164 it matched the break-event telemetry
  poster and the `/api/logs` shipper, so it could only break logging while
  blocking no ads.
- **The Windows tool is new in this tree (1.5.0), and its harness is a rewrite.**
  Same anchors, same counts, same markers, same refusal rules; the machinery
  differs: PowerShell instead of `sh` + `perl`, `Get-Process` + `Win32_Process`
  instead of `ps`, an install-folder search instead of `/Applications`, a
  same-volume `File.Replace` instead of `mv`, and a cause-by-cause message when a
  write is refused (a share violation means quit Freebuff, `C:\Program Files`
  means an elevated shell, read-only means `attrib -R`). The first two anchors are
  asserted across the tools by `npm run validate`: the macOS and Linux perl
  engines are compared byte for byte, and the Windows tool is checked to carry
  the same anchor literals, so the three cannot drift apart silently.
  The suite covers the piped one-liner the page headlines - `install`, `status`,
  `revert` and a refusal, all through the `scriptblock` shape - not just the
  read-only `scan` it used to.
- **What is NOT verified: a real Windows Freebuff bundle, and a real Linux one
  end to end.** For Linux the *bundle* is verified (see above — 0.0.164 opened and
  patched here), but not the last mile: nothing in this workspace has actually
  *launched* a patched AppImage tree and watched an ad break not appear. Electron
  resources are platform-independent, so `resources\orchestrator\orchestrator.js`
  is expected to be the same file we re-anchored against on macOS — but for
  **Windows** even that has not been run: nobody has run `scan` on a Windows
  install. Both tools fail **closed**: if the counts differ, `install` refuses and
  writes nothing, and `scan` prints the report that re-anchors it. To close the
  Windows item: install Freebuff Desktop on Windows and run
  `irm https://freebuff-adblocker.vercel.app/downloads/freebuff-adblock-desktop.ps1 | iex`
  if you are feeling bold, or the read-only form first:
  `$s = irm …/freebuff-adblock-desktop.ps1; & ([scriptblock]::Create($s)) scan`.
  If the scan report matches the macOS one (one literal hit per anchor), the
  anchors carry over and only the report needs filing.
- **The desktop tools can prove a patch is in effect, not just on disk.** `verify`
  waits for Freebuff to be quit and reopened, then compares two times: when the
  patch was written, and when the process running now started. Started later
  means the app that is open read the patched file. It also prints the ad code
  still in the build, so a patch aimed at code that moved is visible rather than
  silent. `install` runs the same check when Freebuff is open; `-NoWait` /
  `--no-wait` report instead of waiting, `-Timeout` / `--timeout SECONDS` bound
  the wait, and a timeout can never fail an install that already succeeded. It
  cannot see whether an ad break still appears — that is the app's behaviour, and
  it says so.
- **On Windows, Ctrl-C is what ends the wait, and nothing else can.** This was
  measured rather than assumed, because the first draft registered a
  `CancelKeyPress` handler that looked tidy and was a trap. A handler written as a
  PowerShell script block cannot run on the signal thread — no runspace — so
  PowerShell answers with an unhandled `PSInvalidOperationException` and the
  process dies of **SIGABRT**. A compiled .NET delegate (`Add-Type`, ~0.5 s) does
  run, but it cannot set a status either: PowerShell still exits **0** for an
  interrupted run and ignores `Environment.Exit()` from that thread. So the tool
  registers no handler, the wait is bounded by `-Timeout` (300 s default) so an
  unattended run comes back, and interrupting prints no verdict rather than a
  false one. The suite sends a real SIGINT and asserts the run ends there instead
  of at its timeout; the interrupted run's exit code belongs to the host, not to
  the script, which is why the page and the read-me say an interrupted wait prints
  no verdict.
- **One version for the whole product: v1.6.0.** 1.4.1 was the 0.0.164
  re-anchor, 1.4.2 added the relaunch check, 1.5.0 shipped the Windows tool, and
  1.6.0 ships the Linux tool. `extension/manifest.json` is the only version there
  is: it names three browser packages, three desktop tools and their three
  packages, `update.xml` and the tag on the site. There is no `DESKTOP_VERSION`.
  The live site still serves 1.4.2 until this tree is deployed, and the stores are
  still on 1.3.0, so their first upload can simply be whatever this tree builds —
  1.6.0.

Last verified, in this order, on the tree being handed off:

```
npm run build     # ok — 3 extension zips + 3 desktop tools + 3 zips + dist/
npm run validate  # "All extension checks passed."  (exit 0)
npm test          # 58 content-script + 69 install-page + 104 macOS desktop
                  # + 151 Windows desktop + Linux desktop checks pass  (exit 0)
```

`npm run build` is safe to re-run: it overwrites `dist/` and the nine files, cleans
stale packages by name, and leaves `site/downloads/` byte-identical for an
unchanged version.

## Commands

```sh
npm install --no-audit --no-fund   # no dependencies; this just makes it a real project
npm i --no-save jsdom              # only for npm test (test-detection.mjs, test-site.mjs)
npm run build                      # packages everything, emits dist/
npm run preview                    # build, then serve dist/ on 0.0.0.0:$PORT (4173)
npm test                           # all five suites
npm run test:desktop               # just the macOS tool, no jsdom, no real bundle
npm run test:windows               # just the Windows tool; needs pwsh
npm run test:linux                 # just the Linux tool; compiles its AppImage stand-in
                                   # with cc/gcc when present, and skips the image checks
                                   # (with a message) when there is no compiler
npm run validate                   # static checks that the stores would otherwise fail on
npm run check                      # node --check on the build tooling
```

`scripts/serve.mjs` binds `0.0.0.0` and honours `$PORT`, defaulting to 4173.

The Windows suite finds PowerShell as `pwsh`, `powershell`, or
`~/.local/pwsh/pwsh`, and skips itself with a message when there is none. On a
dotnet host with no ICU, PowerShell only starts in invariant mode; the suite and
`validate` both set `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` for their child
processes, which changes nothing on a host that has ICU.

The Linux suite compiles a stand-in for an AppImage — a real ELF binary whose
runtime extracts a tree the way the real one does — so the image path is tested as
the thing it is rather than mocked: discovery of `*Freebuff*.AppImage`, extraction
into the versioned directory, the refusal when the extraction fails, the refusal
to patch **inside** an image, and the AppDir path that patches in place. The
inherited tests run on top of that: patch, idempotence, revert, display-only,
`--dry-run`, refusal on a mismatched build, and the relaunch verification against
a real stand-in process. Every check names the platform it ran on, and the whole
suite skips itself only when there is no shell at all, which on Linux there
isn't.

## Open items

1. **Run `scan` against a real Windows Freebuff install** and either file the
   report as confirmation or re-anchor every tool from it. This is the one item
   that stands between the Windows tool and being verified rather than merely
   correct-by-construction. See the note above.
2. **Submit to Edge Add-ons, then paste the URL into `STORE_LINKS.edge`.** Free,
   and it is the one browser that currently gets no hero button: `edge` is an
   empty string, and the button is removed rather than pointed at the Chrome Web
   Store, because an Edge reader clicking "Add to Edge" into Google's store is
   worse than no button.
3. **The Linux tool is unrun by a human on a real install.** The bundle path is
   verified against the real 0.0.164 AppImage (see the notes above), but nobody has
   started a patched tree and watched an ad break fail to appear. Closing it is the
   same shape as the Windows item: `install`, start the path it prints, then
   `verify`. If the extract step ever fails on a distro, the tool says which step
   and writes nothing — that report is the bug report.
4. **The Linux extraction path assumes an AppImage.** It handles an AppImage and
   an AppDir, and refuses anything else by name (`not an AppImage (not an ELF
   executable)`). If Freebuff ever ships a `.deb` or a Flatpak, that is a third
   branch in `resolve_target`, not a new tool.
5. **`site/update.xml` still contains `YOUR_EXTENSION_ID_HERE`.** The ID is known
   (`hgkegdgnihnifjmgnihohlaemaafhlgm`) but the feed also needs `codebase` to
   point at a signed CRX, and a store-installed extension is updated by the store
   anyway. So the placeholder stays until the self-hosted/forcelist route is
   actually wanted.
6. **Optional:** a GitHub Actions workflow that tags a release and attaches the
   built zips, so a version bump is one push instead of a manual upload. Needs a
   `GITHUB_TOKEN` secret in the repo. Not started.

## Traps worth remembering

- **Re-anchoring is a report plus a count, and it never needs the 9 MB bundle.**
  A build whose anchors moved reads `ambiguous` (the shape exists, the count does
  not) or `not found`, and neither tool writes anything. Get the report from the
  installed app itself, then the counts that decide the anchor:

  ```sh
  # macOS
  curl -fsSL <origin>/downloads/freebuff-adblock-desktop.sh | sh -s scan
  sh desktop/freebuff-adblock.sh scan
  grep -c '<candidate anchor text>' <orchestrator.js>
  grep -o 'async request([^)]*)' <orchestrator.js> | sort | uniq -c

  # Windows
  powershell -ExecutionPolicy Bypass -File .\freebuff-adblock-desktop.ps1 scan
  Select-String -Path orchestrator.js -Pattern '<candidate anchor text>' -AllMatches

  # Linux - `sh -s scan` works for the one-liner, exactly as on macOS
  sh desktop/freebuff-adblock-linux.sh scan
  curl -fsSL <origin>/downloads/freebuff-adblock-desktop-linux.sh | sh -s scan
  grep -c '<candidate anchor text>' <extracted>/resources/orchestrator/orchestrator.js
  ```

  The piped form matters for whoever ran the one-liner: they have no local copy.
  On macOS that is `sh -s scan`; on Windows `iex` takes a string and nothing else,
  so the working form is
  `$s = irm <origin>/downloads/freebuff-adblock-desktop.ps1; & ([scriptblock]::Create($s)) scan`.
  **`iex (irm <url>) scan` does not work** — `Invoke-Expression` has no way to pass
  the extra argument and says so. Both forms are covered by tests rather than by
  docs alone. On Linux there is no such trap: the script is `sh` either way, and
  `sh -s scan` after a pipe is the whole trick.

  **Worked example — 0.0.164.** `render` went 2 → 1, because the `displayAd` gate
  is gone. `request` was re-pointed at the ad client's own signature, which is
  unique among the seven `async request(` definitions in that build, and matched
  name-agnostically in its second argument because that local is minifier output
  (`path27`). `post` was **deleted rather than re-pointed**: both of its matches
  are non-ad helpers. The rule that came out of it: never point an anchor at a
  literal that matches two unrelated things, because a count cannot tell you
  which one you meant.
- **On Linux the extraction runs before anything else, and a failure there must
  stop the run — which is not what `die` inside `$( … )` does.** The first draft
  computed the extracted path with `target="$(prepare)"`, and `die` in a command
  substitution kills only the **subshell**: the message printed, the exit status
  was swallowed, and the run carried on into a misleading "Refusing to patch"
  cascade naming a path that did not exist. The fix is the shape now in the file —
  the extraction reports its failure through a status the caller checks, and the
  caller stops. Same class of bug as the Windows method-reference trap: an error
  path that looks handled and is not.
- **The Linux image is never opened for writing, and the code says so out loud.**
  `install` on an AppImage extracts to `~/.local/share/freebuff-adblock/<version>/`
  and patches the copy; a request that would write *inside* the image is refused
  with that reason rather than attempted. The suite asserts the source image is
  byte-identical after an install, because that is the property a user is trusting
  when they run the one-liner on a file they downloaded.
- **A zip's file names are part of its instructions, and a double-click launcher
  is the proof.** The packaging step served the sh tools as
  `freebuff-adblock-desktop.sh` / `…-linux.sh` and put them in the zips under
  those names, while the read-mes, the install page and the tools' own help all
  said `sh freebuff-adblock.sh` / `sh freebuff-adblock-linux.sh`. On Linux that
  broke the only way in — the zip has no launcher — and on macOS it broke the
  `.command` launcher, which runs `sh ./freebuff-adblock.sh install` and therefore
  failed at the one thing a double-click exists for. It was found by extracting the
  built zip and following its own read-me, which is the only way this class of bug
  shows up: the build was green, `npm test` was green, and every name pointed at a
  real file — just not the one in the reader's folder. `scripts/validate.mjs` now
  compares the names `build-desktop.mjs` writes into the zips against every
  instruction that names a tool, and the Linux suite drives the extracted zip's own
  command shape. Fixed in 1.6.0: both zips carry the tool under the name their
  read-me uses.
- **The Windows harness is a rewrite, and the anchors are the only shared code.**
  Anything that reads differently between the tools (a count, a marker, a
  threshold, the two-second tolerance) is a bug, not a platform difference. Both
  suites patch the *same* fixture, imported from `scripts/desktop-fixtures.mjs`,
  so they cannot be tested against different shapes.
- **PowerShell traps that cost time here, all three now guarded by tests:**
  - Variable names are case-insensitive: `$marker` and `$markers` are one
    variable, so a second assignment silently overwrote the first.
  - A bare method reference — `[Console]::remove_CancelKeyPress` with no argument
    — **writes the method's signature string into the output stream**. That turned
    a function's `return 1` into `@(1, 'static void remove_CancelKeyPress…')`, and
    `exit @(…)` then exited **0**: a verify that refused was reporting success.
    Every piece of output in `Wait-ForRelaunch` is assigned or piped to
    `Out-Null`, and the caller checks with `-contains 0` rather than equality.
  - `if` used as an expression (`$x = if (…) { … } else { … }`) is fine in
    PowerShell 7 and should not be relied on for 5.1 in anything new.
  - Unrecognised flags such as `-App` do reach a
    `[Parameter(ValueFromRemainingArguments)]` parameter intact, which is what the
    hand-rolled parser depends on. `--app=PATH` arrives as one token; `-App PATH`
    as two.
- **The desktop patch anchors move between Freebuff releases.** The originals
  were found and verified against Freebuff Desktop **0.0.155**, then re-anchored
  for **0.0.164**. Since v1.4.0 the tools can also match a renamed gate or helper,
  but only when it appears the expected number of times *and* ad code sits within
  320 bytes of every hit. On a rebuilt app:

  ```sh
  sh desktop/freebuff-adblock.sh scan     # what this build has - writes nothing
  sh desktop/freebuff-adblock.sh install
  ```

  A patch reading `not found` or `ambiguous` is the tool refusing to guess. The
  `scan` report (`~/freebuff-patch-backups/orchestrator-scan.<version>.txt`) is
  the payload for re-anchoring: it lists each candidate site with surrounding
  code plus counts for stable tokens. Send that file rather than a screenshot.
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
- **On macOS, patching needs App Management to allow the writing app.** System
  Settings → Privacy & Security → App Management → enable Terminal (or whatever
  ran it), quit and reopen that app. The tool detects this and prints the path
  rather than failing halfway. It never uses `sudo`.
- **On Windows, a refused write is usually a lock, not a permission.** Quitting
  Freebuff properly (tray icon, or Task Manager) releases it; `Run as
  administrator` is only for an install under `C:\Program Files`. The tool reads
  the exception to tell the two apart — HResult `0x80070020` is
  `ERROR_SHARING_VIOLATION`. There is no re-sign step on Windows: signing covers
  the `.exe`, not the JavaScript beside it.
- **The app has to be quit completely (⌘Q on macOS, tray → Exit on Windows) and
  reopened.** The orchestrator is read once at launch; bringing the window
  forward is not enough.
- **Every Freebuff update replaces the resources folder,** so the patch reverts.
  The backup is kept per version, so reverting an older one still works.
- **The desktop UI bundle has a second ad stack** in
  `Resources/orchestrator/ui/assets/*.js` (`adPolicy`, `sponsored_task`,
  `sponsored-proposal`, `spotlight`, `ad-showcase`, `adBreakEvent`). Both tools
  only patch `orchestrator.js`, and `scan` only reads `orchestrator.js`. A new
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
  Nothing in the build shell-outs to `pwsh`, so a host without PowerShell still
  builds and validates; it just prints that the PowerShell parse check was
  skipped.
- **Shell heredocs were blocked in the cloud sandbox** — fixtures were generated
  from a Node script instead. May not apply to the desktop workspace.

## State that lives only on your machine

- `~/freebuff-patch-backups/orchestrator.js.<version>.orig` — the pristine
  original that `revert` restores. The tool creates it on first install. On
  Windows that path is `%USERPROFILE%\freebuff-patch-backups\`. On Linux it is
  the same `~/freebuff-patch-backups/`.
- `~/.local/share/freebuff-adblock/<version>/` — the extracted AppImage tree the
  Linux tool patches and launches from, one directory per version. `install`
  creates it, `revert` restores `orchestrator.js` inside it, and the original
  `.AppImage` is never touched. Deleting a version's directory simply means the
  next `install` extracts it again.
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
  The first number is the raw `FBD-ADS-OFF` count (`2` once the tool is on:
  one `render`, one `request`). `0` markers + `2` anchors means pristine and
  `install` just works. `0` + `0` means the legacy patch is still there. Then run
  `sh desktop/freebuff-adblock.sh status`: both patches (`render 1`, `request 1`)
  reading `applied` means the tool is in place.

## Working preferences

- No `Generated with Codebuff` / `Co-Authored-By` trailers in commit messages.
- Commit and push are the user's call; don't do them unprompted.
- Keep the zero-dependency property. Nothing here needs a package to run, and
  neither desktop tool needs anything that does not ship with its OS.

## First week checklist

1. `npm install --no-audit --no-fund`
2. `npm run build && npm run validate && npm test` — clean on a fresh clone plus
   jsdom (and PowerShell for the Windows suite; it says so if it has to skip)
3. `npm run preview` and click through `/` — hero, `#install`, `#desktop` with all
   three platform tabs (the switch should open on the one you are reading on),
   `#updates`, `/privacy`
4. Run `scan` against a real Windows Freebuff install and file the report (open
   item 1). It writes nothing, so it is the safe first move on a build the tool
   has not seen.
5. On Linux: `install`, start the path it prints, run `verify`, and see whether an
   ad break still shows up (open item 3). The bundle is already verified; this is
   the behaviour half.
6. Close open item 2 (the Edge listing) when it is worth $0 and twenty minutes
