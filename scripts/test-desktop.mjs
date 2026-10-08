/**
 * Desktop tool checks.
 *
 * The desktop blocker edits a 9 MB file inside an app bundle, so the parts that
 * matter are the ones that decide whether it is safe to touch it at all:
 *
 *   - a pristine file is recognised and patched,
 *   - running it twice does not stack a second patch on top of the first,
 *   - a file with none of the expected anchors is refused, not half-written,
 *   - `revert` restores the exact original bytes.
 *
 * Everything runs against a throwaway bundle in a temp directory, with the
 * backup directory redirected too, so the real /Applications and the user's
 * backup folder are never touched. `sh` and `perl` are the only requirements,
 * both of which ship with macOS.
 *
 * Run with `npm run test:desktop` (also part of `npm test`).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'desktop', 'freebuff-adblock.sh');

/** A stand-in for the real orchestrator, carrying the anchors the tool matches. */
const FIXTURE = [
  'function displayAd(c){ if (localAgenticTestCampaign(process.env)) { return { ad: null }; } return { ad: 1 }; }',
  'async function auction(c){ if (localAgenticTestCampaign(process.env)) { return { ads: [] }; } return { ads: [1] }; }',
  'class Ads {',
  '  async post(path28, body2, options2 = {}) { return await fetch(path28, options2); }',
  '  async request(method, path28, payload, timeoutMs = REQUEST_TIMEOUT_MS) { return { ok: true }; }',
  '}',
  '',
].join('\n');

/**
 * The same build one release later: the gate renamed, the helpers now static.
 * The literal anchors are gone, so only the relaxed strategy can find them.
 */
const RENAMED = [
  'function displayAd(c){ if (agenticTestCampaign(process.env)) { return { ad: null }; } return { ad: 1 }; }',
  'async function auction(c){ if (agenticTestCampaign(process.env)) { return { ads: [] }; } return { ads: [1] }; }',
  'class Ads {',
  '  static async post(path28, body2, options2 = {}) { return await fetch(path28, options2); }',
  '  static async request(method, path28, payload, timeoutMs = REQUEST_TIMEOUT_MS) { return { ok: true }; }',
  '}',
  '',
].join('\n');

/**
 * A build with one ad render path left, plus a feature gate that merely looks
 * like the ad gate, well out of arm's reach of any ad code. The relaxed
 * strategy counts two hits here, so only the ad-proximity check stops it.
 */
const DECOY = [
  'function displayAd(c){ if (agenticTestCampaign(process.env)) { return { ad: null }; } return { ad: 1 }; }',
  `/* ${'x'.repeat(900)} */`,
  'function unrelated(c){ if (otherFeatureTest(process.env)) { return 1; } return 2; }',
  '',
].join('\n');

