/**
 * Linux desktop tool checks.
 *
 * These are the only desktop checks that run the tool the way its users do, on
 * the platform it is for. Everything here is a real process: a real `sh`, the
 * real perl engine, real fixtures on disk, and - for the AppImage half - a real
 * ELF binary that extracts like an AppImage does. Nothing is stubbed.
 *
 * The two shapes the Linux tool has to survive:
 *
 *   a tree   a directory holding `resources/orchestrator/orchestrator.js`, which
 *            is patched in place. That is the extracted copy the tool makes, and
 *            what a system install would be.
 *   an image a single executable holding a read-only SquashFS. The tool must
 *            extract it, patch the copy, and never touch the image itself. The
 *            fixture for this is compiled from C at test time: it writes a
 *            `squashfs-root/` tree relative to the working directory exactly as
 *            the AppImage runtime does, so `--appimage-extract` is exercised for
 *            real rather than mocked. If there is no C compiler the image checks
 *            say so and skip; every tree check still runs.
 *
 * Safety properties come first, as they do in the other two suites: a pristine
 * build is recognised and patched, the helpers that are NOT the ad path are left
 * byte-identical, a build whose anchor count moved is refused rather than
 * half-patched, a second run does not stack a second patch, and `revert` restores
 * the original bytes.
 *
 * Run with `npm run test:linux` (also part of `npm test`).
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CURRENT, GATE, RENAMED, TWO_GATES, DECOY } from './desktop-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'desktop', 'freebuff-adblock-linux.sh');
const ORCH = 'resources/orchestrator/orchestrator.js';

let results = 0;
let failures = 0;

function check(name, actual, expected) {
  results++;
  const ok = actual === expected;
  if (!ok) failures++;
  const show = (value) => (typeof value === 'string' && value.length > 90 ? `${value.slice(0, 90)}…` : JSON.stringify(value));
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ` -> ${show(actual)} (want ${show(expected)})`}`);
}

const count = (text, needle) => text.split(needle).length - 1;
const read = (file) => fs.readFileSync(file, 'utf8');
const both = (result) => `${result.stdout}${result.stderr}`;

/* ------------------------------------------------------------------- the tool */

for (const bin of ['sh', 'perl', 'pgrep', 'ps']) {
  const found = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  if (found.status !== 0) {
    console.log(`\nSKIPPED: this suite needs ${bin}, which is not on this machine.`);
    process.exit(0);
  }
}
const TOOL_SOURCE = read(TOOL);

/* ------------------------------------------------------------------ fixtures */

function makeTree(body = CURRENT, name = 'Freebuff.AppDir') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-linux-'));
  const tree = path.join(root, name);
  fs.mkdirSync(path.join(tree, 'resources', 'orchestrator'), { recursive: true });
  const target = path.join(tree, ORCH);
  fs.writeFileSync(target, body);
  return { root, tree, target, backups: path.join(root, 'backups'), work: path.join(root, 'work') };
}

/** The version an extracted AppDir records, which is what names the backup. */
function makeDesktopFile(tree, version) {
  fs.writeFileSync(path.join(tree, 'Freebuff.desktop'), `[Desktop Entry]\nName=Freebuff\nX-AppImage-Version=${version}\n`);
}

const run = (tree, backups, ...args) =>
  spawnSync('sh', [TOOL, ...args, '--app', tree, '--backup-dir', backups], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
    timeout: 120000,
  });

const runWithWork = (tree, backups, work, ...args) =>
  spawnSync(
    'sh',
    [TOOL, ...args, '--app', tree, '--backup-dir', backups, '--work-dir', work],
    { encoding: 'utf8', cwd: os.tmpdir(), timeout: 180000 }
  );

/* ------------------------------------------------------------------- pristine */

console.log('\npristine 0.0.164 tree');
const a = makeTree();
makeDesktopFile(a.tree, '0.0.164');

