# Publishing Freebuff Ad Block

Three stores, two packages, one $5 payment. Work top to bottom — Chrome first,
because the same file goes to Edge, and Firefox is a different package.

| Store | Cost | Package | Reaches |
| --- | --- | --- | --- |
| Chrome Web Store | **$5 once, per account** | `-store.zip` | Chrome, Brave, Opera, Vivaldi, Comet, Arc… |
| Microsoft Edge Add-ons | Free | `-store.zip` (the same file) | Edge |
| addons.mozilla.org | Free | `-firefox.zip` | Firefox, LibreWolf, Floorp, Waterfox… |

Build the packages first:

```sh
npm run build     # writes the extension zips (and the desktop tool) into site/downloads/
```

---

## 0. Assets you need before starting

Some of these do not exist yet. The ones marked **MISSING** are what actually
gates the first submission.

- [x] Extension icon, 128×128 — `extension/icons/icon128.png`
- [x] Flat package with `manifest.json` at the root — `freebuff-adblock-1.3.0-store.zip`
- [x] Firefox package with the event-page background — `freebuff-adblock-1.3.0-firefox.zip`
- [x] Small promo tile at **440×280** — `site/store-assets/promo-440x280.png`
- [x] Marquee at **1400×560** (Chrome only, optional) — `site/store-assets/marquee-1400x560.png`
- [x] Four screenshots at **1280×800** — `site/store-assets/screenshot-*.png`
- [x] A privacy policy **URL** — <https://freebuff-adblocker.vercel.app/privacy>
- [ ] Publisher **contact email** — `workofma@gmail.com`, entered *and* verified in
      the store's own **Settings** page. Unverified, neither store will publish.

### Screenshots

`npm run assets` draws four, each exactly **1280×800**, 24-bit RGB, no alpha —
the size and colour type both stores accept, with no transparency to reject.

| File | Shows |
| --- | --- |
| `screenshot-1-chat-1280x800.png` | the chat mid-build with its slots cleared, beside the three tiers |
| `screenshot-2-popup-1280x800.png` | the popup, annotated: the switch, the live count, the picker |
| `screenshot-3-layers-1280x800.png` | why there are three detection tiers and not one |
| `screenshot-4-scope-1280x800.png` | the one host it asks for, and what it never reads |

These are **composed artwork**, drawn from the extension's own interface rather
than captured from a running browser — the build environment has no browser to
capture in. Every claim in them is true of the product (the slots, the switch,
the counter and the picker all exist), but they are illustrations, so say so if
a reviewer asks.

To add a real capture instead, and it is the stronger submission if you have
five minutes:

1. Load the unpacked extension and open freebuff.com with an ad showing.
2. `Ctrl+Shift+M` for the device toolbar, then set the size to **1280×800**.
3. `Ctrl+Shift+P` → **Capture screenshot**. That writes page content only, as a
   24-bit PNG with no alpha — exactly what both stores want.
4. Upload it as a fifth screenshot; keep the composed ones for the frames a
   screenshot cannot show (the layers, the scope).

---

## 1. Chrome Web Store

**One-time $5.** Covers every extension you ever publish on that account.

1. Sign in at <https://chrome.google.com/webstore/devconsole> with the Google
   account you want to own this. Pick that account deliberately — it cannot be
   moved later.
2. Accept the developer agreement and pay the **$5** registration fee. Turn on
   2FA for the account; the dashboard requires it.
3. Click **Add new item**, upload `freebuff-adblock-1.3.0-store.zip`.
4. **Store listing** tab — name, short description, detailed description
   (copy is in the section at the bottom of this file), category, language,
   and the icon, screenshots and promo tile.
5. **Privacy** tab — set the single purpose, tick the data-usage answers, and
   justify each permission. Draft answers are below. This is where ad-blocking
   extensions get the most scrutiny, so be specific and match the code.
6. **Distribution** tab — visibility **Public**, **Unlisted** or **Private**:

   | Visibility | Who can install |
   | --- | --- |
   | Public | anyone, and it appears in search |
   | **Unlisted** | anyone **with the link**. No listing, no search presence |
   | Private | only your listed trusted testers |

   Unlisted goes through the same review and meets the same policies. It is the
   right choice if you want one-click installs without a public listing.
7. **Submit for review.** You can uncheck auto-publish and release it manually
   once approved, which is useful for coordinating all three stores at once.
8. Note the **extension ID** once it is live — `chrome://extensions` → Details.
   That is what `update.xml` needs if you ever self-host.

