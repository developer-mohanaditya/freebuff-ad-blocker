/**
 * Static validation of the packaged extension.
 *
 * Chrome fails the whole extension over a single missing file, an unknown
 * resource type, or one malformed DNR rule - and none of that shows up until
 * someone tries to load it. This catches it at build time instead.
 *
 * Run with `npm run validate`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firefoxManifest } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

const problems = [];
const fail = (message) => problems.push(message);
const pass = (message) => console.log(`  ok    ${message}`);

/** Enumerated values Chrome validates rules against. */
const RESOURCE_TYPES = new Set([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
]);

const ACTION_TYPES = new Set([
  'block',
  'redirect',
  'upgradeScheme',
  'modifyHeaders',
  'allow',
  'allowAllRequests',
]);

const CONDITION_KEYS = new Set([
  'urlFilter',
  'regexFilter',
  'isUrlFilterCaseSensitive',
  'requestDomains',
  'excludedRequestDomains',
  'initiatorDomains',
  'excludedInitiatorDomains',
  'domainType',
  'excludedDomainTypes',
  'resourceTypes',
  'excludedResourceTypes',
  'tabIds',
  'excludedTabIds',
  'requestMethods',
  'excludedRequestMethods',
]);

const GUARDRAIL_DOMAIN = 'freebuff.com';

/* ----------------------------------------------------------------- manifest */

function checkManifest() {
  console.log('\nmanifest.json');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    pass('parses as JSON');
  } catch (error) {
    fail(`manifest.json is not valid JSON: ${error.message}`);
    return null;
  }

  if (manifest.manifest_version === 3) pass('manifest_version is 3');
  else fail(`manifest_version must be 3, got ${manifest.manifest_version}`);

  if (/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) pass(`version ${manifest.version}`);
  else fail(`version "${manifest.version}" is not a valid extension version`);

  for (const key of ['declarativeNetRequest', 'storage']) {
    (manifest.permissions || []).includes(key)
      ? pass(`permission "${key}" declared`)
      : fail(`missing required permission "${key}"`);
  }

  const banned = ['tabs', 'webRequest', 'webRequestBlocking', '<all_urls>'];
  for (const key of banned) {
    const inPermissions = (manifest.permissions || []).includes(key);
    const inHosts = (manifest.host_permissions || []).includes(key);
    if (inPermissions || inHosts) fail(`over-broad permission declared: "${key}"`);
  }
  pass('no over-broad permissions');

  // Host access must be scoped to the target site.
  const hosts = manifest.host_permissions || [];
  if (hosts.length === 0) fail('host_permissions is empty');
  const scoped = hosts.every((h) => /^(\*|https?):\/\/(\*\.)?freebuff\.com\/(\*)?$/.test(h));
  scoped
    ? pass(`host access scoped: ${hosts.join(', ')}`)
    : fail(`host_permissions not scoped to freebuff.com: ${hosts.join(', ')}`);

  // Chromium reads the manifest on disk verbatim, so it has to stay clean.
  // `background.scripts` is a Manifest V2 key: Chrome 121+ ignores it rather
  // than refusing to load, but it is still reported as a warning on the
  // extensions page. Firefox needs it and Chromium does not, so the build adds
  // it to the Firefox package alone.
  const worker = manifest.background?.service_worker;

  worker
    ? pass(`background service worker: ${worker}`)
    : fail('background.service_worker is missing - no browser would run a background');

  manifest.background?.scripts
    ? fail('background.scripts is in the source manifest - Chromium warns about that key')
    : pass('source manifest is Chromium-clean (no MV2 background key)');

  manifest.browser_specific_settings
    ? fail('browser_specific_settings belongs in the Firefox package, not the source manifest')
    : pass('no Firefox-only keys in the source manifest');

  // The Firefox manifest is derived at build time, so validate what it derives.
  const firefox = firefoxManifest(manifest);
  const eventPage = firefox.background?.scripts;

  Array.isArray(eventPage) && eventPage.includes(worker)
    ? pass(`Firefox package runs ${worker} as an event page`)
    : fail('the Firefox manifest runs no event page - Firefox would have no background');

  // Firefox ignores this key, and AMO's validator says so out loud. Leaving it
  // in beside the event page - which is what this build used to do - is the
  // "unsupported ... and ignored on Firefox" warning in the validation report.
  firefox.background?.service_worker === undefined
    ? pass('Firefox package leaves background.service_worker out')
    : fail('the Firefox manifest still declares background.service_worker - AMO warns about it');

  const backgroundKeys = Object.keys(firefox.background || {}).join(', ');
  backgroundKeys === 'scripts'
    ? pass('Firefox background is the event page and nothing else')
    : fail(`the Firefox background carries more than scripts: ${backgroundKeys || 'nothing'}`);

  const gecko = firefox.browser_specific_settings?.gecko;
  gecko?.id
    ? pass(`Firefox package carries gecko id ${gecko.id}`)
    : fail('the Firefox manifest has no gecko id - AMO cannot sign it');
  gecko?.strict_min_version
    ? pass(`Firefox package sets strict_min_version ${gecko.strict_min_version}`)
    : fail('the Firefox manifest has no strict_min_version');

  // AMO refuses a new submission that does not declare what it collects, and
  // this extension collects nothing. `required: ["none"]` is the whole
  // declaration: `optional` has no `none`, and an empty array is invalid.
  const declared = gecko?.data_collection_permissions;
  JSON.stringify(declared?.required) === '["none"]'
    ? pass('Firefox package declares required data collection: none')
    : fail('data_collection_permissions.required is not ["none"] - AMO blocks the submission');

  declared?.optional
    ? fail('the Firefox manifest declares optional data collection, but nothing here collects anything')
    : pass('no optional data collection declared');

  // 140 is where desktop Firefox learned the key, but AMO's validator also
  // holds the declared minimum against the Android floor of 142 - even though
  // this package declares no gecko_android and never ships there. Below 142 the
  // validation report carries a warning on every submission, so 142 is the
  // floor this package has to keep.
  const floor = Number(gecko?.strict_min_version);
  Number.isFinite(floor) && floor >= 142
    ? pass(`Firefox floor ${gecko.strict_min_version} reports clean for the data declaration`)
    : fail(`strict_min_version ${gecko?.strict_min_version} is below 142.0 - AMO warns that data_collection_permissions is unsupported there`);

  // Every file the manifest points at must exist.
  const referenced = [];
  if (worker) referenced.push(worker);
  if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);

  for (const [size, file] of Object.entries(manifest.icons || {})) referenced.push(file);
  for (const [size, file] of Object.entries(manifest.action?.default_icon || {})) referenced.push(file);

  for (const script of manifest.content_scripts || []) {
    for (const file of [...(script.js || []), ...(script.css || [])]) referenced.push(file);
    if (!script.matches?.length) fail('content script has no matches');
  }

  for (const resource of manifest.declarative_net_request?.rule_resources || []) {
    referenced.push(resource.path);
    if (!resource.id) fail('ruleset is missing an id');
  }

  if (!manifest.content_scripts?.length) fail('no content_scripts declared');
  if (!manifest.declarative_net_request?.rule_resources?.length) fail('no ruleset declared');

  for (const file of referenced) {
    fs.existsSync(path.join(EXT, file))
      ? pass(`references ${file}`)
      : fail(`manifest references missing file: ${file}`);
  }

  return manifest;
}

