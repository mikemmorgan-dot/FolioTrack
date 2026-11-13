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
backfill, provider probes, or an alert check. `GET` and `HEAD /api/health`
return `{ ok: true, uptimeSec, time }` as soon as the process is listening.
That response does not touch the database or a price provider, so a keep-alive
ping is not stuck behind boot work.

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

## Politician trades
Menu → **Politician trades**. The feed lists filings newest disclosure first.
Open a name for that filer's trades, buy and sell counts, and most-traded
tickers. Coverage is every House PTR in the Clerk index for the backfill
window (the complete list, so a current member who filed is included), every
Senate eFD PTR from a senator, and OGE 278-T reports whose title is exactly
President or Vice President. A holding in the **current** model version gets
a badge when a parsed stock, ETF, or mutual-fund trade uses that ticker.
`.TO` / `.V` names do not match a US listing of the same company.

Spouse, joint, and child trades are included and labeled. Alerts default to
**all new trades**. Held-tickers-only stays available and defaults off. Held
tickers are still listed first in the digest.

Amounts stay the printed range. A row that does not validate is not stored
as a trade. The filing stays linked and marked **Needs review**. Rows read
by OCR show an **OCR** label and the confidence.

### What each source actually is
| Source | What is fetched | What parses |
|---|---|---|
| House Clerk | `{year}FD.zip` → `FD.xml` (FilingType `P` only). PDF at `/public_disc/ptr-pdfs/{year}/{DocID}.pdf`. | Machine-generated PTRs (DocIDs that start with `2`). The text layer has the asset, owner code (`SP` / `JT` / `DC` / blank = self), `P`/`S`/`E`, both dates, and a statutory range. DocIDs that start with `8` or `9` are usually scans with no text layer and stay on manual review. |
| Senate eFD | Accept the prohibition agreement, then `POST /search/report/data/` for senator PTRs (`report_types=[11]`, `filer_types=[1]`). | Electronic reports are HTML tables (date, owner, ticker, asset, type, amount). `/search/view/paper/{uuid}/` is a scan and is not downloaded. |
| President / Vice President | `GET https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest`. Title must be exactly President or Vice President, type 278 Transaction. | Scanned 278-T PDFs are rendered one page at a time (`pdftoppm`) and read with the `tesseract` CLI in a child process. A row is kept only when the date parses, the amount is a statutory bucket, and the type word is purchase, sale, or exchange (a single-character slip such as `purchaso` is accepted only when it cannot be another type). Low confidence or a failed check stays on review. PDFs over `POLITICIAN_MAX_PDF_BYTES` (default 32 MB) are linked and not read. The largest filing measured in Nov 2026 was about 27 MB. |

Party is not on the filing. House party comes from the Clerk member list
(`clerk.house.gov/xml/lists/MemberData.xml`) and Senate party from
`senate.gov` senators XML, and only when the name matches one person. The
President's party is left blank. Disclosure date is the Clerk filing date,
the Senate date received, or the date OGE added the report — not the
notification date printed on the form.

### Schedule
Nothing here runs before the port is open, and `/api/health` does not wait
on it. The first look is 45 seconds after boot.

**Backfill.** Until every House PTR, senator PTR, and President/VP 278-T in
the window is stored, the job keeps going: about 25 documents per slice, a
1.2 second gap between requests, cursor saved in Postgres after each slice.
A restart reads that cursor and continues. It does not wait 24 hours between
slices, and it does not email the history.

**Daily check.** After the backfill is done, a run happens when the last
**successful** run in the database is at least 24 hours old
(`POLITICIAN_POLL_INTERVAL_HOURS`). Waking the free-tier process is enough:
the timer only decides when to look, and the decision uses that timestamp.
**Refresh** always starts a run and returns immediately.

A 429 or 5xx backs that source off (5 minutes, or 15 on 429, doubling up to
6 hours). The backfill window is the current US calendar year plus the prior
year (`POLITICIAN_BACKFILL_YEARS`, default 2). After that, digests go to the
existing alert address. Turn them off, or limit them to held tickers, under
Settings → Politician trade alerts.

The image is Docker (`Dockerfile`) so Render has `tesseract` and `pdftoppm`.
Without those binaries the rest of the app still runs and presidential scans
stay on review. `tesseract.js` was not used: on this same page it validated
almost no rows and held about 380MB in the Node process. The CLI is a child
process. A measured 4-page 278-T (827KB, received Aug 2025) took **9.4
seconds** here and moved Node RSS by about **10MB**. It kept **24** rows and
flagged **15**. One kept row read 8/4/2025 where the page shows 8/1/2025;
that date was not rewritten.

### Backfill time (estimate)
About **1,000 House PTRs** (515 in the 2025 index and 468 in the 2026 index
checked on 13 Nov 2026) plus on the order of **several hundred** senator
PTRs, at roughly 2 seconds each, is around an hour of downloading. Presidential
OCR is the slower part: the CLI took about **3 seconds per page** on a normal
CPU for a real 4-page 278-T. Render's free CPU is slower; call it around 8–15
seconds a page. Twenty filings averaging 10 pages is on the order of an hour.
**Estimate: about 2–4 hours of awake time** if the keep-alive stays up. A
killed process resumes from the cursor instead of starting over.

On the 2026 House index, **108 of 439** people on the current Clerk roster
had at least one PTR. The other members had not filed one that year. Every
FilingType `P` row is still stored, so a member who did file is not dropped
because of a name mismatch. The Senate pull is `filer_types=[1]` (senators,
not candidates or former senators). There are 100 senators on the Senate
contact list.

Options, crypto, and bonds are stored and shown. They do not light up a
model holding. Spouse, joint, and child trades are included and labeled.

### Storage and egress (estimates)
A filing row is a few hundred bytes. Two years of House and Senate PTRs is
on the order of a thousand filings; many House PDFs are one or a few trades,
Presidential OCR adds a confidence integer on the rows it keeps. **Estimate:
well under 20 MB** in Neon, including indexes.

Reads are paged (40 rows) or aggregated (`count`, `GROUP BY ticker`). A poll
asks only whether the filing ids it is about to download already exist. It
does not `SELECT` the trade table. **Estimate: a daily poll is under 100 KB
of Neon egress. A feed page is a few tens of KB.** The House zip is about
0.6 MB of ordinary HTTP, not Neon. A 278-T is downloaded once (up to 32 MB)
and OCR'd from disk, one page at a time.

No client names or account values are stored or emailed.

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