const results = [];
const check = (name, actual, expected = true) => {
  const ok = actual === expected;
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ` -> ${JSON.stringify(actual)} (want ${JSON.stringify(expected)})`}`);
};

function makeBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-test-'));
  const app = path.join(root, 'Freebuff.app');
  const orch = path.join(app, 'Contents', 'Resources', 'orchestrator');
  fs.mkdirSync(orch, { recursive: true });
  const target = path.join(orch, 'orchestrator.js');
  fs.writeFileSync(target, FIXTURE);
  return { root, app, target, backups: path.join(root, 'backups') };
}

function run(app, backups, ...args) {
  return spawnSync('sh', [TOOL, ...args, '--app', app, '--backup-dir', backups], {
    encoding: 'utf8',
  });
}

const count = (text, needle) => text.split(needle).length - 1;

/** Locate perl, or the fixture-based checks cannot run at all. */
const hasPerl = spawnSync('sh', ['-c', 'command -v perl'], { encoding: 'utf8' }).status === 0;
if (!hasPerl) {
  console.log('perl is not installed - skipping desktop tool checks.');
  process.exit(0);
}

/* --------------------------------------------------------------- pristine */

console.log('\npristine bundle');
const a = makeBundle();
const pristine = fs.readFileSync(a.target, 'utf8');

const statusClean = run(a.app, a.backups, 'status');
check('status exits 0', statusClean.status, 0);
check('status names each patch', /render/.test(statusClean.stdout) && /post/.test(statusClean.stdout));
check('status says it is not patched yet', /Not patched yet/.test(statusClean.stdout));
check('status changes nothing', fs.readFileSync(a.target, 'utf8') === pristine);

/* ------------------------------------------------------------------ install */

console.log('\ninstall');
const install = run(a.app, a.backups, 'install');
check('install exits 0', install.status, 0);

const patched = fs.readFileSync(a.target, 'utf8');
check('both render anchors are neutralised', count(patched, 'if (true/*FBD-ADS-OFF:render*/)'), 2);
check('the render anchor text is gone', patched.includes('localAgenticTestCampaign(process.env)'), false);
check('the ad post helper returns early', count(patched, '/*FBD-ADS-OFF:post*/'), 1);
check('the ad request helper returns early', count(patched, '/*FBD-ADS-OFF:request*/'), 1);
check('the post early-return is the failure shape the caller expects', patched.includes('ok: false, status: 0'));
check('the request early-return is the failure shape the caller expects', patched.includes('ok: !1, status: 0, message: ""'));
check('one pristine backup was taken', fs.existsSync(path.join(a.backups, 'orchestrator.js.unknown.orig')));
check('the backup is the original bytes', fs.readFileSync(path.join(a.backups, 'orchestrator.js.unknown.orig'), 'utf8') === pristine);

/* --------------------------------------------------------------- idempotent */

console.log('\ninstall twice');
const again = run(a.app, a.backups, 'install');
check('second install exits 0', again.status, 0);
check('it reports already patched', /Already patched/.test(again.stdout));

const twice = fs.readFileSync(a.target, 'utf8');
check('render patch did not stack', count(twice, '/*FBD-ADS-OFF:render*/'), 2);
check('post patch did not stack', count(twice, '/*FBD-ADS-OFF:post*/'), 1);
check('request patch did not stack', count(twice, '/*FBD-ADS-OFF:request*/'), 1);
check('the file is byte-identical to the first patch', twice === patched);

/* ------------------------------------------------------------------- status */

console.log('\nstatus after install');
const statusPatched = run(a.app, a.backups, 'status');
check('status still exits 0', statusPatched.status, 0);
check('status confirms ads are off', /Ads are off/.test(statusPatched.stdout));

/* ------------------------------------------------------------------- revert */

console.log('\nrevert');
const revert = run(a.app, a.backups, 'revert');
check('revert exits 0', revert.status, 0);
check('the original bytes are restored', fs.readFileSync(a.target, 'utf8') === pristine);

/* ------------------------------------------------------------ display-only */

console.log('\ndisplay-only');
const b = makeBundle();
run(b.app, b.backups, 'install', '--display-only');
const partial = fs.readFileSync(b.target, 'utf8');
check('the render patch is applied', count(partial, '/*FBD-ADS-OFF:render*/'), 2);
check('the request choke-points are skipped', count(partial, '/*FBD-ADS-OFF:post*/'), 0);
check('the request helper is left alone', count(partial, '/*FBD-ADS-OFF:request*/'), 0);

/* ---------------------------------------------------------------- fail-safe */

console.log('\nunknown file');
const c = makeBundle();
const mystery = 'export const something = 41; // a future orchestrator with renamed functions\n';
fs.writeFileSync(c.target, mystery);

const refused = run(c.app, c.backups, 'install');
check('install refuses', refused.status !== 0);
check('it says why', /Refusing to patch|does not match/.test(refused.stdout));
check('the file is left untouched', fs.readFileSync(c.target, 'utf8') === mystery);
check('no backup was taken', fs.existsSync(c.backups), false);

/* ------------------------------------------------------------------- dry run */

console.log('\ndry run');
const d = makeBundle();
const dry = run(d.app, d.backups, 'install', '--dry-run');
check('dry run exits 0', dry.status, 0);
check('it writes nothing', fs.readFileSync(d.target, 'utf8') === FIXTURE);

/* ------------------------------------------------------------ renamed build */

console.log('\nrenamed build (the anchors moved)');
const e = makeBundle();
fs.writeFileSync(e.target, RENAMED);

const renamedStatus = run(e.app, e.backups, 'status');
check('status still exits 0', renamedStatus.status, 0);
check('it reports the relaxed match', /via relaxed/.test(renamedStatus.stdout));

const renamedInstall = run(e.app, e.backups, 'install');
check('install exits 0', renamedInstall.status, 0);
check('it says which anchor it matched', /via relaxed match/.test(renamedInstall.stdout));

const relaxed = fs.readFileSync(e.target, 'utf8');
check('the renamed gate is neutralised twice', count(relaxed, '/*FBD-ADS-OFF:render*/'), 2);
check('the renamed gate text is gone', relaxed.includes('agenticTestCampaign'), false);
check('the post helper is stubbed too', count(relaxed, '/*FBD-ADS-OFF:post*/'), 1);
check('the request helper is stubbed too', count(relaxed, '/*FBD-ADS-OFF:request*/'), 1);

run(e.app, e.backups, 'revert');
check('revert restores the renamed build exactly', fs.readFileSync(e.target, 'utf8') === RENAMED);

/* ------------------------------------------------------------------- decoy */

console.log('\ndecoy gate far from ad code');
const f = makeBundle();
fs.writeFileSync(f.target, DECOY);

const decoy = run(f.app, f.backups, 'install');
check('install refuses', decoy.status !== 0);
check('the render anchor reads as ambiguous', /render\s+ambiguous/.test(decoy.stdout));
check('it points at scan', /freebuff-adblock\.sh scan/.test(decoy.stdout));
check('the decoy file is untouched', fs.readFileSync(f.target, 'utf8') === DECOY);
check('no backup was taken', fs.existsSync(f.backups), false);

/* ----------------------------------------------------------- half patched */

console.log('\nhalf-patched file');
const h = makeBundle();
const half = `${FIXTURE}/*FBD-ADS-OFF:render*/`;
fs.writeFileSync(h.target, half);

const halfStatus = run(h.app, h.backups, 'status');
check('status refuses to call it patched', halfStatus.status !== 0);
check('it reports the anchor as broken', /render\s+broken/.test(halfStatus.stdout));
check('install refuses to stack on top of it', run(h.app, h.backups, 'install').status !== 0);
check('it left the file alone', fs.readFileSync(h.target, 'utf8') === half);

/* -------------------------------------------------------------------- scan */

console.log('\nscan');
const g = makeBundle();
fs.writeFileSync(g.target, RENAMED);

const scan = run(g.app, g.backups, 'scan');
check('scan exits 0', scan.status, 0);
check('scan changes nothing', fs.readFileSync(g.target, 'utf8') === RENAMED);
check('scan names both strategies', /literal/.test(scan.stdout) && /relaxed/.test(scan.stdout));
check('scan marks the usable anchor', /<- usable/.test(scan.stdout));
check('scan shows the renamed gate in context', /agenticTestCampaign/.test(scan.stdout));
check('scan reports the probes', /== probes ==/.test(scan.stdout));

const scanFile = path.join(g.backups, 'orchestrator-scan.unknown.txt');
const saved =
  fs.existsSync(scanFile) && fs.readFileSync(scanFile, 'utf8').includes('== render ==');
check('scan saves the report to attach', saved);

const failed = results.filter((r) => !r).length;
console.log('');
if (failed) {
  console.error(`${failed} of ${results.length} desktop checks failed`);
  process.exit(1);
}
console.log(`All ${results.length} desktop checks passed.`);