/* -------------------------------------------------------------------- icons */

function checkIcons(manifest) {
  console.log('\nicons');

  const sizes = Object.entries(manifest?.icons || {});
  if (!sizes.length) {
    fail('manifest declares no icons');
    return;
  }

  for (const [size, file] of sizes) {
    const full = path.join(EXT, file);
    if (!fs.existsSync(full)) continue; // already reported

    const buf = fs.readFileSync(full);
    const signature = buf.subarray(0, 8).toString('hex');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);

    if (signature !== '89504e470d0a1a0a') fail(`${file} is not a PNG`);
    else if (width !== Number(size) || height !== Number(size))
      fail(`${file} is ${width}x${height}, expected ${size}x${size}`);
    else pass(`${file} is a valid ${size}x${size} PNG`);
  }
}

/* -------------------------------------------------------------------- popup */

function checkPopup() {
  console.log('\npopup');

  const htmlPath = path.join(EXT, 'popup.html');
  if (!fs.existsSync(htmlPath)) {
    fail('popup.html missing');
    return;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');

  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(https?:|#|data:)/.test(ref)) continue;
    fs.existsSync(path.join(EXT, ref))
      ? pass(`popup references ${ref}`)
      : fail(`popup.html references missing file: ${ref}`);
  }

  for (const id of [
    'toggle',
    'stateText',
    'count',
    'statusText',
    'installLink',
    'pick',
    'customCount',
    'clearCustom',
  ]) {
    html.includes(`id="${id}"`)
      ? pass(`popup has #${id}`)
      : fail(`popup.html is missing #${id}, which popup.js queries`);
  }
}

/* --------------------------------------------------------------------- rules */

function checkRules() {
  console.log('\nrules.json');

  let rules;
  try {
    rules = JSON.parse(fs.readFileSync(path.join(EXT, 'rules.json'), 'utf8'));
    pass('parses as JSON');
  } catch (error) {
    fail(`rules.json is not valid JSON: ${error.message}`);
    return;
  }

  if (!Array.isArray(rules) || rules.length === 0) {
    fail('rules.json must be a non-empty array');
    return;
  }

  // Chrome rejects unknown top-level keys on a rule.
  const RULE_KEYS = new Set(['id', 'priority', 'action', 'condition']);
  const seenIds = new Set();
  let hasGuardrail = false;

  for (const rule of rules) {
    const label = `rule ${rule.id ?? '?'}`;

    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) fail(`${label}: unknown property "${key}" (Chrome rejects the whole ruleset)`);
    }

    if (!Number.isInteger(rule.id)) fail(`${label}: id must be an integer`);
    else if (seenIds.has(rule.id)) fail(`${label}: duplicate id`);
    else seenIds.add(rule.id);

    if (!Number.isInteger(rule.priority) || rule.priority < 1)
      fail(`${label}: priority must be a positive integer`);

    if (!ACTION_TYPES.has(rule.action?.type)) fail(`${label}: invalid action type "${rule.action?.type}"`);

    if (!rule.condition || typeof rule.condition !== 'object') {
      fail(`${label}: missing condition`);
      continue;
    }

    for (const key of Object.keys(rule.condition)) {
      if (!CONDITION_KEYS.has(key)) fail(`${label}: unknown condition property "${key}"`);
    }

    const hasScope = rule.condition.requestDomains || rule.condition.urlFilter || rule.condition.regexFilter;
    if (!hasScope) fail(`${label}: condition matches every URL`);

    const types = rule.condition.resourceTypes;
    if (types) {
      if (!Array.isArray(types)) fail(`${label}: resourceTypes must be an array`);
      else {
        for (const type of types) {
          if (!RESOURCE_TYPES.has(type)) fail(`${label}: invalid resourceType "${type}"`);
        }
        if (types.includes('main_frame')) fail(`${label}: never block main_frame (breaks navigation)`);
      }
    }

    // The guardrail: every block must be scoped to freebuff.com as initiator.
    if (rule.action.type === 'block') {
      const initiators = rule.condition.initiatorDomains;
      if (!initiators?.includes(GUARDRAIL_DOMAIN))
        fail(`${label}: block rule is not scoped to an initiator on ${GUARDRAIL_DOMAIN}`);
      if (rule.priority > 1) fail(`${label}: block priority must stay below the guardrail`);
    }

    if (rule.action.type === 'allow' && rule.condition.requestDomains?.includes(GUARDRAIL_DOMAIN)) {
      if (rule.priority <= 1) fail(`${label}: guardrail allow must out-rank every block rule`);
      else hasGuardrail = true;
    }
  }

  hasGuardrail
    ? pass('priority-100 first-party allow guardrail present')
    : fail(`no allow rule protects ${GUARDRAIL_DOMAIN} first-party traffic`);

  pass(`${rules.length} rules, ids ${[...seenIds].sort((a, b) => a - b).join(', ')}`);
}

/* ---------------------------------------------------------------- selectors */