**Watch out for:** the dashboard refuses to publish anything until the
**publisher contact email** is set *and verified* on the **Settings** page.
Enter `workofma@gmail.com`, click **Verify**, and open the message it sends -
it lands in spam more often than not. An unverified address is the usual cause
of *"You must verify the publisher's contact email"*, just as an unpushed
privacy page is the usual cause of *"Privacy policy link is not reachable"*.

**Watch out for:** a new publisher account is capped at **two published
extensions**. Your current limit is shown in the dashboard, and there is a
**request an increase** button when you hit it. Decisions are immediate or take
a few days, and are based on engagement and account tenure. Themes do not count
against the limit.

---

## 2. Microsoft Edge Add-ons

Free, but a separate account from Chrome. Same zip — no changes needed.

1. Register as a Microsoft Edge extension developer at
   <https://partner.microsoft.com>. Use a **personal Microsoft account**
   (outlook.com / live.com / hotmail.com). Work or school accounts frequently
   cannot register for this program.
2. In Partner Center, **Home → Workspaces → Edge → Create new extension**.
3. Drag in `freebuff-adblock-1.3.0-store.zip`. Partner Center validates the
   manifest and reports errors immediately — fix and re-upload if it complains.
4. **Availability** — Visibility **Public**, or **Hidden** to keep it out of
   search while still installable by link. Pick your markets.
5. **Properties** — category, and any support/website links. Point the website
   at <https://freebuff-adblocker.vercel.app/>.
6. **Privacy** — this tab is mandatory and asks more than Chrome's:
   - state the extension's purpose
   - justify every permission
   - declare whether you use remote code (**no**)
   - certify data usage (**collects nothing**)
   - **set a privacy policy URL** — <https://freebuff-adblocker.vercel.app/privacy>
7. **Store listing** — per language: description, screenshots, promo tile.
8. **Testing notes** — free text for the reviewer. Use one line: *no account
   needed; open freebuff.com and ads in the chat are hidden.*
9. **Submit.** Review is human and typically takes several business days.

**Watch out for:** the manifest `name` and `description` are read-only from the
package and pre-fill the listing. Ours are already written to read well.

---

## 3. Firefox (addons.mozilla.org)

Free. **This one uses the other zip** — `-firefox.zip`, which carries the gecko
id, the AMO data-collection declaration and a `background.scripts` event page,
and drops `background.service_worker` outright. All four are things the Chromium
package must not have, and the source `extension/manifest.json` stays clean.

1. Create a Firefox Account, then open
   <https://addons.mozilla.org/developers/> and register as a developer.
2. Choose your distribution, because it decides everything downstream:

   | Channel | What it does |
   | --- | --- |
   | **Listed** | public page on AMO, appears in search, installs from AMO |
   | **Unlisted / self-distribution** | AMO signs it, no public page. You host the signed `.xpi` |

3. Upload `freebuff-adblock-1.3.0-firefox.zip` (rename to `.xpi` if you prefer —
   the bytes are identical). It should validate as **0 errors, 0 warnings, 0
   notices** across all five categories. To see that report before uploading,
   run the same linter AMO runs — no dependency is added to the project, this
   fetches it on the spot:

   ```
   npx --yes addons-linter@10.13.0 site/downloads/freebuff-adblock-1.3.0-firefox.zip
   ```
4. Both channels go through **manual review**. Unlisted is usually signed
   quickly, but it is not automatic and can queue behind a queue. Do not plan
   around it being instant.
5. If you went **unlisted**, download the signed `.xpi`, drop it into
   `site/downloads/`, and serve it with:

   ```
   Content-Type: application/x-xpinstall
   ```

   Our `vercel.json` currently forces `Content-Disposition: attachment` on
   everything under `/downloads/*`, which fights the install prompt. A
   self-hosted XPI needs its own header rule.

**License:** the form asks which licence you grant. Answer **MIT License** —
that is what `LICENSE` in this repository says, and the two have to agree. The
source is public, so picking anything more restrictive here would contradict the
repo.

**Watch out for:** the gecko id in the Firefox manifest is
`{7b3d9c4a-1e62-4f58-9c07-2ab5e8d41f93}`. It is effectively permanent — changing
it later makes the add-on a **different** add-on and breaks updates for anyone
who installed it.

**Watch out for:** `browser_specific_settings.gecko.data_collection_permissions`
is `{ "required": ["none"] }` — this extension has no server and transmits
nothing. AMO requires the key from every new submission and
blocks one that omits it, so it must survive every future rebuild, and the
declared value has to stay true. Once a version ships it, later versions have to
keep it. `strict_min_version` is `142.0`: AMO's validator checks the declared
minimum against the Firefox for Android floor for that key as well, so anything
lower reports a warning even though this package is desktop-only.

