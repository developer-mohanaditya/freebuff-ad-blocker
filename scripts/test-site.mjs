/**
 * Install-page checks: does the store button name the browser in front of it,
 * and does it stay out of the way when there is no listing to point at?
 *
 * Loads site/index.html into jsdom and runs site/app.js against a stubbed
 * navigator for each browser that matters, substituting listing URLs into
 * STORE_LINKS so both states are exercised without editing the page.
 *
 * jsdom is deliberately not a project dependency, so this skips itself when it
 * is absent. To run the checks:  npm install --no-save jsdom && npm test
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('jsdom is not installed - skipping install-page checks.');
  console.log('  npm install --no-save jsdom');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'site', 'app.js'), 'utf8');

/**
 * The version the page has to advertise, read from the manifest rather than
 * written here: one product, one number, and a test that hardcodes it is just
 * one more place to forget on the next release.
 */
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')
).version;

/**
 * The listing URLs as they actually ship, read straight out of STORE_LINKS.
 * Every other check substitutes a stub URL, so this is the only place the real
 * ones are held to anything - a blank `chrome:` would hide the button for every
 * Chromium reader and nothing else would notice.
 */
const LIVE = Object.fromEntries(
  [...APP.slice(APP.indexOf('const STORE_LINKS'), APP.indexOf('};', APP.indexOf('const STORE_LINKS')))
    .matchAll(/^\s*([a-z]+):\s*'([^']*)'/gm)]
    .map(([, store, url]) => [store, url])
);

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const EDGE = CHROME.replace('Chrome/121.0.0.0', 'Chrome/121.0.0.0 Edg/121.0.0.0');
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const LISTINGS = {
  chrome: 'https://store.test/chrome',
  edge: 'https://store.test/edge',
  firefox: 'https://store.test/firefox',
};

/**
 * Replace listing URLs in STORE_LINKS the same way a person would, in the
 * source text. An empty string is a store with no listing, so the "nothing to
 * point at" state is exercised without deleting the key. If the shape of that
 * block ever changes this throws rather than silently testing nothing.
 */
function withListings(source, links) {
  let out = source;
  for (const [store, url] of Object.entries(links)) {
    const pattern = new RegExp(`(\\b${store}:\\s*)'[^']*'`);
    if (!pattern.test(out)) {
      throw new Error(`could not set STORE_LINKS.${store} - the shape of that block changed`);
    }
    // A store that is already blank is a no-op, not a failure.
    out = out.replace(pattern, `$1'${url}'`);
  }
  return out;
}

/**
 * Load the page with a given browser attached and listing URLs in place.
 *
 * The user agent is defined on the navigator directly: jsdom's `userAgent`
 * option only sets the header its own requests carry, and navigator.userAgent
 * always answers with jsdom's built-in string regardless.
 */
function open({ ua, brands, brave, links = {}, html = HTML, clipboard, secure, execCommand } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/' });

  const { window } = dom;
  const { document } = window;

  if (ua) {
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  }

  if (brands) {
    Object.defineProperty(window.navigator, 'userAgentData', {
      value: { brands: brands.map((brand) => ({ brand, version: '121' })) },
      configurable: true,
    });
  }

  if (brave) {
    Object.defineProperty(window.navigator, 'brave', {
      value: { isBrave: () => true },
      configurable: true,
    });
  }

  // Both clipboard routes are optional and are installed before app.js runs, so
  // each branch of the copy handler can be exercised on purpose.
  if (clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: clipboard },
      configurable: true,
    });
  }

  if (secure) {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  }

  if (execCommand) {
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
  }

  const script = document.createElement('script');
  script.textContent = withListings(APP, links);
  document.body.appendChild(script);

  const heroLinks = [...document.querySelectorAll('.cta-row a')];

  return {
    window,
    document,
    button: document.querySelector('[data-store-button]'),
    heroLinks,
    zip: document.querySelector('[data-zip]'),
    tabs: [...document.querySelectorAll('[data-platform]')],
    copyButtons: [...document.querySelectorAll('[data-copy]')],
  };
}

