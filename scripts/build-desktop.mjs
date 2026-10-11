/**
 * Desktop-tool packaging.
 * *   desktop/  ->  site/downloads/freebuff-adblock-desktop.sh
 *              ->  site/downloads/freebuff-adblock-desktop.ps1
 *              ->  site/downloads/freebuff-adblock-desktop-linux.sh
 *              ->  site/downloads/freebuff-adblock-desktop-<version>.zip          (macOS)
 *              ->  site/downloads/freebuff-adblock-desktop-<version>-windows.zip  (Windows)
 *              ->  site/downloads/freebuff-adblock-desktop-<version>-linux.zip    (Linux)
 *
 * `<version>` is the app version, read from extension/manifest.json by
 * build.mjs and handed in here - the extension and the desktop tools are one
 * product released under one number, so nothing in this step may invent a
 * version of its own.
 *
 * Every tool is an artifact in its own right: each is what the install page
 * tells people to pipe into a shell (`curl … | sh`, `irm … | iex`), so each is
 * served as a plain file as well as inside its zip — under the names its own
 * read-me and usage text use (see ZIP_TOOL_NAME below). The macOS zip carries
 * the tool, a double-clickable `.command` and a short INSTALL.txt, and it is the
 * zip that stores the Unix permission bits - a bare file served over HTTP loses its
 * executable bit, but a mode written into the archive survives extraction. The
 * Windows zip carries the `.ps1`, a double-clickable `.cmd` and its own
 * INSTALL.txt; nothing in it depends on a permission bit, which is why each
 * platform gets a package of its own rather than one package with every tool in
 * it.
 *
 * Linux gets the tool and a read-me, and no launcher: an AppImage user already
 * runs things from a shell, and the tool itself is the entry point. The
 * extraction it does is the interesting part, and that is in the script.
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

const SH_SOURCE = 'freebuff-adblock.sh';
const SH_LAUNCHER = 'Freebuff AdBlock.command';
const SH_NOTES = 'INSTALL.txt';

const PS_SOURCE = 'freebuff-adblock.ps1';
const PS_LAUNCHER = 'Freebuff AdBlock.cmd';
const PS_NOTES = 'INSTALL-windows.txt';

const LINUX_SOURCE = 'freebuff-adblock-linux.sh';
const LINUX_NOTES = 'INSTALL-linux.txt';

const SCRIPT_NAME = 'freebuff-adblock-desktop.sh';
const WINDOWS_SCRIPT_NAME = 'freebuff-adblock-desktop.ps1';
const LINUX_SCRIPT_NAME = 'freebuff-adblock-desktop-linux.sh';

/**
 * What a downloaded zip calls each tool - deliberately *not* the served name.
 *
 * The two names exist for different readers. The served name is the download
 * URL the one-liners fetch, and it is desktop-prefixed to sit clearly beside the
 * extension's packages. The zip is for someone who would rather have the file,
 * and everything that reader is told to type comes from three places that agree
 * with each other: INSTALL.txt / INSTALL-linux.txt, the `Usage:` block the tool
 * prints for `help`, and the commands in its own output. All of them say
 * `sh freebuff-adblock.sh` and `sh freebuff-adblock-linux.sh`, because those are
 * the source files' names - so those are the names the zip has to carry. Named
 * after the served file instead, a downloaded zip told its user to run a file
 * that was not there, and the macOS `.command` launcher - `sh ./freebuff-adblock.sh`
 * - failed on the double-click it exists for. Windows never had the problem,
 * because there the served name is the name the tool documents.
 */
const ZIP_TOOL_NAME = 'freebuff-adblock.sh';
const ZIP_LINUX_TOOL_NAME = 'freebuff-adblock-linux.sh';
const ZIP_NAME = (version) => `freebuff-adblock-desktop-${version}.zip`;
const WINDOWS_ZIP_NAME = (version) => `freebuff-adblock-desktop-${version}-windows.zip`;
const LINUX_ZIP_NAME = (version) => `freebuff-adblock-desktop-${version}-linux.zip`;

/**
 * Only files this step owns - an extension package is never touched here.
 * `freebuff-adblock-desktop.sh` and `freebuff-adblock-desktop.ps1` are the two
 * served tools; the rest are version-suffixed packages.
 */
const OURS = /^freebuff-adblock-desktop(-linux)?(\.[a-z0-9]+|(-[\d.]+)?(-windows|-linux)?\.zip)$/;

function log(...parts) {
  console.log('[desktop]', ...parts);
}

function read(relative) {
  return fs.readFileSync(path.join(DESKTOP_DIR, relative), 'utf8');
}

/** Fill in the two placeholders the tools read at runtime. */
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

function require(file) {
  if (!fs.existsSync(path.join(DESKTOP_DIR, file))) {
    throw new Error(`desktop/${file} is missing - nothing to package`);
  }
}

/**
 * One platform's package: the tool, its read-me, and a launcher when that
 * platform has one to hand over (macOS's `.command`, Windows's `.cmd`). Linux
 * passes no launcher: the script is the entry point.
 */
