# FolioTrack — Handoff (updated)

Written for whoever picks this up next — human or agent. Supersedes the
original HANDOFF.md this session started from (that version is gone from the
repo; this one replaces it). Everything below reflects the actual current
state of `main` as deployed to `https://foliotrack.onrender.com`.

Repo: `github.com/mikemmorgan-dot/FolioTrack`
Owner: Mike — CFP / Portfolio Manager. Prefers plain, direct, technically
grounded explanations. Wants estimates labeled as estimates. Prefers root-cause
fixes over patches — and will push back (correctly) when an explanation
doesn't match what he's actually seeing, so verify against the live app
before answering, don't reason from what "should" be true.

---

## 1. What the app is (unchanged)

A mobile-first model portfolio tracker for five risk-ranked model portfolios
— target allocations and their history, not client accounts. No client
names, account values, or PII; the URL is public. Keep it that way.

Hybrid pricing: instruments carry `source: 'auto'` (priced from a live
provider chain) or `'manual'` (priced from user-entered NAV points).

Versioning spine unchanged: a model is never mutated in place — every
allocation change writes a new effective-dated version. Still true; still
the foundation for change attribution. Do not add an edit-in-place path.

---

## 2. Starting point for this session

The previous handoff's single open item was: ticker lookups were failing in
production ("AAPL not found"), diagnosed as Yahoo blocking Render's
datacenter IP, with a fix built but never verified against real network
(that assistant had none) or pushed to GitHub. Everything below grew out of
chasing that one bug through an entire session of iterative, verify-then-fix
work — most of it driven by things Mike actually hit live in the app, not
speculative hardening.

---

## 3. What's been completed

### Data-source resilience (the original bug)
- Root cause confirmed: Yahoo intermittently 429s Render's IP (not a hard
  403 block — verified it succeeds plenty of the time too).
- `server/providers.js` now chains **four** fallback sources for auto
  pricing: Yahoo → Twelve Data → Finnhub → Alpha Vantage (last resort, its
  free tier is 25 requests/day total).
- Stooq (the originally planned fallback) is confirmed dead as a source —
  its entire site now sits behind a JS proof-of-work bot check no
  server-side client can pass. Removed rather than left as a 10s-timeout
  dead hop.
- `GET /api/diagnostics` and a boot-time log line report real per-provider
  results, not guesses.
- A blocked/failed lookup now adds the holding as `manual` (prompts for NAV
  entry) instead of gambling that a block is transient.

### Fund look-through for Geo/Sector
- Instruments can carry an optional `{label, weight}[]` sector/country
  breakdown, entered manually from a fund's factsheet (`ClassifyPanel`).
  Geo/Sector tabs distribute a fund's weight across its breakdown instead of
  counting it as one bucket.
- Sector/region entry is now dropdown-driven (11 GICS sectors + Fixed
  Income/Private Equity/Private Credit/Diversified; a curated ~50-country
  list + International/Global/Emerging Markets), with an "Other" free-text
  escape hatch for values outside any curated list (needed — real data
  already has non-GICS placeholders like `"Equity"`).
- Seeded starting-estimate breakdowns for VFV.TO, XEF.TO, VDY.TO, RBF1005 —
  **these are rough approximations, not sourced from any live feed.** Flagged
  as such in the UI ("isn't live data... verify against the factsheet").

### Ex-ante risk model + optimizer (the big build)
- `server/optimize.js`: mean-variance max-Sharpe optimizer. Expected
  returns/covariance come from each holding's own trailing historical
  returns — historical estimates, explicitly not a forecast.
- Solved via Frank-Wolfe rather than a hand-rolled QP/matrix-inversion
  solver, specifically to reduce the chance of a subtle bug in something
  feeding real investment decisions (see `optimize.js`'s header for the
  quasi-concavity argument justifying this).
- Long-only, fully invested by default, optional per-holding weight cap
  (now defaults to 10%).
- **Automatic cash sleeve**: a restrictive cap (or an under-100% save in the
  editor) no longer errors or gets blocked — the shortfall is held as cash
  automatically. Cash is an ordinary manual instrument with a NAV fixed at
  $1.00 forever, needing zero special-casing anywhere in the math.