/** Let an async click handler finish before its result is read. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const results = [];
const show = (value) => {
  if (value === null) return 'no button';
  if (value && value.nodeType) return `<${value.tagName.toLowerCase()}>`;
  return JSON.stringify(value);
};
const check = (name, actual, expected) => {
  const ok = actual === expected;
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name} -> ${show(actual)} (want ${show(expected)})`);
};

const label = (button) => (button ? button.textContent.trim() : null);
const href = (button) => (button ? button.getAttribute('href') : null);
const shown = (button) => !!button && button.hidden === false;

/* ------------------------------------------------------------ no listing yet */

console.log('\nno listing published');
const none = open({ ua: CHROME, links: { chrome: '', firefox: '' } });
check('no store button is offered', none.button, null);
check('the desktop button is still there', label(none.heroLinks.at(-1)), 'For Desktop');
check('the manual path is still on the page', none.zip !== null, true);

/* -------------------------------------------------------- chrome and chromium */

console.log('\nchrome listing, read in chrome');
const chrome = open({ ua: CHROME, links: { chrome: LISTINGS.chrome } });
check('the button appears', shown(chrome.button), true);
check('it names the browser', label(chrome.button), 'Add to Chrome');
check('it points at the listing', href(chrome.button), LISTINGS.chrome);
check('the hero is two buttons, not four', chrome.heroLinks.length, 2);
check('the second one is the desktop jump', href(chrome.heroLinks[1]), '#desktop');

console.log('\nedge listing, read in edge');
const edge = open({ ua: EDGE, links: { edge: LISTINGS.edge } });
check('it names the browser', label(edge.button), 'Add to Edge');
check('it points at the edge store', href(edge.button), LISTINGS.edge);

const edgeBrands = open({
  ua: CHROME,
  brands: ['Not/A)Brand', 'Chromium', 'Microsoft Edge'],
  links: { edge: LISTINGS.edge },
});
check('edge named only by its own brand', label(edgeBrands.button), 'Add to Edge');

console.log('\nedge, before Edge Add-ons has a listing');
const edgeUnlisted = open({
  ua: EDGE,
  links: { edge: '', chrome: LISTINGS.chrome, firefox: LISTINGS.firefox },
});
check('no button, and no guess at another store', edgeUnlisted.button, null);

/* ------------------------------------------------------------------- firefox */

console.log('\nfirefox listing, read in firefox');
const firefox = open({ ua: FIREFOX, links: { firefox: LISTINGS.firefox } });
check('it names the browser', label(firefox.button), 'Add to Firefox');
check('it points at addons.mozilla.org', href(firefox.button), LISTINGS.firefox);
check('the same one button serves both engines', firefox.heroLinks.length, 2);

console.log('\nbrowser with no listing of its own');
const mismatched = open({ ua: FIREFOX, links: { chrome: LISTINGS.chrome, firefox: '' } });
check('a chrome-only listing shows nothing in firefox', mismatched.button, null);

/* ------------------------------------------------------- self-reported brands */

console.log('\nbrowser we have never enumerated');
const unknown = open({
  ua: CHROME,
  brands: ['Chromium', 'Coc Coc', 'Not/A)Brand'],
  links: { chrome: LISTINGS.chrome },
});
check('it keeps the name it reported', label(unknown.button), 'Add to Coc Coc');
check('it takes the store that serves every Blink browser', href(unknown.button), LISTINGS.chrome);

const brave = open({ ua: CHROME, brave: true, links: { chrome: LISTINGS.chrome } });
check('brave is named by its own tell', label(brave.button), 'Add to Brave');

/* ------------------------------------------------------------------- safari */

console.log('\nsafari, with every listing live');
const safari = open({ ua: SAFARI, links: LISTINGS });
check('no button, because there is no build it could install', safari.button, null);
check('safari still gets the desktop section', label(safari.heroLinks.at(-1)), 'For Desktop');

/* ---------------------------------------------------------------------- page */

console.log('\nthe page itself');

const page = open({ ua: CHROME, links: LISTINGS });
const headline = page.document.querySelector('h1').textContent.replace(/\s+/g, ' ').trim();

