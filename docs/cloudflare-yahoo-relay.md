# Yahoo chart relay (Cloudflare Worker)

Render’s shared egress addresses are throttled by Yahoo (HTTP 429) for TSX
symbols. A free Cloudflare Worker has a different address. FolioTrack sends
Yahoo chart calls through it only when `YAHOO_PROXY_URL` is set.

TMX Money is tried first for `.TO` and `.V` and does not need this relay.
Use the relay when you still want Yahoo as a fallback from Render.

About five minutes on the Workers free plan. No credit card.

## 1. Create the Worker

1. Sign in at [https://dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers & Pages** → **Create** → **Workers** → start from **Hello World**.
3. Name it `foliotrack-yahoo` (the name becomes part of the URL).
4. Replace the script with the one below. **Deploy**.

## 2. Worker script

```js
const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
]);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, User-Agent, X-FolioTrack-Secret',
  };
}

function isYahooChart(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (!ALLOWED_HOSTS.has(url.hostname)) return false;
  return url.pathname.startsWith('/v8/finance/chart/');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'GET') {
      return new Response('GET only', { status: 405, headers: corsHeaders() });
    }

    const expected = String(env.YAHOO_PROXY_SECRET || '');
    if (expected) {
      const got = request.headers.get('X-FolioTrack-Secret') || '';
      if (got !== expected) {
        return new Response('unauthorized', { status: 401, headers: corsHeaders() });
      }
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!isYahooChart(target)) {
      return new Response('url must be an https Yahoo v8 chart URL', {
        status: 400,
        headers: corsHeaders(),
      });
    }

    const upstream = await fetch(target, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': request.headers.get('User-Agent') || 'FolioTrack/1.0 (portfolio price history)',
      },
    });
    const body = await upstream.arrayBuffer();
    const headers = corsHeaders();
    headers['Content-Type'] = upstream.headers.get('content-type') || 'application/json';
    const retry = upstream.headers.get('retry-after');
    if (retry) headers['Retry-After'] = retry;
    return new Response(body, { status: upstream.status, headers });
  },
};
```

The script refuses anything that is not a Yahoo chart URL, so the Worker is
not an open proxy.

## 3. Optional shared secret

In the Worker → **Settings** → **Variables and Secrets** → add
`YAHOO_PROXY_SECRET` (type Secret) with a long random string. Save and deploy
again. Skip this if you are fine with the URL being public; anyone who has
the Worker URL can then request Yahoo chart JSON through it.

## 4. Point FolioTrack at it

On Render, set:

- `YAHOO_PROXY_URL` = `https://foliotrack-yahoo.<your-subdomain>.workers.dev`
- `YAHOO_PROXY_SECRET` = the same string, only if you set it on the Worker

Do not put the secret in the URL. FolioTrack calls:

`https://<worker>/?url=<encoded query1 or query2 chart URL>`

and, when the secret is set, sends header `X-FolioTrack-Secret`.

Redeploy or restart the Render service so it picks up the env vars.

## 5. Check

Open `/api/diagnostics`.

- `relay.configured` is true when `YAHOO_PROXY_URL` is set.
- `relay.host` is the Worker host. The secret is not included.
- `relay.secretConfigured` is true when `YAHOO_PROXY_SECRET` is set.
- `relay.working` becomes true after a chart call through the Worker returns
  HTTP 200. `relay.lastSuccessAt` and `relay.lastError` show the last attempt.
- `providers` still lists `tmx` first, with `lastSuccessAt` and any cooldown.

A quick check from your own machine, before Render:

```bash
curl -sS -D - -o /tmp/atd.json \
  -H "X-FolioTrack-Secret: $YAHOO_PROXY_SECRET" \
  "https://foliotrack-yahoo.<your-subdomain>.workers.dev/?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FATD.TO%3Frange%3D5d%26interval%3D1d"
```

HTTP 200 and a JSON `chart.result` means the Worker can reach Yahoo. HTTP 429
means Yahoo throttled the Worker address too; TMX remains the TSX path.
