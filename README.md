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
| TSX / US stocks & ETFs | Yahoo (auto) |
| US mutual funds | Yahoo (mostly auto) |
| Canadian MF (FundServ code) | Manual NAV |
| Private alts (OCIC, CVC, pooled) | Manual NAV |
| CUSIP-only instruments | Manual |

## Compliance note
Keep this to model **allocations** and instrument data. Do not put client account
values or PII on a public URL — gate behind auth or deploy privately if that changes.

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
```