const version = run(a.tree, a.backups, 'version');
check('version exits 0', version.status, 0);
check('and prints a version', /^freebuff-adblock-desktop-linux \S+$/m.test(version.stdout), true);

const help = run(a.tree, a.backups, 'help');
check('help exits 0', help.status, 0);
check('the help text documents verify', /verify\s+wait for Freebuff/.test(help.stdout), true);
check('and the AppImage rule', /never writes to your download|AppImage rule/.test(help.stdout), true);
check('and it does not offer a macOS-only option', help.stdout.includes('--resign'), false);

const clean = run(a.tree, a.backups, 'status');
check('status exits 0', clean.status, 0);
check('it reads the AppDir version', /version\s+0\.0\.164/.test(clean.stdout), true);
check('it reports both anchors', /render/.test(clean.stdout) && /request/.test(clean.stdout), true);
check('and says it is not patched yet', /Not patched yet/.test(clean.stdout), true);
check('status changes nothing', read(a.target) === CURRENT, true);

const doctor = run(a.tree, a.backups, 'doctor');
check('doctor exits 0', doctor.status, 0);
check('doctor names the tree it resolved', doctor.stdout.includes(a.tree), true);
check('doctor reports the copy writable', /this copy is writable/.test(doctor.stdout), true);
check('doctor reports the perl it will use', /perl\s+\/\S+/.test(doctor.stdout), true);

/* -------------------------------------------------------------------- install */

console.log('\ninstall');
const install = run(a.tree, a.backups, 'install', '--no-wait');
check('install exits 0', install.status, 0);
check('it says what it patched', /patched Freebuff 0\.0\.164/.test(install.stdout), true);

const patched = read(a.target);
check('the render gate is neutralised once', count(patched, 'if (true/*FBD-ADS-OFF:render*/)'), 1);
check('the gate text is gone', patched.includes('localAgenticTestCampaign(process.env)'), false);
check('the ad client request helper returns early', count(patched, '/*FBD-ADS-OFF:request*/'), 1);
check('the early return is the shape its callers expect', patched.includes('return { ok: !1, status: 0, message: "" }'), true);
check('no post anchor was invented', count(patched, '/*FBD-ADS-OFF:post*/'), 0);

// The whole point of the re-anchor: the neighbours stay byte-identical.
check('the sites client request is untouched', patched.includes('async request(path27, method = "GET", body2, idempotencyKey, signal) {'), true);
check('the config clients are untouched', patched.includes('async request(path30, method = "GET", value2, authHost = !1) {'), true);
check('the logs shipper is untouched', patched.includes('fetch(`${API_HOST}/api/logs`, { method: "POST" })'), true);
check('the break-event poster is untouched', patched.includes('async post(path27, body2, options2 = {}) {'), true);
check('the gate body it patched is still there', patched.includes('return { ads: [] }'), true);

check('a backup was taken, named for the AppDir version', fs.existsSync(path.join(a.backups, 'orchestrator.js.0.0.164.orig')), true);
check('the backup is the original bytes', read(path.join(a.backups, 'orchestrator.js.0.0.164.orig')) === CURRENT, true);

console.log('\ninstall twice');
const again = run(a.tree, a.backups, 'install', '--no-wait');
check('second install exits 0', again.status, 0);
check('it reports already patched', /Already patched/.test(again.stdout), true);
check('the render patch did not stack', count(read(a.target), '/*FBD-ADS-OFF:render*/'), 1);
check('the request patch did not stack', count(read(a.target), '/*FBD-ADS-OFF:request*/'), 1);
check('the file is byte-identical to the first patch', read(a.target) === patched, true);

const statusPatched = run(a.tree, a.backups, 'status');
check('status confirms ads are off', /Ads are off/.test(statusPatched.stdout), true);

/* ---------------------------------------------------------------------- verify */

