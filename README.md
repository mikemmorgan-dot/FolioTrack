# Model Portfolio Tracker

Tracks 5 risk-ranked model portfolios (Conservative → Aggressive Growth) with a
**hybrid data layer**: listed holdings auto-fetch from Yahoo Finance; Canadian
mutual funds (FundServ) and private alternatives use manual NAV entry. Model
changes are stored as effective-dated versions, which is the foundation for
change-attribution over time.

## Stack
- **client/** — Vite + React (the six-tab portfolio view, sleek analyst UI)
- **server/** — Node/Express: Yahoo adapter, storage seam, model/version API
- One Render web service: the server builds and serves the client + `/api`.

## Run locally
```bash
npm run install:all
npm run dev:server     # terminal 1 → http://localhost:3000
npm run dev:client     # terminal 2 → http://localhost:5173 (proxies /api)
```

## Deploy on Render
Push to GitHub, then either commit `render.yaml` (Blueprint) or create a Web Service manually:
- **Build:** `npm run build && npm --prefix server install`
- **Start:** `npm start`
- **Node:** 20+

## Persistence — set DATABASE_URL for durable data
Storage auto-selects at boot:
- **`DATABASE_URL` set** → Postgres. Schema is created automatically; seed data is
  inserted only if the tables are empty, so restarts/redeploys never clobber your edits.
- **Not set** → a JSON file (`server/data/store.json`). Fine for local dev, but on
  Render's free tier the filesystem is ephemeral, so this is wiped on restart.

**Recommended (free): Neon Postgres.**
1. Create a project at neon.tech, copy the connection string
   (`postgresql://…?sslmode=require`).
2. In Render → your service → Environment, add `DATABASE_URL` = that string.
3. Redeploy. The logs should print `Storage: Postgres`. That's the switch.

Both backends implement the same interface (`store-json.js` / `store-pg.js` behind
`store.js`), so the rest of the app is unaware of which is active.
(Verify current free-tier terms on Render/Neon — they change.)

## Editing a model
Tap the **+** button (or "Add holdings" on an empty model) to open the editor. You can:
- add any ticker — it's looked up on Yahoo; if found it's tracked live, if not you
  add it manually (name, type, currency, optional starting NAV) for funds/alts;
- set target weights with a live "sums to 100%" check and a Normalize button;
- set an effective date and a note describing the change.

Saving writes a **new effective-dated version** — it never overwrites history, which
is what feeds the Performance change-timeline (and, next, attribution).

## Data coverage (honest)
| Instrument | Source |
|---|---|
| TSX / US stocks & ETFs | Yahoo (auto). **Stocks** (and TSX ETFs without a mapped issuer sheet) can **Fetch from Yahoo** on Classify / Prices — review, then Apply series into `nav_series` (merge by date). Source label: `Yahoo Finance`. On Render 429, paste Date / Close from [ca.finance.yahoo.com](https://ca.finance.yahoo.com/) or type them in Prices. Add another `.TO` stock: no mapping needed; add a bare-ticker alias in `server/yahooSeries.js` (`YAHOO_ALIASES`) only if the instrument is stored without `.TO` (e.g. `RY` → `RY.TO`). |
| US mutual funds | Yahoo (mostly auto) |
| Canadian MF (FundServ code) | Manual NAV; mapped funds can fetch Fund Facts / FundPulse / RBC monthly update for look-through and **published** manufacturer returns (not reconstructed from NAV). Add another `RBF####`: copy the `RBF608` block in `server/factsheet/sources.js` (Fund Facts + monthly PDF for that series). |
| Manual ETFs (e.g. Manulife `IDIV.B`) | Manual NAV; mapped tickers can fetch the issuer factsheet PDF for look-through and **published** multi-period returns (same Persist-on-Save path as FID5982). Add another Manulife ETF at `https://funds.manulife.ca/en-us/etfs/{TICKER}/pdf` — see `server/factsheet/sources.js`. |
| Private alts (OCIC, CVC, pooled) | Manual NAV |
| CUSIP-only instruments | Manual |

Yahoo chart calls try **query2 then query1**, use `period1`/`period2` for history (`range=max` came back monthly/quarterly), and send at most one request about every 1.5 seconds. Set `YAHOO_UA` to `none`, `rotate`, or an exact User-Agent; the default is `FolioTrack/1.0 (portfolio price history)`. A Safari browser UA received HTTP 429 from a datacenter VM while that default returned bars, so it is not the default. `GET /api/diagnostics` includes `yahoo.lastSuccessAt`.

## Compliance note
Keep this to model **allocations** and instrument data. Do not put client account
values or PII on a public URL — gate behind auth or deploy privately if that changes.
Alert emails list model holdings only (symbol, drawdown, which models hold it).
They do not include client names or account values.

## Price drop alerts
Settings → **Price drop alerts**. For every holding in the **current** version of
each model (deduped by instrument), drawdown is `current / reference − 1`.

- **Reference** is the highest cached close in the trailing 52 weeks (364 days)
  ending on the latest cached close. If `price_history` has no usable closes,
  the reference is the peak of the saved NAV series.
- **Breach** when drawdown is at or below the threshold (default 20%, allowed 1–90).
- **One email** the first time a holding breaches. Nothing is resent while it
  stays breached. It is marked recovered only after drawdown is back above
  `-(threshold − 2)` percentage points (2-point hysteresis). A later breach
  sends a new email.
- Changing the threshold re-evaluates. A holding that was already emailed and
  is still inside the band is not emailed again.
- Cash is skipped. Private/illiquid names and anything else with no cached
  close and no NAV are skipped. The panel labels the basis
  (`from 52-week high, using cached closes as of DATE`) and warns when the
  price as-of is more than 5 days old.

The check reads the existing price-history cache and NAV series. It refreshes
a stock/ETF history only when that cache is missing or older than 18 hours,
through the same cache that honors provider cooldown, and it never force-refreshes.
A symbol whose live fetch fails entirely is not tried again for 6 hours.

### Schedule (Render free tier sleeps)
The process listens before it migrates the database, warms the provider cache,
or runs the first alert check. `GET` and `HEAD /api/health` return
`{ ok: true, uptimeSec, time }` immediately and do not touch the database or a
price provider. The in-process timer still runs a check on startup and every
**30 minutes** after that, but on the free tier the process sleeps after about
15 minutes of no HTTP traffic and the timer sleeps with it.

Use **two** cron-job.org jobs. A single job that hits the alert check is what
got auto-disabled: Render returns **503 while the instance is cold-starting**
(often longer than cron-job.org’s default ~30s timeout), and a disabled job
means alerts are not checked at all.

| Job | URL | Schedule |
|---|---|---|
| Keep app alive | `GET https://foliotrack.onrender.com/api/health` | Every **10 minutes** |
| Alert check | `GET https://foliotrack.onrender.com/api/alerts/check?token=YOUR_ALERT_CRON_TOKEN` | Every **30 minutes** |

On both jobs:

- Set the request **timeout to 60 seconds**. Health is instant once the process
  is listening; the alert URL returns **202** as soon as the check is queued
  and finishes the work in the background (90s budget, at most 8 price refreshes).
- **Turn on failure notifications** so a run of failures is visible.
- **Do not rely on auto-disable.** cron-job.org will disable a job after a
  streak of failures (this app’s job was disabled after 26 consecutive 503s).
  A 503 during cold start is expected — the proxy has nothing to forward to
  until the process binds the port — and **one failure should not matter**.
  The next keep-alive ping wakes the instance.

`Authorization: Bearer YOUR_ALERT_CRON_TOKEN` works on the alert URL too. If
`ALERT_CRON_TOKEN` is unset, `/api/alerts/check` rejects every request. Health
does not use a token.

Set these on the Render service (Environment), then redeploy:

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend API key. HTTPS only — do not configure SMTP; the free tier blocks outbound SMTP ports. |
| `ALERT_FROM` | Optional. Defaults to `FolioTrack <onboarding@resend.dev>`. |
| `ALERT_CRON_TOKEN` | Secret for the alert-check URL. If unset, `/api/alerts/check` rejects every request. |
| `DATABASE_URL` | Still required if you want alert state to survive sleep/redeploy. The JSON store is ephemeral on Render. |

**Resend setup:** create a free account at resend.com using `mikemmorgan@gmail.com`.
The default `onboarding@resend.dev` sender can only deliver to the address that
owns the Resend account. Put that same address in Settings → Alert email
(it is the default). Then use **Send test email** and confirm it arrives before
relying on breach mail. A missing `RESEND_API_KEY` does not crash the server:
the breach is stored as `pending - email not configured` and retried on the next check.

In the app, **Check now** and **Refresh prices now** start the same background
check (no cron token; the rest of the API is unauthenticated) and poll
`GET /api/alerts/status` until it finishes. The Alerts panel shows the last
check time, duration, and error. A warning stays up when no check has succeeded
in over 2 hours. The header menu shows a red dot while any holding is breached.

## Live now vs. next
- **Live:** Overview, Holdings, Allocation, Geo/Sector, model editing, and the
  **return & attribution engine** (Performance) — monthly model-vs-benchmark
  returns, period breakdown, per-change attribution (new mix vs. holding the prior
  version), and holding contribution.
- **Next:** Risk metrics — they derive from the same monthly return series the
  Performance engine already produces.

### How performance is computed (methodology)
Monthly return series (the honest common frequency, since manual funds/alts report
periodic NAVs). Within each version's window the model holds that version's target
weights; windows are chained. Any month a holding lacks data is renormalized out and
a **coverage** figure is surfaced. Manual holdings realize their return in the month
their NAV updates. Change attribution compares each new version's return to holding
the prior version over the same window. Contribution is arithmetic (weight × return)
over the current version's window. If Yahoo is unreachable the engine degrades
gracefully (flags missing sleeves, computes what it can) rather than failing.

Holding-level period returns (the row under a security’s chart) are computed from
that instrument’s own visible price/NAV series — the same Full history / Since added
slice the chart uses. Each window is `(P_end / P_start) − 1` using the closest
available EOD **on or before** the window start and end (no interpolation). MTD,
QTD, YTD, and 1Y are simple total returns. 3Y / 5Y / 10Y / 15Y / 20Y are
annualized as `(P_end / P_start)^(1/years) − 1` where `years` is the actual
year-fraction between the two observation dates (day count / 365.25). A dash
means the visible series does not cover that window — never a fabricated 0%.
Thin samples (under ~90% of expected trading days) are labeled **est.**

Mapped Canadian mutual funds and Manulife ETFs can also show a **Published
(Fund Facts / FundPulse / RBC monthly / Manulife)** row: manufacturer calendar-year and
annualized figures copied from the issuer document. Those are not reconstructed
from NAV and are not invented from a single price point. Series letter is
load-bearing for Fundserv (FID5982 = F, RBF608 = F); Manulife class suffixes are too
(`IDIV.B` ≠ `IDIV.U`).

TSX stocks (starting with `RY.TO`) compute the same period-return row from an
applied Yahoo EOD series. That path is `nav_series`, not Published Fund Facts.
```