check('the hero says the ads disappear', headline, 'The ads disappear. The build keeps streaming.');
check('"How to install" is gone from the hero', page.heroLinks.filter((a) => a.getAttribute('href') === '#install').length, 0);
check('three platform tabs are offered', page.tabs.length, 3);
check('macOS is the one that is selectable', page.tabs.filter((t) => !t.disabled).map((t) => t.dataset.platform).join(','), 'macos');
check('windows and linux are disabled', page.tabs.filter((t) => t.disabled).map((t) => t.dataset.platform).join(','), 'windows,linux');
check('the macOS panel is the one on screen', page.document.querySelectorAll('[data-platform-panel]:not([hidden])').length, 1);

// One product, one version: the extension and the desktop tool are inspected
// and released together, so the tag, the footer and every file name carry the
// same number - and nothing may regress into labelling two tracks.
const tag = page.document.querySelector('.topbar [data-version]');
check('the navbar has exactly one version stamp', page.document.querySelectorAll('.topbar [data-version]').length, 1);
check(`the navbar tag reads v${VERSION}`, tag.textContent, VERSION);
check('no second version rides along anywhere', page.document.querySelectorAll('[data-desktop-version]').length, 0);

const downloads = [...page.document.querySelectorAll('a[href^="downloads/"]')].map((a) => a.getAttribute('href'));
check(`the extension zip is a ${VERSION} file`, downloads.includes(`downloads/freebuff-adblock-${VERSION}.zip`), true);
check(`the desktop package is a ${VERSION} file`, downloads.includes(`downloads/freebuff-adblock-desktop-${VERSION}.zip`), true);
check(`every named file carries ${VERSION}`, downloads.filter((h) => /\d+\.\d+\.\d+/.test(h)).every((h) => h.includes(VERSION)), true);

const footerText = page.document.querySelector('.footer p').textContent.replace(/\s+/g, ' ').trim();
check('the footer reads the same version', footerText.includes(`Freebuff Ad Block · v${VERSION}`), true);

// The listings as they ship - the stubs above never reach these values.
check('chrome points at the Chrome Web Store listing', LIVE.chrome, 'https://chromewebstore.google.com/detail/hgkegdgnihnifjmgnihohlaemaafhlgm');
check('firefox points at the addons.mozilla.org listing', LIVE.firefox, 'https://addons.mozilla.org/en-US/firefox/addon/freebuff-ad-block/');

/* ------------------------------------------------------------- the switch */

/**
 * The switch only has one platform today, so the interesting behaviour is the
 * one that has no content yet: enable a second tab, give it a panel, and check
 * the control actually swaps them. Otherwise "just add a panel later" is an
 * untested promise.
 */
console.log('\nwhen a second platform ships');

const secondPlatform = HTML
  .replace('data-platform="windows"\n            disabled\n', 'data-platform="windows"\n')
  .replace(
    '<div class="split" data-platform-panel="macos">',
    '<div class="split" data-platform-panel="windows" hidden></div><div class="split" data-platform-panel="macos">'
  );

const switching = open({ ua: CHROME, links: LISTINGS, html: secondPlatform });
const windowsTab = switching.tabs.find((tab) => tab.dataset.platform === 'windows');
const panel = (name) => switching.document.querySelector(`[data-platform-panel="${name}"]`);

check('its tab can be enabled', windowsTab.disabled, false);
check('macOS starts out on screen', panel('macos').hidden, false);

windowsTab.click();

check('clicking it shows its panel', panel('windows').hidden, false);
check('and takes macOS off screen', panel('macos').hidden, true);
check('the tab itself reads as selected', windowsTab.getAttribute('aria-selected'), 'true');

/* ----------------------------------------------------------- copy buttons */

/**
 * The page has two copy rows and they must both work. The bug this exists for:
 * app.js bound `document.querySelector('[data-copy]')`, so only the download
 * path's button had a listener and the desktop one-liner's button did nothing at
 * all. `copyButtons.length` is asserted first, so this can never pass by finding
 * a single button.
 */
console.log('\nthe copy buttons');