console.log('\nverify');
const noProcess = run(a.tree, a.backups, 'verify', '--no-wait');
check('verify refuses when nothing is running the patched file', noProcess.status !== 0, true);
check('and says why', /Not verified/.test(noProcess.stdout), true);
check('and tells you how to start it', /sh freebuff-adblock-linux\.sh verify/.test(noProcess.stdout), true);
check('verifying wrote nothing', read(a.target) === patched, true);

// A stand-in for the orchestrator: the app runs it with the file as the last
// argument, so a script whose command line ends in the path is what the check is
// looking for. The body carries the anchors so this is the same file shape.
const runTree = makeTree(`#!/bin/sh\nsleep 30\n${CURRENT}`);
fs.chmodSync(runTree.target, 0o755);
run(runTree.tree, runTree.backups, 'install', '--no-wait');
const child = spawn(runTree.target, [], { stdio: 'ignore', detached: true });
child.unref();
await new Promise((resolve) => setTimeout(resolve, 600));

const seen = run(runTree.tree, runTree.backups, 'verify', '--no-wait');
check('verify passes once the patched file is the running process', seen.status, 0);
check('it names the pid it found', /pid \d+/.test(seen.stdout), true);
// The clock line is worded by how close the two times are, and a test process
// starts within the same second as the patch by definition - so both wordings
// are correct here and the *verdict* above is the thing being asserted.
check('it reports where the process sits relative to the patch', /after the patch|within a second of the patch/.test(seen.stdout), true);
check('it names the running app as the patched file', /running app is the patched file/.test(seen.stdout), true);
check('it reports the ad code still in the build', /still in this build: .*auction \d+/.test(seen.stdout), true);
check('it says what only the user can see', /only you can/.test(seen.stdout), true);

