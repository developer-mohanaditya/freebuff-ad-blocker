# Freebuff Ad Block — conversation export

**Exported:** 8 October 2026
**Project:** `freebuff-ad-block` — a site-scoped browser extension for freebuff.com, a macOS desktop patch tool for the Freebuff app, and the static install page that ships both.
**Current version in the tree:** **1.4.0** — one number for the whole product, driven by `extension/manifest.json`.
**Repository:** `github.com/developer-mohanaditya/freebuff-ad-blocker` (Vercel builds `dist/` from `npm run build`).

> **Note added after this export.** The thread carried on past this point: the
> version moved to **1.4.1** when the desktop tool was re-anchored for Freebuff
> Desktop **0.0.164** (one render gate, the ad client's own `request` helper, the
> `post` anchor dropped), and the install page's copy buttons were fixed. The
> sections below describe the tree exactly as it stood at export time;
> `HANDOFF.md` in the repository is the current record.

---

## How to read this file

This is the working conversation between the user and the coding agent, kept for
conversation memory. Three fidelity levels apply, and they are marked per turn:

| Mark | Meaning |
| --- | --- |
| ✅ **verbatim** | The user's message and the agent's reply are reproduced as sent. |
| ⚠️ **reconstructed** | The exact transcript was dropped when the agent's context was compacted. The turn is summarised from the surviving record and from the repository state it produced. Treat wording as a faithful paraphrase, not a quote. |
| 🔧 **tool activity** | Raw command output and file contents are not reproduced for any turn. Where a conclusion rested on one, the command and the observed values are quoted in the turn. |

The durable record of the work is the repository itself — `README.md`,
`HANDOFF.md` and `PUBLISHING.md` carry the decisions, traps and release
procedure. This file carries the *reasoning* and the *verification*.

---

## Table of contents

