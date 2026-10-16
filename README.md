# Hedge Lab — delta-neutral funding arbitrage across 7 perpetual venues

A research and execution-support tool for **delta-neutral funding arbitrage**. It normalises live
funding rates from seven perpetual venues, finds pairs where the same asset pays materially
different funding on two of them, and sizes the position against the constraint that actually
binds.

**Live demo:** <https://hedge-lab-demo.vercel.app> — the dashboard is open to everyone; the
scanner, ranking, position and journal screens ask for a Telegram sign-in.

---

## The idea

A perpetual future pays *funding* — a periodic transfer between longs and shorts that keeps the
contract near spot. Venues arrive at different rates for the same asset. Long one, short the
other, and price movement cancels: the position is delta-neutral and the funding difference is
the return.

Finding those pairs is easy. **Deciding which are actually tradeable is not.**

## Seven venues, seven conventions

| Venue | Funding interval | Rate published as | Leverage cap derived from |
|---|---|---|---|
| Variational | 4h / 8h **per asset** | annualised, RFQ-quoted | not published (RFQ model) |
| Ethereal | 1h | hourly | `maxLeverage` |
| Nado | 1h | `x18` fixed-point | `long_weight_initial_x18` → `1/(1−w)` |
| Lighter | 1h settlement | **8h-equivalent** rate | `min_initial_margin_fraction` → `10000/f` |
| Lighter (Robinhood Chain) | 1h | same | same |
| Aster | **1h / 2h / 4h / 8h per symbol** | per-interval | `requiredMarginPercent` → `100/pct` |
| edgeX | 4h | per-interval | `riskTierList[0].maxLeverage` |

Get any of these wrong and you get a plausible-looking number that is off by 8×. Aster alone
publishes four different intervals across its symbols, so the interval must be read per symbol
from `/fundingInfo` or every APR on that venue is wrong. Verifying Lighter's convention against
Hyperliquid's hourly rate gave a ratio of exactly 8.000 — the published rate is 8h-equivalent
even though settlement is hourly.

An eighth venue, **Phoenix** (Solana), is wired in as a Variational cross only — it is not in
the combined matrix. It ticks hourly, `fundingRate × 87.6` gives the annual percentage
(calibrated against Hyperliquid), and its public API has no 24h volume, so that column shows
open interest instead.

## Three columns that came out of live trading

Raw spread is a poor signal alone. Three derived columns encode what the measurements showed:

**`Rés` (gap)** — the *price* difference between venues, not the funding difference. A
delta-neutral round's basis P&L is exactly the change in this number while the position is open.
On thin books it moves further in an hour than the funding pays in a day, which makes it the
binding constraint rather than the spread.

**`Egyirány` (aligned)** — whether the gap and the funding pull the same way: does the funding
want you to short the *more expensive* leg? When aligned, a narrowing gap pays on top of the
carry. When opposed, they fight. Two live rounds on consecutive days, same method, differing
only in this flag: **+$12.73** and **−$4.61**.

**`Ítélet` (verdict)** — reads each venue's own measured history rather than the current tick:

| | meaning |
|---|---|
| `⇄` | **reversed** — the 7-day average points the *opposite* way. One asset read −703.9% average against +1914.3% current, and turned back within hours |
| `⚠` | **spike** — far above its own average; it will revert |
| `✓` | **structural** — 72h+ in one direction, safe to size against the average |
| `~` | **young** — a real direction, under three days old |

## Charts on a symlog axis

Funding series span orders of magnitude — one asset ran between 11% and −17520% with most
readings sitting at 11%. On a linear axis one spike sets the range and everything else collapses
onto the zero line. The vertical axis is **symlog**: linear near zero, logarithmic further out,
negatives handled, unit set per series from its own median absolute value.

## What's in the app

Six screens, plus a deep dive that opens from any row:

- **Dashboard** — what each cross is worth right now, a heatmap of the best spread per venue
  pair, and the raw funding matrix: every asset on all seven venues
- **Pairs Scanner** — one cross at a time (Variational against Aster, edgeX, Lighter-RH,
  Lighter, Nado or Phoenix), each row with gap, alignment, leverage cap, verdict, round-trip
  cost and break-even days
