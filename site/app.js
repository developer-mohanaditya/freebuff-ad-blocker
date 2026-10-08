/**
 * Install page behaviour.
 *
 * Progressive enhancement only - the page is fully readable with JS disabled,
 * which is why the reveal styles are gated behind the `js` class set here.
 */

document.documentElement.classList.add('js');

/* ------------------------------------------------------------ reveal on scroll */

const revealables = document.querySelectorAll('.reveal');

if ('IntersectionObserver' in window && revealables.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
  );

  revealables.forEach((el, index) => {
    el.style.transitionDelay = `${Math.min(index % 3, 2) * 70}ms`;
    observer.observe(el);
  });
} else {
  revealables.forEach((el) => el.classList.add('in'));
}

/* ---------------------------------------------------------------- store links */

/**
 * Store listings. Paste a listing URL in when it goes live. A browser whose
 * store is still empty gets no button, so the page can never show a dead link.
 *
 * The zip stays regardless. It is the only path that works before a listing
 * exists, the only one that needs no review, and the only one that reaches a
 * browser with no store of its own.
 */
const STORE_LINKS = {
  chrome: '',
  edge: '',
  firefox: '',
};

/**
 * Chromium browsers will name themselves when asked, through
 * `userAgentData.brands`, and that answer is used before anything is guessed:
 * a fork nobody has heard of still gets its own label rather than being reported
 * as Chrome. Firefox and Safari implement no such API, so the user-agent table
 * further down is the fallback for them.
 *
 * Brand string -> the name to show and the store that serves it. A brand that is
 * not listed is still a Blink browser, so it keeps the name it reported and
 * takes the Chrome Web Store, which serves all of them.
 */
const BRAND_STORES = {
  'google chrome': { name: 'Chrome', store: 'chrome' },
  'microsoft edge': { name: 'Edge', store: 'edge' },
  opera: { name: 'Opera', store: 'chrome' },
  brave: { name: 'Brave', store: 'chrome' },
  vivaldi: { name: 'Vivaldi', store: 'chrome' },
};

/**
 * Brands that carry no information: the mandated grease entry, and Chromium
 * itself, which every Blink browser lists beside its real name.
 */
const NOISE_BRAND = /not.?a.?brand|^chromium$/i;

/** What the browser says it is, or null when it does not say. */
function selfReportedBrowser() {
  const list = navigator.userAgentData?.brands || [];
  const named = list
    .map((entry) => entry && entry.brand)
    .filter((brand) => typeof brand === 'string' && brand && !NOISE_BRAND.test(brand));

  if (!named.length) return null;

  // Only one real brand survives the filter, and the vendor shuffles the order,
  // so take the last rather than trusting a position.
  const brand = named[named.length - 1].trim();
  return BRAND_STORES[brand.toLowerCase()] || { name: brand, store: 'chrome' };
}

/**
 * Browser -> the store that serves it, for browsers that do not name
 * themselves. First match wins, so specific names come before the generic ones,
 * and Safari comes last: its user agent also claims to be Chrome on iOS and
 * Firefox on Android, so it only matches when no other name fits.
 *
 * Every Chromium browser installs from the Chrome Web Store. That is why an
 * unrecognised browser falls through to it rather than to nothing - a wrong
 * guess costs a label, never an install. `store: null` means there is no store
 * this build can reach for that browser at all.
 */
const BROWSERS = [
  { name: 'Brave', store: 'chrome', test: /brave/i },
  { name: 'Comet', store: 'chrome', test: /comet/i },
  { name: 'Edge', store: 'edge', test: /edg/i },
  { name: 'Vivaldi', store: 'chrome', test: /vivaldi/i },
  { name: 'Opera', store: 'chrome', test: /opr|opera/i },
  { name: 'Firefox', store: 'firefox', test: /firefox|fxios/i },
  {
    name: 'Safari',
    store: null,
    // Safari is the only engine that pairs Version/ with Safari/ and does not
    // claim to be something else. That Version/ requirement is what stops a
    // stripped Blink user agent from being read as Safari and losing a button
    // that would have worked.
    test: /version\/[\d.]+.*safari\//i,
    not: /chrome|chromium|crios|edg|opr|firefox|fxios/i,
  },
  { name: 'Chrome', store: 'chrome', test: /chrome|chromium|crios/i },
];

/** The browser this page is being read in, or null when nothing matches. */
function detectBrowser() {
  // Brave ships no distinguishing user agent string, and its brand does not
  // always appear in the list either. This is its own tell.
  if (navigator.brave) return { name: 'Brave', store: 'chrome' };

  const reported = selfReportedBrowser();
  if (reported) return reported;

  // Firefox and Safari implement neither, so the user agent is all that is left.
  const haystack = navigator.userAgent || '';

  return (
    BROWSERS.find(
      (browser) =>
        browser.test.test(haystack) && !(browser.not && browser.not.test(haystack))
    ) || null
  );
}

const storeButton = document.querySelector('[data-store-button]');

if (storeButton) {
  // An unknown browser is treated as Chromium, because a Chrome Web Store link
  // works in all of them - a useful button beats no button.
  const browser = detectBrowser() || { name: 'Chrome', store: 'chrome' };
  const url = browser.store ? STORE_LINKS[browser.store] : '';

  if (!url) {
    // No listing for this browser yet, so the zip below is the honest path.
    storeButton.remove();
  } else {
    storeButton.textContent = `Add to ${browser.name}`;
    storeButton.href = url;
    storeButton.rel = 'noopener';
    storeButton.hidden = false;

    // With a one-click install on offer, the zip is the fallback rather than
    // the headline - so it steps back and says what it is.
    document.querySelectorAll('[data-zip]').forEach((el) => {
      el.classList.replace('btn-primary', 'btn-ghost');
      const meta = el.querySelector('.btn-meta');
      if (meta) meta.textContent = 'manual install';
    });
  }
}

/* ----------------------------------------------------------------- copy path */

const copyButton = document.querySelector('[data-copy]');

if (copyButton) {
  copyButton.addEventListener('click', async () => {
    const code = copyButton.parentElement.querySelector('code');
    const value = code ? code.textContent.trim() : '';
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API unavailable (non-secure context) - fall back to selection.
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }

    const original = copyButton.textContent;
    copyButton.textContent = 'Copied';
    copyButton.dataset.state = 'done';

    setTimeout(() => {
      copyButton.textContent = original;
      delete copyButton.dataset.state;
    }, 1600);
  });
}

/* --------------------------------------------------------------- live version */

/**
 * The build stamps version.json into dist/. If it is present, reconcile the
 * rendered version in case the page was served from a stale cache; if not,
 * leave the statically stamped value alone.
 */
async function reconcileVersion() {
  try {
    const response = await fetch('version.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!data || !data.version) return;

    document.querySelectorAll('[data-version]').forEach((el) => {
      el.textContent = data.version;
    });

    const download = document.querySelector('a[download]');
    if (download && data.zip) download.setAttribute('href', data.zip);

    // The desktop tool has its own downloads and its own one-liner. They are
    // stamped into the page at build time too; this only heals a stale cache.
    const desktopZip = document.querySelector('[data-desktop-zip]');
    if (desktopZip && data.desktopZip) desktopZip.setAttribute('href', data.desktopZip);

    if (data.desktop && data.origin) {
      document.querySelectorAll('[data-desktop-command]').forEach((el) => {
        el.textContent = `curl -fsSL ${data.origin}/${data.desktop} | sh`;
      });
    }
  } catch {
    // Static values are already correct - nothing to do.
  }
}

reconcileVersion();