1. [Turn 1 — desktop tool released and verified live](#turn-1) ⚠️
2. [Turn 2 — the install page: live listings, two-button hero, platform switch](#turn-2) ⚠️
3. [Turn 3 — the version pill made explicit](#turn-3) ⚠️
4. [Turn 4 — "the version tag is still not updated"](#turn-4) ✅
5. [Turn 5 — one product, one version, filenames follow the tag](#turn-5) ✅
6. [Turn 6 — this export](#turn-6) ✅
7. [Current state appendix](#appendix)

---

<a id="turn-1"></a>
## Turn 1 — desktop tool released and verified live ⚠️ reconstructed

**Context.** The desktop patch tool (`desktop/freebuff-adblock.sh`) had just
been changed so it survives a Freebuff rebuild: relaxed anchor matching,
a read-only `scan` command that prints what an installed build actually
contains, and a rule that a write made through a relaxation is undone if a fresh
count disagrees afterwards. It shipped as **1.4.0** while the extension stayed at
**1.3.0**.

**What the agent did.** Verified the release against the live site rather than
trusting the local build:

| Check | Observed |
| --- | --- |
| `/version.json` | `version` 1.3.0 (extension), desktop fields pointing at 1.4.0 |
| `/downloads/freebuff-adblock-desktop.sh` | 26,471 bytes, `VERSION="1.4.0"`, origin matches the site |
| `/downloads/freebuff-adblock-desktop-1.4.0.zip` | HTTP 200, 10,489 bytes, contains `freebuff-adblock-desktop.sh`, `Freebuff Ad Block.command`, `INSTALL.txt` |
| the old 1.3.0 desktop zip | HTTP 404 — correctly removed by the release |
| install page desktop section | `data-desktop-version` pill `1.4.0`, `data-desktop-zip` → the 1.4.0 zip, `data-desktop-command` → the `curl … | sh` one-liner, zero inline `1.3.0` |
| repo | HEAD `56c6407`, working tree clean, `dist/` and `site/downloads/` already carrying the 1.4.0 artefacts |

**Stated limits.** No rebuilt Freebuff bundle was available to run
`scan`/`install` against — that real-world test only exists on the user's
machine. One probe of the desktop zip returned a 404 that a repeat fetch did not
reproduce; the repeat was treated as authoritative and the 404 as a transient
fetch artefact.

---

<a id="turn-2"></a>
## Turn 2 — the install page: live listings, two-button hero, platform switch ⚠️ reconstructed

**What the agent did.**

- **`site/app.js`** — `STORE_LINKS` filled in with the real listings: Chrome
  (`chromewebstore.google.com/detail/hgkegdgnihnifjmgnihohlaemaafhlgm`) and Firefox
  (`addons.mozilla.org/en-US/firefox/addon/freebuff-ad-block/`). Edge
  deliberately left empty. Removed the old "demote the zip" logic, since the zip
  no longer sits in the hero. Added a few lines of platform-switch behaviour.
- **`site/index.html`** — headline became **"The ads disappear."**; the hero
  became **exactly two buttons** (the store button, whose label is
  `Add to Chrome` / `Add to Edge` / `Add to Brave` / `Add to Firefox` from
  detection, plus **For Desktop** → `#desktop`); "How to install" removed; the
  zip moved into install step 1 behind a `data-zip` hook; the desktop section
  gained a three-way switch **For macOS / For Windows / For Linux** with
  `windows` and `linux` carrying `disabled`.
- **`site/styles.css`** — `.platform-switch` / `.platform-tab` as a segmented
  control, plus `[data-platform-panel][hidden] { display: none !important }`
  because `.split` sets its own `display`.
- **Tests** — install-page suite **18 → 34 checks**, including the hero-is-two-
  buttons assertion, the exact headline, the switch invariants, the two shipped
  listing URLs, and a test that enables a second tab, gives it a panel and clicks
  it, so "just add a panel later" is proven rather than promised.
  `validate.mjs` began failing if `STORE_LINKS.chrome` / `.firefox` is emptied.
- **Docs** — README, HANDOFF and PUBLISHING §4 corrected; the open-items list
  renumbered with Edge submission as item 1.

**Bug caught in review.** `reconcileVersion()` in `site/app.js` targeted
`document.querySelector('a[download]')`. With the hero zip gone, the first
`download` link on the page is the **Firefox** package — the function would have
silently repointed the Firefox zip at the Chromium one. Re-keyed to `[data-zip]`.

**Verified.** `npm run build`, `npm test` (58 content-script + 34 install-page +
57 desktop) and `npm run validate` all exit 0; the preview served the new page at
HTTP 200.

---

<a id="turn-3"></a>
## Turn 3 — the version pill made explicit ⚠️ reconstructed

**Problem.** The navbar and footer showed a bare `v1.3.0`. With the desktop tool
on 1.4.0 and the extension on 1.3.0, a correct number read as a stale site.

**What the agent did.** Confirmed the extension really is 1.3.0 in
`extension/manifest.json` and in the packages that shipped to both stores (the
store pages themselves sit behind bot challenges, so the shipped zips were
checked instead). Then relabelled the tag on the install page:

- `site/index.html` — pill became
  `extension v<span data-version>1.3.0</span> · desktop v<span data-desktop-version>1.4.0</span>`;
  footer became `Freebuff Ad Block · extension v… · desktop tool v…`.
- `site/styles.css` — `.pill-desktop`, hidden under 620px so the topbar stays
  one line.
- `scripts/build.mjs` — a second stamp, and `desktopVersion` added to
  `version.json`.
- `site/app.js` — the stale-cache heal extended to `[data-desktop-version]`.
- `scripts/validate.mjs`, `scripts/test-site.mjs` — checks for the labelled pill
  and footer.

**Verified.** build / test / validate all exit 0.

---

<a id="turn-4"></a>
## Turn 4 — "the version tag is still not updated" ✅ verbatim

**User:**

> Still the version tag in the navbar and footer is not updated with the current version

**Agent reply:**

Found it, and it wasn't a deploy problem — there was a second page nobody had relabelled.

### The actual bug

`site/privacy.html` (served at `/privacy`) still had the **old** markup:

```html
<span class="pill">v<span data-version>1.3.0</span></span>          <!-- navbar -->
Freebuff Ad Block · v<span data-version>1.3.0</span> · site-scoped…  <!-- footer -->
```

and `scripts/build.mjs` only stamped `index.html` — so even the version-stamping
pass skipped it. The install page was relabelled in the previous turn; the
privacy page kept a bare `v1.3.0` and could never move off it.

### Fixed

| File | Change |
| --- | --- |
| `site/privacy.html` | navbar pill and footer now carry both labelled stamps, same as the install page |
| `scripts/build.mjs` | stamps **every** `site/*.html` (dist + source), not just `index.html`; throws if `site/` has no pages |
| `scripts/validate.mjs` | new `version labels` check, run per page: navbar and footer must name *extension* and *desktop*, and no version literal may be hardcoded there |
| `HANDOFF.md` | the trap recorded under "Traps worth remembering" |

### Verified

Served pages, in the running preview:

```
/         navbar: extension v1.3.0 · desktop v1.4.0
/         footer: Freebuff Ad Block · extension v1.3.0 · desktop tool v1.4.0 · site-scoped…
/privacy  navbar: extension v1.3.0 · desktop v1.4.0
/privacy  footer: Freebuff Ad Block · extension v1.3.0 · desktop tool v1.4.0 · site-scoped…
bare v1.x left in nav/footer: 0 (both pages)
```

```
npm run build     exit 0
npm test          exit 0 — 58 + 40 + 57 checks
npm run validate  exit 0 — 113 ok, "All extension checks passed."
```

The new check is **mutation-tested**: the bare pill was temporarily put back, and
`validate` failed with `site/privacy.html: the navbar pill does not name the
extension version` / `… does not name the desktop version` (exit 1). The fix was
then restored and the check re-run green — so it is a check that can actually
fail, not decoration.

### Why both numbers, not one

The extension is genuinely **1.3.0** (`extension/manifest.json`, and the three
shipped zips) and the desktop tool is genuinely **1.4.0**
(`scripts/build-desktop.mjs`). One bare number has to be wrong about one of them
— which is why a correct 1.3.0 kept reading as stale.

### Still yours to do

**The live site hasn't been redeployed** — `https://freebuff-adblocker.vercel.app`
still serves the pre-change build. Vercel builds from GitHub, and the modified
files were uncommitted, so the fix existed only in the workspace. Nothing was
committed or pushed.

**🔧 Tool activity for this turn:** read `site/privacy.html`, `site/index.html`,
`site/app.js`, `scripts/build.mjs`, `scripts/validate.mjs`, `scripts/test-site.mjs`,
`scripts/serve.mjs`, `vercel.json`, `.gitignore`; fetched the live site and
`/version.json`; ran `npm run build`, `npm test`, `npm run validate`; ran a
mutation test (reintroduce the bare pill → validate exit 1 → restore → green);
served `/` and `/privacy` through the preview and extracted the navbar/footer
text.

**Then, an automated final-completion check** (system-injected, not user
content) asked the agent to re-verify the deliverables. It found and repaired two
things:

- The privacy policy date had been bumped to 8 October 2026, which *overstated* a
  document whose text had not changed. Reverted to "Last updated: 1 October 2026".
- `HANDOFF.md` carried two stale claims: the check counts (`34 install-page` →
  `43`) and an open item labelled "1.3.1", a release number that no longer
  existed. Also disambiguated an anchor-trap sentence that read as if `1.4.0`
  were a *Freebuff* version (Freebuff Desktop was 0.0.155).
- `scripts/test-detection.mjs` was found carrying a second version in a test
  double — `getManifest: () => ({ version: '1.3.0' })`. It now reads the real
  manifest, so a version bump cannot leave a lie in the tests.

---

<a id="turn-5"></a>
## Turn 5 — one product, one version, filenames follow the tag ✅ verbatim

**User:**

> Umm, We run the total app as one thing - both extension and the desktop. So, just write in the tag and where ever it needed as 1.40 instead os speaking them as two different things.
>
> So everytime we make update to the app, we inspect the both tools and update them, and release them as the updated version together. So, It is just Freebuff Ad Block v1.4.0 instead of "Freebuff Ad Block · extension v1.3.0 · desktop tool v1.4.0"
>
> So change the tag accordingly. And also, the tag name should represents the versions of the downloadable files and their file names. So modify the filenames and version tag, and update everywhere the tag is mentioned.

**Agent reply:**

Done — one product, one number, everywhere.

### The tag now reads one version

| Page | Navbar | Footer |
| --- | --- | --- |
| `/` | `v1.4.0` | `Freebuff Ad Block · v1.4.0 · site-scoped, no accounts, no telemetry.` |
| `/privacy` | `v1.4.0` | same |

`extension v…` / `desktop v…` / `data-desktop-version` / `.pill-desktop` are gone
from the markup, the CSS and `app.js`. The install button's meta and the desktop
paragraph now carry the same stamp, so all four stamps on the page move together.

### The filenames follow the tag

`extension/manifest.json` is now the single source of truth (`"version": "1.4.0"`),
and it names everything:

```
freebuff-adblock-1.4.0.zip            200  24,862 B   manifest inside: 1.4.0
freebuff-adblock-1.4.0-store.zip      200  24,454 B   manifest inside: 1.4.0
freebuff-adblock-1.4.0-firefox.zip    200  24,562 B   manifest inside: 1.4.0, gecko key intact
freebuff-adblock-desktop-1.4.0.zip    200  10,489 B   3 files as before
freebuff-adblock-desktop.sh           200  26,471 B   VERSION="1.4.0"
freebuff-adblock-1.3.0.zip            404           (removed by the build)
```

`update.xml` now reads `codebase='…/freebuff-adblock-1.4.0.zip' version='1.4.0'`,
and `version.json` is down to one `version` field.

### Removed the second version track

- `scripts/build-desktop.mjs`: `DESKTOP_VERSION` constant deleted;
  `buildDesktop({ version })` takes the app version and throws if it isn't given.
- `scripts/build.mjs`: one `version` from the manifest → zips, `update.xml`, the
  desktop tool's stamp and package, `version.json`, and the site tag.
  `desktopVersion` is gone.
- `site/app.js`: heals every `[data-version]` stamp from `version.json`.

### Guards rewritten for one version

`npm run validate` now checks, per page: the navbar and footer carry the stamp,
no version is hardcoded there, **every download path on the page contains the
current version**, no `data-desktop-version` stamp exists, and the four `v1.4.0`
packages plus the unversioned script actually exist in `site/downloads/`. It also
fails if `DESKTOP_VERSION` comes back. `npm test` asserts the navbar has exactly
one stamp, that the zip and desktop links are the 1.4.0 files, and that a stale
cache heals every stamp *and* the zip link.

### Verified

```
npm run build     exit 0 — stale 1.3.0 packages removed, all packages stamped 1.4.0
npm test          exit 0 — 58 content-script + 43 install-page + 57 desktop
npm run validate  exit 0 — "All extension checks passed."
```

Each file was fetched through the running preview (statuses and sizes above), so
the check is on the served artefacts, not just on disk.

### Docs updated

`README.md`, `HANDOFF.md`, `PUBLISHING.md` — the shipping-an-update flow is now:
bump `extension/manifest.json`, re-scan the desktop tool against the current
Freebuff build (it ships with the extension now), build/test/validate, upload the
three browser packages.

### Left as-is, deliberately

- The privacy policy's **"Last updated: 1 October 2026"** stays: only the version
  it applies to moved to `1.4.0`, the policy text didn't change.
- `desktop/freebuff-adblock.sh` keeps the stable unversioned name
  `freebuff-adblock-desktop.sh`, because that URL is what already sits in
  people's terminal commands; only the zip carries the version.
- **Still not deployed:** the live site serves the old build (two-track tag,
  1.3.0 zips) and the stores are still on 1.3.0. Nothing was committed or pushed.

**🔧 Tool activity for this turn:** grepped the whole repo for `1.3.0`, `1.4.0`,
`DESKTOP_VERSION`, `desktopVersion`, `data-desktop-version`; edited
`extension/manifest.json`, `package.json`, `scripts/build.mjs`,
`scripts/build-desktop.mjs`, `site/index.html`, `site/privacy.html`,
`site/styles.css`, `site/app.js`, `scripts/validate.mjs`, `scripts/test-site.mjs`,
`scripts/test-detection.mjs`, `README.md`, `HANDOFF.md`, `PUBLISHING.md`;
`node --check` on every edited script; full build/test/validate; read each
package's `manifest.json` out of the zips; fetched every download path through the
preview.

---

<a id="turn-6"></a>
## Turn 6 — this export ✅ verbatim

**User:**

> Okay, Now export this entire thread to a markdown file and provide it here so I can download and share it in the desktop for conversation memory.

**Agent reply:** this file, `CONVERSATION.md`, written at the project root. Turns
1–3 are marked ⚠️ reconstructed because the exact transcripts were dropped when
the agent's context was compacted; turns 4–6 are reproduced as sent. No raw tool
output is included for any turn.

---

<a id="appendix"></a>
## Current state appendix

### Version and artefacts

- **App version: 1.4.0**, from `extension/manifest.json`. Nothing else in the
  tree may carry a version of its own — `validate` enforces that.
- Packages in `site/downloads/`: `freebuff-adblock-1.4.0.zip` (load unpacked),
  `-1.4.0-store.zip` (Chrome Web Store / Edge Add-ons), `-1.4.0-firefox.zip`
  (AMO), `freebuff-adblock-desktop-1.4.0.zip`, and the stable
  `freebuff-adblock-desktop.sh`.

### What is live vs local

| Thing | State |
| --- | --- |
| Chrome Web Store | **live**, extension 1.3.0 — needs the 1.4.0 upload |
| addons.mozilla.org | **live**, extension 1.3.0 — needs the 1.4.0 upload |
| Edge Add-ons | not submitted, so `STORE_LINKS.edge` is empty and Edge readers get no store button |
| Live site | serving the **old** build (two-track tag, 1.3.0 zips) — needs a redeploy |
| Local tree | one-version tag, 1.4.0 filenames, build/test/validate all green, **uncommitted** |

### Reproduce the verification

```sh
npm install --no-audit --no-fund     # no runtime dependencies
npm i --no-save jsdom                # only for npm test
npm run build                        # packages everything, emits dist/
npm test                             # 58 content-script + 43 install-page + 57 desktop
npm run validate                     # static checks the stores would otherwise fail on
```

### Known open items

1. Submit to Edge Add-ons, then paste the URL into `STORE_LINKS.edge`.
2. `site/update.xml` still holds `YOUR_EXTENSION_ID_HERE` — the ID is known, but
   the feed also needs a signed CRX, and a store-installed extension updates via
   the store anyway.
3. In 1.4.1, make the manifest description browser-neutral (it mentions Chromium
   and Firefox; AMO accepted it but it reads oddly there).
4. Optional: a GitHub Actions workflow that tags a release and attaches the three
   built zips.

### Honest limitations carried through the thread

- No real-browser visual pass at any point — verification was served HTML/CSS,
  jsdom behaviour and fetched artefacts, never a screenshot.
- The desktop patch tool has **never been run against a rebuilt Freebuff bundle**
  from this workspace: no bundle is available. That test is the user's to run
  (`sh desktop/freebuff-adblock.sh scan`, then `install`).
- The Chrome Web Store and AMO pages sit behind bot challenges, so the *published*
  version was inferred from the shipped packages, not read off the listings.
- Nothing has been committed, pushed or deployed by the agent at any point.
