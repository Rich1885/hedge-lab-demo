# Hedge Lab — delta-neutral funding arbitrage across 7 perpetual venues

A research and execution-support tool for **delta-neutral funding arbitrage**. It normalises live
funding rates from seven perpetual venues, finds pairs where the same asset pays materially
different funding on two of them, and sizes the position against the constraint that actually
binds.

**Live demo:** _(deploy URL)_ — interactive, in-memory, no wallet connected.

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

- **Scanner** — seven cross tables plus a combined multi-venue view, each with gap, alignment,
  leverage cap, verdict, round-trip cost and break-even days
- **Deep dive** — per-asset history, book depth at size, funding series, structural verdict
- **Position panel** — funding-tick countdowns per leg, per-tick value, and a running funding
  accumulator that credits the rate *in force at each tick boundary* rather than elapsed time ×
  current rate (across one live round the hourly ticks ran 2.36 → 1.80 → 1.18 → 2.18 → 0.67 →
  0.49; the closing rate would have implied $14.16 against an actual $8.68)
- **Sizing** — liquidation distance from the venue's real maintenance-margin fraction, not the
  nominal leverage
- **Journal** — round P&L split into funding, basis and execution cost

Everything below the scanner is interactive. State lives in memory and resets on restart.

## Data

Seeded with **99 hourly snapshots** collected since 16 August 2026 across ~700 pairs, so the
history-dependent columns are populated on first load. It keeps measuring while it runs.

```
GET /                     → landing page (overview, conventions, signals)
GET /app                  → the dashboard itself
GET /api/archive          → available days
GET /api/archive/<day>    → that day's hourly snapshots
GET /api/scan             → full computed scanner payload
GET /api/dive/<symbol>    → per-asset detail, series, book depth
```

Each snapshot holds funding rate and price per venue per symbol. Nothing else is recorded.

## Running it

```bash
npm start          # http://localhost:8879
```

No API keys, no database, no build step. Node 18+. Everything runs in memory, so the
journal resets on restart.

## Deployment

One service, one domain. The same Node process serves the landing page (`/`), the app
(`/app`) and the API, so there is no second origin, no CORS and no proxy layer.

```
Vercel     serverless        landing + app + API
Supabase   free project      users + journal          (recommended on Vercel)
Telegram   login only        no messages are sent     (optional)
```

`server.js` runs two ways from the same code: locally it starts a real, always-on
`http.createServer` (`node server.js`); on Vercel, `api/index.js` re-exports the same
request handler as a serverless function, and `vercel.json` rewrites every path — `/`,
`/app`, `/api/*` — to it, so the whole app stays on one origin (which Telegram's login
requires) without a second service or a proxy layer.

**The tradeoff of serverless is state.** A serverless function has no persistent memory
between requests — a different one (or a fresh cold start) can serve the next call.
Concretely, on Vercel:

- **Signed-in journals are unaffected** — they live in Supabase, not in the function.
- **Anonymous journals** (no Supabase configured) fall back to in-memory storage, which
  on Vercel is unreliable across requests — entries can appear to vanish. Set `SUPA_URL`
  / `SUPA_KEY` if you want the journal to actually work for visitors who don't sign in.
- **The 7-day history and verdict badges stop accumulating** past the seeded seed data —
  each cold start resets to the shipped snapshot rather than recording a new one. The
  scanner, deep dive and every other panel are unaffected; only the "keeps measuring
  while it runs" line in the Data section below doesn't hold on Vercel the way it does
  on a persistent server.
- **The scan cache is best-effort, not guaranteed** — a `/api/scan` request may land on
  a cold instance and re-run the full 7-venue fetch (~5s) instead of hitting a warm
  60-second cache. Slower under load, never broken.

None of this needs any setup to deploy — `vercel deploy` or connecting the repo on
[vercel.com](https://vercel.com) works with zero configuration. Every environment
variable below is optional and the server degrades cleanly without them, which is also
what makes `git clone && npm start` work locally with zero setup.

| Variable | Effect when unset |
|---|---|
| `SUPA_URL`, `SUPA_KEY` | journal falls back to memory (unreliable on Vercel, fine locally) |
| `TG_BOT_TOKEN`, `TG_BOT_NAME` | no sign-in button; the app is fully usable anonymously |
| `SESSION_SECRET` | random per boot — on Vercel, set this explicitly, or every cold start invalidates existing sessions |

For persistence, run [`schema.sql`](schema.sql) once in the Supabase SQL editor.

`render.yaml` is also in the repo: a persistent Node server has none of the tradeoffs
above, at the cost of a real server to run. It works standalone if you'd rather use it.

### Telegram sign-in

Telegram has no separate identity provider: **the bot is the application registration**,
the way an OAuth client ID is elsewhere, and its token is the secret used to verify the
signature Telegram puts on the login payload. This bot never sends or receives a message.

1. Create a bot in [@BotFather](https://t.me/BotFather) — use a **separate** bot, not one
   already wired to something else, since its token has to live in the server environment.
2. `/setdomain` → the domain the app is served from. Telegram accepts exactly one per bot,
   which is the other reason everything sits behind a single origin.
3. Set `TG_BOT_TOKEN` and `TG_BOT_NAME` as environment variables on Vercel.

Verification follows Telegram's documented scheme — HMAC-SHA256 over the sorted fields,
keyed by `SHA256(bot_token)`, with a 24-hour freshness check on `auth_date` so an
intercepted login URL cannot be replayed forever. The session is a signed cookie rather
than server-side state, so a restart does not sign anyone out.

Signed-in users get their own journal. Anonymous visitors can still use every panel; their
entries live in server memory and disappear on restart.

## Scope

This is a public demo built from a private system that trades real capital. Position tracking,
alerting and the live trade journal are not part of this repository; the wallet field is inert
and the journal starts empty. Everything here is public market data.

Advisory only. Not financial advice.
