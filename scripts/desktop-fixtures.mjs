/**
 * The synthetic Freebuff Desktop bundle both desktop-tool suites patch.
 *
 * Shared rather than duplicated because the two tools must agree about what they
 * patch: the macOS shell tool and the Windows PowerShell tool carry the same
 * anchors, and a fixture that drifted between the suites would let one of them
 * pass against a bundle the other refuses. One source, two suites.
 *
 * The shapes are taken from a real Freebuff Desktop **0.0.164** bundle, as
 * reported by `scan` on that build: one render gate inside `auction()`, the ad
 * client's own `request` helper, and the decoys that make the old, looser anchors
 * dangerous - six other `async request(` definitions, and two `async post(`
 * helpers, one of which is the logs shipper that POSTs to `${API_HOST}/api/logs`.
 */

export const CURRENT = [
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

export const GATE = 'if (localAgenticTestCampaign(process.env)) return { ads: [] };';

/** The same build one Release later: the gate renamed, the shape unchanged. */
export const RENAMED = CURRENT.replace(GATE, 'if (agenticTestCampaign(process.env)) return { ads: [] };');

/**
 * A build that still has TWO gates, the way 0.0.155 did. `render` now expects
 * one, so this must be refused rather than half-patched - the second gate would
 * keep rendering ads while the tool claimed success.
 */
export const TWO_GATES = CURRENT.replace(
  'class Proxy',
  `function displayAd(c) { ${GATE} }\nclass Proxy`
);

/**
 * One real gate, and a decoy gate that merely looks like it, well out of arm's
 * reach of any ad code. The relaxation counts two hits here, so only the
 * ad-proximity rule stops it.
 */
export const DECOY = [
  `function displayAd(c) { if (agenticTestCampaign(process.env)) return { ad: null }; }`,
  `/* ${'x'.repeat(900)} */`,
  'function unrelated(c) { if (otherFeatureTest(process.env)) { return 1; } return 2; }',
  '',
].join('\n');
