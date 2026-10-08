/**
 * Build pipeline.
 *
 *   extension/  ->  site/downloads/freebuff-adblock-<version>.zip
 *               ->  site/update.xml
 *   site/       ->  dist/   (static output the preview and hosting serve)
 *
 * Idempotent and dependency-free so it runs identically in the sandbox and in
 * the production build image (Node only, no shell utilities, no network).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDesktop } from './build-desktop.mjs';
import { ensureIcons } from './png.mjs';
import { createZip, walk } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension');
const SITE_DIR = path.join(ROOT, 'site');
const DIST_DIR = path.join(ROOT, 'dist');
const ICONS_DIR = path.join(EXT_DIR, 'icons');
const DOWNLOADS_DIR = path.join(SITE_DIR, 'downloads');

/**
 * Public origin the install page and update feed are served from.
 * Must match INSTALL_URL in extension/popup.js.
 * Override with SITE_ORIGIN when the project is deployed elsewhere.
 */
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://freebuff-adblocker.vercel.app';

const ZIP_ROOT_FOLDER = 'freebuff-adblock';

/** Chrome rejects this feed until the real ID and a signed CRX exist. */
const PLACEHOLDER_APP_ID = 'YOUR_EXTENSION_ID_HERE';

/**
 * What Firefox needs and Chromium does not.
 *
 * Firefox has no Manifest V3 service worker, so it runs the same file as an
 * event page through `background.scripts`. Chromium reads that key as Manifest
 * V2: harmless since Chrome 121, which ignores it - but it is still reported as
 * a warning on the extensions page. So the source manifest stays Chromium-clean
 * and this is added to the Firefox package only.
 *
 * The Firefox background is `scripts` *alone*. Keeping `service_worker` beside
 * it is what AMO's validator warns about - "unsupported ... and ignored on
 * Firefox" - and dropping the key is the fix, not pairing it with a fallback.
 * Firefox cannot use a service worker at all, so there is nothing to lose.
 *
 * The id is required to sign an MV3 add-on on AMO. A GUID is used rather than an
 * address, so it cannot collide with - or be squatted on - a real domain.
 */
const GECKO = {
  id: '{7b3d9c4a-1e62-4f58-9c07-2ab5e8d41f93}',
  // 142, and it is a floor taken from the validator rather than from a feature
  // this extension uses. `data_collection_permissions` below arrived in desktop
  // Firefox 140 and Firefox for Android 142, and AMO's validator checks the
  // declared minimum against *both* even for an add-on that never ships on
  // Android - it reads the Android floor straight off this desktop value. Claim
  // 140 and every submission carries a permanent
  // KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION warning for a platform this
  // build does not target (no `gecko_android` key). 142 is the smallest value
  // that reports clean, and both 140 and 142 are long superseded.
  strict_min_version: '142.0',
  // AMO blocks the submission of any new extension that does not say whether it
  // collects data. This one has no server and transmits nothing, and `none` is
  // the only way to say exactly that. It is valid in `required` only - the
  // `optional` list has no such value - and once a version ships the key, every
  // later version has to keep it.
  // https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
  data_collection_permissions: { required: ['none'] },
};

/** The same extension, declared the way Firefox has to have it. */
export function firefoxManifest(manifest) {
  const firefox = structuredClone(manifest);
  const worker = manifest.background.service_worker;
  firefox.background = { scripts: [worker] };
  firefox.browser_specific_settings = { gecko: structuredClone(GECKO) };
  return firefox;
}

function log(...parts) {
  console.log('[build]', ...parts);
}

/* ------------------------------------------------------------------ helpers */

function readManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) {
    throw new Error(`manifest.json version "${manifest.version}" is not a valid version`);
  }
  return manifest;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ------------------------------------------------------------- package the zip */

function packageAll(version, manifest) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  const files = walk(EXT_DIR).sort();
  if (!files.includes('manifest.json')) {
    throw new Error('extension/manifest.json not found - nothing to package');
  }

  const pack = (root, suffix, override) => {
    const entries = files.map((relative) => {
      const name = relative.split(path.sep).join('/');
      const swapped = name === 'manifest.json' && override;
      return {
        // A single top-level folder keeps a hand-extracted result tidy. Store
        // submissions are the other way round: the Chrome Web Store, Edge
        // Add-ons and AMO all want manifest.json at the root of the archive.
        name: root ? `${root}/${name}` : name,
        data: swapped
          ? Buffer.from(`${JSON.stringify(override, null, 2)}\n`)
          : fs.readFileSync(path.join(EXT_DIR, relative)),
      };
    });

    const zip = createZip(entries);
    const fileName = `freebuff-adblock-${version}${suffix}.zip`;
    fs.writeFileSync(path.join(DOWNLOADS_DIR, fileName), zip);

    return {
      fileName,
      relativePath: `downloads/${fileName}`,
      absoluteUrl: `${SITE_ORIGIN}/downloads/${fileName}`,
      bytes: zip.length,
      fileCount: entries.length,
    };
  };

  const unpacked = pack(ZIP_ROOT_FOLDER, '');
  const store = pack(null, '-store');
  const firefox = pack(null, '-firefox', firefoxManifest(manifest));

  // Remove stale packages so downloads/ never accumulates old versions. Every
  // current variant is kept - none is a leftover of another. The pattern is
  // deliberately narrow: the desktop tool's packages live in the same folder
  // and are cleaned by buildDesktop(), not here.
  const EXTENSION_PACKAGE = /^freebuff-adblock-[\d.]+(-store|-firefox)?\.zip$/;
  const keep = new Set([unpacked.fileName, store.fileName, firefox.fileName]);
  for (const existing of fs.readdirSync(DOWNLOADS_DIR)) {
    if (EXTENSION_PACKAGE.test(existing) && !keep.has(existing)) {
      fs.unlinkSync(path.join(DOWNLOADS_DIR, existing));
      log('removed stale package', existing);
    }
  }

  return { unpacked, store, firefox };
}