- **Best Pairs** — the scanner's whole universe scored and ordered; the score is the sum of
  five measured components (spread, verdict, alignment, break-even, liquidity)
- **Gap Watch** — every cross in one list, ranked by suitability for a *gap reversion*
  rather than by spread. Each pair's current price gap is measured against its own history
  (distance from its median in MAD units, and whether it is drifting rather than swinging),
  then scored on five components: capturable gap against the taker cost of the round trip,
  stretch, liquidity, alignment and carry. Pairs that fail outright — too little history,
  a gap that does not cover its cost, a thin book, a drift — are graded *Excluded* with the
  reason shown. A pair needs 12 hourly price measurements before it can be graded
- **Position** — sizing and stops, funding-tick countdowns per leg, a live price-gap strip
  against the gap recorded at entry, and a running funding accumulator that credits the rate
  *in force at each tick boundary* rather than elapsed time × current rate (across one live
  round the hourly ticks ran 2.36 → 1.80 → 1.18 → 2.18 → 0.67 → 0.49; the closing rate would
  have implied $14.16 against an actual $8.68). Liquidation distance comes from the venue's
  real maintenance-margin fraction, not the nominal leverage
- **History** — the journal: one line per closed round, net P&L and a note on the funding /
  basis / fee split
- **Deep dive** — per-asset history, book depth at size, funding series, structural verdict

### Who sees what

Sign-in is optional for whoever deploys it, and the app behaves differently in each case:

| | Dashboard, deep dive | Pairs Scanner, Best Pairs, Gap Watch, Position, History | Where state lives |
|---|---|---|---|
| No Telegram bot configured | open | open | server memory, one shared session |
| Bot configured, visitor not signed in | open | behind a sign-in card | — |
| Signed in | open | open | Supabase, per Telegram account |

A signed-in user's configuration, open round (entry price, entry gap, opening time, funding
accrued so far) and journal are stored per account, so a round follows them between devices
and survives a restart.

The gate is in the page, not in the API: the market-data endpoints below stay public.
Journal writes are the exception — the server refuses them without a session.

## Data

The repository ships **99 hourly snapshots** taken 16–20 August 2026 across ~700 pairs. Each
snapshot holds funding rate and price per venue per symbol. Nothing else is recorded.

While it runs, the server adds at most one snapshot per hour, taken when a scan runs, and
keeps 30 days. With Supabase configured each snapshot is also written to a shared
`lab_snapshot` table and read back on boot.

Two consequences:

- The seed is older than the 30-day window, so it ages out at the first live snapshot. From
  then on the history columns (7-day average, verdict, charts) show what the instance or
  Supabase has collected.
- On Vercel a scan only runs when somebody has the app open, so the history has a row only
  for the hours that saw traffic.

```
GET /                     → landing page (overview, conventions, signals)
GET /app                  → the app
GET /api/scan             → full computed scanner payload (cached 60 s)
GET /api/dive/<symbol>    → per-asset detail, series, book depth (?leg=<usd>)
GET /api/series/<symbol>  → that asset's series from the stored history only
GET /api/archive          → days that have snapshots
GET /api/archive/<day>    → that day's hourly snapshots
GET /api/me               → whether sign-in is enabled and who is signed in
```

## Running it

```bash
npm start          # http://localhost:8879
```

No API keys, no database, no build step, no dependencies. Node 18+. Without any environment
variables there is no sign-in, nothing is gated, and everything — settings, open round,
journal — lives in memory and resets on restart. `PORT` changes the port.

## Deployment

One service, one domain. The same Node process serves the landing page (`/`), the app
(`/app`) and the API, so there is no second origin, no CORS and no proxy layer.

```
Vercel     serverless        landing + app + API
Supabase   free project      users, journal, settings, history, login   (recommended on Vercel)
Telegram   login only        one "signed in" reply per login             (optional, needs Supabase)
```

`server.js` runs two ways from the same code: locally it starts a real, always-on
`http.createServer` (`node server.js`); on Vercel, `api/index.js` re-exports the same
request handler as a serverless function, and `vercel.json` rewrites every path — `/`,
`/app`, `/api/*` — to it, so the whole app stays on one origin without a second service or a
proxy layer. The rewrite passes the original path along as `?__p=…`, because Vercel hands
the function the rewrite target rather than the path the visitor asked for.

