/**
 * Desktop-tool packaging.
 *
 *   desktop/  ->  site/downloads/freebuff-adblock-desktop.sh
 *              -> site/downloads/freebuff-adblock-desktop-<version>.zip
 *
 * `<version>` is the app version, read from extension/manifest.json by
 * build.mjs and handed in here - the extension and the desktop tool are one
 * product released under one number, so nothing in this step may invent a
 * version of its own.
 *
 * The shell tool is the artifact: it is what the install page tells people to
 * pipe through `sh`, so it is served as a plain file as well as inside the zip.
 * The zip carries the same tool plus a double-clickable `.command` and a short
 * INSTALL.txt, and it is the zip that stores the Unix permission bits - a bare
 * file served over HTTP loses its executable bit, but a mode written into the
 * archive survives extraction.
 *
 * Idempotent and dependency-free, like the rest of the build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_DIR = path.join(ROOT, 'desktop');
const DOWNLOADS_DIR = path.join(ROOT, 'site', 'downloads');

const TOOL_SOURCE = 'freebuff-adblock.sh';
const LAUNCHER_SOURCE = 'Freebuff AdBlock.command';
const NOTES_SOURCE = 'INSTALL.txt';

const SCRIPT_NAME = 'freebuff-adblock-desktop.sh';
const ZIP_NAME = (version) => `freebuff-adblock-desktop-${version}.zip`;

/** Only files this step owns - an extension package is never touched here. */
const OURS = /^(freebuff-adblock-desktop(-[\d.]+)?\.(zip|sh))$/;

function log(...parts) {
  console.log('[desktop]', ...parts);
}

function read(relative) {
  return fs.readFileSync(path.join(DESKTOP_DIR, relative), 'utf8');
}

/** Fill in the two placeholders the tool reads at runtime. */
function stamp(source, { version, origin }) {
  return source
    .replaceAll('__FBD_VERSION__', version)
    .replaceAll('__FBD_ORIGIN__', origin);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildDesktop({ version, origin }) {
  if (!version) throw new Error('buildDesktop needs the app version');

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  if (!fs.existsSync(path.join(DESKTOP_DIR, TOOL_SOURCE))) {
    throw new Error(`desktop/${TOOL_SOURCE} is missing - nothing to package`);
  }

  const tool = stamp(read(TOOL_SOURCE), { version, origin });
  const launcher = read(LAUNCHER_SOURCE);
  const notes = stamp(read(NOTES_SOURCE), { version, origin });

  const scriptPath = path.join(DOWNLOADS_DIR, SCRIPT_NAME);
  fs.writeFileSync(scriptPath, tool);
  fs.chmodSync(scriptPath, 0o755);

  // 0o755 for anything meant to be run, 0o644 for the read-me.
  const entries = [
    { name: SCRIPT_NAME, data: Buffer.from(tool), mode: 0o755 },
    { name: LAUNCHER_SOURCE, data: Buffer.from(launcher), mode: 0o755 },
    { name: NOTES_SOURCE, data: Buffer.from(notes), mode: 0o644 },
  ];

  const zip = createZip(entries);
  const zipName = ZIP_NAME(version);
  fs.writeFileSync(path.join(DOWNLOADS_DIR, zipName), zip);

  // Drop stale desktop packages only. packageAll() cleans the extension zips.
  for (const existing of fs.readdirSync(DOWNLOADS_DIR)) {
    if (OURS.test(existing) && existing !== SCRIPT_NAME && existing !== zipName) {
      fs.unlinkSync(path.join(DOWNLOADS_DIR, existing));
      log('removed stale desktop package', existing);
    }
  }

  const script = {
    fileName: SCRIPT_NAME,
    relativePath: `downloads/${SCRIPT_NAME}`,
    absoluteUrl: `${origin}/downloads/${SCRIPT_NAME}`,
    bytes: Buffer.byteLength(tool),
  };

  const archive = {
    fileName: zipName,
    relativePath: `downloads/${zipName}`,
    absoluteUrl: `${origin}/downloads/${zipName}`,
    bytes: zip.length,
    fileCount: entries.length,
  };

  log(`tool     site/${script.relativePath}   (${formatBytes(script.bytes)})`);
  log(`package  site/${archive.relativePath}   (${archive.fileCount} files, ${formatBytes(archive.bytes)})`);

  return { script, archive };
}