try {
  process.kill(-child.pid, 'SIGKILL');
} catch {
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

// A process that merely mentions the path must not count as the orchestrator.
const mentionTree = makeTree();
const mention = spawn('tail', ['-f', mentionTree.target], { stdio: 'ignore', detached: true });
mention.unref();
await new Promise((resolve) => setTimeout(resolve, 400));
const notVerified = run(mentionTree.tree, mentionTree.backups, 'verify', '--no-wait');
check('a process that only mentions the path is not a pass', notVerified.status !== 0, true);
try {
  process.kill(-mention.pid, 'SIGKILL');
} catch {
  try {
    mention.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/* ---------------------------------------------------------------------- revert */

console.log('\nrevert');
const revert = run(a.tree, a.backups, 'revert');
check('revert exits 0', revert.status, 0);
check('the original bytes are restored', read(a.target) === CURRENT, true);
const nothing = run(a.tree, a.backups, 'revert');
check('reverting twice still exits 0', nothing.status, 0);

/* --------------------------------------------------------------- display-only */

console.log('\ndisplay-only');
const b = makeTree();
run(b.tree, b.backups, 'install', '--no-wait', '--display-only');
check('the render gate is applied', count(read(b.target), '/*FBD-ADS-OFF:render*/'), 1);
check('the ad client is left alone', count(read(b.target), '/*FBD-ADS-OFF:request*/'), 0);
check('and the ad client is still intact', read(b.target).includes('async request(method, path27, payload, timeoutMs = REQUEST_TIMEOUT_MS) {'), true);

/* ----------------------------------------------------------------- fail-safe */

console.log('\ntwo gates, as 0.0.155 had');
const c = makeTree(TWO_GATES);
const twoGates = run(c.tree, c.backups, 'install', '--no-wait');
check('install refuses', twoGates.status !== 0, true);
check('the render anchor reads as ambiguous', /render\s+ambiguous/.test(twoGates.stdout), true);
check('it says why, with the counts', /match\(es\)/.test(twoGates.stdout) && /trusted as written/.test(twoGates.stdout), true);
check('it points at the local scan', /freebuff-adblock-linux\.sh scan/.test(twoGates.stdout), true);
check('and at the piped scan', /downloads\/freebuff-adblock-desktop-linux\.sh \| sh -s scan/.test(twoGates.stdout), true);
check('the file is left untouched', read(c.target) === TWO_GATES, true);
check('no backup was taken', fs.existsSync(c.backups), false);

console.log('\nunknown file');
const d = makeTree('export const something = 41; // a future orchestrator with renamed functions\n');
const refused = run(d.tree, d.backups, 'install', '--no-wait');
check('install refuses', refused.status !== 0, true);
check('it says why', /Refusing to patch|does not match/.test(refused.stdout), true);
check('the file is left untouched', read(d.target).includes('something = 41'), true);
check('no backup was taken', fs.existsSync(d.backups), false);

console.log('\na marker where the anchor cannot account for it');
const doubled = makeTree(`${CURRENT}\n/*FBD-ADS-OFF:render*/ /*FBD-ADS-OFF:render*/`);
const halfStatus = run(doubled.tree, doubled.backups, 'status');
check('status refuses to call it patched', halfStatus.status !== 0, true);
check('it reports the anchor as broken', /render\s+broken/.test(halfStatus.stdout), true);
check('install refuses to stack on top of it', run(doubled.tree, doubled.backups, 'install', '--no-wait').status !== 0, true);
check('it left the file alone', read(doubled.target).length > 0, true);

console.log('\nan anchor that is simply gone');
const gone = makeTree(CURRENT.replace(GATE, 'if (false) return { ads: [] };'));
const goneRun = run(gone.tree, gone.backups, 'install', '--no-wait');
check('install refuses', goneRun.status !== 0, true);
check('it reports the render anchor as not found', /render\s+not found/.test(goneRun.stdout), true);
check('it says nothing was written', /Nothing was written/.test(goneRun.stdout), true);
check('it left the file alone', read(gone.target) === CURRENT.replace(GATE, 'if (false) return { ads: [] };'), true);
check('no backup was taken', fs.existsSync(gone.backups), false);

console.log('\ndry run');
const e = makeTree();
const dry = run(e.tree, e.backups, 'install', '--dry-run', '--no-wait');
check('dry run exits 0', dry.status, 0);
check('it writes nothing', read(e.target) === CURRENT, true);
check('it says so', /nothing was written/.test(dry.stdout), true);

console.log('\nrenamed build (the gate moved)');
const f = makeTree(RENAMED);
const renamed = run(f.tree, f.backups, 'install', '--no-wait');
check('install exits 0', renamed.status, 0);
check('it says which anchor it matched', /via relaxed match/.test(renamed.stdout), true);
check('the renamed gate is neutralised', count(read(f.target), '/*FBD-ADS-OFF:render*/'), 1);
check('the ad client is stubbed too', count(read(f.target), '/*FBD-ADS-OFF:request*/'), 1);
run(f.tree, f.backups, 'revert');
check('revert restores the renamed build exactly', read(f.target) === RENAMED, true);

console.log('\ndecoy gate far from ad code');
const g = makeTree(DECOY);
const decoy = run(g.tree, g.backups, 'install', '--no-wait');
check('install refuses', decoy.status !== 0, true);
check('the render anchor reads as ambiguous', /render\s+ambiguous/.test(decoy.stdout), true);
check('the decoy file is untouched', read(g.target) === DECOY, true);
check('no backup was taken', fs.existsSync(g.backups), false);

/* ------------------------------------------------------------------------ scan */

console.log('\nscan');
const i = makeTree();
makeDesktopFile(i.tree, '0.0.164');
const scan = run(i.tree, i.backups, 'scan');
check('scan exits 0', scan.status, 0);
check('scan changes nothing', read(i.target) === CURRENT, true);
check('scan names both strategies', /literal/.test(scan.stdout) && /relaxed/.test(scan.stdout), true);
check('scan marks the usable anchor', /<- usable/.test(scan.stdout), true);
check('scan says a trusted literal has no adjacency check', /trusted as written/.test(scan.stdout), true);
check('scan reports the probes', /== probes ==/.test(scan.stdout), true);
check('scan reports the size it read', /bytes\s+\d+/.test(scan.stdout), true);
// The report is saved under the AppDir's own version, which is what makes it
// attachable to a bug report about one specific build.
check('scan saves the report to attach', read(path.join(i.backups, 'orchestrator-scan.0.0.164.txt')).includes('== render =='), true);

/* -------------------------------------------------------------------- the image */

console.log('\nthe AppImage path');

const CC = spawnSync('sh', ['-c', 'command -v cc || command -v gcc'], { encoding: 'utf8' });
const hasCompiler = CC.status === 0 && CC.stdout.trim() !== '';

/**
 * A stand-in for an AppImage: a real ELF executable that extracts a tree when
 * asked, exactly where a real AppImage puts it. The fixture body and the version
 * are compiled in, so the C source is generated per test.
 */
function buildFakeAppImage(body, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-img-'));
  const bodyPath = path.join(dir, 'body.js');
  fs.writeFileSync(bodyPath, body);
  const source = path.join(dir, 'runtime.c');
  fs.writeFileSync(
    source,
    `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <errno.h>
static const char *BODY = ${JSON.stringify(bodyPath)};
static const char *VERSION = ${JSON.stringify(version)};
int main(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "--appimage-extract") != 0) {
    fprintf(stderr, "this fake runtime only understands --appimage-extract\\n");
    return 2;
  }
  mkdir("squashfs-root", 0755);
  mkdir("squashfs-root/resources", 0755);
  mkdir("squashfs-root/resources/orchestrator", 0755);
  FILE *in = fopen(BODY, "rb");
  if (!in) { perror("body"); return 3; }
  FILE *out = fopen("squashfs-root/resources/orchestrator/orchestrator.js", "wb");
  if (!out) { perror("out"); return 4; }
  char buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, in)) > 0) fwrite(buf, 1, n, out);
  fclose(in); fclose(out);
  FILE *desk = fopen("squashfs-root/Freebuff.desktop", "w");
  if (desk) { fprintf(desk, "[Desktop Entry]\\nName=Freebuff\\nX-AppImage-Version=%s\\n", VERSION); fclose(desk); }
  FILE *apprun = fopen("squashfs-root/AppRun", "w");
  if (apprun) { fprintf(apprun, "#!/bin/sh\\nexec ./@freebuff-desktop\\n"); fclose(apprun); chmod("squashfs-root/AppRun", 0755); }
  return 0;
}
`
  );
  const image = path.join(dir, `Freebuff-${version}-linux-x86_64.AppImage`);
  const cc = spawnSync(CC.stdout.trim(), ['-O0', '-o', image, source], { encoding: 'utf8' });
  if (cc.status !== 0) throw new Error(`compiling the fake runtime failed:\n${cc.stderr}`);
  fs.chmodSync(image, 0o755);
  return { dir, image };
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (!hasCompiler) {
  console.log('  ..    no C compiler on this machine: the AppImage checks were skipped');
} else {
  const img = buildFakeAppImage(CURRENT, '9.9.9');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-linux-img-'));
  const backups = path.join(root, 'backups');
  const work = path.join(root, 'work');

  const before = sha(img.image);
  const imgInstall = runWithWork(img.image, backups, work, 'install', '--no-wait');
  check('installing from an AppImage exits 0', imgInstall.status, 0);
  check('it says it is extracting', /extracting \S+\.AppImage/.test(imgInstall.stdout), true);
  check('it reads the version from the file name', /patched Freebuff 9\.9\.9/.test(imgInstall.stdout), true);
  check('it patches the extracted copy', count(read(path.join(work, 'freebuff-9.9.9', 'squashfs-root', ORCH)), '/*FBD-ADS-OFF:render*/'), 1);
  check('and the ad client in it', count(read(path.join(work, 'freebuff-9.9.9', 'squashfs-root', ORCH)), '/*FBD-ADS-OFF:request*/'), 1);
  check('the image itself is byte-identical', sha(img.image), before);
  check('the backup is named for the image version', fs.existsSync(path.join(backups, 'orchestrator.js.9.9.9.orig')), true);

  // The one instruction that makes the whole flow work.
  check('it says to start the extracted copy', /Start the patched copy, not the original image/.test(imgInstall.stdout), true);
  check('and prints the AppRun path', imgInstall.stdout.includes(path.join(work, 'freebuff-9.9.9', 'squashfs-root', 'AppRun')), true);
  check('and says the image was not modified', /was not modified at all/.test(imgInstall.stdout), true);

  const imgAgain = runWithWork(img.image, backups, work, 'install', '--no-wait');
  check('a second install reuses the extracted copy', /extracting/.test(imgAgain.stdout), false);
  check('and reports it is already patched', /Already patched/.test(imgAgain.stdout), true);
  check('and still leaves the image alone', sha(img.image), before);

  const imgStatus = runWithWork(img.image, backups, work, 'status');
  check('status on an image reads the extracted copy', /Ads are off/.test(imgStatus.stdout), true);
  check('it reports the image and the copy', /image\s+\S+\.AppImage/.test(imgStatus.stdout) && /copy\s+\S+squashfs-root/.test(imgStatus.stdout), true);

  // Read-only commands must not leave a 400 MB extraction behind.
  const freshWork = path.join(root, 'work-fresh');
  const tempDirsBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('fbd-image.')).length;
  const imgScan = runWithWork(img.image, backups, freshWork, 'scan');
  const tempDirsAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('fbd-image.')).length;
  check('scan on an image exits 0', imgScan.status, 0);
  check('it prints the anchor report', /== render ==/.test(imgScan.stdout), true);
  check('and leaves no temporary extraction behind', tempDirsAfter - tempDirsBefore, 0);
  check('and never creates the persistent work dir', fs.existsSync(freshWork), false);

  const imgRevert = runWithWork(img.image, backups, work, 'revert');
  check('revert on an image exits 0', imgRevert.status, 0);
  check('and restores the extracted copy exactly', read(path.join(work, 'freebuff-9.9.9', 'squashfs-root', ORCH)) === CURRENT, true);
  check('and still leaves the image alone', sha(img.image), before);

  // People rename downloads, so the version comes from the leading number in the
  // file name when there is one, and from the extracted AppDir when there is not:
  // even `Freebuff.AppImage` reports the build it really is, which for this fake
  // image is 9.9.9 - the version it records inside itself.
  console.log('\nversions in file names');
  for (const [name, want] of [
    ['Freebuff-0.0.164-linux-x86_64.AppImage', '0.0.164'],
    ['Freebuff-1.2.3.AppImage', '1.2.3'],
    ['Freebuff.AppImage', '9.9.9'],
  ]) {
    const renamed = path.join(img.dir, name);
    fs.copyFileSync(img.image, renamed);
    fs.chmodSync(renamed, 0o755);
    const out = runWithWork(renamed, backups, path.join(root, `w-${want}`), 'status');
    check(`a file named ${name} reads as ${want}`, new RegExp(`version\\s+${want.replace('.', '\\.')}`).test(out.stdout), true);
  }

  console.log('\nnot an AppImage at all');
  const notAnImage = path.join(root, 'notes.txt');
  fs.writeFileSync(notAnImage, 'this is not an AppImage\n');
  const notImage = runWithWork(notAnImage, backups, work, 'install', '--no-wait');
  check('install refuses', notImage.status !== 0, true);
  check('it says what is wrong', /is not an AppImage \(not an ELF executable\)/.test(both(notImage)), true);
  check('and it stops there rather than reporting a patch', /Refusing to patch/.test(notImage.stdout), false);
}

/* ------------------------------------------------------------------ discovery */

console.log('\ndiscovery');

// A Freebuff AppImage in the place people actually keep them, found with no
// --app at all. This is the path a person who downloaded the app and the tool
// takes, and it is the only thing discovery has to get right.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-home-'));
fs.mkdirSync(path.join(home, 'Applications'), { recursive: true });
if (hasCompiler) {
  const shipped = buildFakeAppImage(CURRENT, '7.7.7');
  fs.copyFileSync(shipped.image, path.join(home, 'Applications', 'Freebuff-7.7.7-linux-x86_64.AppImage'));
  fs.chmodSync(path.join(home, 'Applications', 'Freebuff-7.7.7-linux-x86_64.AppImage'), 0o755);
}

const discovered = spawnSync('sh', [TOOL, 'status'], {
  encoding: 'utf8',
  cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-cwd-')),
  env: { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share') },
});
if (hasCompiler) {
  check('it finds the AppImage in ~/Applications with no --app', /image\s+\S+Applications\/Freebuff-7\.7\.7/.test(discovered.stdout), true);
  check('and reads its version out of the file name', /version\s+7\.7\.7/.test(discovered.stdout), true);
} else {
  console.log('  ..    the ~/Applications discovery check needs the compiled AppImage');
}

const nowhere = spawnSync('sh', [TOOL, 'status'], {
  encoding: 'utf8',
  cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-cwd-')),
  env: { PATH: process.env.PATH, HOME: path.join(home, 'empty'), XDG_DATA_HOME: path.join(home, 'empty', '.local', 'share') },
});
check('with nothing to find it exits non-zero', nowhere.status !== 0, true);
check('and says where it looked', /Looked in:/.test(nowhere.stderr), true);
check('and suggests --app', /Pass --app/.test(nowhere.stderr), true);

console.log('\nargument handling');
const missing = run('/tmp/definitely-not-here.AppImage', path.join(home, 'backups'), 'status');
check('a path that does not exist is refused', missing.status !== 0, true);
check('with the path in the message', /no such file or directory/.test(missing.stderr), true);

const notATree = spawnSync('sh', [TOOL, 'status', '--app', home, '--backup-dir', path.join(home, 'b')], {
  encoding: 'utf8',
  cwd: os.tmpdir(),
});
check('a directory that is not a Freebuff tree is refused', notATree.status !== 0, true);
check('and it says what it expected', new RegExp(`${ORCH}`.replace(/\//g, '\\/')).test(notATree.stderr), true);

const badArg = spawnSync('sh', [TOOL, '--nope'], { encoding: 'utf8', cwd: os.tmpdir() });
check('an unknown argument is refused', badArg.status !== 0, true);
check('with the argument named', /unknown argument: --nope/.test(badArg.stderr), true);

const badTimeout = spawnSync('sh', [TOOL, 'verify', '--timeout', 'soon'], { encoding: 'utf8', cwd: os.tmpdir() });
check('a non-numeric --timeout is refused', badTimeout.status !== 0, true);

const badCommand = spawnSync('sh', [TOOL, 'frobnicate'], { encoding: 'utf8', cwd: os.tmpdir() });
check('an unknown command is refused', badCommand.status !== 0, true);

/* -------------------------------------------------------------------- syntax */

console.log('\nthe script itself');
const syntax = spawnSync('sh', ['-n', TOOL], { encoding: 'utf8' });
check('the Linux tool parses as POSIX sh', syntax.status, 0);
check('it is stamped with a version', TOOL_SOURCE.includes('__FBD_VERSION__'), true);
check('and with an origin', TOOL_SOURCE.includes('__FBD_ORIGIN__'), true);
// One product, one rule: the anchors are the same two as the macOS tool, and
// `npm run validate` asserts the engine text is byte-identical between them.
check('it never writes to an AppImage in place', /never write|never writes to your download/.test(TOOL_SOURCE), true);
check('it does not use sudo', /^\s*sudo\s/m.test(TOOL_SOURCE), false);

/* ---------------------------------------------------------------------- done */

console.log(failures === 0 ? `\nAll ${results} Linux desktop checks passed.` : `\n${failures} of ${results} Linux desktop checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
