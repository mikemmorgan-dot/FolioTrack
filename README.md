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

## ⚠️ Persistence — read before relying on saved changes
The default store writes to `server/data/store.json`. **Render's free tier has an
ephemeral filesystem and spins down when idle** — that file is wiped on every
restart/redeploy, so model changes you save will not survive. The app re-seeds so
it never looks broken, which can mask silent data loss.

Fix one of these before real use:
1. **Managed Postgres** (recommended) — Neon or Supabase free tier. Replace the
   body of `server/store.js` only; the API it exposes stays identical, so nothing
   else changes. This is the clean long-term path.
2. **Render persistent disk** — set `DATA_FILE=/var/data/store.json` and mount a
   disk (requires a paid instance; see commented block in `render.yaml`).
3. **Gist-backed JSON** — like your TravelSmart price-watch setup; fine for
   single-user, low write volume.

(Verify current free-tier terms on Render/Neon — they change.)

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
- **Live:** Overview, Holdings, Allocation, Geo/Sector, model-change timeline.
- **Next:** return & attribution engine (Performance), risk metrics — both compute
  from data already wired (Yahoo history + entered NAVs, vs the blended benchmark).
```
