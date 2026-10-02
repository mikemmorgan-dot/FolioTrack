// boot.js — bind the port before migrations, cache warmup, or the first alert check.
// Render's free tier answers 503 until the process is listening. A keep-alive
// ping must get 200 from /api/health during that window, without touching the
// database or a price provider.

import { once } from 'node:events';

export function healthBody({
  now = new Date(),
  uptimeSec = Math.round(process.uptime()),
} = {}) {
  return {
    ok: true,
    uptimeSec,
    time: now.toISOString(),
  };
}

export function registerHealthRoute(app, deps = {}) {
  const handler = (_req, res) => {
    const now = typeof deps.now === 'function' ? deps.now() : new Date();
    const uptimeSec = typeof deps.uptimeSec === 'function' ? deps.uptimeSec() : Math.round(process.uptime());
    res.status(200).json(healthBody({ now, uptimeSec }));
  };
  // Registered before express.json() and every other route so a health ping
  // never waits on body parsing, Postgres, or a provider call.
  app.get('/api/health', handler);
  app.head('/api/health', handler);
  return handler;
}

/**
 * Accept HTTP, then run migrations and mount the rest of the app.
 * `warmup` (provider probe, first alert check) is started after mount and is
 * not awaited — a slow probe must not delay the listening socket.
 */
export function listenThenStart({
  app,
  port,
  host,
  getStore,
  mount,
  warmup,
  logger = console,
} = {}) {
  if (!app) throw new Error('listenThenStart requires an express app');
  if (typeof getStore !== 'function') throw new Error('listenThenStart requires getStore()');
  if (typeof mount !== 'function') throw new Error('listenThenStart requires mount()');

  registerHealthRoute(app);
  const server = host != null ? app.listen(port, host) : app.listen(port);

  const listening = once(server, 'listening').then(() => {
    const addr = server.address();
    const shown = addr && typeof addr === 'object' ? addr.port : port;
    logger.log(`MPT server on :${shown}`);
  });

  const started = listening.then(async () => {
    const store = await getStore();
    await mount(app, store);
    Promise.resolve()
      .then(() => warmup?.(store))
      .catch((e) => logger.error(`[boot] warmup failed: ${e.message}`));
    return { server, store };
  });

  return { server, listening, started };
}