/* ---------------------------------------------------------------- update feed */

function writeUpdateXml(version, packageInfo) {
  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<!--
  Chromium update manifest for Freebuff Ad Block.

  BEFORE THIS FEED GOES LIVE:
    1. Replace ${PLACEHOLDER_APP_ID} with the real 32-character extension ID
       (chrome://extensions -> Details -> ID) of the PACKED extension.
    2. Publish the extension's .crx and point codebase at it. A .zip is only a
       placeholder here - Chrome installs from an update feed expect a CRX.
    3. Make sure SITE_ORIGIN (scripts/build.mjs) matches the domain this file
       is actually served from.

  Chrome only consults this feed for extensions installed FROM it, i.e. via a
  managed ExtensionInstallForcelist policy or the Chrome Web Store. An
  extension loaded unpacked never reads it. See the Auto-updates section of the
  install page.
-->
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${PLACEHOLDER_APP_ID}'>
    <updatecheck codebase='${packageInfo.absoluteUrl}' version='${version}' />
  </app>
</gupdate>
`;

  fs.writeFileSync(path.join(SITE_DIR, 'update.xml'), xml);
}

/* ------------------------------------------------------------------ site dist */

/**
 * Copy site/ into dist/ and stamp the version into index.html.
 * Substitutions are regexes over already-substituted values, so rebuilding
 * never drifts: run it twice and the output is identical.
 */
function writeDist(version, packageInfo, storeInfo, firefoxInfo, desktop) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  fs.cpSync(SITE_DIR, DIST_DIR, { recursive: true });

  // The version-suffixed filenames are rewritten to whatever this build just
  // produced, so the page can never point at a package that is not there. The
  // Firefox pattern is checked separately: `[\d.]+\.zip` cannot match
  // `-firefox.zip`, because the character after the version is a dash.
  const stamp = (source) =>
    source
      .replace(
        /href="downloads\/freebuff-adblock-[\d.]+\.zip"/g,
        `href="${packageInfo.relativePath}"`
      )
      .replace(
        /href="downloads\/freebuff-adblock-[\d.]+-firefox\.zip"/g,
        `href="${firefoxInfo.relativePath}"`
      )
      .replace(
        /href="downloads\/freebuff-adblock-desktop-[\d.]+\.zip"/g,
        `href="${desktop.archive.relativePath}"`
      )
      .replace(/(<span data-version>)[^<]*(<\/span>)/g, `$1${version}$2`)
      .replace(/(<span data-desktop-version>)[^<]*(<\/span>)/g, `$1${version}$2`)
      .replace(/(<code data-download-path>)[^<]*(<\/code>)/g, `$1/${packageInfo.relativePath}$2`)
      .replace(
        /(<code data-desktop-command>)[^<]*(<\/code>)/g,
        `$1curl -fsSL ${SITE_ORIGIN}/${desktop.script.relativePath} | sh$2`
      );

  const indexPath = path.join(DIST_DIR, 'index.html');
  fs.writeFileSync(indexPath, stamp(fs.readFileSync(indexPath, 'utf8')));

  // Keep the source copy in sync too, so site/ is always directly serveable.
  const sourceIndex = path.join(SITE_DIR, 'index.html');
  const sourceHtml = fs.readFileSync(sourceIndex, 'utf8');
  const stampedSource = stamp(sourceHtml);

  if (stampedSource !== sourceHtml) {
    fs.writeFileSync(sourceIndex, stampedSource);
    log('stamped version into site/index.html');
  }

  // Favicon for the install page, straight from the extension's own artwork.
  const favicon = path.join(ICONS_DIR, 'icon128.png');
  if (fs.existsSync(favicon)) fs.copyFileSync(favicon, path.join(DIST_DIR, 'favicon.png'));

  fs.writeFileSync(
    path.join(DIST_DIR, 'version.json'),
    `${JSON.stringify(
      {
        version,
        zip: packageInfo.relativePath,
        store: storeInfo ? storeInfo.relativePath : null,
        firefox: firefoxInfo ? firefoxInfo.relativePath : null,
        desktop: desktop ? desktop.script.relativePath : null,
        desktopZip: desktop ? desktop.archive.relativePath : null,
        origin: SITE_ORIGIN,
      },
      null,
      2
    )}\n`
  );
}

/* --------------------------------------------------------------------- build */

export function build() {
  const started = Date.now();

  const regenerated = ensureIcons(ICONS_DIR);
  if (regenerated) log('generated extension icons');

  const manifest = readManifest();
  const version = manifest.version;

  const { unpacked, store, firefox } = packageAll(version, manifest);
  writeUpdateXml(version, unpacked);
  const desktop = buildDesktop({ version, origin: SITE_ORIGIN });
  writeDist(version, unpacked, store, firefox, desktop);

  log(`v${version} - ${unpacked.fileCount} files, ${formatBytes(unpacked.bytes)}`);
  log(`desktop  Freebuff Desktop patch tool v${version}`);
  log(`package  site/${unpacked.relativePath}   (load unpacked, Chromium)`);
  log(`package  site/${store.relativePath}   (Chrome Web Store, Edge Add-ons)`);
  log(`package  site/${firefox.relativePath}   (addons.mozilla.org)`);
  log('feed     site/update.xml');
  log(`output   dist/  (${Date.now() - started}ms)`);

  return { version, unpacked, store, firefox };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) build();
