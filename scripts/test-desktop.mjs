/**
 * Desktop tool checks.
 *
 * The desktop blocker edits a 9 MB file inside an app bundle, so the parts that
 * matter are the ones that decide whether it is safe to touch it at all:
 *
 *   - a pristine file with the current anchors is recognised and patched,
 *   - the helpers that are NOT the ad path are left exactly as they were,
 *   - a build whose anchor count changed is refused, not half-patched,
 *   - running it twice does not stack a second patch on top of the first,
 *   - `revert` restores the exact original bytes,
 *   - `verify` says nothing is proven while the app is closed, and confirms the
 *     running app once a process that started after the patch exists.
 *
 * The anchor shapes here are taken from a real Freebuff Desktop **0.0.164**
 * bundle, as reported by `scan` on that build: one render gate inside
 * `auction()`, the ad client's own `request` helper, and the decoys that make the
 * old, looser anchors dangerous - six other `async request(` definitions, and
 * two `async post(` helpers, one of which is the logs shipper that POSTs to
 * `${API_HOST}/api/logs`.
 *
 * Everything runs against a throwaway bundle in a temp directory, with the
 * backup directory redirected too, so the real /Applications and the user's
 * backup folder are never touched. `sh` and `perl` are the only requirements,
 * both of which ship with macOS.
 *
 * Run with `npm run test:desktop` (also part of `npm test`).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'desktop', 'freebuff-adblock.sh');
const TOOL_SOURCE = fs.readFileSync(TOOL, 'utf8');

/* ------------------------------------------------------------------ fixtures */

/**
 * Freebuff 0.0.164 as `scan` described it: the ad client with its single request
 * helper, the one remaining ad gate inside `auction()`, plus the neighbours that
 * a loose anchor would love to patch by mistake.
 */
const CURRENT = [
  'class AdsClient {',
  '  constructor(options2) { this.options = options2; }',
  '  async prefs(update5) { return outcome(await this.request("POST", "/api/v1/ads/prefs", update5)); }',
  '  async request(method, path27, payload, timeoutMs = REQUEST_TIMEOUT_MS) {',
  '    let token = this.getToken();',
  '    if (!token) return { ok: !1, status: 401, message: "Sign in to Freebuff" };',
  '    return this.send(method, path27, payload, timeoutMs);',
  '  }',
  '  async auction({ placementId, boundCampaignId, invitationFundingToken, invitationId, invitationFundingWorkspaceId, clientContext } = {}) {',
  '    if (localAgenticTestCampaign(process.env)) return { ads: [] };',
  '    let displayCapability = displayLocalCapability(localCapability), capabilityAuction = displayCapability !== null;',
  '    if (!capabilityAuction) return { ads: [] };',
  '    return { ads: await this.request("POST", `/api/v1/ads/proposal/${placementId}`, {}) };',
  '  }',
  '}',
  // Six other `async request(` definitions, as counted in the real bundle.
  'class Proxy { async request(e, t) { return this.forward(e, t); } }',
  'class Config { async request(payload, token) { return this.post(payload, token); } }',
  'class Metrics { async request(path30, method, body2) { return this.call(path30, method, body2); } }',
  'class Auth { async request(path30, method = "GET", value2, authHost = !1) { return this.go(path30, method, value2, authHost); } }',
  'class SitesClient {',
  '  async request(path27, method = "GET", body2, idempotencyKey, signal) {',
  '    let token = this.options.getToken();',
  '    if (!token) throw new SitesClientError(401, "sites_sign_in_required", "Sign in to Freebuff");',
  '    return this.fetchJson(path27, method, body2);',
  '  }',
  '}',
  // The two `async post(` helpers. Neither is the ad path.
  'class LogShipper {',
  '  async post(records) {',
  '    let token = this.getToken(), send = (authToken) => fetch(`${API_HOST}/api/logs`, { method: "POST" });',
  '    return send(token);',
  '  }',
  '}',
  'class BreakEvents {',
  '  async post(path27, body2, options2 = {}) {',
  '    let { signal, eventId, dwellMs, host = API_HOST } = options2, token = this.getToken();',
  '    if (!token) return null;',
  '    return fetch(`${host}/api/v1/ads/invitation/event`, { method: "POST" });',
  '  }',
  '}',
  '',
].join('\n');