function packageFor({ tool, toolName, launcherName, launcherSource, notesName, notesSource, version, origin }) {
  const stampedTool = stamp(tool, { version, origin });

  // 0o755 for anything meant to be run, 0o644 for the read-me. On Windows the
  // mode is inert; the .cmd is what a person double-clicks there.
  const entries = [
    { name: toolName, data: Buffer.from(stampedTool), mode: 0o755 },
    ...(launcherName
      ? [{ name: launcherName, data: Buffer.from(launcherSource), mode: 0o755 }]
      : []),
    { name: notesName, data: Buffer.from(stamp(notesSource, { version, origin })), mode: 0o644 },
  ];

  return { tool: stampedTool, entries, zip: createZip(entries) };
}

export function buildDesktop({ version, origin }) {
  if (!version) throw new Error('buildDesktop needs the app version');

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  for (const file of [
    SH_SOURCE,
    SH_LAUNCHER,
    SH_NOTES,
    PS_SOURCE,
    PS_LAUNCHER,
    PS_NOTES,
    LINUX_SOURCE,
    LINUX_NOTES,
  ]) {
    require(file);
  }

  const sh = packageFor({
    tool: read(SH_SOURCE),
    toolName: ZIP_TOOL_NAME,
    launcherName: SH_LAUNCHER,
    launcherSource: read(SH_LAUNCHER),
    notesName: SH_NOTES,
    notesSource: read(SH_NOTES),
    version,
    origin,
  });

  const ps = packageFor({
    tool: read(PS_SOURCE),
    toolName: WINDOWS_SCRIPT_NAME,
    launcherName: PS_LAUNCHER,
    launcherSource: read(PS_LAUNCHER),
    notesName: PS_NOTES,
    notesSource: read(PS_NOTES),
    version,
    origin,
  });

  const linux = packageFor({
    tool: read(LINUX_SOURCE),
    toolName: ZIP_LINUX_TOOL_NAME,
    notesName: LINUX_NOTES,
    notesSource: read(LINUX_NOTES),
    version,
    origin,
  });

  // The two bare tools, served as files as well as inside their zips, because
  // they are what the one-liners fetch.
  const shPath = path.join(DOWNLOADS_DIR, SCRIPT_NAME);
  fs.writeFileSync(shPath, sh.tool);
  fs.chmodSync(shPath, 0o755);

  fs.writeFileSync(path.join(DOWNLOADS_DIR, WINDOWS_SCRIPT_NAME), ps.tool);

  const linuxPath = path.join(DOWNLOADS_DIR, LINUX_SCRIPT_NAME);
  fs.writeFileSync(linuxPath, linux.tool);
  fs.chmodSync(linuxPath, 0o755);

  const shZipName = ZIP_NAME(version);
  fs.writeFileSync(path.join(DOWNLOADS_DIR, shZipName), sh.zip);

  const psZipName = WINDOWS_ZIP_NAME(version);
  fs.writeFileSync(path.join(DOWNLOADS_DIR, psZipName), ps.zip);

  const linuxZipName = LINUX_ZIP_NAME(version);
  fs.writeFileSync(path.join(DOWNLOADS_DIR, linuxZipName), linux.zip);

  // Drop stale desktop artifacts only. packageAll() cleans the extension zips.
  const keep = new Set([SCRIPT_NAME, WINDOWS_SCRIPT_NAME, LINUX_SCRIPT_NAME, shZipName, psZipName, linuxZipName]);
  for (const existing of fs.readdirSync(DOWNLOADS_DIR)) {
    if (OURS.test(existing) && !keep.has(existing)) {
      fs.unlinkSync(path.join(DOWNLOADS_DIR, existing));
      log('removed stale desktop package', existing);
    }
  }

  const tool = (fileName, bytes) => ({
    fileName,
    relativePath: `downloads/${fileName}`,
    absoluteUrl: `${origin}/downloads/${fileName}`,
    bytes,
  });

  const archive = (fileName, bytes, fileCount) => ({
    fileName,
    relativePath: `downloads/${fileName}`,
    absoluteUrl: `${origin}/downloads/${fileName}`,
    bytes,
    fileCount,
  });

  const script = tool(SCRIPT_NAME, Buffer.byteLength(sh.tool));
  const windowsScript = tool(WINDOWS_SCRIPT_NAME, Buffer.byteLength(ps.tool));
  const linuxScript = tool(LINUX_SCRIPT_NAME, Buffer.byteLength(linux.tool));
  const desktopZip = archive(shZipName, sh.zip.length, sh.entries.length);
  const windowsZip = archive(psZipName, ps.zip.length, ps.entries.length);
  const linuxZip = archive(linuxZipName, linux.zip.length, linux.entries.length);

  log(`tool     site/${script.relativePath}   (${formatBytes(script.bytes)})`);
  log(`package  site/${desktopZip.relativePath}   (${desktopZip.fileCount} files, ${formatBytes(desktopZip.bytes)})`);
  log(`tool     site/${windowsScript.relativePath}   (${formatBytes(windowsScript.bytes)})`);
  log(`package  site/${windowsZip.relativePath}   (${windowsZip.fileCount} files, ${formatBytes(windowsZip.bytes)})`);
  log(`tool     site/${linuxScript.relativePath}   (${formatBytes(linuxScript.bytes)})`);
  log(`package  site/${linuxZip.relativePath}   (${linuxZip.fileCount} files, ${formatBytes(linuxZip.bytes)})`);

  return {
    script,
    archive: desktopZip,
    windowsScript,
    windowsArchive: windowsZip,
    linuxScript,
    linuxArchive: linuxZip,
  };
}
