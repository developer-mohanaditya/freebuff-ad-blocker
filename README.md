# Freebuff Ad Block

**The ads stop. The build keeps streaming.**

An extension for Chromium and Firefox (Manifest V3) that removes the ads on
**freebuff.com**: the network-served slots, the ones the page injects while a
build is thinking, and the product's own in-line "AD" cards.

Site-scoped by design — it touches freebuff.com and nothing else. No accounts,
no backend, no database, no telemetry, and nothing to configure.

The **desktop app** is a separate bundle with no extension surface, so it has
its own tool: a dependency-free shell script in [`desktop/`](desktop) that turns
the app's bundled ad runtime off in place. Same rules — local, reversible, and
nothing to configure.

[Install it](https://freebuff-adblocker.vercel.app/) ·
[Privacy policy](https://freebuff-adblocker.vercel.app/privacy) ·
[Report an issue](https://github.com/developer-mohanaditya/freebuff-ad-blocker/issues)

## Install

Both listings are live:
[Chrome Web Store](https://chromewebstore.google.com/detail/hgkegdgnihnifjmgnihohlaemaafhlgm)
for Chrome, Edge, Brave, Opera, Vivaldi and every other Chromium browser, and
[addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/freebuff-ad-block/)
for Firefox. The hero button works out which of the two is reading the page and
points at the store that serves it, so it reads **Add to Chrome** or **Add to
Firefox** and nothing else. A browser with no listing — Edge today, Safari ever —
gets no button rather than a dead one.

The manual path stays for the cases a store cannot serve, and for reviewing the
package itself. It behaves exactly like an installed one — in Chromium it
persists, in Firefox a temporary add-on lasts until the browser restarts.

**Chromium** (Chrome, Edge, Brave, Opera, Vivaldi, Comet…)

1. Download the zip from the install page and extract it somewhere permanent.
   If you move the folder later, Chrome reports the extension as unloaded and
   you have to point it at the new path again.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Enable **Developer mode** → **Load unpacked** → pick the extracted
   `freebuff-adblock` folder.
4. Reload any freebuff.com tabs that were already open.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** → pick `manifest.json` inside the extracted
   Firefox zip.

The hero is two buttons and stays that way: the store button above, and **For
Desktop** for the desktop app's section. The zip is not a third hero option — it
lives in the first install step, where a browser with no listing finds it.

## Why three layers

| Layer | File | Catches |
| --- | --- | --- |
| Network | `extension/rules.json` | Ad requests, before they leave the tab |
| DOM hooks | `extension/content.js` | Ad-shaped markup injected mid-build |
| In-product promos | `extension/content.js` | freebuff.com's own "AD" cards |
| Ad-network slots | `extension/content.js` + `rules.json` | `data-gravity-ad` slots, `rel="sponsored"` links |
| Picked by hand | `popup` + `extension/content.js` | Anything you hide yourself, on every visit |

None of them alone is sufficient. A `declarativeNetRequest` ruleset only sees
requests, so it is blind to an ad container the page builds itself while it is
thinking. A content script only sees markup, so it never stops the request. And
an in-product promo card is first-party with no ad-shaped class or id at all, so
it can only be found by its badge text. The extension runs all three.

The promo tier is the one place matching is not based on an attribute, so it is
fenced in tightly: a leaf whose entire text is a label like `AD`, a card found
above it that holds a link or button, stays under 600 characters, contains no
code block or editor, and carries a single call to action. That last guard is
what stops the walk from climbing out of the card and taking the skill chips
below it.

The ruleset carries a priority-100 `allow` for freebuff.com's own traffic that
every block rule (all priority 1) loses against — your build and thinking stream
can never be blocked. See `extension/rules.md` for the full reasoning.

## Browsers

Firefox has no Manifest V3 service worker, so it needs `background.scripts` to
run the same file as an event page — and that key is Manifest V2 as far as
Chromium is concerned. Chrome 121+ ignores it rather than refusing to load, but
it still shows up as a **warning on `chrome://extensions`**. So the source
manifest stays Chromium-clean and `firefoxManifest()` in `scripts/build.mjs`
derives the Firefox one. Three differences, and each one is something AMO
complains about when it is missing or wrong:

| Key | Value in the Firefox package | Why |
| --- | --- | --- |
| `background` | `scripts` **only**, no `service_worker` | Firefox ignores that key and its validator says so in the report |
| `browser_specific_settings.gecko.id` | the add-on GUID | required to sign an MV3 add-on; Chromium-only keys are ignored |
| `…gecko.data_collection_permissions` | `{ "required": ["none"] }` | AMO blocks any new submission that does not declare what it collects, and nothing here collects anything |

`strict_min_version` is `142.0`. Desktop Firefox learned the data collection key
in 140, but AMO's validator holds the declared minimum against the Firefox for
Android floor of 142 too — even for a package that declares no Android support,
which this one does not — so anything lower leaves a warning in every validation
report.

Everything else is shared: the same `declarativeNetRequest` ruleset, the same
content script, the same popup. `npm run validate` fails if an MV2-only key
creeps back into the source manifest, or if the derived Firefox manifest loses
the event page, the gecko id or the `none` declaration — or picks the service
worker key back up.

One build writes three packages:

| File | For |
| --- | --- |
| `freebuff-adblock-<version>.zip` | load unpacked in Chromium — one tidy top-level folder |
| `freebuff-adblock-<version>-store.zip` | Chrome Web Store and Edge Add-ons — `manifest.json` at the archive root |
| `freebuff-adblock-<version>-firefox.zip` | addons.mozilla.org — the same, plus the event-page background |

The zips are reproducible: entries are stamped with the ZIP epoch rather than
the build time (or `SOURCE_DATE_EPOCH` when it is set), so two builds of the
same sources are byte-identical and a signed package can be matched back to a
commit.

## Desktop app

Freebuff Desktop renders its ads from a runtime it ships inside its own bundle —
`Contents/Resources/orchestrator/orchestrator.js`, which the bundled Bun runs.
That file is not in `app.asar`, and no browser extension can reach it, so the
desktop app needs a different tool rather than a different rule.

**macOS is the only build.** The install page's desktop section carries a
three-way platform switch — For macOS, For Windows, For Linux — and the latter
two are `disabled` in the markup: shown, greyed and unclickable rather than
hidden, because a missing tab reads as a missing feature. Shipping a second
platform means adding its `data-platform-panel` block and dropping that
attribute; the switch itself needs no change.

`desktop/freebuff-adblock.sh` is that tool. One file, no dependencies — macOS
already ships the `sh` and `perl` it uses:

```sh
curl -fsSL https://freebuff-adblocker.vercel.app/downloads/freebuff-adblock-desktop.sh | sh

sh freebuff-adblock.sh status    # what is applied, change nothing
sh freebuff-adblock.sh scan      # every anchor this build has, change nothing
sh freebuff-adblock.sh install   # patch, backing up first
sh freebuff-adblock.sh revert    # restore the untouched original
sh freebuff-adblock.sh doctor    # environment report, for a bug report
```

It edits only the ad code, at two counted anchors:

| Patch | Anchors | What it does |
| --- | --- | --- |
| `render` | 1 | forces the gate the ad auction consults to return "no ads to show" |
| `request` | 1 | the ad client's own request helper fails before it sends, so nothing at `/api/v1/ads/*` is reachable |

There is deliberately **no `post` patch any more**. The 0.0.155 tool had one, for
an ad helper that no longer exists: in 0.0.164 `async post(...)` matches the ad
break-event telemetry poster and the shipper that POSTs to `${API_HOST}/api/logs`,
so patching it would break Freebuff's own logging and block no ads. The `request`
anchor already stops the ad API from being reached.

0.0.155 also had two render gates (`displayAd` + `auction`); the `displayAd` one
is gone from **0.0.164**, which is the build the current anchors were verified
against. An older build with both gates is now refused rather than half-patched.

The safety story is the counting. Every anchor has to appear the exact number of
times the tool expects before it writes anything; a Freebuff version that renamed
a function leaves the counts at zero and the tool stops, rather than
half-patching a 9 MB file. The pristine file is copied to
`~/freebuff-patch-backups/orchestrator.js.<version>.orig` before the first write,
and `revert` puts it back.

Each anchor has two forms, so a rename is not automatically a dead end. The
first is the literal this tool was verified against; the second is a relaxation
of it — the same gate with the identifier renamed, the same helper with
`async`/`static` spelled differently. **A relaxation only counts when it appears
the expected number of times *and* ad code sits within 320 bytes of every hit**,
so a similarly shaped feature gate elsewhere in the bundle is never mistaken for
the ad render path. A write made through a relaxation is re-counted immediately
afterwards, and if the result disagrees the pristine copy goes straight back.

Everything under this product ships under **one version**. The extension and the
desktop tool are inspected together and released together, so the number in
`extension/manifest.json` names the browser packages, the desktop tool and its
package, the update feed and the tag on the site. `1.4.0` introduced relaxed
anchors and `scan`; **`1.4.1` is the release re-anchored for Freebuff Desktop
0.0.164**, which dropped one of the two render gates and moved the ad helpers.

When a patch still reports `not found`, that is the new build telling you where
it is: `scan` prints every candidate site it can see for each anchor — literal
and relaxed, with the surrounding code — plus a probe of stable tokens
(`displayAd`, `auction`, `agenticTestCampaign`, `gravity`, `sponsor`,
`track/click`), and saves the same report to
`~/freebuff-patch-backups/orchestrator-scan.<version>.txt`. It opens nothing for
writing, so it is safe to run on a build you have not patched.

Because the patches sit on the render entry points and the two request helpers,
they cover *any* slot the app renders, including ones added in a Freebuff release
this repo has never seen.

It writes inside an app bundle, so macOS App Management has to allow it. When
that is what blocked the write, the tool prints the exact System Settings path
instead of failing halfway through. It never asks for a password and never uses
`sudo`.

Two things it cannot do anything about, both stated on the install page:
Freebuff has to be quit and reopened after patching, because the orchestrator is
read once at launch; and every Freebuff update replaces `Resources/`, so the
patch is gone after one and the tool has to be run again.

`npm run test:desktop` exercises the whole thing against a throwaway bundle in a
temp directory: patch, idempotence, revert, `--display-only`, the refusal path,
and `--dry-run`. It never touches `/Applications` or the real backup folder.

Patching a third-party app's bundled code may conflict with that app's terms of
service. That is on the person running it, which is why nothing here does it
silently.

## The ad network, and what happens when it changes

The in-product slots are not hand-built by freebuff.com. They arrive from an ad
network, and the slots it injects carry three markers worth knowing:

| Marker | Meaning |
| --- | --- |
| `data-gravity-ad` (and `data-gravity-ad-*`) | the network's own slot attribute |
| `rel="… sponsored"` | the standard sponsored-link rel value |
| `href="…/track/click?…"` | the network's click endpoint |

Matching on the network's markers rather than on freebuff.com's layout is what
makes this hold in places we have never seen: a new slot anywhere in the app is
caught by the same attribute, without a screenshot and without a guess.

That still only covers what the network marks. **`npm test` covers the rest.**

### Slots that have to keep their place

The strip the network drops into the preview toolbar cannot be removed the way
the others are. It is wrapped in a full-width `flex` div that is itself one item
of the toolbar row, so taking the wrapper out of the flow collapses that item
and slides the controls beside it to the left.

Ads shaped that way are **emptied where they stand** instead: the stylesheet
makes the node invisible and un-clickable but leaves its box alone, so the row
keeps its exact width, and the script skips it rather than collapsing its
wrapper. Two conditions decide it - the ad is an item of a horizontal flex row,
and it holds no block-level content. A card that merely happens to sit in a row
has `div`s and `p`s in it, so it is still removed outright, wrapper included.

The popup's **Hide an element on the page** button is the part no heuristic can
replace. Click it, click an ad nothing recognised, and the rule is saved to
`chrome.storage.sync` and reapplied on every future visit. The picker builds the
most durable selector it can — a real attribute first, then an id, then any
`data-*` attribute, and a structural path only as a last resort, because
structural paths break the moment a layout changes.

Deliberate rules are applied last in every pass and are never second-guessed by
`rescue()`, so a rule you made by hand outranks anything inferred.

## Privacy

The extension has one host permission, no network requests of its own, and no
analytics. What it stores, and what it does not, is written out in
[`site/privacy.html`](site/privacy.html) — the policy both stores link to.

## Layout

```
extension/          the extension source
  manifest.json       MV3 manifest
  rules.json          declarativeNetRequest static ruleset
  rules.md            why the rules are shaped the way they are
  content.js          stylesheet injection + MutationObserver
  background.js       service worker (badge counter)
  popup.*             enable/disable popup + "is it running on this tab?"
  icons/              16/32/48/128, generated procedurally
scripts/            zero-dependency build tooling
  build.mjs           packages both zips, writes update.xml, emits dist/
  serve.mjs           preview server (builds first, binds 0.0.0.0)
  validate.mjs        static checks Chrome would otherwise only fail at load
  test-detection.mjs  jsdom checks: hides the ads, keeps the chat
  test-site.mjs       jsdom checks: the install page's store button
  zip.mjs             minimal ZIP writer
  png.mjs             minimal PNG encoder + icon artwork
  store-assets.mjs    promo tile, marquee, and the four listing screenshots
  gen-icons.mjs       force-regenerate icons
  build-desktop.mjs   stamps + packages the desktop tool into site/downloads
  test-desktop.mjs    desktop tool checks, against a throwaway bundle
desktop/            the macOS patch tool for the desktop app
  freebuff-adblock.sh      install / status / revert / doctor; the shipped file
  Freebuff AdBlock.command double-click launcher, packaged in the zip
  INSTALL.txt              the read-me that travels with the zip
site/               the install page and everything it serves
  index.html          markup; the version is stamped in at build time
  styles.css
  app.js              store-button detection (listing URLs in STORE_LINKS)
                      + the desktop section's platform switch
  privacy.html        the policy both stores link to
  store-assets/       the listing art
  downloads/          the built zips
dist/               static output - served by the preview and by hosting
LICENSE             MIT
PUBLISHING.md       step-by-step store submissions, plus the listing copy
```

There are no npm dependencies. Uploaded files lose their executable bit, so the
packaging step is plain Node rather than a `zip` shell-out.

## Commands

```sh
npm run build     # package both zips -> site/downloads, write site/update.xml, emit dist/
npm run preview   # build, then serve dist/ on 0.0.0.0:$PORT (default 4173)
npm run icons     # force-regenerate extension/icons
npm run assets    # redraw the store art: promo tile, marquee, screenshots
npm run check     # syntax-check the build tooling
npm run validate  # static checks: manifest, icons, DNR rules, selectors, desktop tool
npm test          # jsdom checks for the content script and the install page,
                  # then the desktop tool's shell checks
                  # (jsdom needs `npm i --no-save jsdom`)
npm run test:desktop  # just the desktop tool checks - no jsdom, no app bundle
```

## Hosting

`dist/` is the whole deployment: a static directory, no server, no build-time
secrets. `scripts/build.mjs` stamps the public origin into `site/update.xml`
and into the download links, so it has to match where the site is actually
served; `SITE_ORIGIN` overrides the default.

`extension/popup.js` (`INSTALL_URL`) points at the same origin, and
`npm run validate` fails if the two drift apart, because a mismatch is a dead
link in the popup and a dead `codebase` in the feed rather than anything visible
here.

## Auto-updates

`site/update.xml` is regenerated with every build with the matching version and
codebase URL, but **Chrome only consults an update feed for an extension
installed from that feed** — via a managed `ExtensionInstallForcelist` policy or
the Chrome Web Store. An extension loaded unpacked never polls it.

Before the feed goes live, replace `YOUR_EXTENSION_ID_HERE` with the packed
extension's real ID and point `codebase` at a signed CRX. The install page
explains both routes to the user rather than implying unpacked extensions
update themselves.

## Scope

Two apps, two tools. The **web version** is covered by the extension in
`extension/`, which can only reach pages Chromium renders, so it stops there.
The **desktop app** is a separate bundle with no extension surface, so it is
covered by the local tool in `desktop/` instead. Neither has a server, an account
or a telemetry endpoint, and neither touches anything but freebuff.com and the
machine it runs on.

## License

MIT — see [`LICENSE`](LICENSE).

In short: use it, fork it, ship it, sell it, keep your changes to yourself if
you like. The only condition is that the copyright notice and this permission
notice travel with any copy or substantial portion of the code.

Every store form that asks which licence you grant — addons.mozilla.org, the
Edge Add-ons dashboard — should be answered **MIT License**, so the listing and
this repository say the same thing.