- UI: an "Optimize" card in the Risk tab (current vs. suggested, per-holding
  and portfolio-level), "Edit with suggested weights" flows into the
  existing editor and its pre-trade preview.
- **Risk tab methodology changed on Mike's explicit direction**: it now
  backtests the model's *current* target weights held statically over each
  holding's full available history, instead of the model's *realized*
  version-chained history. This was a real inconsistency fix, not just a
  preference — the old "current" Sharpe on the Risk tab never actually
  matched the "Now" column in the pre-trade preview for the same model at
  the same moment; both use the same method now. The Performance tab's
  change-attribution deliberately still uses the realized/chained history —
  a different, valid question ("how did my actual decisions do") — left
  unchanged.

### Security detail view
- Tapping a holding now shows price, a price-history chart (1Y/2Y/5Y
  toggle), and basic performance (annualized return/volatility/max
  drawdown) computed from that instrument's own history — folded into the
  existing classify panel rather than adding a second tap target.

### MER — was missing entirely
- There was no field anywhere in the UI to enter or edit MER; new holdings
  always saved `mer: null`. This is why "Blended MER" read as a dash on a
  real model with a real ETF holding. Added an MER field to both the
  add-holding flow (ETF/mutual fund only) and the classify panel.

### Settings
- The $10,000 "modelled" display basis was hardcoded. Now editable (Settings
  panel, behind the menu button) and persisted per-device in localStorage —
  a display preference only, never touches the server or other viewers.

### Correctness fixes found along the way
- **No-op saves blocked**: saving with no actual change (same holdings,
  weights, date, note as the current version) no longer creates a stray
  empty-note duplicate version.
- **Stale lookup fields**: a failed/unclassified ticker lookup used to leave
  whatever a *different*, previously-looked-up symbol had filled in (e.g.
  looking up `H.TO` right after `H` showed Hyatt Hotels' name for Hydro
  One). Now clears fields it can't fill instead of leaving stale data.
- **Stale-model race condition (the serious one)**: switching the model
  pill and acting quickly (before the new model's data finished loading)
  could open the editor labeled with the new model's name while it still
  showed the *previous* model's actual holdings — a real risk of saving one
  model's data over another's. Fixed by gating all model-dependent
  rendering on the fetched data actually matching the current selection.
- **Sortino from a single observation**: showed a specific-looking number
  computed from one month of data while Sharpe correctly showed "no data"
  for the same insufficient sample. Now both correctly show "—" below 2
  observations.
- **Optimizer Sharpe formula bug**: found while verifying the cash-sleeve
  change. `expectedReturn - rf` silently assumed the whole portfolio must
  beat rf, which only worked because weights always summed to exactly 1
  before caps could leave some unallocated. The moment that stopped being
  guaranteed, it produced a nonsensical *negative* Sharpe for an 8-asset,
  all-positive-excess-return, 10%-capped case. Fixed (idle cash earns rf,
  standard Sharpe assumption) and verified the corrected result is
  genuinely better than the best single-asset alternative, not just
  "no longer negative."
- **Ticker vs. company name**: typing a company name ("HYDRO ONE") into the
  ticker field now gets an instant format hint instead of burning a
  provider call and returning a wall of per-provider errors.

### Tests
- vitest added (`npm test` at the root, or `npm --prefix server test`).
  Coverage for `perf.js`, `risk.js`, `optimize.js`, `util.js` — all pure,
  network-free math.
- **Caveat**: no local Node was available in the environment that wrote
  this suite. Every assertion was verified once in a real JS engine (the
  pure functions loaded into a browser tab) before being written into the
  test files — not shipped blind — but `npm test` itself was never actually
  run end-to-end this session. Worth running for real once.

---

## 4. Challenges encountered — solved

- **Yahoo 403 vs. 429**: originally diagnosed as a hard block; live testing
  showed it's an intermittent rate limit, not permanent — explains why the
  symptom looked inconsistent rather than uniformly broken.
- **Stooq**: confirmed genuinely dead (site-wide bot-check), not
  IP-specific — removed rather than kept as a false hope.
- **Twelve Data and Finnhub both paywall TSX quotes** on their free tiers,
  despite both *looking* like they cover TSX in symbol search / marketing
  copy. Confirmed live both times before trusting either.
- **Twelve Data's `/profile` endpoint** (meant to auto-fill sector/country)
  turned out to only work for `AAPL` — a demo/showcase symbol on their end,
  not real coverage. Caught this late (had prematurely called it "working"
  after testing only that one symbol) — corrected once Mike hit it live
  with `NVDA`/`TSLA`/`GOOGL`. Now surfaces the real per-lookup reason
  instead of silently failing blank.
- **Render free-tier cold starts and shared-IP rate limiting**: explains
  several "why did this look broken" moments — the app spins down after
  ~15 min idle, and heavy testing in one session can burn through Twelve
  Data's 8/min and Alpha Vantage's 25/day caps fast enough to make the app
  look broken to real usage happening at the same time.
- **The stale-model race condition** (see above) — a real correctness bug
  in the client, not a data or provider issue, caught by reproducing a
  report literally while investigating something else.

## 5. Challenges encountered — NOT solved (still open)

- **No reliable free real-time TSX pricing.** Four providers tried; none
  give free, reliable TSX coverage. Options discussed and left to Mike:
  pay for Twelve Data or Finnhub's TSX-inclusive tier (zero new code,
  both already wired in), pursue official TMX/CBOE data (likely
  institutional pricing), or keep the current manual-entry fallback.
  Explicitly parked mid-session ("we'll come back to the TSX later") —
  revisit this first if picking the project back up.
