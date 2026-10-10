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
| TSX / TSXV stocks & ETFs | **TMX Money** first for `.TO` and `.V` (quote `getQuoteBySymbol`, daily bars `getTimeSeriesData`, symbol without the suffix). Then Yahoo query2, query1, Stooq, and (`.TO` only) Alpha Vantage if `ALPHAVANTAGE_API_KEY` is set. **Stocks** and unmapped TSX ETFs can **Fetch** on Classify / Prices — review, then Apply into `nav_series`. That writes only on Apply. Manual NAV rows are never replaced by a background refresh. If Fetch fails, Prices offers **Fill from my phone** (browser GET to TMX; Yahoo chart does not allow browser CORS), a Yahoo history CSV paste, or an upload of the Yahoo Historical Data page printed to PDF (iOS Safari Save as PDF). The upload previews Close (not Adj Close), then writes `nav_series` only after Apply — Only add missing, or Overwrite when you confirm. |
| US stocks & ETFs | Yahoo query2, then query1, then Twelve Data, Finnhub, Alpha Vantage, Stooq. TMX is not asked. Fetch / Apply works the same way; the phone fallback is a single last-price field because Yahoo does not allow browser CORS. A Historical Data PDF or CSV upload uses the same preview / apply path as TSX names. |
| US mutual funds | Yahoo (mostly auto) |
| Canadian MF (FundServ code) | Manual NAV; mapped funds can fetch Fund Facts / FundPulse / RBC monthly update for look-through and **published** manufacturer returns (not reconstructed from NAV). Add another `RBF####`: copy the `RBF608` block in `server/factsheet/sources.js` (Fund Facts + monthly PDF for that series). |
| Manual ETFs (e.g. Manulife `IDIV.B`) | Manual NAV; mapped tickers can fetch the issuer factsheet PDF for look-through and **published** multi-period returns (same Persist-on-Save path as FID5982). Add another Manulife ETF at `https://funds.manulife.ca/en-us/etfs/{TICKER}/pdf` — see `server/factsheet/sources.js`. |
| Private alts (OCIC, CVC, pooled) | Manual NAV |
| CUSIP-only instruments | Manual |

Yahoo chart calls try **query2 then query1**, use `period1`/`period2` for history (`range=max` came back monthly/quarterly), and send at most one request about every 1.5 seconds. Set `YAHOO_UA` to `none`, `rotate`, or an exact User-Agent; the default is `FolioTrack/1.0 (portfolio price history)`. Set `YAHOO_PROXY_URL` (and optional `YAHOO_PROXY_SECRET`) to send those calls through a Cloudflare Worker — full script and steps in `docs/cloudflare-yahoo-relay.md`. `GET /api/diagnostics` lists each hop’s `lastSuccessAt` and cooldown, plus `tmx` and `relay` (configured / working). US stocks and ETFs still use Yahoo first; TMX’s `supports()` is false for them. Add a bare-ticker alias in `server/yahooSeries.js` (`YAHOO_ALIASES`) only if a TSX name is stored without `.TO` (e.g. `RY` → `RY.TO`).

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
The process binds its port before database migration, the price-points
backfill, provider probes, or an alert check. Nothing in startup runs before
`app.listen`. `GET` and `HEAD /api/health` return `{ ok: true, uptimeSec, time }`
as soon as the process is listening. That response does not touch the database
or a price provider, so a keep-alive ping is not stuck behind boot work.

On the free tier the process sleeps after about 15 minutes with no HTTP
traffic, and the in-process alert timer sleeps with it. After a cold wake,
that timer runs a check immediately when the last run is missing or at least
**30 minutes** old, then every 30 minutes while the process stays awake. A
missed external alert ping does not skip alerts. A wake that happens sooner
than 30 minutes after the last run waits out the rest of the interval.

#### GitHub Actions keep-alive (primary)

`.github/workflows/keepalive.yml` requests `GET /api/health` every 10 minutes
(`*/10 * * * *`) and can also be run by hand (`workflow_dispatch`). Each
request uses `--max-time 90`. On HTTP 5xx or a timeout it retries every 15
seconds for about 4 minutes, and the job fails only if health never returns
200 in that window. A 503 while Render is spinning the instance up is
expected and is not treated as a dead app. The workflow calls health only,
so it does not need `ALERT_CRON_TOKEN`.

The URL defaults to `https://foliotrack.onrender.com/api/health`. Set a
repository **variable** or **secret** named `APP_URL` to override it. A value
with no `/api/health` path is treated as the site origin and that path is
appended. Scheduled workflows run from the default branch. GitHub can start
them a few minutes late, and it disables the schedule after 60 days without
repo activity.

This is the keep-alive that should stay on. cron-job.org turns a job off
after a streak of failures (this app was disabled after 26 consecutive 503s).
A failed GitHub run does not turn the schedule off, so the next 10-minute
run still tries to wake the service.

#### cron-job.org (backup)

Optional. Treat it as a backup to the GitHub workflow, not the only thing
waking the app. Two jobs:

| Job | URL | Schedule |
|---|---|---|
| Keep app alive | `GET https://foliotrack.onrender.com/api/health` | Every **10 minutes** |
| Alert check | `GET https://foliotrack.onrender.com/api/alerts/check?token=YOUR_ALERT_CRON_TOKEN` | Every **30 minutes** |

On both jobs, set the request **timeout to the longest value the site allows**.
Health is instant once the process is listening, but Render returns **503
while the instance is cold-starting**, and a short timeout (the old default
was about 30 seconds; cold start here is often around 20 seconds and can be
longer) records a failure. The alert URL returns **202** as soon as the check
is queued and finishes the work in the background (90s budget, at most 8
price refreshes). Turn on failure notifications. A disabled cron-job.org job
will not wake the app, which is why it is only a backup.

`Authorization: Bearer YOUR_ALERT_CRON_TOKEN` works on the alert URL too. If
`ALERT_CRON_TOKEN` is unset, `/api/alerts/check` rejects every request. Health
does not use a token.

#### Render Starter

Render's **Starter** plan (and above) does not sleep. On that plan the GitHub
keep-alive and the cron-job.org wake ping are unnecessary. The in-process
30 minute timer still runs alerts for as long as the service is up.

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