function checkSelectors() {
  console.log('\ncontent.js selectors');

  const source = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

  const grab = (name) => {
    const match = source.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    if (!match) return null;

    // Strip line comments before pairing quotes. Prose inside the array can
    // contain an apostrophe, and one stray quote shifts every pair after it -
    // the check then reports selectors that are not there and misses ones that
    // are, which is worse than not checking at all.
    const body = match[1]
      .split('\n')
      .map((line) => {
        const at = line.indexOf('//');
        return at < 0 ? line : line.slice(0, at);
      })
      .join('\n');

    return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  };

  const selectors = grab('AD_SELECTORS');
  if (!selectors?.length) fail('could not read AD_SELECTORS from content.js');
  else {
    for (const selector of selectors) {
      const opens = (selector.match(/\[/g) || []).length;
      const closes = (selector.match(/\]/g) || []).length;
      if (opens !== closes) fail(`unbalanced selector: ${selector}`);
      if (selector.endsWith(',')) fail(`trailing comma in selector: ${selector}`);
    }
    pass(`${selectors.length} ad selectors, all balanced`);
  }

  // The dangerous pattern: a bare substring match that also catches real UI.
  const dangerous = (selectors || []).filter((s) => /\[class\*="(ad|ads|adv)"\]/.test(s));
  dangerous.length
    ? fail(`blank-page selector present: ${dangerous.join(', ')} (matches header/add/read/load)`)
    : pass('no bare [class*="ad"] selector (would match header/add/read/load)');

  // The ad network's own hooks. These carry the in-product slots, which ship no
  // text label to match on, so losing one silently re-opens the toolbar strip.
  for (const hook of ['[data-gravity-ad]', 'a[rel~="sponsored"]']) {
    (selectors || []).includes(hook)
      ? pass(`ad-network hook present: ${hook}`)
      : fail(`AD_SELECTORS no longer covers ${hook} - in-product ad slots would slip through`);
  }

  const tokens = source.match(/const AD_TOKENS = new Set\(\[([\s\S]*?)\]\);/);
  if (!tokens) fail('could not read AD_TOKENS from content.js');
  else {
    const list = [...tokens[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    if (list.includes('add') || list.includes('header') || list.includes('load'))
      fail('AD_TOKENS contains a token that matches ordinary UI');
    else pass(`${list.length} exact ad tokens, none matching ordinary UI`);
  }

  // Tier C: promo cards are matched on badge *text*, which is a far wider net
  // than an attribute hook. The guards around it have to stay in place.
  const labels = source.match(/const BADGE_LABELS = new Set\(\[([\s\S]*?)\]\);/);
  if (!labels) fail('could not read BADGE_LABELS from content.js');
  else {
    const list = [...labels[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    if (!list.includes('ad') || !list.includes('sponsored'))
      fail(`BADGE_LABELS is missing a base label: ${list.join(', ')}`);
    else pass(`${list.length} badge labels`);
  }

  for (const needle of ['PROMO_ACTION_SELECTOR', 'REAL_CONTENT_SELECTOR']) {
    source.includes(`const ${needle}`)
      ? pass(`promo tier keeps its ${needle} guard`)
      : fail(`content.js no longer defines ${needle} - promo detection would be unguarded`);
  }

  if (!source.includes('characterData: true'))
    fail('observer does not watch characterData; a badge that appears as text is missed');
  else pass('observer watches characterData for late badges');

  for (const needle of ['MutationObserver', 'chrome.storage', 'requestAnimationFrame']) {
    source.includes(needle)
      ? pass(`uses ${needle}`)
      : fail(`content.js does not use ${needle}`);
  }
}

/* ------------------------------------------------------------------- origin */

/**
 * The popup's install link and the feed's codebase URL come from two different
 * files. When they disagree, the popup links to a domain that does not exist and
 * the feed advertises a package nobody can fetch - and nothing anywhere reports
 * an error, because both files are individually well-formed. So compare them.
 */
/**
 * The first single-quoted string after `needle`, or null.
 *
 * Deliberately not a regex. The obvious greedy pattern backtracks to the last
 * quote on the line and then lets its capture group run on across newlines, so
 * it silently compares two pieces of unrelated text and reports a mismatch that
 * does not exist. This cannot do that.
 */
function quotedAfter(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0) return null;
  const open = source.indexOf("'", at);
  if (open < 0) return null;
  const close = source.indexOf("'", open + 1);
  if (close < 0) return null;
  return source.slice(open + 1, close);
}

function checkOrigin() {
  console.log('\nsite origin');

  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8');
  const popup = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');

  const origin = quotedAfter(build, 'const SITE_ORIGIN'); // dead: old regex tail -> \n]*'([^']+)'/);
  if (!origin || !origin.startsWith('http')) {
    fail('could not read SITE_ORIGIN from scripts/build.mjs');
    return;
  }
  pass(`build origin: ${origin}`);

  const install = quotedAfter(popup, 'const INSTALL_URL'); // dead: old regex tail -> \n]*'([^']+)'/);
  if (!install || !install.startsWith('http')) {
    fail('could not read INSTALL_URL from extension/popup.js');
    return;
  }

  const expected = origin.endsWith('/') ? origin : `${origin}/`;
  if (install === expected) pass(`popup install link matches: ${install}`);
  else
    fail(
      `popup INSTALL_URL ${install} does not match SITE_ORIGIN ${origin} - the popup would link off-site`
    );
}

/* ------------------------------------------------------------ picker wiring */

/**
 * The popup asks the content script to start picking by message type. Two files
 * hold that string, and if they ever disagree the button silently does nothing -
 * no error anywhere, just a dead control.
 */
function checkPickerWiring() {
  console.log('\npicker wiring');

  const declaration = (file, name) => {
    const source = fs.readFileSync(file, 'utf8');
    const line = source.split('\n').find((text) => text.includes(`const ${name} =`));
    if (!line) return null;
    const open = line.indexOf("'");
    const close = line.lastIndexOf("'");
    return open >= 0 && close > open ? line.slice(open + 1, close) : null;
  };

  const fromContent = declaration(path.join(EXT, 'content.js'), 'PICK_TYPE');
  const fromPopup = declaration(path.join(EXT, 'popup.js'), 'PICK_TYPE');

  if (!fromContent || !fromPopup) {
    fail('could not read PICK_TYPE from both content.js and popup.js');
  } else if (fromContent !== fromPopup) {
    fail(`PICK_TYPE disagrees: content.js "${fromContent}" vs popup.js "${fromPopup}"`);
  } else {
    pass(`picker message type agrees: ${fromContent}`);
  }

  const content = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  for (const needle of ['startPicking', 'describeElement', 'CUSTOM_KEY']) {
    content.includes(needle)
      ? pass(`content.js keeps ${needle}`)
      : fail(`content.js no longer defines ${needle} - hand-picked rules would break`);
  }
}

/* ------------------------------------------------------------ store buttons */

/**
 * The install page shows a store button only for a store app.js knows a
 * listing URL for. A `data-store` value with no matching STORE_LINKS key is
 * dead markup: the button would be removed on load and never come back, no
 * matter what URL is pasted in later.
 */
function checkStoreButtons() {
  console.log('\nstore buttons');

  const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'site', 'app.js'), 'utf8');

  html.includes('data-store-button')
    ? pass('the store button is wired into the page')
    : fail('index.html has no store button - the adaptive install link would never render');

  html.includes('data-zip')
    ? pass('the zip download stays alongside it')
    : fail('index.html no longer offers the zip - the pre-listing install path would vanish');

  const linksAt = app.indexOf('const STORE_LINKS');
  if (linksAt < 0) {
    fail('app.js no longer defines STORE_LINKS - no listing could ever be linked');
    return;
  }

  const linksBlock = app.slice(linksAt, app.indexOf('};', linksAt));
  const known = [...linksBlock.matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1]);
  pass(`stores that can be linked: ${known.join(', ')}`);

  // The two listings that are live. An emptied value does not break anything
  // visible - the button is simply removed on load - so it has to be asserted
  // here or a live store silently stops being reachable from the page.
  const listing = (store) => {
    const match = linksBlock.match(new RegExp(`^\\s*${store}:\\s*'([^']*)'`, 'm'));
    return match ? match[1] : null;
  };

  const chromeListing = listing('chrome');
  if (chromeListing?.startsWith('https://chromewebstore.google.com/'))
    pass('the Chrome Web Store listing is linked');
  else fail(`STORE_LINKS.chrome is "${chromeListing}" - every Chromium reader would get no button`);

  const firefoxListing = listing('firefox');
  if (firefoxListing?.startsWith('https://addons.mozilla.org/'))
    pass('the addons.mozilla.org listing is linked');
  else fail(`STORE_LINKS.firefox is "${firefoxListing}" - Firefox would get no button`);

  // Every browser in the detection table must name a store that exists. One bad
  // key and that browser silently gets no button, however the URL is filled in.
  const browsersAt = app.indexOf('const BROWSERS');
  if (browsersAt < 0) {
    fail('app.js no longer detects a browser - the button would always say Chrome');
    return;
  }

  app.includes('selfReportedBrowser')
    ? pass('the browser is asked to name itself before any user-agent matching')
    : fail('app.js no longer reads userAgentData - the name would always come from a table');

  // Every store reference anywhere in the file must name a store that exists,
  // or that browser silently loses its button however the URL is filled in.
  const mapped = [...app.matchAll(/store: '([a-z]+)'/g)].map((m) => m[1]);

  if (!mapped.length) {
    fail('no browser anywhere in app.js is mapped to a store');
  } else {
    const unknown = [...new Set(mapped)].filter((name) => !known.includes(name));
    unknown.length
      ? fail(`browser mapped to a store with no link: ${unknown.join(', ')}`)
      : pass(`${mapped.length} store references, all known`);
  }

  const browsersBlock = app.slice(browsersAt, app.indexOf('\n];', browsersAt));
  for (const name of ['Brave', 'Comet', 'Edge', 'Vivaldi', 'Opera', 'Firefox', 'Safari']) {
    browsersBlock.includes(`'${name}'`)
      ? pass(`${name} named in the user-agent fallback`)
      : fail(`${name} dropped from the fallback table - its button would say Chrome`);
  }
}

