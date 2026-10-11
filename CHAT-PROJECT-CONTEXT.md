# Project context — Freebuff Ad Block

Drop this file into any chat about this project and the chat can give you
accurate, up-to-date answers about work that was actually done here, without
hallucinating from the repo's public docs (CONVERSATION.md, HANDOFF.md and
README.md are already in the tree and still useful for that — this file is the
cheat sheet for **what this build is right now**).

---

## What this project is

A site-scoped browser extension for **freebuff.com** that blocks its ad slots —
including the ones injected while a build is running, which never fire a separate
network request. Plus the desktop half: a local tool that does the same job inside
the Freebuff Desktop app, whose ads are rendered from a runtime inside its own bundle
(`Contents/Resources/orchestrator/orchestrator.js` on macOS, an AppImage on Linux).

Two apps, three desktop builds, one version:

| Piece | Path | Ships as |
| --- | --- | --- |
| Browser extension (MV3) | `extension/` | three zips in `site/downloads/` |
| macOS desktop patch tool | `desktop/freebuff-adblock.sh` | `freebuff-adblock-desktop.sh` (served) + `freebuff-adblock-desktop-<version>.zip` |
| Windows desktop patch tool | `desktop/freebuff-adblock.ps1` | `freebuff-adblock-desktop.ps1` (served) + `freebuff-adblock-desktop-<version>-windows.zip` |
| Linux desktop patch tool | `desktop/freebuff-adblock-linux.sh` | `freebuff-adblock-desktop-linux.sh` (served) + `freebuff-adblock-desktop-<version>-linux.zip` |
| Install page + policy | `site/` | static `dist/`, served by the preview and by hosting |

Origin: the repo is `github.com/developer-mohanaditya/freebuff-ad-blocker`. The site
origin baked into the build (and the one-liners, and `extension/popup.js`) is
`https://freebuff-adblocker.vercel.app`, overridable with `SITE_ORIGIN`. Licence: MIT.

---

## What this build is right now (the part that matters for a chat session)

**Version: `1.6.0`** — the only version in the tree. It is read from
`extension/manifest.json` by the build; nothing else in the tree may invent a version
of its own (`validate` enforces that). `package.json` carries the same number.

The build writes these into `site/downloads/` and `dist/version.json`:

| File | Meaning |
| --- | --- |
| `freebuff-adblock-<version>.zip` | load unpacked in Chromium |
| `freebuff-adblock-<version>-store.zip` | Chrome Web Store / Edge Add-ons (manifest at root) |
| `freebuff-adblock-<version>-firefox.zip` | addons.mozilla.org (event-page background + gecko id) |
| `freebuff-adblock-desktop.sh` | the `curl … | sh` one-liner, served as a file too |
| `freebuff-adblock-desktop-<version>.zip` | macOS zip: the script + `Freebuff AdBlock.command` + `INSTALL.txt` |
| `freebuff-adblock-desktop.ps1` | the `irm … | iex` one-liner, served as a file too |
| `freebuff-adblock-desktop-<version>-windows.zip` | Windows zip: `.ps1` + `Freebuff AdBlock.cmd` + `INSTALL-windows.txt` |
| `freebuff-adblock-desktop-linux.sh` | the `curl … | sh` one-liner, served as a file too |
| `freebuff-adblock-desktop-<version>-linux.zip` | Linux zip: the script + `INSTALL-linux.txt` |

The two shell tools are served under their desktop-prefixed names
(`freebuff-adblock-desktop.sh`, `freebuff-adblock-desktop-linux.sh`), but shipped
**inside their zips under the names every instruction uses**
(`freebuff-adblock.sh`, `freebuff-adblock-linux.sh`). That is the Linux zip line
below (zip entries are `freebuff-adblock-linux.sh` and `INSTALL-linux.txt` — the name
the read-mes and the tool's help use) and the macOS `Freebuff AdBlock.command` line
everywhere. Only `freebuff-adblock-desktop.ps1` has one name everywhere. This is
guarded by a static check in `scripts/validate.mjs` (`checkDesktopPackaging`).

**Linux exists as of 1.6.0.** Freebuff for Linux ships **only as an AppImage** — a single
executable with a read-only SquashFS filesystem, no `.deb`/`.rpm`, no fixed install
directory. So there is nothing in place to patch. The Linux tool's workflow is:
1. extract the image with the runtime the image itself carries (`--appimage-extract` — no
   FUSE, no `squashfs-tools`, no root),
2. patch the extracted copy under `~/.local/share/freebuff-adblock/<version>/`,
3. tell you to start that copy instead of the original image.
`--app` pointed at a directory (an AppDir you unpacked yourself, or a system install) patches
in place, exactly like macOS. The tool never writes to the .AppImage and never needs root.

The Linux anchors are **measured, not assumed**: the real **0.0.164** AppImage was downloaded,
opened and patched in this workspace — one literal hit per anchor, same counts as macOS, patch
applies and reverts byte-identically. The **0.0.87** image still served on the appimage download
path matched zero anchors and was refused by name. The suite has a suite-level check for this.

---

## Commands

```sh
npm install --no-audit --no-fund       # no runtime dependencies; makes it a real project
npm i --no-save jsdom                 # only for npm test (jsdom checks)
npm run build                         # packages into site/downloads/, writes site/update.xml + dist/
npm run preview                       # build then serve dist/ on 0.0.0.0:$PORT (default 4173)
npm start                             # serve dist/ only (no rebuild)
npm run validate                      # static checks the stores/browser would otherwise fail at load
npm run check                         # node --check on the build tooling
npm test                              # all suites: detection + site + desktop (macOS) + desktop (Windows) + desktop (Linux)
npm run test:desktop                  # just the macOS tool; no jsdom, no real bundle
npm run test:windows                  # just the Windows tool; needs pwsh, skips itself if there is none
npm run test:linux                    # just the Linux tool; compiles its AppImage stand-in when cc/gcc exists
```

The Linux suite's AppImage stand-in is a real ELF binary whose runtime extracts a tree the way
the real one does — so the image path is tested as the thing it is (discovery, extraction, the
"never write inside the image" property, the AppDir in-place path), not mocked. When there is no
compiler the image checks are skipped with a message, but the inherited shell tests still run.

---

## The contract of the desktop tools (shared by all three, the part a chat must not blur)

- **It patches only the ad code**, at two anchors: the gate the ad auction consults is forced to
  return "no ads to show", and the ad client's own request helper (the single method every
  `/api/v1/ads/*` call goes through) is made to give up before it sends. Nothing else in the file
  changes — in particular the log shipper that POSTs to `/api/logs` is left alone, so a `post`
  anchor is **not** one of the two anymore (it was in 0.0.155; in 0.0.164 it only matched
  non-ad helpers).