For scripted signing instead of the web upload, add these in
Settings → Environment and hand them over:

- `WEB_EXT_API_KEY`
- `WEB_EXT_API_SECRET`

---

## 4. After the first listing is approved

The site is already built to switch over automatically. Paste the listing URLs
into `STORE_LINKS` at the top of `site/app.js`:

```js
const STORE_LINKS = {
  chrome: 'https://chromewebstore.google.com/detail/<slug>/<extension-id>',
  edge: 'https://microsoftedge.microsoft.com/addons/detail/<slug>/<extension-id>',
  firefox: 'https://addons.mozilla.org/firefox/addon/<slug>/',
};
```

Any store left empty keeps its button hidden, so this is safe to fill in one at
a time. Then `npm run build` and redeploy. The hero button will read
**Add to Chrome / Edge / Firefox** for whoever is looking at it, and the zip
demotes to a "manual install" fallback.

`npm test` covers this: it loads the real page for each browser and checks the
label, the link, and that the button is absent when there is no listing.

## 5. Shipping an update

1. Bump `"version"` in `extension/manifest.json`.
2. `npm run build && npm test && npm run validate`
3. Upload the new zips. Stores review updates, then roll them out themselves —
   nothing to do on our side.
4. If you self-host the Firefox `.xpi`, replace the file and keep the same
   filename pattern the build stamps in.

---

## 6. The desktop tool

The desktop app is **not** a store submission and has no listing. It ships as a
file on this site, so there is no review, no signing and no fee — `npm run build`
stamps and packages it into `site/downloads/` alongside the extension zips:

| File | For |
| --- | --- |
| `freebuff-adblock-desktop.sh` | the `curl … | sh` one-liner on the install page |
| `freebuff-adblock-desktop-<version>.zip` | the download button: the same script, a double-clickable launcher, `INSTALL.txt` |

Both carry the same version as `extension/manifest.json`, so one bump moves
everything. The zip stores Unix permission bits, which is what keeps the
launcher executable after extraction — a bare file served over HTTP loses that
bit, which is why the one-liner pipes the script into `sh` rather than
executing it.

The desktop tool is verified by `npm run test:desktop` and by `npm run validate`
(shell syntax, the build placeholders, and all three patch markers), so a release
checklist is the same as any other: `npm run build && npm test && npm run validate`.

---

## Copy to paste into the listings

**Name:** `Freebuff Ad Block`

**Short description** (fits Chrome's 132-character limit):

> Site-scoped ad blocker for freebuff.com. No accounts, no tracking, no remote code.

**Detailed description:**

> Freebuff Ad Block removes the advertising slots that appear in the freebuff.com
> web app — including the ones injected while a build is running, which never
> make a separate network request and so are invisible to a normal blocklist.
>
> It works in three layers: network rules that stop ad requests before they leave
> the tab, a DOM layer that clears out slots rendered mid-build, and a picker you
> can use to hide anything the heuristics miss.
>
> **Scoped to one site.** It only ever touches freebuff.com. Requests are matched
> only when they originate from a freebuff.com page, so it does not follow you
> anywhere else.
>
> **Nothing leaves your browser.** No accounts, no analytics, no telemetry, no
> remote code. The only stored data is your on/off setting and any element rules
> you create yourself, kept in the browser's own synced storage.
>
> **It cannot break your build.** A priority-100 allow rule covers freebuff.com's
> own traffic, so the streaming response is never matched by a block rule.

**Single purpose:**

> Hides the advertising slots that freebuff.com renders inside its own interface.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `declarativeNetRequest` | Blocks requests to known ad-network hosts that originate from freebuff.com pages. |
| `storage` | Stores the on/off setting and any element rules the user adds by hand. |
| Host access: `*://freebuff.com/*`, `*://*.freebuff.com/*` | The content script must read the page to find and hide ad slots. No other site is accessed. |

**Data usage:** does not collect or transmit any user data; does not use remote
code; does not sell or transfer data to third parties.

**Privacy statement** (for the privacy policy URL Edge requires):

> Freebuff Ad Block collects nothing. It has no server, no analytics and no
> accounts, and it makes no network requests of its own.
>
> All processing happens locally in your browser. The only data it stores is your
> on/off preference and any element rules you create with the picker, both kept in
> the browser's own extension storage and optionally synced by your browser
> vendor's account — never sent to us.
>
> The extension only runs on freebuff.com. It cannot read or modify any other
> site.