/* ---------------------------------------------------------- version labels */

/**
 * Two artifacts ship from this site on different clocks: the extension follows
 * browser-store review, the desktop tool follows Freebuff's release cycle. So
 * every version shown anywhere has to say which one it is.
 *
 * The bug this exists for: site/privacy.html kept a bare `v1.3.0` in its navbar
 * and footer after the install page had been relabelled, so the site still read
 * as stale on the one page nobody thought to look at. Checked per page rather
 * than on index.html alone, so a new page cannot ship unlabelled either.
 */
function checkVersionLabels(manifest) {
  console.log('\nversion labels');

  const SITE = path.join(ROOT, 'site');
  const pages = fs.readdirSync(SITE).filter((name) => name.endsWith('.html')).sort();
  const version = manifest.version;

  if (!pages.length) {
    fail('site/ has no HTML pages');
    return;
  }

  for (const page of pages) {
    const source = fs.readFileSync(path.join(SITE, page), 'utf8');
    // Flatten whitespace: the markup wraps, and a reflow must not fail a check.
    const html = source.replace(/\s+/g, ' ');

    const pillAt = html.indexOf('<span class="pill">');
    const pill = pillAt === -1 ? '' : html.slice(pillAt, html.indexOf('</header>', pillAt));
    const footerAt = html.indexOf('<footer class="footer">');
    const footer =
      footerAt === -1 ? '' : html.slice(footerAt, html.indexOf('</footer>', footerAt));

    const missing = [];
    if (!/v<span data-version>/.test(pill)) missing.push('the navbar tag is not a version stamp');
    if (!footer.includes('Freebuff Ad Block · v<span data-version>'))
      missing.push('the footer does not carry the version stamp');

    if (missing.length) {
      for (const problem of missing) fail(`site/${page}: ${problem}`);
    } else {
      pass(`site/${page} carries the version tag in the navbar and the footer`);
    }

    // The number comes from the build. A literal in the navbar or the footer is
    // the other half of the same bug: it is the copy that stops moving when the
    // version does.
    const unwrapped = `${pill} ${footer}`.replace(/<span data-version>[^<]*<\/span>/g, '<stamp>');
    const literal = unwrapped.match(/\b\d+\.\d+\.\d+\b/g) || [];

    literal.length
      ? fail(`site/${page}: version ${literal.join(', ')} is hardcoded in the navbar or footer - only the build may write a version there`)
      : pass(`site/${page} takes its version from the build`);

    // The tag has to be true of the files it points at. One app version means
    // every download path - extension zips and the desktop package alike - is
    // named after that same number.
    const files = [...new Set([...source.matchAll(/downloads\/[A-Za-z0-9._-]+/g)].map((m) => m[0]))];
    const stale = files.filter((file) => /\d+\.\d+\.\d+/.test(file) && !file.includes(version));

    stale.length
      ? fail(`site/${page} offers ${stale.join(', ')} but the app version is ${version}`)
      : pass(`site/${page}: all ${files.length} download paths carry ${version}`);

    // A second version key would be a second version, which is the thing this
    // replaced. The desktop tool ships as the app, under the app's number.
    const secondTrack = (source.match(/data-desktop-version/g) || []).length;
    secondTrack
      ? fail(`site/${page}: ${secondTrack} data-desktop-version stamp(s) - the desktop tool has no version of its own`)
      : pass(`site/${page} has no separate desktop version stamp`);
  }

  // The names on the page are only worth anything if the files are there.
  const expected = [
    `freebuff-adblock-${version}.zip`,
    `freebuff-adblock-${version}-store.zip`,
    `freebuff-adblock-${version}-firefox.zip`,
    `freebuff-adblock-desktop-${version}.zip`,
    `freebuff-adblock-desktop-${version}-windows.zip`,
    `freebuff-adblock-desktop-${version}-linux.zip`,
    'freebuff-adblock-desktop.sh',
    'freebuff-adblock-desktop.ps1',
    'freebuff-adblock-desktop-linux.sh',
  ];
  const downloads = fs.readdirSync(path.join(SITE, 'downloads'));
  const absent = expected.filter((name) => !downloads.includes(name));

  absent.length
    ? fail(`site/downloads/ has no ${absent.join(', ')} - run npm run build`)
    : pass(`every v${version} package the pages offer exists in site/downloads/`);

  // The stamps are only worth anything if the build rewrites them per page, so
  // that a bumped version can never leave a page behind on the old number - and
  // if the desktop tool takes that same number instead of inventing one.
  const buildSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8');
  const desktopSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-desktop.mjs'), 'utf8');

  buildSource.includes("endsWith('.html')")
    ? pass('the build stamps every page, not just index.html')
    : fail('scripts/build.mjs only stamps index.html - a second page would keep its old version');

  buildSource.includes('buildDesktop({ version') &&
  !buildSource.includes('DESKTOP_VERSION') &&
  !desktopSource.includes('DESKTOP_VERSION')
    ? pass('the desktop package is built as the app version, with no version of its own')
    : fail('a separate desktop version is back - the extension and the desktop tool release under one number');
}

/* ----------------------------------------------------------------- privacy */

/**
 * Edge cannot be published without a privacy policy URL, and both stores read
 * the page as the extension's data declaration. So it has to exist, it has to
 * still say the things the extension actually does - a policy that quietly
 * stops mentioning remote code is a policy that no longer matches the package -
 * and it has to be reachable from the install page.
 */