**The tradeoff of serverless is state.** A serverless function has no persistent memory
between requests — a different one (or a fresh cold start) can serve the next call.
Concretely, on Vercel:

- **Signed-in users are unaffected** — their journal, settings and open round live in
  Supabase, not in the function.
- **Without Supabase** all of that falls back to in-memory storage, which on Vercel is
  unreliable across requests — entries can appear to vanish.
- **The history only grows with Supabase.** Without it, each cold start resets to the
  shipped seed. With it, snapshots persist, but only for the hours in which someone used
  the app (see Data above).
- **The scan cache is best-effort, not guaranteed** — a `/api/scan` request may land on
  a cold instance and re-run the full venue fetch (~5s) instead of hitting a warm
  60-second cache. Slower under load, never broken.

None of this needs any setup to deploy — `vercel deploy` or connecting the repo on
[vercel.com](https://vercel.com) works with zero configuration. Every environment
variable below is optional and the server degrades cleanly without them, which is also
what makes `git clone && npm start` work locally with zero setup.

| Variable | Effect when unset |
|---|---|
| `SUPA_URL`, `SUPA_KEY` | everything falls back to memory (unreliable on Vercel, fine locally). `SUPA_KEY` is the service key; it stays on the server |
| `TG_BOT_TOKEN`, `TG_BOT_NAME` | no sign-in and no gate; the app is fully usable anonymously |
| `SESSION_SECRET` | random per boot — on Vercel, set this explicitly, or every cold start invalidates existing sessions |

Set the Telegram variables only together with the Supabase ones. The sign-in flow stores
its one-time codes in Supabase, so a bot without a database switches the gate on with no
way through it.

For persistence, run [`schema.sql`](schema.sql) once in the Supabase SQL editor. Row-level
security is on with no policies, so only the server's service key can reach the tables.

`render.yaml` is also in the repo: a persistent Node server has none of the tradeoffs
above, at the cost of a real server to run. It works standalone if you'd rather use it.

### Telegram sign-in

Sign-in goes through the bot's deep link. Telegram's Login Widget stopped working in
September 2026 — its `oauth.telegram.org/auth` popup now answers `deprecated` — so the
button it drew led nowhere.

1. The browser asks the server for a one-time code and gets a `t.me/<bot>?start=<code>` link.
2. The user opens the link and presses **Start** — on any device, including a phone while
   the browser waits on a desktop.
3. Telegram delivers that `/start <code>` to the bot's webhook, which records who pressed
   it and replies with a one-line confirmation.
4. The browser, polling in the meantime, receives the session cookie.

Setup:

1. Create a bot in [@BotFather](https://t.me/BotFather) — use a **separate** bot, not one
   already wired to something else: its token has to live in the server environment, and a
   bot has only one webhook.
2. Run [`schema.sql`](schema.sql) in Supabase (it creates the `login_nonce` table).
3. Set `TG_BOT_TOKEN`, `TG_BOT_NAME`, `SESSION_SECRET` and the Supabase variables on Vercel.
4. Open `https://<your-domain>/api/tg/setup` once. It registers
   `https://<your-domain>/api/tg/webhook` with Telegram and prints Telegram's answer.

What keeps it honest:

- The webhook only accepts calls carrying the secret header Telegram was given at setup.
  The secret is derived from the bot token, so there is no extra variable to manage.
- A code is 32 random hex characters, valid for 10 minutes, accepted once, and deleted the
  moment it signs someone in.
- The session is a signed, HttpOnly cookie valid for 30 days rather than server-side state,
  so a restart does not sign anyone out.

The old widget callback (`/api/auth/telegram`, HMAC-SHA256 over the sorted fields keyed by
`SHA256(bot_token)`) is still in the code but nothing calls it any more.

## Scope

This is a public demo built from a private system that trades real capital. Nothing here
can place an order: there are no private keys, no signing and no exchange credentials
anywhere in the code. The optional wallet field takes a public address and only reads that
address's open positions on Nado and Lighter, to compare them with the round you are
tracking. The private system's own trade history is not part of this repository, and every
journal starts empty.

Advisory only. Not financial advice.