let copied = null;
const secureCopy = open({
  ua: CHROME,
  links: LISTINGS,
  secure: true,
  clipboard: async (value) => {
    copied = value;
  },
});

const command = secureCopy.document.querySelector('[data-desktop-command]').textContent.trim();
const downloadPath = secureCopy.document.querySelector('[data-download-path]').textContent.trim();

check('both copy rows are on the page', secureCopy.copyButtons.length, 2);
check('every copy button is labelled Copy', secureCopy.copyButtons.every((b) => b.textContent.trim() === 'Copy'), true);

secureCopy.copyButtons[1].click();
await settle();
check('the desktop button copies the command beside it', copied, command);
check('and the command is the curl one-liner', /^curl -fsSL https:\/\/\S+ \| sh$/.test(copied || ''), true);
check('the button confirms it copied', secureCopy.copyButtons[1].textContent, 'Copied');

copied = null;
secureCopy.copyButtons[0].click();
await settle();
check('the first button copies its own row, not the command', copied, downloadPath);
check('which is the download path, not the command', copied === command, false);

// A denied clipboard permission must not leave the button silent.
const denied = open({
  ua: CHROME,
  links: LISTINGS,
  secure: true,
  clipboard: async () => {
    throw new Error('denied');
  },
  execCommand: () => true,
});

denied.copyButtons[1].click();
await settle();
check('a denied clipboard falls back to the selection route', denied.copyButtons[1].textContent, 'Copied');
check('and the button still reads as successful', denied.copyButtons[1].dataset.state, 'done');

// The plain-http case: no Clipboard API at all, and execCommand refuses.
const insecure = open({
  ua: CHROME,
  links: LISTINGS,
  execCommand: () => false,
});

insecure.copyButtons[1].click();
await settle();
check('with no clipboard API the text is selected instead', insecure.copyButtons[1].textContent, 'Press Ctrl+C');
check('the button reports that state', insecure.copyButtons[1].dataset.state, 'warn');
check(
  'and the selection really holds the command',
  insecure.window.getSelection().toString().trim(),
  command
);

// Clicking twice inside the flash window must not leave the button permanently
// claiming "Copied" - the label to restore is fixed when the button is bound.
console.log('\nthe copy button clicked twice');

const rapid = open({ ua: CHROME, links: LISTINGS, secure: true, clipboard: async () => {} });
rapid.copyButtons[1].click();
await settle();
rapid.copyButtons[1].click();
await settle();
check('it still reads as copied straight after', rapid.copyButtons[1].textContent, 'Copied');

await new Promise((resolve) => setTimeout(resolve, 1750));
check('and the label does come back to Copy', rapid.copyButtons[1].textContent, 'Copy');
check('with its state cleared', rapid.copyButtons[1].dataset.state, undefined);

/* ------------------------------------------------------------ stale cache */

/**
 * The build stamps the version into the page, and app.js re-reads it from
 * version.json. jsdom has no fetch, so this stubs one: if a stamp stops being
 * healed, a cached page shows the previous version beside the current one - and
 * a zip named after a build that is no longer there - which is the shape of the
 * bug this replaced.
 */
console.log('\na stale cache is healed from version.json');

const cached = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.test/' });
cached.window.fetch = async () => ({
  ok: true,
  json: async () => ({ version: '9.9.9', zip: 'downloads/freebuff-adblock-9.9.9.zip' }),
});

const cachedScript = cached.window.document.createElement('script');
cachedScript.textContent = APP;
cached.window.document.body.appendChild(cachedScript);
await new Promise((resolve) => setTimeout(resolve, 0));

const stamps = [...cached.window.document.querySelectorAll('[data-version]')];
check('every version stamp on the page heals', stamps.length >= 3 && stamps.every((el) => el.textContent === '9.9.9'), true);
check(
  'the zip link follows the healed version',
  cached.window.document.querySelector('[data-zip]').getAttribute('href'),
  'downloads/freebuff-adblock-9.9.9.zip'
);

const failed = results.filter((r) => !r).length;
console.log('');
if (failed) {
  console.error(`${failed} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`All ${results.length} checks passed.`);
