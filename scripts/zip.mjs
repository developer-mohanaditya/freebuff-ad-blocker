/**
 * Dependency-free ZIP writer.
 *
 * The production build image is Node-only and uploaded files lose their
 * executable bit, so shelling out to a `zip` binary is not an option. This
 * implements just enough of the format: deflate (with a stored fallback),
 * local headers, the central directory, and the end-of-central-directory
 * record.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The modification time stamped on every entry.
 *
 * Fixed, deliberately - not the wall clock. A ZIP stores a time per entry, so
 * stamping `new Date()` makes two builds of identical sources produce different
 * bytes: the package shipped to a store could never be checked against the
 * commit it came from, and every `npm run build` dirtied the working tree. The
 * default is the ZIP epoch, which is what reproducible-build tooling uses when
 * there is no better answer. `SOURCE_DATE_EPOCH` overrides it.
 */
function entryDate() {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000);
  return new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
}

/** Read in UTC, so the archive does not vary with the machine's timezone. */
function dosDateTime(date = entryDate()) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * @param {{ name: string, data: Buffer, mode?: number }[]} entries
 *   `mode` is optional and Unix-only. The extension packages omit it, so their
 *   bytes are unchanged; a package that ships an executable (the desktop zip's
 *   double-clickable launcher) passes 0o755, which macOS Archive Utility reads
 *   back out of the external-attributes field when it extracts the file.
 * @returns {Buffer}
 */
export function createZip(entries) {
  if (entries.length > 0xffff) throw new Error('Too many entries for a non-zip64 archive');

  const localParts = [];
  const centralParts = [];
  const { time, date } = dosDateTime();
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const source = entry.data;

    const deflated = zlib.deflateRawSync(source, { level: 9 });
    const stored = deflated.length >= source.length;
    const payload = stored ? source : deflated;
    const method = stored ? METHOD_STORE : METHOD_DEFLATE;
    const crc = crc32(source);

    // A mode switches the entry to Unix and stores the permission bits where
    // the extractor looks for them. Without one, the header stays exactly as it
    // has always been, so the extension zips reproduce byte for byte.
    const unixMode = typeof entry.mode === 'number' ? entry.mode : null;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    // 0x031e is 'made by UNIX, version 3.0' - required for the mode below to
    // mean anything to the extractor.
    central.writeUInt16LE(unixMode === null ? 20 : 0x031e, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(unixMode === null ? 0 : ((unixMode & 0xffff) << 16) >>> 0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/** Recursively list files under `dir`, returning paths relative to it. */
export function walk(dir, base = dir, out = []) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) walk(full, base, out);
    else if (dirent.isFile()) out.push(path.relative(base, full));
  }
  return out;
}