- **It refuses to run at all unless every anchor is found the exact expected number of times**, and
  a relaxed match is only accepted when ad code sits beside it. A Freebuff version that renamed a
  function fails safe and changes nothing rather than half-patching a 9 MB file. `scan` then prints
  what that build actually contains, so re-anchoring is a report to read, not a dead end.
- **It backs up the pristine file before the first write**, and `revert` puts it back. The backup is
  per-versioned.
- **`status` and `scan` are read-only.** `install` patches (after backing up and after a fresh
  check), `revert` restores, `verify` is the half nobody else can answer — whether the *running*
  app is loading the patched file, not whether the patched file is on disk. The orchestrator is read
  once at launch, so `verify` waits for Quit + reopen, compares the patch time with the process start
  time (two-second tolerance because `ps` rounds), and reports the ad code still in the build. Ctrl-C
  stops the wait; an interrupted wait prints no verdict rather than a false one. `install` runs the
  same check for you when the app is open.
- **A build whose anchors moved reports `ambiguous` or `not found` and writes nothing.** The refusal
  carries the per-anchor counts and offers the piped form for whoever ran the one-liner and has no
  local copy.

---

## What is still unverified (honest limitations, not a claim of completion)

- **No human has launched a patched AppImage tree by hand and watched an ad break fail to appear.**
  The *bundle* path is verified against the real 0.0.164 AppImage; the behaviour half (the last mile)
  still needs a human. That is open item 3 in `HANDOFF.md`.
- **No one has run a `scan` against a real Windows Freebuff install** — the Windows tool shares the
  shape with the others (Electron resources are platform-independent), but nobody has run that one-liner
  on a Windows install yet. Same open item shape as the Linux one.
- **The live site still serves the old build until this tree is deployed, and the stores are still on
  1.3.0**, so their first upload for this tree can simply be whatever it builds (1.6.0).
- No store listings are in the sources: Chrome Web Store is live, AMO is live, Edge Add-ons is not
  submitted (`STORE_LINKS.edge` is empty), and `site/update.xml` still holds the placeholder app ID
  (`YOUR_EXTENSION_ID_HERE`) — the feed also needs a signed CRX, and a store-installed extension updates
  via the store anyway.
- The desktop tools have never been run against a *rebuilt* Freebuff bundle from this workspace — no bundle
  is available here. The one a user runs looks like 0.0.164 or newer; `scan` is the safe first move on a
  build the tool has not seen (it writes nothing).

---

## A chat session should not say these things about this build

- "Linux is disabled / not built yet" — it shipped in 1.6.0.
- "The Linux tool patches the AppImage in place" — it can't; it extracts first.
- "There's one desktop tool" — there are three, sharing one anchor set and one engine.
- "The Python/IoC/ghost-fleet checks are part of this build" — they live in a separate
  "companion" context that was discussed alongside this project but is not in this tree. This project
  is the Freebuff-ad-block extension + desktop patch tools + install page.
- "It writes the orchestrator" when `verify` is what answers that question — `status`/`scan` are read-only.

---

## How to use this file in a chat

Paste it alongside a question about this build. The chat should treat the tree as the source of truth
for filenames and paths, this file for the current state and the limits, and the existing docs
(`README.md`, `HANDOFF.md`, `PUBLISHING.md`, `CONVERSATION.md`) for the history and the traps. If a
question is about the ad network rules or the browser extension internals, the relevant source is
`extension/content.js`, `extension/rules.json` and `extension/rules.md` — this file is only about the
whole product shape.

Files in the tree that are still authoritative for a session:
- `extension/manifest.json` — the one version.
- `extension/content.js`, `extension/rules.json`, `extension/rules.md`, `extension/popup.js` — the extension itself.
- `desktop/freebuff-adblock.sh`, `desktop/freebuff-adblock.ps1`, `desktop/freebuff-adblock-linux.sh` — the three tools.
- `desktop/Freebuff AdBlock.command`, `desktop/Freebuff AdBlock.cmd`, `desktop/INSTALL.txt`,
  `desktop/INSTALL-windows.txt`, `desktop/INSTALL-linux.txt` — the zips' read-mes and launchers.
- `scripts/build.mjs`, `scripts/build-desktop.mjs` — what produces the artifacts and stamps the versions.
- `scripts/validate.mjs`, `scripts/test-desktop.mjs`, `scripts/test-desktop-windows.mjs`,
  `scripts/test-desktop-linux.mjs`, `scripts/test-site.mjs`, `scripts/test-detection.mjs` — the verification.
- `site/index.html`, `site/app.js`, `site/styles.css`, `site/privacy.html` — the install page and its page behaviour.
- `HANDOFF.md`, `PUBLISHING.md`, `CONVERSATION.md`, `README.md` — the record and the release procedure.