const GATE = 'if (localAgenticTestCampaign(process.env)) return { ads: [] };';

/** The same build one Release later: the gate renamed, the shape unchanged. */
const RENAMED = CURRENT.replace(GATE, 'if (agenticTestCampaign(process.env)) return { ads: [] };');

/**
 * A build that still has TWO gates, the way 0.0.155 did. `render` now expects
 * one, so this must be refused rather than half-patched - the second gate would
 * keep rendering ads while the tool claimed success.
 */
const TWO_GATES = CURRENT.replace(
  'class Proxy',
  `function displayAd(c) { ${GATE} }\nclass Proxy`
);

/**
 * One real gate, and a decoy gate that merely looks like it, well out of arm's
 * reach of any ad code. The relaxation counts two hits here, so only the
 * ad-proximity rule stops it.
 */
const DECOY = [
  `function displayAd(c) { if (agenticTestCampaign(process.env)) return { ad: null }; }`,
  `/* ${'x'.repeat(900)} */`,
  'function unrelated(c) { if (otherFeatureTest(process.env)) { return 1; } return 2; }',
  '',
].join('\n');

/* -------------------------------------------------------------------- harness */

const results = [];
const check = (name, actual, expected = true) => {
  const ok = actual === expected;
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ` -> ${JSON.stringify(actual)} (want ${JSON.stringify(expected)})`}`);
};

function makeBundle(body = CURRENT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbd-test-'));
  const app = path.join(root, 'Freebuff.app');
  const orch = path.join(app, 'Contents', 'Resources', 'orchestrator');
  fs.mkdirSync(orch, { recursive: true });
  const target = path.join(orch, 'orchestrator.js');
  fs.writeFileSync(target, body);
  return { root, app, target, backups: path.join(root, 'backups') };
}

function run(app, backups, ...args) {
  return spawnSync('sh', [TOOL, ...args, '--app', app, '--backup-dir', backups], {
    encoding: 'utf8',
  });
}

/**
 * The piped form the README and the refusal message both tell people to run:
 * the script arrives on stdin, and the command is the first argument.
 */
function runPiped(app, backups, ...args) {
  return spawnSync('sh', ['-s', ...args, '--app', app, '--backup-dir', backups], {
    encoding: 'utf8',
    input: TOOL_SOURCE,
  });
}

const count = (text, needle) => text.split(needle).length - 1;
const read = (file) => fs.readFileSync(file, 'utf8');

/** Locate perl, or the fixture-based checks cannot run at all. */
const hasPerl = spawnSync('sh', ['-c', 'command -v perl'], { encoding: 'utf8' }).status === 0;
if (!hasPerl) {
  console.log('perl is not installed - skipping desktop tool checks.');
  process.exit(0);
}

/* ----------------------------------------------------------------- pristine */

console.log('\npristine 0.0.164 bundle');
const a = makeBundle();

const statusClean = run(a.app, a.backups, 'status');
check('status exits 0', statusClean.status, 0);
check('status names both anchors', /render/.test(statusClean.stdout) && /request/.test(statusClean.stdout));
check('status says it is not patched yet', /Not patched yet/.test(statusClean.stdout));
check('status changes nothing', read(a.target) === CURRENT);

/* ------------------------------------------------------------------ install */

console.log('\ninstall');
const install = run(a.app, a.backups, 'install');
check('install exits 0', install.status, 0);

const patched = read(a.target);
check('the one render gate is neutralised', count(patched, 'if (true/*FBD-ADS-OFF:render*/)'), 1);
check('the render gate text is gone', patched.includes('localAgenticTestCampaign(process.env)'), false);
check('the ad client request helper returns early', count(patched, '/*FBD-ADS-OFF:request*/'), 1);
check('the early return is the failure shape its callers expect', patched.includes('return { ok: !1, status: 0, message: "" }'));
check('no post anchor was invented', count(patched, '/*FBD-ADS-OFF:post*/'), 0);

// The whole point of the re-anchor: the neighbours stay byte-identical.
check('the sites client request is untouched', patched.includes('async request(path27, method = "GET", body2, idempotencyKey, signal) {'));
check('the config clients are untouched', patched.includes('async request(path30, method = "GET", value2, authHost = !1) {'));
check('the logs shipper is untouched', patched.includes('fetch(`${API_HOST}/api/logs`, { method: "POST" })'));
check('the break-event poster is untouched', patched.includes('async post(path27, body2, options2 = {}) {'));
check('the gate body it patched is still there', patched.includes('return { ads: [] }'));

check('one pristine backup was taken', fs.existsSync(path.join(a.backups, 'orchestrator.js.unknown.orig')));
check('the backup is the original bytes', read(path.join(a.backups, 'orchestrator.js.unknown.orig')) === CURRENT);

/* --------------------------------------------------------------- idempotent */

console.log('\ninstall twice');
const again = run(a.app, a.backups, 'install');
check('second install exits 0', again.status, 0);
check('it reports already patched', /Already patched/.test(again.stdout));

const twice = read(a.target);
check('the render patch did not stack', count(twice, '/*FBD-ADS-OFF:render*/'), 1);
check('the request patch did not stack', count(twice, '/*FBD-ADS-OFF:request*/'), 1);
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
check('the original bytes are restored', read(a.target) === CURRENT);

/* ------------------------------------------------------------ display-only */

console.log('\ndisplay-only');
const b = makeBundle();
run(b.app, b.backups, 'install', '--display-only');
const partial = read(b.target);
check('the render gate is applied', count(partial, '/*FBD-ADS-OFF:render*/'), 1);
check('the ad client is left alone', count(partial, '/*FBD-ADS-OFF:request*/'), 0);
check('and the ad client is still intact', partial.includes('async request(method, path27, payload, timeoutMs = REQUEST_TIMEOUT_MS) {'));

/* ---------------------------------------------------------------- fail-safe */

console.log('\ntwo gates, as 0.0.155 had');
const c = makeBundle(TWO_GATES);
const twoGates = run(c.app, c.backups, 'install');
check('install refuses', twoGates.status !== 0);
check('the render anchor reads as ambiguous', /render\s+ambiguous/.test(twoGates.stdout));
check('it says why, with the counts', /match\(es\)/.test(twoGates.stdout) && /trusted as written/.test(twoGates.stdout));
check('it points at the local scan', /freebuff-adblock\.sh scan/.test(twoGates.stdout));
check('and at the piped one', /freebuff-adblock-desktop\.sh \| sh -s scan/.test(twoGates.stdout));
check('the file is left untouched', read(c.target) === TWO_GATES);
check('no backup was taken', fs.existsSync(c.backups), false);

console.log('\nunknown file');
const d = makeBundle('export const something = 41; // a future orchestrator with renamed functions\n');
const refused = run(d.app, d.backups, 'install');
check('install refuses', refused.status !== 0);
check('it says why', /Refusing to patch|does not match/.test(refused.stdout));
check('the file is left untouched', read(d.target).includes('something = 41'));
check('no backup was taken', fs.existsSync(d.backups), false);

console.log('\na marker where the anchor cannot account for it');
// With one gate expected, a file carrying two render markers is a file the tool
// did not write and cannot reason about - it must refuse rather than add a third.
const doubledBody = `${CURRENT}\n/*FBD-ADS-OFF:render*/\n/*FBD-ADS-OFF:render*/`;
const e = makeBundle(doubledBody);
const halfStatus = run(e.app, e.backups, 'status');
check('status refuses to call it patched', halfStatus.status !== 0);
check('it reports the anchor as broken', /render\s+broken/.test(halfStatus.stdout));
check('install refuses to stack on top of it', run(e.app, e.backups, 'install').status !== 0);
check('it left the file alone', read(e.target) === doubledBody);

console.log('\nan anchor that is simply gone');
// A build whose ad code moved away from every anchor left: nothing to patch, so
// the tool refuses and hands over the two ways to get the report that fixes it.
const goneBody = CURRENT.replace(GATE, 'if (false) return { ads: [] };');
const e2 = makeBundle(goneBody);
const gone = run(e2.app, e2.backups, 'install');
check('install refuses', gone.status !== 0);
check('it reports the render anchor as not found', /render\s+not found/.test(gone.stdout));
check('it offers the piped scan', /sh -s scan/.test(gone.stdout));
check('it left the file alone', read(e2.target) === goneBody);
check('no backup was taken', fs.existsSync(e2.backups), false);

/* ------------------------------------------------------------------- dry run */

console.log('\ndry run');
const f = makeBundle();
const dry = run(f.app, f.backups, 'install', '--dry-run');
check('dry run exits 0', dry.status, 0);
check('it writes nothing', read(f.target) === CURRENT);

/* ------------------------------------------------------------ renamed build */

console.log('\nrenamed build (the gate moved)');
const g = makeBundle(RENAMED);
const renamedInstall = run(g.app, g.backups, 'install');
check('install exits 0', renamedInstall.status, 0);
check('it says which anchor it matched', /via relaxed match/.test(renamedInstall.stdout));

const relaxed = read(g.target);
check('the renamed gate is neutralised', count(relaxed, '/*FBD-ADS-OFF:render*/'), 1);
check('the renamed gate text is gone', relaxed.includes('agenticTestCampaign(process.env)'), false);
check('the ad client is stubbed too', count(relaxed, '/*FBD-ADS-OFF:request*/'), 1);
run(g.app, g.backups, 'revert');
check('revert restores the renamed build exactly', read(g.target) === RENAMED);

/* -------------------------------------------------------------------- decoy */

console.log('\ndecoy gate far from ad code');
const h = makeBundle(DECOY);
const decoy = run(h.app, h.backups, 'install');
check('install refuses', decoy.status !== 0);
check('the render anchor reads as ambiguous', /render\s+ambiguous/.test(decoy.stdout));
check('the decoy file is untouched', read(h.target) === DECOY);
check('no backup was taken', fs.existsSync(h.backups), false);

/* --------------------------------------------------------------------- scan */

console.log('\nscan');
const i = makeBundle();
const scan = run(i.app, i.backups, 'scan');
check('scan exits 0', scan.status, 0);
check('scan changes nothing', read(i.target) === CURRENT);
check('scan names both strategies', /literal/.test(scan.stdout) && /relaxed/.test(scan.stdout));
check('scan marks the usable anchor', /<- usable/.test(scan.stdout));
check('scan says a trusted literal has no adjacency check', /trusted as written/.test(scan.stdout));
check('scan reports the probes', /== probes ==/.test(scan.stdout));
check('scan saves the report to attach', read(path.join(i.backups, 'orchestrator-scan.unknown.txt')).includes('== render =='));

// The case-insensitive probe fix: this bundle has localAgenticTestCampaign, and
// a case-sensitive probe for agenticTestCampaign used to report 0 - which reads
// as "the ad runtime is gone" when it is right there.
const probeLine = scan.stdout.split('\n').find((line) => /^\s+agenticTestCampaign\s+\d+/.test(line)) || '';
check('the agenticTestCampaign probe now finds the local variant', /\s[1-9]\d*$/.test(probeLine.trim()));

/* ------------------------------------------------------------- piped one-liner */

console.log('\nthe piped form');
const j = makeBundle();
const pipedScan = runPiped(j.app, j.backups, 'scan');
check('`sh -s scan` exits 0', pipedScan.status, 0);
check('and prints the scan report', /== render ==/.test(pipedScan.stdout));
check('and names the tool version it is running', /anchor scan \(tool \S+\)/.test(pipedScan.stdout));

/* ------------------------------------------------------------------ verify */

/**
 * The relaunch check, which is the one thing `status` cannot say. It is driven
 * by two times rather than by anything on disk, so it has to be tested against a
 * real process: `pgrep -f` finds a process whose command line *ends* with the
 * orchestrator path, and a plain `sh -c 'sleep 30; exit 0' <path>` is exactly
 * that - the same shape as the bundled Bun process, without needing Freebuff.
 */
console.log('\nverify');

const v = makeBundle();

const beforeInstall = run(v.app, v.backups, 'verify', '--no-wait');
check('verify exits non-zero before the patch is applied', beforeInstall.status !== 0);
check('it says it is not patched yet', /Not patched yet/.test(beforeInstall.stdout));
check('it writes nothing', read(v.target) === CURRENT);

run(v.app, v.backups, 'install');
const patchedBytes = read(v.target);

const idle = run(v.app, v.backups, 'verify', '--no-wait');
check('verify exits non-zero with Freebuff closed', idle.status !== 0);
check('it reports both anchors applied', /render\s+applied/.test(idle.stdout) && /request\s+applied/.test(idle.stdout));
check('it says Freebuff is not open', /Freebuff is not open/.test(idle.stdout));
check('it points at running verify again', /freebuff-adblock\.sh verify/.test(idle.stdout));
check('verify changes nothing in the bundle', read(v.target) === patchedBytes);

const noTimeout = run(v.app, v.backups, 'verify', '--no-wait', '--timeout', 'soon');
check('a non-numeric --timeout is refused', /--timeout needs/.test(`${noTimeout.stdout}${noTimeout.stderr}`));

const ORCH = path.join(v.app, 'Contents', 'Resources', 'orchestrator', 'orchestrator.js');
const standIn = () => spawn('sh', ['-c', 'sleep 30; exit 0', ORCH], { detached: true, stdio: 'ignore' });
const retire = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* it has already gone */
    }
  }
};

/**
 * The no-wait cases are decided by two times, so the fixture writes one of them
 * directly: a patch written a minute ago, or a minute from now. Sleeping through
 * a real minute would test the same comparison more slowly, and ps only reports a
 * process's age to the second anyway - the wait itself is covered end to end
 * below, where a pid that appeared after watching began is the evidence.
 */
const stampPatchTime = (target, seconds) => {
  const when = (Date.now() + seconds * 1000) / 1000;
  fs.utimesSync(target, when, when);
};

// The half that matters more: a process that started *before* the write is an
// app that has not been relaunched, and it must never be reported as verified.
console.log('\nverify, with an app that was already running');
const stale = makeBundle();
const already = spawn(
  'sh',
  ['-c', 'sleep 30; exit 0', path.join(stale.app, 'Contents', 'Resources', 'orchestrator', 'orchestrator.js')],
  { detached: true, stdio: 'ignore' }
);
already.unref();

await new Promise((resolve) => setTimeout(resolve, 400));
run(stale.app, stale.backups, 'install');
stampPatchTime(stale.target, 60);
const notYet = run(stale.app, stale.backups, 'verify', '--no-wait');
retire(already);

check('a process started before the patch is not verified', notYet.status !== 0);
check('it says the app has not been relaunched since', /has not been relaunched since/.test(notYet.stdout));
check('it reports the gap it measured', /before the patch/.test(notYet.stdout));
check('and the patch itself still went in', read(stale.target).includes('/*FBD-ADS-OFF:render*/'));

const live = standIn();
live.unref();
await new Promise((resolve) => setTimeout(resolve, 400));
stampPatchTime(v.target, -60);

const seen = run(v.app, v.backups, 'verify', '--no-wait');
retire(live);

check('verify exits 0 once a process started after the patch exists', seen.status, 0);
check('it names the pid it found', /pid \d+/.test(seen.stdout));
check('it reports the process as started after the patch', /after the patch/.test(seen.stdout));
check('it names the running app as the patched file', /running app is the patched file/.test(seen.stdout));
check('it reports the ad code still in the build', /still in this build: .*auction \d+/.test(seen.stdout));
check('it says what only the user can see', /only you can/.test(seen.stdout));

// The whole point of the command: started with the app closed, it has to sit on
// its own and finish when the app comes back, with no second command to run.
const waiting = spawn(
  'sh',
  [TOOL, 'verify', '--app', v.app, '--backup-dir', v.backups, '--timeout', '20'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
let waitOut = '';
waiting.stdout.on('data', (chunk) => {
  waitOut += chunk;
});

await new Promise((resolve) => setTimeout(resolve, 600));
check('it waits while Freebuff is closed', /Waiting for Freebuff/.test(waitOut));

const arrived = standIn();
arrived.unref();
const waitedCode = await new Promise((resolve) => waiting.on('exit', resolve));
retire(arrived);

check('the wait ends by itself once the app comes back', waitedCode, 0);
check('and it reaches the same verdict', /running app is the patched file/.test(waitOut));
check('and it still wrote nothing', read(v.target) === patchedBytes);

/* ---------------------------------------------------- the shipped artifact */

/**
 * Everything above tests the source. This tests the file people actually
 * download: stamped with a version and an origin, and carrying the same
 * anchors. A shipped copy that lags the source is the failure this catches -
 * it is built by `npm run build`, so a missing or stale one is a build away.
 */
console.log('\nthe stamped artifact in site/downloads');
const STAMPED = path.join(ROOT, 'site', 'downloads', 'freebuff-adblock-desktop.sh');

if (!fs.existsSync(STAMPED)) {
  console.log('  (not built yet - skipping; run npm run build)');
} else {
  const stampedSource = read(STAMPED);
  const k = makeBundle();
  const shipped = spawnSync('sh', [STAMPED, 'install', '--app', k.app, '--backup-dir', k.backups], {
    encoding: 'utf8',
  });

  check('it is stamped, not shipped with placeholders', /__FBD_(VERSION|ORIGIN)__/.test(stampedSource), false);
  check('the shipped copy installs on a 0.0.164-shaped build', shipped.status, 0);
  check('it applies the render anchor once', count(read(k.target), '/*FBD-ADS-OFF:render*/'), 1);
  check('it applies the request anchor once', count(read(k.target), '/*FBD-ADS-OFF:request*/'), 1);
  check('it leaves the logs shipper alone', read(k.target).includes('api/logs'));
  // The origin is composed at runtime from the stamped $ORIGIN, so the only way
  // to check the hint is to make the shipped copy refuse and read what it says.
  const k2 = makeBundle(TWO_GATES);
  const shippedRefusal = spawnSync('sh', [STAMPED, 'install', '--app', k2.app, '--backup-dir', k2.backups], {
    encoding: 'utf8',
  });

  check('it refuses when the anchor count moved', shippedRefusal.status !== 0);
  check('and prints the counts it saw', /match\(es\)/.test(shippedRefusal.stdout));
  check(
    'and a piped scan command naming the real origin',
    /curl -fsSL https:\/\/\S+ \| sh -s scan/.test(shippedRefusal.stdout)
  );
  check('and leaves that build untouched', read(k2.target) === TWO_GATES);
}

const failed = results.filter((r) => !r).length;
console.log('');
if (failed) {
  console.error(`${failed} of ${results.length} desktop checks failed`);
  process.exit(1);
}
console.log(`All ${results.length} desktop checks passed.`);
