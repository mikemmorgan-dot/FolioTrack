// yahooRelay.js — optional Cloudflare Worker in front of Yahoo chart calls.
//
// YAHOO_PROXY_URL=https://foliotrack-yahoo.<account>.workers.dev
// Requests go to https://<worker>/?url=<encoded yahoo chart url>.
// YAHOO_PROXY_SECRET, when set, is sent as X-FolioTrack-Secret.
// The worker script and deploy steps are in docs/cloudflare-yahoo-relay.md.

export const RELAY_SECRET_HEADER = 'X-FolioTrack-Secret';

export function yahooProxyConfig(env = process.env) {
  const raw = String(env?.YAHOO_PROXY_URL || '').trim();
  if (!raw) return { configured: false, base: null, host: null, secret: null };
  const base = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let host = null;
  try { host = new URL(base).host; } catch { host = null; }
  const secret = String(env?.YAHOO_PROXY_SECRET || '').trim();
  return { configured: true, base, host, secret: secret || null };
}

export function buildYahooRelayUrl(yahooUrl, env = process.env) {
  const cfg = yahooProxyConfig(env);
  if (!cfg.configured) return { configured: false, url: yahooUrl, headers: {}, host: null };
  let target;
  try {
    target = new URL(cfg.base);
  } catch {
    const err = new Error('YAHOO_PROXY_URL is not a valid URL');
    err.status = 500;
    throw err;
  }
  target.searchParams.set('url', yahooUrl);
  const headers = {};
  if (cfg.secret) headers[RELAY_SECRET_HEADER] = cfg.secret;
  return { configured: true, url: target.toString(), headers, host: target.host };
}

export function relayStatus(state = {}, env = process.env) {
  const cfg = yahooProxyConfig(env);
  const lastSuccessViaRelay = !!state.lastSuccessViaRelay;
  return {
    configured: cfg.configured,
    host: cfg.configured ? cfg.host : null,
    secretConfigured: !!cfg.secret,
    working: !!(cfg.configured && lastSuccessViaRelay && !state.lastError),
    lastSuccessAt: lastSuccessViaRelay ? (state.lastSuccessAt || null) : null,
    lastSuccessSymbol: lastSuccessViaRelay ? (state.lastSuccessSymbol || null) : null,
    lastHttpStatus: cfg.configured ? (state.lastHttpStatus ?? null) : null,
    lastError: cfg.configured ? (state.lastError || null) : null,
    header: RELAY_SECRET_HEADER,
  };
}