function checkPrivacy() {
  console.log('\nprivacy policy');

  const file = path.join(ROOT, 'site', 'privacy.html');
  if (!fs.existsSync(file)) {
    fail('site/privacy.html is missing - the Edge listing has no privacy policy URL');
    return;
  }
  pass('site/privacy.html exists');

  const html = fs.readFileSync(file, 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');

  // The prose is wrapped, so a phrase can straddle a newline and its indent.
  // Flatten runs of whitespace before matching, or the check fails on nothing
  // but a reflow.
  const prose = html.replace(/\s+/g, ' ').toLowerCase();

  // Each of these is a claim a store checks the extension against.
  const claims = [
    ['collects nothing', 'the no-collection statement'],
    ['declarativenetrequest', 'the network permission'],
    ['storage', 'the storage permission'],
    ['freebuff.com', 'the single host it touches'],
    ['remote code', 'the no-remote-code declaration'],
    ['third parties', 'the no-third-parties statement'],
  ];

  for (const [needle, why] of claims) {
    prose.includes(needle)
      ? pass(`policy covers ${why}`)
      : fail(`privacy.html no longer covers ${why}`);
  }

  index.includes('href="privacy.html"')
    ? pass('the install page links the policy in its footer')
    : fail('index.html no longer links privacy.html - reviewers reach the policy from there');

  // The footer link is relative, like every other link on the site. The URL a
  // store is given is the clean one (`cleanUrls`), so the preview server has to
  // resolve that too, or the address handed to a reviewer 404s wherever the
  // page is actually checked before release.
  const serve = fs.readFileSync(path.join(ROOT, 'scripts', 'serve.mjs'), 'utf8');
  serve.includes('`${target}.html`')
    ? pass('the preview resolves the extensionless URL production serves')
    : fail('serve.mjs no longer maps /privacy to privacy.html - that URL would 404 in the preview');
}

/* ------------------------------------------------------------ store assets */

/**
 * The listing art `npm run assets` writes. The stores reject a screenshot that
 * is not 1280x800 (640x400 also works) or a tile that is not 440x280, and they
 * reject alpha outright - so the size and the PNG colour type are the two
 * properties worth failing on, since neither is visible until a reviewer says
 * no.
 */
const STORE_ASSETS = [
  ['promo-440x280.png', 440, 280],
  ['marquee-1400x560.png', 1400, 560],
  ['screenshot-1-chat-1280x800.png', 1280, 800],
  ['screenshot-2-popup-1280x800.png', 1280, 800],
  ['screenshot-3-layers-1280x800.png', 1280, 800],
  ['screenshot-4-scope-1280x800.png', 1280, 800],
];

function checkStoreAssets() {
  const dir = path.join(ROOT, 'site', 'store-assets');
  const bad = [];

  for (const [fileName, width, height] of STORE_ASSETS) {
    const file = path.join(dir, fileName);

    if (!fs.existsSync(file)) {
      bad.push(`site/store-assets/${fileName} is missing - run \`npm run assets\``);
      continue;
    }

    const png = fs.readFileSync(file);

    if (png.subarray(1, 4).toString('ascii') !== 'PNG') {
      bad.push(`site/store-assets/${fileName} is not a PNG`);
      continue;
    }

    const actualWidth = png.readUInt32BE(16);
    const actualHeight = png.readUInt32BE(20);
    const colourType = png[25];

    if (actualWidth !== width || actualHeight !== height) {
      bad.push(
        `site/store-assets/${fileName} is ${actualWidth}x${actualHeight}, the stores want ${width}x${height}`
      );
    } else if (colourType !== 2) {
      bad.push(
        `site/store-assets/${fileName} has PNG colour type ${colourType} - the stores reject transparency (type 2) - and an opaque RGBA image still declares alpha`
      );
    }
  }

  if (bad.length) for (const problem of bad) fail(problem);
  else pass(`${STORE_ASSETS.length} store assets are the right size, with no alpha channel`);
}

/* ----------------------------------------------------------------- desktop */

/**
 * PowerShell, wherever this host keeps it. Windows PowerShell 5.1 is
 * `powershell` and ships with Windows; `pwsh` is PowerShell 7. Either runs the
 * tool, so either is accepted, and its absence only skips the parse check.
 */
function findPowerShell() {
  const candidates = [
    process.env.FBD_PWSH,
    'pwsh',
    'pwsh.exe',
    'powershell',
    'powershell.exe',
    path.join(os.homedir(), '.local', 'pwsh', 'pwsh'),
    '/usr/local/bin/pwsh',
    '/opt/microsoft/powershell/7/pwsh',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/**
 * The Windows tool. It patches the same two anchors in the same bundle as the
 * shell tool, in a language that has to be told everything the shell was not, so
 * the checks are the shell ones again plus the three things that only exist here:
 * the two build-time placeholders, a refusal that names the problem in the counts
 * it saw, and a wait that can never fail a patch that already succeeded.
 *
 * The anchors are asserted as strings rather than trusted: the whole point of the
 * port is that they are the *same* anchors as the macOS tool, not a fresh guess,
 * and a silent drift between the two would be invisible until someone's Freebuff
 * stopped being patched.
 */
/**
 * The Linux tool.
 *
 * It is the same engine as the macOS tool by construction - the file was copied
 * from it and the platform layer rewritten - so the interesting assertion here is
 * that the perl payload is *byte-identical* between the two. Two scripts with one
 * engine is only acceptable while that stays true; the moment someone edits one
 * and not the other, this fails.
 */
function engineOf(source) {
  const start = source.indexOf('cat > "$prog" <<\'FBD_PERL\'');
  const end = source.indexOf('\nFBD_PERL\n', start);
  if (start === -1 || end === -1) return null;
  return source.slice(start, end);
}

function checkDesktopLinux() {
  console.log('\nlinux desktop tool');

  const file = path.join(ROOT, 'desktop', 'freebuff-adblock-linux.sh');
  if (!fs.existsSync(file)) {
    fail('desktop/freebuff-adblock-linux.sh is missing - the Linux tool does not ship');
    return;
  }
  pass('desktop/freebuff-adblock-linux.sh exists');

  const source = fs.readFileSync(file, 'utf8');
  const macSource = fs.readFileSync(path.join(ROOT, 'desktop', 'freebuff-adblock.sh'), 'utf8');

  for (const token of ['__FBD_VERSION__', '__FBD_ORIGIN__']) {
    source.includes(token)
      ? pass(`build placeholder ${token} is present for build-desktop.mjs to fill in`)
      : fail(`${token} is gone - the Linux tool would ship without its version or origin`);
  }

  for (const id of ['render', 'request']) {
    source.includes(`FBD-ADS-OFF:${id}`)
      ? pass(`patch "${id}" is defined`)
      : fail(`patch "${id}" is missing from the Linux tool`);
  }

  source.includes('FBD-ADS-OFF:post')
    ? fail('a "post" anchor is back in the Linux tool - it can only match helpers that are not the ad path')
    : pass('no "post" anchor in the Linux tool either');

  // The one that matters most: one engine, two scripts, no drift.
  const macEngine = engineOf(macSource);
  const linuxEngine = engineOf(source);
  if (!macEngine || !linuxEngine) {
    fail('the perl engine block could not be found in one of the two shell tools');
  } else if (macEngine === linuxEngine) {
    pass(`the perl engine is byte-identical between the macOS and Linux tools (${linuxEngine.length} bytes)`);
  } else {
    fail('the macOS and Linux tools now carry different perl engines - the anchors would drift apart silently');
  }

  // The AppImage rule. There is no patchable file inside a read-only SquashFS, so
  // the tool must extract rather than edit, and it must do it with the runtime
  // the image carries rather than a package the user has to install.
  source.includes('--appimage-extract')
    ? pass('it extracts an AppImage with the image\'s own runtime')
    : fail('the Linux tool no longer extracts AppImages - there is nothing it could patch');

  source.includes('resolve_app') && source.includes('is_tree') && source.includes('extract_image')
    ? pass('it tells an AppImage from an AppDir before it writes anything')
    : fail('the Linux tool does not resolve image-vs-directory, so it may write to the wrong thing');

  /--work-dir/.test(source)
    ? pass('the extracted copy has its own directory, overridable with --work-dir')
    : fail('the Linux tool has nowhere to put an extracted AppImage');

  source.includes('AppRun')
    ? pass('install says which extracted copy to start')
    : fail('the Linux tool never names the AppRun it patched - the patch would be unreachable');

  // It patches a copy the user owns, so it must never reach for privilege - and
  // where a system install would need it, the help says so instead.
  /^\s*sudo\s/m.test(source)
    ? fail('the Linux tool runs sudo - it must never need a password')
    : pass('the Linux tool never escalates with sudo');

  // The macOS tool's `verify` contract, kept: documented in the help text and
  // reachable from the dispatcher.
  source.includes('verify    wait for Freebuff') && /^\s*verify\)\s+cmd_verify/m.test(source)
    ? pass('`verify` is documented in the help text and dispatched')
    : fail('`verify` is missing from the Linux help text or the command dispatch');

  // Bounded and interruptible, exactly as on macOS: PowerShell could not honour
  // an interrupt, but a shell can, and this tool relies on it.
  /^WAIT_SECS=\d+$/m.test(source) && source.includes("trap 'interrupted=1' INT")
    ? pass('the relaunch wait has a default timeout and Ctrl-C stops it')
    : fail('the Linux relaunch wait has no default timeout, or cannot be interrupted');

  // A refusal has to explain itself and offer the command a piped user can run -
  // and the piped form has to be the Linux tool's own URL, not the macOS one.
  source.includes('trusted as written') && source.includes('$r->{notes}')
    ? pass('a refusal carries the per-anchor counts')
    : fail('the Linux refusal no longer says why an anchor did not fit');

  source.includes('| sh -s scan') && source.includes('downloads/freebuff-adblock-desktop-linux.sh')
    ? pass('the Linux refusal offers the piped scan at the Linux tool\'s own URL')
    : fail('the Linux refusal points at the wrong script, or offers no piped scan');

  source.includes('Refusing to patch')
    ? pass('the Linux tool refuses to patch an unrecognised file')
    : fail('the Linux tool no longer refuses an unrecognised orchestrator.js');

  const syntax = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
  if (syntax.status === 0) pass('the Linux tool passes `sh -n`');
  else fail(`the Linux tool has a shell syntax error: ${(syntax.stderr || '').trim()}`);
}

/**
 * What a downloaded zip calls its tools, against what the zip tells you to run.
 *
 * This exists because it was wrong. The packaging step once named each sh tool
 * after the file it *serves* (`freebuff-adblock-desktop.sh`), while INSTALL.txt,
 * the tool's own `Usage:` block and the install page all said
 * `sh freebuff-adblock.sh` - so a reader who took the download, followed the
 * read-me and typed the command it gave them got "No such file". On macOS it was
 * worse than a typo: the double-clickable `.command` launcher runs
 * `sh ./freebuff-adblock.sh install`, so it failed at the one thing it is for.
 *
 * The rule is therefore: the name a zip carries is the name every instruction
 * beside it uses. Checked statically - the read-mes, the launchers and the tools'
 * own help text are all files in the tree, and reading them needs no build.
 */
function checkDesktopPackaging() {
  console.log('\ndesktop packages');

  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const buildSource = read('scripts/build-desktop.mjs');

  const constant = (name) => {
    const found = buildSource.match(new RegExp(`const ${name} = '([^']+)'`));
    return found ? found[1] : null;
  };

  const macZipName = constant('ZIP_TOOL_NAME');
  const linuxZipName = constant('ZIP_LINUX_TOOL_NAME');

  if (!macZipName || !linuxZipName) {
    fail('build-desktop.mjs no longer declares the names its zips carry - the read-mes cannot be checked');
    return;
  }

  // Every `sh <something>.sh` an instruction tells the reader to run, collected
  // from one file. A url is never a match: the token before it is not `sh`.
  const shellCommands = (text) =>
    new Set((text.match(/sh (?:\.\/)?freebuff-adblock[A-Za-z0-9._-]*\.sh/g) || []).map((hit) => hit.replace(/^sh (?:\.\/)?/, '')));

  const check = (label, text, expected) => {
    const found = [...shellCommands(text)];
    if (!found.length) {
      fail(`${label} tells the reader to run no shell tool at all`);
      return;
    }
    const strays = found.filter((name) => name !== expected);
    strays.length
      ? fail(`${label} tells the reader to run ${strays.join(', ')}, but the zip carries ${expected}`)
      : pass(`${label} names the file its zip carries (${expected})`);
  };

  check('desktop/INSTALL.txt', read('desktop/INSTALL.txt'), macZipName);
  check('desktop/INSTALL-linux.txt', read('desktop/INSTALL-linux.txt'), linuxZipName);
  check('the Linux tool\'s own help', read('desktop/freebuff-adblock-linux.sh'), linuxZipName);
  check('the macOS tool\'s own help', read('desktop/freebuff-adblock.sh'), macZipName);

  // The macOS launcher is the one place this runs by itself, so its reference is
  // checked literally rather than through the collector above.
  read('desktop/Freebuff AdBlock.command').includes(`sh ./${macZipName}`)
    ? pass(`the .command launcher runs the file the zip carries (sh ./${macZipName})`)
    : fail(`the .command launcher does not run sh ./${macZipName} - double-clicking it would fail`);

  // Windows has always been consistent, and that consistency is the reason the
  // other two are checked at all.
  read('desktop/Freebuff AdBlock.cmd').includes('freebuff-adblock-desktop.ps1')
    ? pass('the .cmd launcher runs the .ps1 the zip carries')
    : fail('the .cmd launcher names a .ps1 that the zip does not carry');
}

function checkDesktopPowerShell() {
  console.log('\nwindows desktop tool');

  const file = path.join(ROOT, 'desktop', 'freebuff-adblock.ps1');
  if (!fs.existsSync(file)) {
    fail('desktop/freebuff-adblock.ps1 is missing - the Windows tool does not ship');
    return;
  }
  pass('desktop/freebuff-adblock.ps1 exists');

  const source = fs.readFileSync(file, 'utf8');

  // PowerShell 5.1 is what she ships with, so a 5.1 host has to get a clear
  // "needs 5.1" rather than a parse error from newer syntax.
  source.includes('#Requires -Version 5.1')
    ? pass('the Windows tool declares the PowerShell version it needs')
    : fail('desktop/freebuff-adblock.ps1 no longer declares #Requires -Version 5.1');

  for (const token of ['__FBD_VERSION__', '__FBD_ORIGIN__']) {
    source.includes(token)
      ? pass(`build placeholder ${token} is present for build-desktop.mjs to fill in`)
      : fail(`${token} is gone - the Windows tool would ship without its version or origin`);
  }

  for (const id of ['render', 'request']) {
    source.includes(`FBD-ADS-OFF:${id}`)
      ? pass(`patch "${id}" is defined`)
      : fail(`patch "${id}" is missing from the Windows tool`);
  }

  source.includes('FBD-ADS-OFF:post')
    ? fail('a "post" anchor is back in the Windows tool - it can only match helpers that are not the ad path')
    : pass('no "post" anchor in the Windows tool either');

  // The three anchors themselves, exactly as the shell tool carries them. The
  // two literals are what the tool was verified against on 0.0.164; the relaxed
  // ones are what keeps a rename from bricking it.
  const anchors = [
    'if (localAgenticTestCampaign(process.env))',
    'async request\\(method, [A-Za-z_$][\\w$]*, payload, timeoutMs = REQUEST_TIMEOUT_MS\\) \\{',
    '(?<![.\\w$])(?:(?:async|static)\\s+)*request\\s*\\([^)]*\\)\\s*\\{',
  ];
  for (const anchor of anchors) {
    source.includes(anchor)
      ? pass(`anchor ${anchor.slice(0, 32)}… matches the macOS tool`)
      : fail(`the Windows tool lost an anchor the macOS tool still carries: ${anchor}`);
  }

  // A refusal has to explain itself with the counts, and offer the piped command
  // a person who ran the one-liner can actually paste.
  source.includes('trusted as written') && source.includes('match(es)')
    ? pass('a refusal carries the per-anchor counts')
    : fail('the Windows refusal no longer says why an anchor did not fit');

  source.includes('freebuff-adblock-desktop.ps1') && source.includes('scriptblock')
    ? pass('the refusal offers the piped scan, for people with no local copy')
    : fail('the Windows refusal only offers the local form, which a piped run cannot use');

  source.includes('Refusing to patch')
    ? pass('the Windows tool refuses to patch an unrecognised file')
    : fail('the Windows tool no longer refuses an unrecognised orchestrator.js');

  /Start-Process[^\n]*RunAs|^\s*sudo\s/m.test(source)
    ? fail('the Windows tool elevates by itself - it must never need a password')
    : pass('the Windows tool never escalates on its own');

  // It must not rewrite a file in an encoding it did not read, and it must not
  // write through a bundle it cannot parse as UTF-8.
  source.includes('is not valid UTF-8') && source.includes('UTF-16')
    ? pass('a file that is not UTF-8 is refused rather than re-encoded')
    : fail('the Windows tool would rewrite a file it cannot read as UTF-8');

  source.includes('[System.IO.File]::Replace')
    ? pass('the write replaces the file in place, keeping its ACL and attributes')
    : fail('the Windows tool writes in a way that can lose the file ACL');

  source.includes('ERROR_SHARING_VIOLATION')
    ? pass('a locked file is reported as Freebuff holding it, not as a permissions problem')
    : fail('the Windows tool cannot tell a share violation from a permission problem');

  source.includes('@codebufffreebuff-desktop')
    ? pass('the tool knows the per-user install folder the Windows build uses')
    : fail('the Windows tool no longer looks in %LOCALAPPDATA%\\Programs for the app');

  // `verify` is the half no file on disk can answer, and the page tells people to
  // use it. It has to exist in the help text and in the dispatch, or the page and
  // the tool disagree about what the tool does.
  source.includes('verify    wait for Freebuff') && /'verify'\s*\{\s*Invoke-Verify/.test(source)
    ? pass('`verify` is documented in the help text and dispatched')
    : fail('`verify` is missing from the Windows help text or the command dispatch');

  // Bounded, and honest about how it ends. There is no Ctrl-C handler here on
  // purpose: measured with pwsh, a CancelKeyPress handler written as a script
  // block never gets to run - the signal arrives on a thread with no runspace, so
  // PowerShell answers with an unhandled PSInvalidOperationException and the
  // process dies of SIGABRT. A compiled .NET delegate does run (Add-Type) but
  // cannot set the status: PowerShell still exits 0 for an interrupted run. So
  // Ctrl-C does the stopping, as PowerShell's own behaviour, and the budget below
  // brings an unattended run back. `test-desktop-windows.mjs` covers both halves -
  // the bound with a short -Timeout, the interruption by sending the signal.
  /^\s*\$WaitSecs = \d+$/m.test(source) && /\$remaining -= \d+/.test(source)
    ? pass('the relaunch wait has a default timeout, so an unattended run comes back')
    : fail('the Windows relaunch wait is unbounded');

  !source.includes('add_CancelKeyPress') && source.includes('Ctrl-C')
    ? pass('Ctrl-C ends the wait, and no handler that would crash on the signal thread is registered')
    : fail('the Windows wait registers a CancelKeyPress handler, or never mentions Ctrl-C');

  // And it must only ever wait for a relaunch that can happen, and never let a
  // timeout turn a successful patch into a failure. The discarded result is the
  // point: `| Out-Null` is what makes a timed-out wait harmless.
  /if \(\$Wait\) \{\s*\n\s*Wait-ForRelaunch[^\n]*\| Out-Null/.test(source) && source.includes('if ($running) {')
    ? pass('install waits only when Freebuff is open, and a timed-out wait cannot fail it')
    : fail('install can wait with Freebuff closed, or lets a timed-out wait fail the patch');

  // The one check that needs PowerShell itself: does the file parse at all. A
  // syntax error here would be a tool that cannot start on the machine that needs
  // it, which no string check above would catch.
  const pwsh = findPowerShell();
  if (!pwsh) {
    console.log('  (no PowerShell on this host - skipping the parse check)');
  } else {
    const script =
      `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(` +
      `'${file.replace(/'/g, "''")}', [ref]$null, [ref]$errors); ` +
      `if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }`;
    const parsed = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
    });
    if (parsed.status === 0) pass(`the Windows tool parses (${path.basename(pwsh)})`);
    else fail(`the Windows tool has a PowerShell syntax error: ${(parsed.stdout || parsed.stderr || '').trim()}`);
  }
}

/**
 * The desktop tool ships as a shell script that edits a bundle on someone
 * else's machine, so the two things that must never quietly drift are its
 * fail-safe (it refuses when the anchors do not match) and its two build-time
 * placeholders (an unstamped script would report the literal __FBD_VERSION__
 * and point its own help text at nothing).
 */
function checkDesktop(manifest) {
  console.log('\ndesktop tool');

  const file = path.join(ROOT, 'desktop', 'freebuff-adblock.sh');
  if (!fs.existsSync(file)) {
    fail('desktop/freebuff-adblock.sh is missing');
    return;
  }
  pass('desktop/freebuff-adblock.sh exists');

  const source = fs.readFileSync(file, 'utf8');

  for (const token of ['__FBD_VERSION__', '__FBD_ORIGIN__']) {
    source.includes(token)
      ? pass(`build placeholder ${token} is present for build-desktop.mjs to fill in`)
      : fail(`${token} is gone - the tool would ship without its version or origin`);
  }

  for (const id of ['render', 'request']) {
    source.includes(`FBD-ADS-OFF:${id}`)
      ? pass(`patch "${id}" is defined`)
      : fail(`patch "${id}" is missing from the desktop tool`);
  }

  // `post` is deliberately not an anchor any more. In Freebuff 0.0.164 both
  // `async post(` helpers are non-ad - the break-event telemetry poster and the
  // shipper that POSTs to /api/logs - so a `post` anchor could only break
  // Freebuff's own logging while blocking no ads.
  source.includes('FBD-ADS-OFF:post')
    ? fail('a "post" anchor is back - in 0.0.164 it can only match helpers that are not the ad path')
    : pass('no "post" anchor, so the /api/logs shipper is never in reach');

  // A refusal has to explain itself and offer the command a piped user can run.
  source.includes('trusted as written') && source.includes('$r->{notes}')
    ? pass('a refusal carries the per-anchor counts')
    : fail('the refusal no longer says why an anchor did not fit');

  source.includes('| sh -s scan')
    ? pass('the refusal offers the piped scan for people with no local copy')
    : fail('the refusal only offers `sh freebuff-adblock.sh scan`, which a piped run cannot use');

  // The refusal path is the whole safety story: without it an unexpected
  // orchestrator would be edited with whatever matched.
  source.includes('Refusing to patch')
    ? pass('the tool refuses to patch an unrecognised file')
    : fail('the desktop tool no longer refuses an unrecognised orchestrator.js');

  if (/^\s*sudo\s/m.test(source)) {
    fail('the desktop tool runs sudo - it must never need a password');
  } else {
    pass('the desktop tool never escalates with sudo');
  }

  // `verify` is the half of the story no file on disk can answer - whether the
  // app that is open now loaded the patched file - and the install page tells
  // people to use it. It has to exist in both the help text and the dispatch, or
  // the page and the tool disagree about what the tool does.
  source.includes('verify    wait') && /^\s*verify\)\s+cmd_verify/m.test(source)
    ? pass('`verify` is documented in the help text and dispatched')
    : fail('`verify` is missing from the help text or the command dispatch');

  // Waiting is only acceptable because it is bounded and interruptible: a run
  // left alone must always come back, and a person must be able to stop it.
  /^WAIT_SECS=\d+$/m.test(source) && source.includes("trap 'interrupted=1' INT")
    ? pass('the relaunch wait has a default timeout and Ctrl-C stops it')
    : fail('the relaunch wait has no default timeout, or cannot be interrupted');

  // And it must only ever wait for a relaunch that can happen: with Freebuff
  // closed there is nothing to observe, so a piped or scripted install would sit
  // on the wait for the whole timeout. The `|| true` matters too - a wait that
  // times out must not turn a successful patch into a failure.
  /if \[ "\$WAIT" = "1" \]; then\s+verify_running "\$app" "\$target" \|\| true/.test(source) &&
  source.includes('if app_running; then')
    ? pass('install waits only when Freebuff is open, and a timed-out wait cannot fail it')
    : fail('install can wait with Freebuff closed, or lets a timed-out wait fail the patch');

  const syntax = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
  if (syntax.status === 0) pass('the desktop tool passes `sh -n`');
  else fail(`the desktop tool has a shell syntax error: ${(syntax.stderr || '').trim()}`);

  checkDesktopPackaging();
  checkDesktopPowerShell();
  checkDesktopLinux();

  // The install page has to actually offer them, or the tools are unreachable.
  const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');

  html.includes('id="desktop"')
    ? pass('the install page has a desktop section')
    : fail('site/index.html lost its #desktop section - the tool is unreachable');

  html.includes('data-desktop-command') && html.includes('data-desktop-zip')
    ? pass('the desktop one-liner and package are wired into the page')
    : fail('site/index.html no longer carries the desktop command and zip hooks');

  for (const part of [
    'freebuff-adblock-desktop.sh',
    'freebuff-adblock-desktop.ps1',
    'freebuff-adblock-desktop-linux.sh',
    'freebuff-adblock-desktop-',
    'data-desktop-win-command',
    'data-desktop-win-zip',
    'data-desktop-linux-command',
    'data-desktop-linux-zip',
  ]) {
    html.includes(part)
      ? pass(`the page references ${part}`)
      : fail(`site/index.html no longer references ${part}`);
  }

  // The Windows one-liner is the one thing a reader is told to paste, so what is
  // on the page has to be the runnable shape: whatever it fetches, piped into iex.
  const winCommand = (html.match(/<code data-desktop-win-command>([^<]*)<\/code>/) || [])[1] || '';
  /^irm \S+ \| iex$/.test(winCommand.trim())
    ? pass(`the Windows one-liner is the piped form (${winCommand.trim()})`)
    : fail(`the Windows one-liner is not "irm <url> | iex": ${JSON.stringify(winCommand.trim())}`);

  // The Linux one-liner is the same shape as the macOS one - a fetch piped into
  // a shell - but it has to name the Linux script, or a Linux reader is handed a
  // macOS tool.
  const linuxCommand = (html.match(/<code data-desktop-linux-command>([^<]*)<\/code>/) || [])[1] || '';
  /^curl -fsSL \S+downloads\/freebuff-adblock-desktop-linux\.sh \| sh$/.test(linuxCommand.trim())
    ? pass(`the Linux one-liner fetches the Linux tool (${linuxCommand.trim()})`)
    : fail(`the Linux one-liner is not "curl -fsSL <linux tool> | sh": ${JSON.stringify(linuxCommand.trim())}`);

  // The platform switch. macOS and Windows have a tool, Linux does not, so exactly
  // those two tabs may be selectable and Linux must stay disabled - an enabled tab
  // with no panel behind it is a control that does nothing when clicked.
  const tabs = [...html.matchAll(/data-platform="([a-z]+)"([^>]*)>/g)].map((m) => ({
    name: m[1],
    disabled: /\bdisabled\b/.test(m[2]),
  }));
  const panels = [...html.matchAll(/data-platform-panel="([a-z]+)"/g)].map((m) => m[1]);

  if (!tabs.length) {
    fail('site/index.html lost its platform switch - the desktop section has no platform control');
  } else {
    const enabled = tabs.filter((tab) => !tab.disabled).map((tab) => tab.name);
    pass(`platform tabs: ${tabs.length} (selectable: ${enabled.join(', ') || 'none'})`);

    const orphaned = enabled.filter((name) => !panels.includes(name));
    orphaned.length
      ? fail(`these platforms are selectable but have no panel to show: ${orphaned.join(', ')}`)
      : pass('every selectable platform has content behind it');

    const unreachable = panels.filter((name) => !enabled.includes(name));
    unreachable.length
      ? fail(`these platforms have content but no selectable tab: ${unreachable.join(', ')}`)
      : pass('every platform with content has a tab');

    const macos = tabs.find((tab) => tab.name === 'macos');
    macos && !macos.disabled
      ? pass('the macOS tab is selectable, and the macOS tool ships')
      : fail('the macOS tab is disabled or missing, but the macOS tool is one that ships');

    const windows = tabs.find((tab) => tab.name === 'windows');
    windows && !windows.disabled
      ? pass('the Windows tab is selectable, and the Windows tool ships')
      : fail('the Windows tab is disabled - the Windows tool is unreachable from the page');

    const linux = tabs.find((tab) => tab.name === 'linux');
    linux && !linux.disabled
      ? pass('the Linux tab is selectable, and the Linux tool ships')
      : fail('the Linux tab is disabled - the Linux tool is unreachable from the page');
  }

  // Both desktop packages have to be named after the same version the extension
  // ships under: one product, one release, one number.
  for (const name of [
    `freebuff-adblock-desktop-${manifest.version}.zip`,
    `freebuff-adblock-desktop-${manifest.version}-windows.zip`,
    `freebuff-adblock-desktop-${manifest.version}-linux.zip`,
  ]) {
    html.includes(name)
      ? pass(`the page offers ${name}`)
      : fail(`the desktop section does not offer ${name}`);
  }

  const buildSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8');
  buildSource.includes('desktopVersion')
    ? fail('scripts/build.mjs writes a second version into version.json')
    : pass('version.json carries the one app version');
}

/* ------------------------------------------------------------------ package */

function run() {
  console.log('Validating extension/');

  const manifest = checkManifest();
  checkIcons(manifest);
  checkPopup();
  checkRules();
  checkSelectors();
  checkOrigin();
  checkPickerWiring();
  checkStoreButtons();
  checkVersionLabels(manifest);
  checkPrivacy();
  checkStoreAssets();
  checkDesktop(manifest);

  console.log('');
  if (problems.length) {
    console.error(`FAILED - ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log('All extension checks passed.');
}

run();