- **Alpha Vantage's TSX suffix (`.TRT`) is unverified.** Implemented from
  their docs examples, never actually confirmed against a real TSX symbol
  — every attempt so far hit either the daily cap or a burst limit before
  a clean test could land. Worth a real check once the quota is fresh.
- **Neon DB password rotation status is unknown.** The original handoff
  flagged that the connection string was pasted into a chat during setup
  and Mike was advised to rotate it. This was never confirmed either way
  this session — worth asking directly.
- **Free-tier quotas are thin relative to real usage + active development
  happening in the same window.** No code fix for this — just worth
  knowing that heavy testing (mine or anyone's) can visibly degrade the
  live app for real users until quotas reset.

---

## 6. What remains to be built / open items

Roughly in the order they'd likely matter:

1. **Decide the TSX data question** (§5 above) — the highest-value open
   item, since most of the real portfolios are TSX-heavy.
2. **No auth** — the URL is still fully public. Low urgency while the app
   stays allocation-only (no PII, no client data), per Mike's and the
   original handoff's shared framing — but revisit before anything
   client-specific gets added.
3. **Confirm the Neon credential rotation** actually happened.
4. **Run `npm test` for real once** — verify the vitest suite passes
   through actual Node/vitest execution, not just the browser-based
   verification method used to write it.
5. **Two orphaned client files** — `ModelSidebar.jsx` and
   `PortfolioView.jsx` sit unused and unimported in `client/src/components`.
   Harmless, never cleaned up, noted early in this session and never
   revisited.
6. **No dedicated "add cash manually" UI** — Cash only gets created via the
   automatic shortfall-fill on save; there's no direct "Cash" option in the
   AddPanel's type selector if someone wants to add a cash position
   deliberately rather than as an automatic remainder. Small, easy add if
   wanted.
7. **Client-side test coverage** — none exists; only server-side pure
   functions are covered. Not clear it's worth the setup cost for a small
   React app, but flagging the gap.

---

## 7. Conventions (unchanged from the original handoff)

ES modules throughout. Server: no TypeScript, no build step. Client: plain
React + Vite, no state library, no CSS framework, hand-rolled SVG charts.
Mobile-first, true-black OLED theme. Compliance: model allocations and
instrument data only, no client account values or PII. Surface uncertainty
in the UI rather than hiding it — this is a deliberate, load-bearing pattern
throughout the app (coverage warnings, blocked-source notices, small-sample
caveats, "this isn't live data" labels) and every feature added this session
followed it.
