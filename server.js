// ── HEDGE LAB v2 — egyesített dashboard + multi-venue szkenner ───────────────
// A dashboard.py TELJES felülete (KPI + kártyák, ahogy megszoktad) Node-ra portolva,
// ALATTA a hedge_lab.js 4-venue szkennere — egy görgethető oldal.
// Futtatás: node hedge_lab_v2.js   →   http://localhost:8879   (HEDGE_LAB_V2.bat)
//
// Újdonságok a régi dashboardhoz képest:
//   • funding-countdown VALÓDI intervallummal, eszközönként (Vari API funding_interval_s:
//     crypto 4h / részvény 8h; Ethereal 1h) — mindkét lábra
//   • alatta a teljes 4-venue szkenner (Vari+Ethereal+Nado+Lighter) + Vari+Nado + Verseny
// Állapot: hedge_config.json + hedge_naplo.json (KÜLÖN fájlok — a régi
// config.json/naplo.json ÉRINTETLEN; a napló első indításkor a naplo.json-ból seedel).

const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 8879

// ── DEMO-TÁROLÁS ──────────────────────────────────────────────────
// Az éles rendszer lemezre (illetve Supabase-be) ír. A demo mindent MEMÓRIÁBAN tart:
// nincs mit kiszívárogtatni, és minden újraindítás tiszta lappal indul. A látogató
// szabadon átállíthatja a beállításokat és naplózhat — a következő indulásnál eltűnik.
//
// KÉT ÜZEMMÓD, ugyanazzal a kóddal:
//   • Supabase-kulcsok nélkül  → minden memóriában, a napló újraindításkor ürül.
//     Így fut lokálisan `node server.js`-szel, nulla konfigurációval.
//   • Kulcsokkal               → a napló felhasználónként a Supabase-ben él.
// A fallback nem kényelmi kérdés: enélkül a repót klónozó bárki egy hibaüzenetbe
// futna bele az első indításnál.
const SUPA_URL = process.env.SUPA_URL || ''
const SUPA_KEY = process.env.SUPA_KEY || ''
const SUPA_ON = !!(SUPA_URL && SUPA_KEY)

let _cfg = null            // config — MINDIG memóriában (nézőnként külön, nem közös)
let _naplo = []            // napló — csak a memória-módban használt

// Supabase REST. Külön kliens-könyvtár nélkül: három végpont kell összesen.
async function supa(pathq, opts = {}) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${pathq}`, {
    ...opts,
    headers: {
      apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  })
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.status === 204 ? null : r.json()
}

// ── TELEGRAM LOGIN ────────────────────────────────────────────────
// A Telegramnál nincs külön "login szolgáltató": a BOT MAGA az alkalmazás
// azonosítója (mint máshol az OAuth client ID), a tokenje pedig a titkos kulcs,
// amivel a Telegram aláírja a bejelentkezési adatot. A bot soha nem küld üzenetet.
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || ''
const TG_BOT_NAME = process.env.TG_BOT_NAME || ''
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
const AUTH_ON = !!(TG_BOT_TOKEN && TG_BOT_NAME)

// A Telegram dokumentált ellenőrzése: a mezőkből kulcs szerint rendezett
// "k=v" sorok, HMAC-SHA256-tal, SHA256(bot_token) kulccsal. Ha ez egyezik a
// kapott hash-sel, az adat tényleg a Telegramtól jött és nem lett hamisítva.
function tgVerify(data) {
  if (!TG_BOT_TOKEN || !data || !data.hash) return null
  const secret = crypto.createHash('sha256').update(TG_BOT_TOKEN).digest()
  const check = Object.keys(data).filter((k) => k !== 'hash').sort()
    .map((k) => `${k}=${data[k]}`).join(String.fromCharCode(10))
  const hmac = crypto.createHmac('sha256', secret).update(check).digest('hex')
  const a = Buffer.from(hmac), b = Buffer.from(String(data.hash))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  // Lejárt aláírás: egy elcsípett login-URL ne legyen örökre újrajátszható.
  if (Math.abs(Date.now() / 1000 - Number(data.auth_date)) > 86400) return null
  return { id: String(data.id), username: data.username || '', first_name: data.first_name || '' }
}
// Session: aláírt süti, nem tárolt session-azonosító. Nincs mit lejáratni
// szerveroldalon, és a Render újraindulása sem lépteti ki a felhasználót.
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url')
  return `${body}.${mac}`
}
function unsign(tok) {
  if (!tok || !tok.includes('.')) return null
  const [body, mac] = tok.split('.')
  const exp = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url')
  const a = Buffer.from(mac), b = Buffer.from(exp)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()) } catch { return null }
}
function currentUser(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim())
    .find((c) => c.startsWith('hl_session='))
  return raw ? unsign(decodeURIComponent(raw.slice('hl_session='.length))) : null
}

// ── config (a dashboard.py sémája; alap a config.json aktuális értékeiből) ──
const CFG_DEFAULT = {
  capital_variational_usd: 1000, capital_meridian_usd: 1000, margin_per_leg_usd: 500,
  leverage: 3, mode: 'same', same_asset: 'BTC',
  active_config: null, entry_price_asset: null, same_short_on: null, entry_gap: null,
  entry_price_btc: null, entry_price_eth: null, beep_on_flip: true,
  same_va: 'Variational', same_vb: 'Aster',   // same-asset kereszt két platformja (választható)
  fund_acc: null,   // { platform: {usd, last, ticks} } — a nyitott kör óta gyűlt funding
  wallet: '',   // publikus tárcacím — ebből olvassuk ki a VALÓDI pozíciókat (csak olvasás)
}
// platform-megjelenítőnév → lastVenues kulcs
const VMAP = { Variational: 'Vari', Ethereal: 'Ethereal', Nado: 'Nado', Lighter: 'Lighter', Aster: 'Aster', edgeX: 'EdgeX', Phoenix: 'Phoenix', 'Lighter-RH': 'RhLighter' }
// Ami itt nincs benne, azt a pozíció-panelen nem lehet kiválasztani — hiába látszik a
// szkennerben. Az Aster és az edgeX ennél fogva három napig úgy szerepelt a táblákban,
// hogy beállítani nem lehetett rájuk keresztet: aki RARE-t vagy COW-ot próbált, anál
// az úrlap némán visszaesett Vari+Ethereal-ra. Új venue esetén EZT is bővítsd.
const VENUE_OPTS = ['Variational', 'Ethereal', 'Nado', 'Lighter', 'Lighter-RH', 'Aster', 'edgeX', 'Phoenix']
function loadCfg() { return { ...CFG_DEFAULT, ...(_cfg || {}) } }
function saveCfg(c) { _cfg = c }
// A napló mindig EGY felhasználóé. Ha az auth élesben van (AUTH_ON), bejelentkezés
// KÖTELEZŐ hozzá — nincs megosztott anonim napló, mert az egyszerre két hibát vinne
// be: idegenek látnák egymás bejegyzéseit, és Vercelen a memóriás tárolás egyébként
// sem megbízható kérések között. A memóriás fallback KIZÁRÓLAG akkor él, ha auth
// egyáltalán nincs beállítva (`node server.js` kulcsok nélkül, helyi próbához) —
// akkor uid mindig null, tehát egyetlen közös munkamenet van, nem több felhasználóé.
async function naploList(uid) {
  if (!AUTH_ON) return _naplo
  if (!uid) return []
  if (!SUPA_ON) return []   // auth be van kapcsolva, de nincs hova írni — inkább üres, mint megosztott
  const rows = await supa(`journal?telegram_id=eq.${uid}&order=id.asc&select=*`)
  return rows.map(fromRow)
}
async function naploAdd(uid, entry) {
  if (!AUTH_ON) { _naplo.push(entry); return entry }
  if (!uid || !SUPA_ON) return null
  const [row] = await supa('journal', { method: 'POST', body: JSON.stringify(toRow(uid, entry)) })
  return fromRow(row)
}
async function naploDelete(uid, id) {
  if (!AUTH_ON) {
    const i = +id
    if (Number.isInteger(i) && i >= 0 && i < _naplo.length) _naplo.splice(i, 1)
    return
  }
  if (!uid || !SUPA_ON) return
  await supa(`journal?telegram_id=eq.${uid}&id=eq.${id}`, { method: 'DELETE' })
}
// A kliens `date`-et és `id`-t vár; a tábla `created_at`-ot ad.
const toRow = (uid, e) => ({ telegram_id: uid, pnl: e.pnl, note: e.note, kind: e.kind })
const fromRow = (r) => ({
  id: r.id, kind: r.kind, pnl: r.pnl, note: r.note || '',
  date: String(r.created_at || '').slice(0, 16).replace('T', ' '),
})

// ── funding-history (közös a v1-gyel) ──
// A demo egy VALÓDI, 2026-08-16 óta gyűlt méréssel indul (99 óránkénti pillanatkép,
// ~700 pár). Ennélkül a 7d spr oszlop, az Ítélet-jelvények és a chartok napokig üresen
// állnának. A seed CSAK piaci adat: funding-ráta és ár venue-nként.
let labHist = []
try {
  labHist = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'labhist-seed.json'), 'utf8')).rows || []
  console.log(`⚙ seed: ${labHist.length} pillanatkép`)
} catch (e) { console.error('seed hiányzik:', e.message) }
function recordSnapshot(vari, eth, nado, lighter, phoenix, aster, edgex, rhlighter) {
  const hour = new Date().toISOString().slice(0, 13)
  if (labHist.length && labHist[labHist.length - 1].hour === hour) return
  const d = {}
  const put = (sym, key, val) => { if (val == null) return; (d[sym] = d[sym] || {})[key] = +val.toFixed(4) }
  // Az ÁR is bekerül (pv/pl), nem csak a funding. Két kérdést enged eldönteni, amit
  // eddig csak szemre néztünk: (1) hogyan alakul a Vari↔Lighter ár-rés — ez az a tétel,
  // amit a napló hetekig "bázis-elcsúszásnak" könyvelt, és 2026-08-10-én 0,42%-ról
  // 2,49%-ra nyílt egy nap alatt; (2) van-e rendszeres ármozgás a Vari 4h/8h snapshot
  // körül (a tick előtt a short zárása = vétel, utána a longok kiszállása = eladás).
  // 6 tizedes, mert a sub-dolláros altokon a 4. már elnyelné a százalékos elmozdulást.
  // Number()-rel kényszerítünk: a Lighter last_trade_price stringként is jöhet.
  const putP = (sym, key, val) => { const n = Number(val); if (!isFinite(n) || n <= 0) return; (d[sym] = d[sym] || {})[key] = +n.toFixed(6) }
  for (const [s, x] of Object.entries(vari)) if (x.vol !== 0) { put(s, 'v', x.apr); putP(s, 'pv', x.price) }
  for (const [s, x] of Object.entries(eth)) if (x.vol !== 0) put(s, 'e', x.apr)
  for (const [s, x] of Object.entries(nado)) if (x.vol !== 0) put(s, 'n', x.apr)
  for (const [s, x] of Object.entries(lighter)) if (x.vol !== 0) { put(s, 'l', x.apr); putP(s, 'pl', x.price) }
  for (const [s, x] of Object.entries(phoenix || {})) { put(s, 'x', x.apr); putP(s, 'px', x.price) }
  for (const [s, x] of Object.entries(aster || {})) { put(s, 'a', x.apr); putP(s, 'pa', x.price) }
  for (const [s, x] of Object.entries(edgex || {})) { put(s, 'g', x.apr); putP(s, 'pg', x.price) }
  for (const [s, x] of Object.entries(rhlighter || {})) { put(s, 'r', x.apr); putP(s, 'pr', x.price) }
  const sor = { hour, ts: Date.now(), d }
  labHist.push(sor)
  // A demo 30 napig tart meg — hosszabb sor, olvashatóbb chart, korlátos memória.
  labHist = labHist.filter((r) => r.ts >= Date.now() - 30 * 86400e3)
}
// ── ÁR-RÉS (a „rés") ──────────────────────────────────────────────────────────
// A funding-Spread és az ár-rés KÉT KÜLÖN dolog, és eddig csak az elsőt mutattuk.
// A rés = (variÁr − másikÁr) / másikÁr. Egy delta-semleges kör ár-PnL-je pontosan
// ennek a VÁLTOZÁSA: LONG Vari / SHORT másik akkor nyer, ha a rés tágul, és akkor
// veszít, ha szűkül. 2026-08-10-én ez élesben kétszer is látszott ugyanazon a napon:
// a szűkülő résen a SHORT Vari / LONG Lighter kör +$26,03-at hozott, a fordított
// állás egy órával később −$3,98-at — pedig a $29,31-es tick MINDKETTŐBEN megvolt.
// Ezért kap saját oszlopot: ez dönti el, melyik irányba érdemes nyitni.
// ── MAX TÉT (tőkeáttétel) ─────────────────────────────────
// Mind a hat venue máshogy fejezi ki ugyanazt, ezért egy helyen fordítjuk "x"-re.
// Miért kell egyáltalán: a delta-semleges lábat a SZŰKEBB oldal köti meg, és a
// tőzsde a tőkeáttétel-plafonnal lényegében a könyv vékonyságát üzeni. Ahol 3-5x
// a plafon, ott a rés is nagyot lép — épp az, ami a hasznot elviszi.
// A Variational NEM adja meg publikusan (RFQ: a market maker árazza a kockázatot,
// nincs közös könyv, amihez sávozni kellene) — ott marad a "—". Ez a gyakorlatban
// nem hiány: a Vari mindenre 20-50x, tehát sosem ő a szűkebb láb.
const levFromMarginPct = (p) => { const v = parseFloat(p); return v > 0 ? Math.round(100 / v) : null }
const levFromFraction  = (f) => { const v = parseFloat(f); return v > 0 ? Math.round(10000 / v) : null }
const levFromWeight    = (w) => { const v = parseFloat(w) / 1e18; return v > 0 && v < 1 ? Math.round(1 / (1 - v)) : null }

// ── EGYIRÁNY: húzza-e a rés ugyanarra, amerre a funding? ───────────────────
// A szabály, ami 2026-08-15-én élesben szétválasztotta a jó párt a rosszól:
//
//     JÓ, ha a funding szerint a DRÁGÁBB lábat kell shortolni.
//
// Ha egy perp drágább IS és negatívabb a fundingja IS, mindkettő ugyanazt mondja:
// túl sok ott a long, korrigálni fog. Ilyenkor a szűkülő résen nyersz, és közben
// kapod a fundingot — a két erő összeadódik (ACE: rés 1,11%→0,67%, funding +$2,38/óra).
// Ha szétválnak, versenyfutás lesz: a COW-n a funding +$27/órát hozott, de egy teljes
// rés-összezárás −$147 lett volna — 5,4 órát kellett volna kibírni, hogy megérje.
//
// gap = (variAr − masikAr) / masikAr, tehát gap > 0 ⇒ a Vari a drágább.
function gapAligned(gap, shortVenue) {
  if (gap == null || gap === 0) return null
  return (gap > 0) === (shortVenue === 'Vari')
}

function priceGap(a, b) {
  if (!a || !b || !(a > 0) || !(b > 0)) return null
  return (a - b) / b
}
const NAPLO_KINDS = ['scalp', 'hedge', 'hiba']
const VKEY = { Vari: 'v', Ethereal: 'e', Nado: 'n', Lighter: 'l', Phoenix: 'x', Aster: 'a', EdgeX: 'g', RhLighter: 'r' }
function pairHistory(sym, shortV, longV, curDiff) {
  const ks = VKEY[shortV], kl = VKEY[longV]
  const diffs = []
  for (const row of labHist) { const x = row.d[sym]; if (x && x[ks] != null && x[kl] != null) diffs.push(x[ks] - x[kl]) }
  if (!diffs.length) return { ageH: null, capped: false, avg7d: null }
  const avg7d = diffs.reduce((a, b) => a + b, 0) / diffs.length
  let ageH = null
  if (Math.abs(curDiff) >= 0.10) {
    ageH = 0
    for (let i = diffs.length - 1; i >= 0; i--) { if (Math.abs(diffs[i]) >= 0.10 && Math.sign(diffs[i]) === Math.sign(curDiff)) ageH++; else break }
  }
  return { ageH, capped: ageH != null && ageH === diffs.length, avg7d }
}
// Vari spread mindig a legpontosabb elérhető forrásból: élő könyv @ $1k (spread1k), csak ha nincs,
// akkor esik vissza a kiírt nominális base_spread_bps-re (sb).
function variSpreadFrac(vv) { return vv?.spread1k ?? (vv?.sb != null ? vv.sb / 1e4 : null) }
function legRoundTripCost(venue, variSpreadFracVal) {
  if (venue === 'Lighter' || venue === 'Ethereal' || venue === 'RhLighter') return 0
  if (venue === 'Nado') return 0.0002
  // Phoenix: maker 0,5 bp, taker 3,5 bp. Limittel nyit+zár = 2 × 0,5 bp. Ez NEM nulla,
  // de a mért könyv-hatás is kicsi ($3 000 SPCX-re 0,046%), szemben a Lighterrel, ahol
  // a 0 fee mellé bejött a fél százalékos becsapódás.
  if (venue === 'Phoenix') return 0.0001
  // Aster: maker 0,01% (a részvény-perpeken 0), taker 0,035%. Limittel nyit+zár = 2×1 bp.
  if (venue === 'Aster') return 0.0002
  // edgeX: VIP nélkül maker 0,012%, taker 0,038%. Limittel nyit+zár = 2×1,2 bp.
  if (venue === 'EdgeX') return 0.00024
  if (venue === 'Vari') return variSpreadFracVal != null ? variSpreadFracVal : 6 / 1e4
  return 0
}
const RWA_SET = new Set(['TSLA','GOOGL','GOOG','AAPL','MSFT','META','NVDA','MU','INTC','SNDK','AMD','COIN','HOOD','MSTR','CRCL','NBIS','QQQ','SPY','SPX','SPCX','SP500','TSM','ASML','AVGO','QCOM','MRVL','DELL','IBM','ARM','SMH','WDC','RKLB','EWY','EWJ','SOXL','DRAM','GME','NFLX','COST','LLY','ORCL','AMZN','BABA','RIVN','BX','ZM','EBAY','CBRS','STRC','NDX','KR200','JP225','NIFTY','IBOV','XAUT','XAU','GOLD','XAG','SILVER','PLATINUM','PALLADIUM','COPPER','ALUMINIUM','URANIUM','URNM','NATGAS','BRENTOIL','CL','WHEAT','CORN','VIX','DXY','EUR','GBP','JPY','KRW','EURUSD','AUDUSD','XLE','TTF','QNT'])
const MAJOR_SET = new Set(['BTC','ETH','SOL','BNB','XRP'])
function category(sym) { return RWA_SET.has(sym) ? 'RWA' : MAJOR_SET.has(sym) ? 'major' : 'alt' }
function pointMult(cat) { return cat === 'major' ? 7 : cat === 'RWA' ? 25 : 22 }

const VARI = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats'
const ETH_BASE = 'https://api.ethereal.trade/v1'
const NADO_GW = 'https://gateway.prod.nado.xyz/v1'
const NADO_ARCH = 'https://archive.prod.nado.xyz/v1'
const LIGHTER = 'https://mainnet.zklighter.elliot.ai/api/v1'
const RHLIGHTER = 'https://api.rh.lighter.xyz/api/v1'
const PHOENIX = 'https://perp-api.phoenix.trade/v1'
const ASTER = 'https://fapi.asterdex.com/fapi/v1'
const EDGEX = 'https://edgex-prod-v2.edgex.exchange/api/v2/public'
const HL = 'https://api.hyperliquid.xyz/info'
const THIN_VOL_USD = 10000

let lastVariIv = {}   // { SYM: seconds }  — valódi Vari tick-intervallum
function variIvS(sym) { return lastVariIv[sym] || 14400 }   // fallback 4h
// Egy platform funding-tick intervalluma egy eszközre, másodpercben.
// A Variational eszközönként más (kriptó 4h, RWA 8h), az Aster szintén eszközönként
// (1h/2h/4h/8h), az edgeX 4h — ezeket a saját adatukból vesszük. A többi 1h.
// Ha ez téved, a visszaszámláló és a „köv. tick $” is téved — az meg a tick-fogás alapja.
function venueIvForAsset(disp, sym) {
  if (disp === 'Variational') return variIvS(sym)
  const x = lastVenues && lastVenues[VMAP[disp]] && lastVenues[VMAP[disp]][sym]
  if (x && x.ivH > 0) return x.ivH * 3600
  return 3600
}
// egy platform élő adata egy szimbólumra ({apr, price, lot_size, min_qty}) vagy null
function venueData(disp, sym) { const k = VMAP[disp]; const x = lastVenues && lastVenues[k] && lastVenues[k][sym]; return x ? { apr: x.apr ?? null, price: x.price ?? null, lot_size: x.lot_size ?? 0, min_qty: x.min_qty ?? 0, maxLev: x.maxLev ?? null } : null }

async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(`${url.slice(0, 60)} → HTTP ${r.status}`); return r.json() }
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function fetchVariational() {
  const d = await j(VARI)
  const out = {}
  for (const l of d.listings) {
    const q = l.quotes?.size_1k
    out[l.ticker] = {
      apr: parseFloat(l.funding_rate), price: parseFloat(l.mark_price), vol: parseFloat(l.volume_24h) || 0,
      sb: parseFloat(l.base_spread_bps) || null, spread1k: q ? (q.ask - q.bid) / q.ask : null,
      ivS: l.funding_interval_s != null ? parseFloat(l.funding_interval_s) : null,
    }
  }
  return out
}
async function fetchEthereal() {
  const d = await j(`${ETH_BASE}/product`)
  const out = {}
  for (const p of d.data) out[p.baseTokenName] = {
    apr: parseFloat(p.fundingRate1h) * 24 * 365, vol_base: parseFloat(p.volume24h) || 0,
    lot_size: parseFloat(p.lotSize) || 0, min_qty: parseFloat(p.minQuantity) || 0,
    taker_fee: parseFloat(p.takerFee) || 0, ticker: p.ticker, max_lev: p.maxLeverage,
    maxLev: +p.maxLeverage || null,
  }
  return out
}
// ── élő pozíció-tükör ───────────────────────────────────────────────────────
// A tárcacím alapján kiolvassuk a VALÓDI nyitott pozíciókat, hogy kiderüljön, ha a
// rögzített állapot (Nyitottam/Zártam gomb) elcsúszott a valóságtól — pontosan az a
// hiba, ami az SPCX-körnél megtörtént. CSAK OLVASÁS: a configot soha nem írja felül,
// mert egy hibás vagy üres API-válasz kitörölné a belépő árat, és a drift-számítás
// végleg elveszne. Ha bármi hibázik, a panel egyszerűen nem jelenik meg.
// A Variational NEM ad nyilvános számla-végpontot — az a láb nem ellenőrizhető.
let nadoSymByProduct = {}
let lastLivePos = null
const NADO_SUB_SUFFIX = '64656661756c740000000000'   // "default" alszámla-név, 12 bájtra töltve

async function nadoPositions(wallet) {
  const sub = wallet.toLowerCase() + NADO_SUB_SUFFIX
  const d = await j(`${NADO_GW}/query?type=subaccount_info&subaccount=${sub}`)
  const out = []
  for (const p of d.data?.perp_balances || []) {
    const qty = Number(p.balance?.amount || 0) / 1e18
    if (Math.abs(qty) < 1e-9) continue
    out.push({ sym: nadoSymByProduct[p.product_id] || ('#' + p.product_id), qty, side: qty > 0 ? 'LONG' : 'SHORT' })
  }
  return out
}

async function lighterPositions(wallet) {
  const a = await j(`${LIGHTER}/accountsByL1Address?l1_address=${wallet}`)
  const idx = a.sub_accounts?.[0]?.index
  if (idx == null) return []
  const d = await j(`${LIGHTER}/account?by=index&value=${idx}`)
  const out = []
  for (const p of d.accounts?.[0]?.positions || []) {
    const qty = parseFloat(p.position || 0)
    if (!qty) continue
    const signed = (p.sign === -1 || p.sign === 0) ? -qty : qty
    out.push({ sym: p.symbol, qty: signed, side: signed > 0 ? 'LONG' : 'SHORT',
      entry: parseFloat(p.avg_entry_price) || null, upnl: parseFloat(p.unrealized_pnl) || null })
  }
  return out
}

// Platformonként külön try/catch: az egyik kiesése ne vigye el a másikat.
async function fetchLivePositions(wallet) {
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return null
  const venues = {}, errors = []
  await Promise.all([
    nadoPositions(wallet).then((r) => { venues.Nado = r }).catch((e) => errors.push('Nado: ' + e.message)),
    lighterPositions(wallet).then((r) => { venues.Lighter = r }).catch((e) => errors.push('Lighter: ' + e.message)),
  ])
  if (!Object.keys(venues).length) return null
  return { at: Date.now(), venues, errors }
}

async function fetchNado() {
  const sy = await j(`${NADO_GW}/query?type=symbols`)
  const perps = Object.values(sy.data.symbols).filter((s) => s.type === 'perp' && s.trading_status === 'live')
  const ids = perps.map((p) => p.product_id)
  const [fr, snap] = await Promise.all([
    post(NADO_ARCH, { funding_rates: { product_ids: ids } }),
    post(NADO_ARCH, { market_snapshots: { interval: { count: 2, granularity: 86400 }, product_ids: ids } }),
  ])
  const [now, prev] = snap.snapshots
  const out = {}
  nadoSymByProduct = {}
  for (const p of perps) nadoSymByProduct[p.product_id] = p.symbol.replace(/-PERP$/, '')
  for (const p of perps) {
    const f = fr[p.product_id]; if (!f) continue
    const cv = now?.cumulative_volumes?.[p.product_id], pv = prev?.cumulative_volumes?.[p.product_id]
    out[p.symbol.replace(/-PERP$/, '')] = {
      apr: (parseFloat(f.funding_rate_x18) / 1e18) * 365,
      vol: cv != null && pv != null ? (parseFloat(cv) - parseFloat(pv)) / 1e18 : null,
      price: now?.oracle_prices?.[p.product_id] != null ? parseFloat(now.oracle_prices[p.product_id]) / 1e18 : null,
      // Vertex-stílusú kockázati súly: a kezdeti fedezet 1 − long_weight_initial.
      maxLev: levFromWeight(p.long_weight_initial_x18),
    }
  }
  return out
}
async function fetchLighter() {
  // Az orderBookDetails csak a tőkeáttétel-plafon miatt kell: a min_initial_margin_fraction
  // tízezrelékben adja a kezdeti fedezetet (KAITO 2000 = 20% = 5x, BTC 200 = 2% = 50x).
  // Ez az a szám, ami miatt a jó párok nagy része használhatatlan volt — lásd a
  // "Max tét" oszlopot. Nem dobhat: ha kiesik, csak a plafon marad ismeretlen.
  const [d, stats, det] = await Promise.all([
    j(`${LIGHTER}/funding-rates`), j(`${LIGHTER}/exchangeStats`),
    j(`${LIGHTER}/orderBookDetails`).catch(() => null),
  ])
  const volBySym = {}
  for (const s of stats.order_book_stats) volBySym[s.symbol] = { vol: s.daily_quote_token_volume, price: s.last_trade_price }
  const levBySym = {}
  for (const b of det?.order_book_details || []) levBySym[b.symbol] = levFromFraction(b.min_initial_margin_fraction)
  const out = { lighter: {}, hyperliquid: {}, binance: {}, bybit: {} }
  for (const r of d.funding_rates) {
    if (!out[r.exchange]) continue
    const e = { apr: r.rate * 3 * 365 }
    if (r.exchange === 'lighter') {
      e.vol = volBySym[r.symbol]?.vol ?? null; e.price = volBySym[r.symbol]?.price ?? null
      e.maxLev = levBySym[r.symbol] ?? null
    }
    out[r.exchange][r.symbol] = e
  }
  return out
}

// legutóbbi nyers venue-adat (a dashboard payload + pozíció élő számításához)
// Lighter a Robinhood Chainen — KÜLÖN tőzsde, nem a régi Lighter egy füle.
// Miért kell külön venue-ként:
//   • A régi (zkLighter, Ethereum) pontprogramja a Season 2-vel 2025 decéberében lezárult.
//     Az EGYETLEN élő Lighter-pontprogram ezen a láncon fut (2026-08-10 óta, 11M LIT,
//     pénteki kiosztás), Robinhood Walletből 2×. Magyarország nincs a tiltólistán.
//   • Más a piac-összetétel: 66 piac, majorok és részvények, nem vékony altok. Ezért a
//     rések 0,03-0,2% körül vannak (a régi láncon a KAITO-nál 1,46% volt), és a
//     tőkeáttétel 10-50x a régi 3-5x helyett ugyanazokon a párokon.
// Az API sémája azonos a régiével, csak a cím más (api.rh.lighter.xyz).
async function fetchRhLighter() {
  const [d, stats, det] = await Promise.all([
    j(`${RHLIGHTER}/funding-rates`), j(`${RHLIGHTER}/exchangeStats`),
    j(`${RHLIGHTER}/orderBookDetails`).catch(() => null),
  ])
  const volBySym = {}
  for (const s of stats.order_book_stats) volBySym[s.symbol] = { vol: s.daily_quote_token_volume, price: s.last_trade_price }
  const levBySym = {}
  for (const b of det?.order_book_details || []) levBySym[b.symbol] = levFromFraction(b.min_initial_margin_fraction)
  const out = {}
  for (const r of d.funding_rates) {
    if (r.exchange !== 'lighter') continue
    const v = volBySym[r.symbol]
    out[r.symbol] = {
      apr: r.rate * 3 * 365,
      vol: v?.vol ?? null, price: v?.price ?? null,
      maxLev: levBySym[r.symbol] ?? null,
    }
  }
  return out
}

// Phoenix (Solana, Ellipsis Labs) — a Lighter lehetséges váltótársa a Vari mellé.
// KÉT dolgot érdemes tudni róla, mielőtt bárki hozzányúl:
//
// 1) A fundingRate mezőt NE a fundingAmountPerUnit/markPrice arányból vezesd le. Az
//    piaconként más decimális skálán jön (BTC-n 10 000×, AAPL-en 100× az arány), tehát
//    100-szoros hibát ad. A helyes szorzó Hyperliquid-referencián mérve: fundingRate ×
//    87,6 = %/év, azaz × 0,876 a labor tizedes-tört egységében (Phoenix ETH 8,9% vs
//    HL 8,8%, BTC 8,2% vs 11%). Óránként tickel, naponta egyszer számolódik el.
// 2) Volumen helyett NYITOTT KÖTÉST (OI) adunk vissza `vol`-ként. Nincs 24h volumen a
//    publikus API-ban — de a Lighter-tanulság után az OI amúgy is jobb mérce: a forgalom
//    nem mélység (KAITO $5,48M/nap mellett $57 a legjobb bidnél). A Flight Club is a
//    tartott OI-t fizeti, tehát ez a szám kétszeresen releváns.
const PHX_APR = 0.876
async function fetchPhoenix() {
  const [f, m] = await Promise.all([j(`${PHOENIX}/funding/overview`), j(`${PHOENIX}/view/markets`)])
  const oiBase = {}, phxLev = {}
  for (const mk of m.markets || []) {
    const o = mk.openInterest
    if (o && o.value != null) oiBase[mk.symbol] = +o.value / Math.pow(10, o.decimals || 0)
    phxLev[mk.symbol] = +(mk.leverageTiers?.[0]?.maxLeverage) || null
  }
  const out = {}
  for (const s of f.series || []) {
    const pts = s.points
    if (!pts || !pts.length) continue
    const last = pts[pts.length - 1]
    const price = +last.markPrice
    if (!isFinite(price) || price <= 0) continue
    const oiUsd = oiBase[s.symbol] != null ? oiBase[s.symbol] * price : null
    out[s.symbol] = { apr: +last.fundingRate * PHX_APR, price, oi: oiUsd, vol: oiUsd, maxLev: phxLev[s.symbol] ?? null }
  }
  return out
}

// A két új venue szimbólumai tőzsdepárként jönnek (BTCUSDT, BTCUSDC), a labor
// viszont csupasz tickerrel dolgozik (BTC), mert a Vari is úgy adja. Csak a végződést
// vágjuk le — a "1000PEPE" típusú előtagot NEM, mert az más szerződés, mint a PEPE.
const bareSym = (s) => s.replace(/(USDT|USDC|USD1|USD)$/, '')

// Aster (BNB Chain, Binance-kompatibilis API). Három dolog, amit tudni kell:
//
// 1) A funding-intervallum SZIMBÓLUMONKÉNT MÁS — 1h, 2h, 4h vagy 8h. Ha ezt elnézed,
//    nyolcszoros APR-hibát kapsz. Szerencsére a /fundingInfo egyetlen hívásban kiadja
//    mindet (fundingIntervalHours), tehát nem kell szimbólumonként historyt kérni.
// 2) Ugyanarra az eszközre több szerződés is fut (BTCUSDT és BTCUSD). A BTCUSD
//    coin-margined, a fundingja 0 és 2h-s — ha az nyer a normalizálásnál, néma nullát
//    kapsz. Ezért a USDT-jegyzésű, TRADING státuszú perp élvez elsőbbséget.
// 3) A maker fee 0,01% (a részvény-perpeken 0). Nem nulla, mint a Lighteren, de a
//    nagyságrendje ugyanaz, mint a Nadóé.
async function fetchAster() {
  const [prem, info, tick, ex] = await Promise.all([
    j(`${ASTER}/premiumIndex`), j(`${ASTER}/fundingInfo`),
    j(`${ASTER}/ticker/24hr`), j(`${ASTER}/exchangeInfo`),
  ])
  const ivH = {}
  for (const f of info) ivH[f.symbol] = +f.fundingIntervalHours || 8
  const volBy = {}
  for (const t of tick) volBy[t.symbol] = +t.quoteVolume || 0
  // csak élő, USDT-jegyzésű, örökjáradék szerződések
  const ok = new Set(), lev = {}
  for (const sy of ex.symbols || []) {
    if (sy.status === 'TRADING' && sy.contractType === 'PERPETUAL' && sy.quoteAsset === 'USDT') {
      ok.add(sy.symbol); lev[sy.symbol] = levFromMarginPct(sy.requiredMarginPercent)
    }
  }
  const out = {}
  for (const r of prem) {
    if (!ok.has(r.symbol)) continue
    const s = bareSym(r.symbol)
    const iv = ivH[r.symbol] || 8
    const price = +r.markPrice
    if (!isFinite(price) || price <= 0) continue
    out[s] = {
      apr: +r.lastFundingRate * (24 / iv) * 365,
      price, vol: volBy[r.symbol] ?? 0, ivH: iv, next: +r.nextFundingTime || null,
      maxLev: lev[r.symbol] ?? null,
    }
  }
  return out
}

// edgeX (saját L2). A ticker egyetlen hívásban adja a fundingot, az árat, a napi
// forgalmat ÉS a nyitott kötést — viszont contractId-nként külön kell kérni, tömeges
// végpont nincs (a vesszős lista üres tömböt ad vissza). Ezért:
//   • a szerződés-metaadatot egy órára cache-eljük (ritkán változik),
//   • tickert csak arra kérünk, ami a Varival is közös (~100 pár, nem 151),
//   • korlátozott párhuzamossággal, hogy a 90 mp-es szken-ciklusba beférjen.
// A maxLev a riskTierList első (legkisebb pozíció-méret) sávjából jön: ez az, amit
// egy $1-3 ezres lábbal ténylegesen megkapsz.
let _edgexMeta = null, _edgexMetaAt = 0
async function edgexMeta() {
  if (_edgexMeta && Date.now() - _edgexMetaAt < 3600e3) return _edgexMeta
  const d = await j(`${EDGEX}/meta/getMetaData`)
  const m = new Map()
  for (const c of d.data?.contractList || []) {
    m.set(bareSym(c.contractName), { id: c.contractId, maxLev: +(c.riskTierList?.[0]?.maxLeverage) || null })
  }
  _edgexMeta = m; _edgexMetaAt = Date.now()
  return m
}
async function fetchEdgex(wanted) {
  const meta = await edgexMeta()
  const syms = [...meta.keys()].filter((s) => !wanted || wanted.has(s))
  const out = {}
  const QUEUE = 10
  let i = 0
  const worker = async () => {
    while (i < syms.length) {
      const s = syms[i++], c = meta.get(s)
      try {
        const t = await j(`${EDGEX}/quote/getTicker?contractId=${c.id}`)
        const x = t.data?.[0]
        if (!x) continue
        const price = +x.lastPrice
        // az intervallum a két funding-időbélyeg különbsége (jelenleg 4h, de ne kössük be fixen)
        const ivH = (+x.nextFundingTime - +x.fundingTime) / 3600e3
        if (!isFinite(price) || price <= 0 || !isFinite(ivH) || ivH <= 0) continue
        out[s] = {
          apr: +x.fundingRate * (24 / ivH) * 365,
          price, vol: +x.value || 0, oi: (+x.openInterest || 0) * price,
          ivH, next: +x.nextFundingTime || null, maxLev: c.maxLev,
        }
      } catch { /* egy szerződés kiesése ne vigye el az egész venue-t */ }
    }
  }
  await Promise.all(Array.from({ length: QUEUE }, worker))
  return out
}

// ── FUNDING-SZÁMLÁLÓ ─────────────────────────────────────────────────
// Eddig két tőzsde tranzakciós listáját kellett görgetni ahhoz, hogy megtudd, mennyi
// funding gyűlt egy körön. Ez labánként összeadja.
//
// NEM úgy számol, hogy eltelt idő × mostani ráta — a ráta mozog. A COW-körön az órás
// tickek így alakultak: 2,36 → 1,80 → 1,18 → 2,18 → 0,67 → 0,49. Az utolsó értékkel
// visszaszorozva $14,16 jönne ki a valós $8,68 helyett. Ezért minden TICK-HATÁRON az
// AKKOR érvényes értéket adja hozzá, és a határt elrakja — így egy szerver-újraindítás
// vagy egy kihagyott szken sem duplikál.
//
// Előjel: a SHORT láb kap, ha a funding pozitív; a LONG akkor, ha negatív.
function tickFunding(sor, apr, ivS, notional) {
  if (apr == null || !(ivS > 0) || !(notional > 0)) return 0
  const kap = (sor === 'SHORT') === (apr > 0)
  return (kap ? 1 : -1) * Math.abs(notional * apr * (ivS / 3600) / 8760)
}
// A nyitott kör óta gyűlt funding, labánként. A cfg-ben él, tehát túléli az
// újraindítást. A demoban memóriában él, tehát szerver-újraindításnál nullázódik.
function akkumulalFunding(same) {
  const cfg = loadCfg()
  if (!same || same.error || !same.open) return
  const acc = cfg.fund_acc || {}
  let valtozott = false
  for (const [venue, sor, apr] of [[same.short_on, 'SHORT', same.short_apr], [same.long_on, 'LONG', same.long_apr]]) {
    const ivS = venueIvForAsset(venue, same.asset)
    const iv = ivS * 1000
    const hatar = Math.floor(Date.now() / iv) * iv     // a legutóbbi tick-határ
    const e = acc[venue] || { usd: 0, last: null, ticks: 0 }
    // Az első szken csak bejegyzi, hol tartunk — visszamenőleg nem számol.
    if (e.last == null) { e.last = hatar; acc[venue] = e; valtozott = true; continue }
    if (hatar > e.last) {
      // Több határ is kimaradhatott: a Render ingyenes szintje alszik, és egy újraindítás
      // alatt órák telhetnek el. A kimaradtakhoz nincs történeti rátánk, ezért a mostanival
      // számolunk — ez becslés, de sokkal közelebb van, mint egyetlen tickre csökkenteni.
      // Külön számoljuk őket, hogy a felület jelezhesse, mennyi nem megfigyelt.
      const db = Math.min(24, Math.round((hatar - e.last) / iv))
      const egy = tickFunding(sor, apr, ivS, same.leg_notional)
      e.usd += egy * db
      e.ticks += db
      if (db > 1) e.est = (e.est || 0) + (db - 1)
      e.last = hatar
      acc[venue] = e; valtozott = true
    }
  }
  if (valtozott) { cfg.fund_acc = acc; saveCfg(cfg) }
}

// legutóbbi nyers venue-adat (a dashboard payload + pozíció élő számításához)
let lastVenues = null

async function scan() {
  // A Phoenix nem dobhatja el az egész szkent, ha épp nem elérhető — a többi négy venue
  // évek óta megy, ez az új. Hiba esetén üres objektum, a Vari+Phoenix fül marad üres.
  const [vari, eth, nado, li, phx, ast, rhl] = await Promise.all([
    fetchVariational(), fetchEthereal(), fetchNado(), fetchLighter(),
    fetchPhoenix().catch((e) => { console.error('[HEDGE] Phoenix:', e.message); return {} }),
    fetchAster().catch((e) => { console.error('[HEDGE] Aster:', e.message); return {} }),
    fetchRhLighter().catch((e) => { console.error('[HEDGE] Lighter-RH:', e.message); return {} }),
  ])
  // Az edgeX szerződésenként külön hívást kér, ezért csak azt kérdezzük le, ami a Varival
  // közös — így ~100 hívás lesz 151 helyett. Emiatt viszont a Vari után kell futnia.
  const edx = await fetchEdgex(new Set(Object.keys(vari)))
    .catch((e) => { console.error('[HEDGE] edgeX:', e.message); return {} })

  for (const [s, e] of Object.entries(eth)) {
    const px = vari[s]?.price ?? li.lighter[s]?.price ?? nado[s]?.price ?? null
    e.vol = px != null ? e.vol_base * px : null; e.price = px
  }
  lastVariIv = {}
  for (const [s, x] of Object.entries(vari)) if (x.ivS) lastVariIv[s] = x.ivS
  lastVenues = { Vari: vari, Ethereal: eth, Nado: nado, Lighter: li.lighter, Aster: ast, EdgeX: edx, Phoenix: phx, RhLighter: rhl }

  const VENUES = { Vari: vari, Ethereal: eth, Nado: nado, Lighter: li.lighter, Aster: ast, EdgeX: edx, RhLighter: rhl }
  const names = Object.keys(VENUES)
  const alive = (v) => v && v.vol !== 0
  const syms = new Set()
  for (const v of Object.values(VENUES)) for (const s of Object.keys(v)) syms.add(s)
  const rows = []
  for (const s of syms) {
    const present = names.filter((n) => alive(VENUES[n][s]))
    if (present.length < 2) continue
    const healthyLeg = (n) => VENUES[n][s].vol == null || VENUES[n][s].vol >= THIN_VOL_USD
    let best = null, bestHealthy = null
    for (let i = 0; i < present.length; i++) for (let k = i + 1; k < present.length; k++) {
      const a = present[i], b = present[k]
      const diff = VENUES[a][s].apr - VENUES[b][s].apr
      const pair = diff >= 0 ? { short: a, long: b, diff } : { short: b, long: a, diff: -diff }
      if (!best || Math.abs(pair.diff) > Math.abs(best.diff)) best = pair
      if (healthyLeg(a) && healthyLeg(b) && (!bestHealthy || Math.abs(pair.diff) > Math.abs(bestHealthy.diff))) bestHealthy = pair
    }
    const chosen = bestHealthy || best
    const variSpread = variSpreadFrac(vari[s])
    const costRT = legRoundTripCost(chosen.short, variSpread) + legRoundTripCost(chosen.long, variSpread)
    const h = pairHistory(s, chosen.short, chosen.long, chosen.diff)
    rows.push({
      sym: s, pair: chosen, thin: !bestHealthy,
      volS: VENUES[chosen.short][s].vol, volL: VENUES[chosen.long][s].vol,
      // A lábat a szűkebb oldal köti meg: a pár két lábja közül a kisebbik plafon számít.
      // A Vari nem adja meg (RFQ) — ha csak az hiányzik, a másik láb száma a mérvadó.
      maxLev: (() => { const a = VENUES[chosen.short][s]?.maxLev, b = VENUES[chosen.long][s]?.maxLev
        const xs = [a, b].filter((x) => x != null); return xs.length ? Math.min(...xs) : null })(),
      aprs: { Vari: alive(vari[s]) ? vari[s].apr : null, Ethereal: alive(eth[s]) ? eth[s].apr : null, Nado: alive(nado[s]) ? nado[s].apr : null, Lighter: alive(li.lighter[s]) ? li.lighter[s].apr : null, Aster: alive(ast[s]) ? ast[s].apr : null, EdgeX: alive(edx[s]) ? edx[s].apr : null, RhLighter: alive(rhl[s]) ? rhl[s].apr : null },
      hl: li.hyperliquid[s]?.apr ?? null,
      costRT, beDays: Math.abs(chosen.diff) > 0 ? (costRT * 365) / Math.abs(chosen.diff) : null,
      avg7d: h.avg7d, ageH: h.ageH, ageCapped: h.capped,
      // A Vari fundingja PILLANATKÉP-alapú, és a tick-intervalluma eszközfüggő (kripto 4h,
      // RWA 8h). Ezért egy 4h-s eszközön egy pillanatra bent lévő pozíció is megkapja a
      // TELJES intervallum kifizetését — ez külön szám a spreadtől, és gyakran nagyobb tétel.
      // A kliens ebből számolja a "Köv. tick $"-t a beállított lábmérettel.
      variIvS: variIvS(s), variApr: alive(vari[s]) ? vari[s].apr : null,
      cat: category(s),
      // A kereszt-táblákon a rés mindig a Varihoz képest értendő, mert ott a Vari az
      // egyik láb. Itt a pár BÁRMELY két venue lehet (pl. Aster → Lighter), ezért az
      // általános alak kell: a rés a SHORT és a LONG láb ára közt. Ugyanaz a szabály —
      // egyirányú, ha a funding a DRÁGÁBB lábat shortoltatja, vagyis ha a rés pozitív.
      ...(() => {
        const ps = VENUES[chosen.short][s]?.price, pl = VENUES[chosen.long][s]?.price
        const g = priceGap(ps, pl)
        return { gap: g, aligned: g == null || g === 0 ? null : g > 0 }
      })(),
    })
  }
  rows.sort((a, b) => Math.abs(b.pair.diff) - Math.abs(a.pair.diff))

  const nadovari = []
  for (const s of syms) {
    const vv = vari[s], nn = nado[s]
    if (!alive(vv) || !alive(nn)) continue
    const diff = vv.apr - nn.apr
    const pair = diff >= 0 ? { short: 'Vari', long: 'Nado', diff } : { short: 'Nado', long: 'Vari', diff: -diff }
    const variSpread = variSpreadFrac(vv)
    const costRT = legRoundTripCost('Vari', variSpread) + legRoundTripCost('Nado', variSpread)
    const h = pairHistory(s, pair.short, pair.long, pair.diff)
    const cat = category(s)
    nadovari.push({
      sym: s, cat, mult: pointMult(cat), pair, thin: (vv.vol < THIN_VOL_USD || nn.vol < THIN_VOL_USD),
      vApr: vv.apr, nApr: nn.apr, diff: pair.diff, vVol: vv.vol, nVol: nn.vol,
      maxLev: nn.maxLev ?? null,
      // A rés a Vari+Nado kereszten sokáig hiányzott — egyedüliként a hat közül —,
      // pedig a Nado ad oracle-árat. Emiatt ezen a kereszten se a Gap oszlop, se az
      // Egyirány-szűrő nem működött, holott épp itt számít: a Nado alt-könyvei
      // vékonyak (a CHIP-kör $2000-ból 15%-ot töltött), és ott a rés viszi el, amit
      // a funding hoz. Pontosan úgy számoljuk, ahogy a másik öt kereszten.
      gap: priceGap(vv.price, nn.price), aligned: gapAligned(priceGap(vv.price, nn.price), pair.short),
      costRT, beDays: Math.abs(pair.diff) > 0 ? (costRT * 365) / Math.abs(pair.diff) : null,
      avg7d: h.avg7d, ageH: h.ageH, ageCapped: h.capped,
      variIvS: variIvS(s),   // a Vari pillanatkép-tickjéhez (kripto 4h, RWA 8h)
    })
  }
  nadovari.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))

  // Vari + Lighter: pontosan ugyanaz a szerkezet, mint a nadovari fent — teljes univerzum
  // (nem kézzel felsorolt lista), kategória a szűrőhöz, 7d spread és kor a laborhistóriából.
  // Így a három fül oszlopai egyeznek, és a szűrő is ugyanúgy működik mindkét kereszten.
  const comp = []
  for (const s of syms) {
    const vv = vari[s], ll = li.lighter[s]
    if (!alive(vv) || !alive(ll)) continue
    const diff = vv.apr - ll.apr
    const pair = diff >= 0 ? { short: 'Vari', long: 'Lighter', diff } : { short: 'Lighter', long: 'Vari', diff: -diff }
    const variSpread = variSpreadFrac(vv)
    const costRT = legRoundTripCost('Vari', variSpread) + legRoundTripCost('Lighter', variSpread)
    const h = pairHistory(s, pair.short, pair.long, pair.diff)
    const cat = category(s)
    comp.push({
      sym: s, cat, mult: pointMult(cat), pair, thin: (vv.vol < THIN_VOL_USD || ll.vol < THIN_VOL_USD),
      vApr: vv.apr, lApr: ll.apr, diff: pair.diff, vVol: vv.vol, lVol: ll.vol,
      maxLev: ll.maxLev ?? null,
      gap: priceGap(vv.price, ll.price), aligned: gapAligned(priceGap(vv.price, ll.price), pair.short),
      costRT, beDays: Math.abs(pair.diff) > 0 ? (costRT * 365) / Math.abs(pair.diff) : null,
      avg7d: h.avg7d, ageH: h.ageH, ageCapped: h.capped,
      variIvS: variIvS(s),   // a Vari pillanatkép-tickjéhez (kripto 4h, RWA 8h)
    })
  }
  comp.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))

  // ── Vari + Phoenix kereszt ── ugyanaz a szerkezet, mint a comp (Vari+Lighter), csak a
  // "Phoenix vol" oszlop valójában OI (lásd fetchPhoenix).
  const phxvari = []
  for (const s of Object.keys(vari)) {
    const vv = vari[s], pp = phx[s]
    if (!alive(vv) || !pp || pp.apr == null) continue
    const diff = vv.apr - pp.apr
    const pair = diff >= 0 ? { short: 'Vari', long: 'Phoenix', diff } : { short: 'Phoenix', long: 'Vari', diff: -diff }
    const variSpread = variSpreadFrac(vv)
    const costRT = legRoundTripCost('Vari', variSpread) + legRoundTripCost('Phoenix', variSpread)
    const h = pairHistory(s, pair.short, pair.long, pair.diff)
    const cat = category(s)
    phxvari.push({
      sym: s, cat, mult: pointMult(cat), pair, thin: (vv.vol < THIN_VOL_USD || (pp.oi != null && pp.oi < THIN_VOL_USD)),
      vApr: vv.apr, pApr: pp.apr, diff: pair.diff, vVol: vv.vol, pOi: pp.oi,
      maxLev: pp.maxLev ?? null,
      gap: priceGap(vv.price, pp.price), aligned: gapAligned(priceGap(vv.price, pp.price), pair.short),
      costRT, beDays: Math.abs(pair.diff) > 0 ? (costRT * 365) / Math.abs(pair.diff) : null,
      avg7d: h.avg7d, ageH: h.ageH, ageCapped: h.capped,
      variIvS: variIvS(s),
    })
  }
  phxvari.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))

  // ── Vari + X kereszt, általánosan ──────────────────────────────────────────────
  // A fenti három (nadovari, comp, phxvari) egymás másolata, mert egyesével nőttek.
  // Az Aster és az edgeX nem másolja őket negyedszer és ötödször: ugyanaz a számítás,
  // egy helyen. A mezőnevek szándékosan semlegesek (aApr/bApr helyett vApr/oApr, ahol
  // az "o" = other), így egy render-függvény mindkét új fület ki tudja szolgálni.
  const buildVariCross = (other, otherName) => {
    const list = []
    for (const s of Object.keys(vari)) {
      const vv = vari[s], oo = other[s]
      if (!alive(vv) || !oo || oo.apr == null || !isFinite(oo.apr)) continue
      const diff = vv.apr - oo.apr
      const pair = diff >= 0
        ? { short: 'Vari', long: otherName, diff }
        : { short: otherName, long: 'Vari', diff: -diff }
      const variSpread = variSpreadFrac(vv)
      const costRT = legRoundTripCost('Vari', variSpread) + legRoundTripCost(otherName, variSpread)
      const h = pairHistory(s, pair.short, pair.long, pair.diff)
      const cat = category(s)
      list.push({
        sym: s, cat, mult: pointMult(cat), pair,
        thin: (vv.vol < THIN_VOL_USD || (oo.vol != null && oo.vol < THIN_VOL_USD)),
        vApr: vv.apr, oApr: oo.apr, diff: pair.diff, vVol: vv.vol, oVol: oo.vol,
        oOi: oo.oi ?? null,
        // Csak az edgeX adja meg — a Vari-oldal úgyis 20-50x, tehát a lábméretezést
        // gyakorlatilag ez a szám köti meg. Az Asternél nincs a publikus API-ban.
        maxLev: oo.maxLev ?? null,
        gap: priceGap(vv.price, oo.price), aligned: gapAligned(priceGap(vv.price, oo.price), pair.short),
        costRT, beDays: Math.abs(pair.diff) > 0 ? (costRT * 365) / Math.abs(pair.diff) : null,
        avg7d: h.avg7d, ageH: h.ageH, ageCapped: h.capped,
        variIvS: variIvS(s),
      })
    }
    list.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    return list
  }
  const astervari = buildVariCross(ast, 'Aster')
  const edgexvari = buildVariCross(edx, 'EdgeX')
  const rhlvari = buildVariCross(rhl, 'RhLighter')

  recordSnapshot(vari, eth, nado, li.lighter, phx, ast, edx, rhl)
  // élő pozíciók frissítése — sosem dobhat, a hiba csak annyit jelent, hogy nincs tükör
  try { const lp = await fetchLivePositions(loadCfg().wallet); if (lp) lastLivePos = lp } catch {}
  return { time: new Date().toLocaleString('hu-HU'), histHours: labHist.length, priceHist: priceHistStat(), rows, nadovari, comp, phxvari, astervari, edgexvari, rhlvari }
}

// Hány órányi ÁR-mérés gyűlt eddig. A funding-history régebbi, mint az ár-rögzítés
// (2026-08-10), ezért a labHist hossza itt félrevezetne — külön kell számolni azokat
// a sorokat, amikben van legalább egy pv/pl. A dashboard emlékeztető-csíkja ezt mutatja.
function priceHistStat() {
  const withP = labHist.filter((r) => Object.values(r.d).some((x) => x.pv != null || x.pl != null))
  if (!withP.length) return { hours: 0, since: null }
  return { hours: withP.length, since: withP[0].ts }
}

// Mennyibe kerül VALÓJÁBAN egy adott dollárméretű piaci rendelés a könyvben. Nem a
// jegyzett spreadet adja vissza, hanem a súlyozott átlagár eltérését a legjobb ártól —
// ez az a szám, ami a Lighteren $57-es best biddel háromszor is elvágta a lábat.
// `levels`: [[ár, mennyiség], …] a legjobbtól kifelé.
function bookImpact(levels, legUsd) {
  if (!levels || !levels.length || !(legUsd > 0)) return null
  const best = +levels[0][0]
  if (!(best > 0)) return null
  let need = legUsd, cost = 0, qty = 0
  for (const lv of levels) {
    if (need <= 0) break
    const p = +lv[0], val = p * +lv[1]
    const take = Math.min(val, need)
    cost += take; qty += take / p; need -= take
  }
  const filled = legUsd - need
  return { impact: qty > 0 ? Math.abs(best - cost / qty) / best : null, filled, full: need <= 0, best }
}

// A labHist-ből visszaadja egy eszköz idősorát: a Vari rátát és a RÉST venue-nként.
// Ez a labor SAJÁT mérése — pontosabb a döntéshez, mint a Hyperliquid proxy, mert
// azokon a platformokon mér, ahol ténylegesen nyitsz.
function diveSeries(sym) {
  const t = [], v = [], gLi = [], gPhx = [], gAst = [], gEdx = [], gRhl = []
  for (const row of labHist) {
    const x = row.d[sym]
    if (!x) continue
    t.push(row.ts)
    v.push(x.v != null ? x.v : null)
    gLi.push(x.pv != null && x.pl > 0 ? (x.pv - x.pl) / x.pl : null)
    gPhx.push(x.pv != null && x.px > 0 ? (x.pv - x.px) / x.px : null)
    gAst.push(x.pv != null && x.pa > 0 ? (x.pv - x.pa) / x.pa : null)
    gEdx.push(x.pv != null && x.pg > 0 ? (x.pv - x.pg) / x.pg : null)
    gRhl.push(x.pv != null && x.pr > 0 ? (x.pv - x.pr) / x.pr : null)
  }
  return { t, v, gLi, gPhx, gAst, gEdx, gRhl }
}

async function dive(sym, legUsd) {
  const leg = legUsd > 0 ? legUsd : 3000
  const out = { sym, leg }
  try {
    let hist = []
    try { hist = await post(HL, { type: 'fundingHistory', coin: sym, startTime: Date.now() - 7 * 86400e3 }) } catch {}
    if (!hist.length) { try { hist = await post(HL, { type: 'fundingHistory', coin: `xyz:${sym}`, startTime: Date.now() - 7 * 86400e3 }); if (hist.length) out.hlNote = 'xyz builder-piac' } catch {} }
    if (hist.length) {
      const aprs = hist.map((h) => parseFloat(h.fundingRate) * 24 * 365)
      const avg = aprs.reduce((a, b) => a + b, 0) / aprs.length
      let ss = 0
      for (let i = aprs.length - 1; i >= 0; i--) { if (Math.sign(aprs[i]) === Math.sign(aprs[aprs.length - 1]) && Math.abs(aprs[i]) > 0.01) ss++; else break }
      out.hl = { now: aprs[aprs.length - 1], avg7d: avg, sameSignH: ss }
      out.verdict = Math.abs(avg) < Math.abs(out.hl.now) * 0.35 ? 'spike' : ss >= 72 ? 'structural' : 'young'
    }
  } catch {}
  try {
    const variD = await j(VARI)
    const v = variD.listings.find((l) => l.ticker === sym)
    if (v) {
      const q = v.quotes || {}
      const sp = (o) => o && o.ask > 0 ? (o.ask - o.bid) / o.ask : null
      out.vari = {
        apr: parseFloat(v.funding_rate), price: parseFloat(v.mark_price), vol: parseFloat(v.volume_24h),
        oiL: parseFloat(v.open_interest.long_open_interest), oiS: parseFloat(v.open_interest.short_open_interest),
        // A Vari nem ad könyvet, hanem MÉRET SZERINTI jegyzést: $1k-ra és $100k-ra külön.
        // A kettő eltérése mutatja, mennyire hízik a spread mérettel — ez a Vari-oldali
        // becsapódás legjobb elérhető közelítése.
        spread1k: sp(q.size_1k), spread100k: sp(q.size_100k), spreadBase: sp(q.base),
        ivS: v.funding_interval_s || null,
      }
    }
  } catch {}
  try {
    // A könyvhöz SZÁMSZERŰ market_id kell, a szimbólum 400-at ad. Az /orderBooks
    // adja a leképezést — enélkül a becsapódás csendben üresen maradna.
    const [fr, stats, obs] = await Promise.all([
      j(`${LIGHTER}/funding-rates`), j(`${LIGHTER}/exchangeStats`), j(`${LIGHTER}/orderBooks`).catch(() => null),
    ])
    const r = fr.funding_rates.find((x) => x.exchange === 'lighter' && x.symbol === sym)
    const st = stats.order_book_stats.find((x) => x.symbol === sym)
    if (r || st) out.lighter = { apr: r ? r.rate * 3 * 365 : null, vol: st?.daily_quote_token_volume ?? null, trades: st?.daily_trades_count ?? null, price: st?.last_trade_price ?? null }
    const mid = obs && (obs.order_books || []).find((x) => x.symbol === sym)
    if (out.lighter && mid) {
      const ob = await j(`${LIGHTER}/orderBookOrders?market_id=${mid.market_id}&limit=100`).catch(() => null)
      if (ob && ob.bids) out.lighter.book = bookImpact(ob.bids.map((b) => [b.price, b.remaining_base_amount]), leg)
    }
  } catch {}
  try {
    const [f, mk, ob] = await Promise.all([
      j(`${PHOENIX}/funding/overview`), j(`${PHOENIX}/view/markets`),
      j(`${PHOENIX}/view/orderbook/${encodeURIComponent(sym)}?include_splines=true`).catch(() => null),
    ])
    const s = (f.series || []).find((x) => x.symbol === sym)
    const m = (mk.markets || []).find((x) => x.symbol === sym)
    if (s && s.points && s.points.length) {
      const last = s.points[s.points.length - 1]
      const price = +last.markPrice
      out.phoenix = { apr: +last.fundingRate * PHX_APR, price }
      if (m && m.openInterest) out.phoenix.oi = (+m.openInterest.value / Math.pow(10, m.openInterest.decimals || 0)) * price
      // Nyitvatartás: a commodity/részvény piacok ZÁRNAK, és a naptár megmondja, mikor.
      // Éjszakai tartásnál ez dönti el, ki tudsz-e szállni — a COPPER pl. 23:00-00:00
      // között áll (Budapest), pénteken meg hétfő hajnalig.
      if (m && m.commodityMetadata) out.phoenix.hours = { isCommodity: !!m.commodityMetadata.isCommodity, afterHours: !!m.commodityMetadata.isAfterHours, status: m.commodityMetadata.status, nextTransition: m.metadata?.calendar?.nextMarketTransitionUtc || null, calendar: m.metadata?.calendar?.id || null }
      if (ob && ob.bids) out.phoenix.book = bookImpact(ob.bids, leg)
    }
  } catch {}
  // A mélyfúrás eddig csak három venue-t hívott meg külön (Vari, Lighter, Phoenix), így a
  // táblában látható hét oszlopból négy egyszerűen hiányzott a felugró ablakból. Ezeket
  // NEM kérdezzük le újra: a legutóbbi szkennelés adata már megvan, 90 másodpercnél nem
  // régebbi, és négy extra API-kör másodperceket tenne a megnyitáshoz.
  if (lastVenues) {
    out.venues = {}
    for (const k of ['Vari', 'Ethereal', 'Nado', 'Lighter', 'RhLighter', 'Aster', 'EdgeX']) {
      const x = lastVenues[k] && lastVenues[k][sym]
      if (x && x.vol !== 0) out.venues[k] = { apr: x.apr ?? null, price: x.price ?? null, vol: x.vol ?? null, maxLev: x.maxLev ?? null }
    }
  }
  out.series = diveSeries(sym)
  return out
}

// ── dashboard payload (a dashboard.py build_payload portja) ──
function roundLot(qty, lot) { if (!lot || lot <= 0) return qty; return Math.floor(Math.max(0, qty) / lot) * lot }
const legEarnApr = (side, f) => side === 'SHORT' ? f : -f
function buildConfigs(v, m) {
  return {
    A: [['Variational', 'BTC', 'LONG', v.BTC.funding_apr], ['Variational', 'ETH', 'SHORT', v.ETH.funding_apr], ['Ethereal', 'BTC', 'SHORT', m.BTC.funding_apr], ['Ethereal', 'ETH', 'LONG', m.ETH.funding_apr]],
    B: [['Variational', 'BTC', 'SHORT', v.BTC.funding_apr], ['Variational', 'ETH', 'LONG', v.ETH.funding_apr], ['Ethereal', 'BTC', 'LONG', m.BTC.funding_apr], ['Ethereal', 'ETH', 'SHORT', m.ETH.funding_apr]],
  }
}
const netApr = (legs) => legs.reduce((a, l) => a + legEarnApr(l[2], l[3]), 0) / 4
function markPrice(sym) { if (!lastVenues) return null; for (const v of ['Vari', 'Lighter', 'Nado', 'Ethereal']) { const x = lastVenues[v] && lastVenues[v][sym]; if (x && x.price != null) return x.price } return null }

function openPnl(cfg, priceAsset, px) {
  const lev = cfg.leverage
  const marginLeg = cfg.margin_per_leg_usd || Math.min(cfg.capital_variational_usd, cfg.capital_meridian_usd) / 2
  const legNotional = marginLeg * lev
  const pnl = { Variational: 0, Ethereal: 0, Nado: 0, Lighter: 0 }
  const active = cfg.active_config
  if (active === 'SAME' && cfg.entry_price_asset && priceAsset != null) {
    const entry = cfg.entry_price_asset
    const delta = legNotional / entry * (priceAsset - entry)
    const va = cfg.same_va || 'Variational', vb = cfg.same_vb || 'Ethereal'
    const shortOn = cfg.same_short_on || vb
    const longOn = shortOn === va ? vb : va
    pnl[shortOn] -= delta; pnl[longOn] += delta
  } else if ((active === 'A' || active === 'B') && cfg.entry_price_btc && cfg.entry_price_eth && px) {
    const dB = legNotional / cfg.entry_price_btc * (px.BTC - cfg.entry_price_btc)
    const dE = legNotional / cfg.entry_price_eth * (px.ETH - cfg.entry_price_eth)
    const sign = active === 'A' ? 1 : -1
    pnl.Variational = sign * (dB - dE); pnl.Ethereal = -pnl.Variational
  }
  return pnl
}
function snapshotOpenPnl() {
  try {
    const cfg = loadCfg(); const active = cfg.active_config
    if (!active) return { Ethereal: 0, Variational: 0 }
    if (active === 'SAME') return openPnl(cfg, markPrice(cfg.same_asset || 'ENA'))
    return openPnl(cfg, null, { BTC: markPrice('BTC'), ETH: markPrice('ETH') })
  } catch { return { Ethereal: 0, Variational: 0 } }
}
// A kiegyenlítés-kalkulátor a demóban NEM tud működni, és ezt itt mondjuk ki egyszer.
//
// Az éles rendszerben a napló minden bejegyzése hordozta a két platform aznapi
// egyenlegét (`eth_usd` / `vari_usd`), és ebből a legutolsóból + a nyitott PnL-ből
// jött ki, mennyit kell átutalni, hogy a két oldal újra egyforma legyen. A demó
// naplója viszont szándékosan csak a kör eredményét tárolja — `{id, kind, pnl,
// note, date}`, lásd fromRow() —, mert egyenleget közölni egy publikus demóban
// nem kell és nem is illik. A számításnak így nincs kiindulópontja.
//
// A kivágáskor a függvény törzse bent maradt, és a szülő SZINKRON loadNaplo()-ját
// hívta, ami a demóban nem létezik (itt a napló async naploList(uid)). Ettől a
// /api/data 500-zal elszállt: MINDIG `pair` módban, és `same` módban akkor, ha
// valaki a Variational+Ethereal keresztet választotta — vagyis a látogató két
// kattintással üres dashboardot kapott.
//
// null = "nincs kiegyenlítési javaslat", pontosan az, amit az eredeti is adott
// volna baseE/baseV nélkül. A hívási helyek (1118, 1137) érintetlenek maradhatnak.
function rebalanceCalc(_pnlNow) {
  return null
}
function rebTxt(r) { if (!r || r.amount < 20) return ''; return ` → Utalj ~$${r.amount.toFixed(0)} ${r.from} → ${r.to} (becslés: Ethereal ~$${r.est_e.toFixed(0)} / Vari ~$${r.est_v.toFixed(0)}, cél ~$${r.target.toFixed(0)}/oldal).` }

// Összeveti a rögzített állapotot (Nyitottam/Zártam) a platformokról olvasott valósággal.
// Csak JELEZ — a javítás a felhasználó egy kattintása, mert egy téves API-válaszra
// automatikusan felülírni az állapotot többet ártana, mint használna.
function reconcile(cfg) {
  if (!lastLivePos) return null
  const seen = lastLivePos.venues
  const all = []
  for (const [v, list] of Object.entries(seen)) for (const p of list) all.push({ venue: v, ...p })
  const asset = cfg.same_asset
  const isSame = (cfg.mode || 'pair') === 'same'
  const recordedOpen = isSame && cfg.active_config === 'SAME'
  // melyik láb ellenőrizhető egyáltalán? (a Variational nem ad nyilvános végpontot)
  const pairNames = [cfg.same_va || 'Variational', cfg.same_vb || 'Ethereal']
  const checkable = pairNames.filter((n) => seen[VMAP[n]] !== undefined || seen[n] !== undefined)
  const hit = all.filter((p) => p.sym === asset)
  let status = 'ok', text = ''
  if (!checkable.length) {
    status = 'unknown'
    text = `A(z) ${pairNames.join(' + ')} pár egyik lába sem olvasható nyilvánosan — nincs mihez hasonlítani.`
  } else if (recordedOpen && !hit.length) {
    status = 'ghost'
    text = `A dashboard szerint ${asset} pozíció ÉL, de ${checkable.join('/')} szerint nincs nyitva semmi. Ha lezártad, nyomd meg a Zártam-ot.`
  } else if (!recordedOpen && all.length) {
    status = 'untracked'
    text = `Nyitott pozíció a platformon (${all.map((p) => p.venue + ' ' + p.side + ' ' + p.sym).join(', ')}), de a dashboardon nincs rögzítve. Nyomd meg a Nyitottam-ot.`
  } else if (recordedOpen && hit.length) {
    text = `${asset}: a rögzített állapot egyezik a platformmal (${hit.map((p) => p.venue + ' ' + p.side).join(', ')}).`
  } else {
    text = 'Nincs nyitott pozíció sem a dashboardon, sem a platformokon.'
  }
  return { status, text, positions: all, checkable, at: lastLivePos.at, errors: lastLivePos.errors }
}

function buildPayload() {
  const cfg = loadCfg()
  const V = lastVenues.Vari, E = lastVenues.Ethereal
  const g = (o, s) => o[s] || {}
  const varD = { BTC: { funding_apr: g(V, 'BTC').apr, mark_price: g(V, 'BTC').price }, ETH: { funding_apr: g(V, 'ETH').apr, mark_price: g(V, 'ETH').price } }
  const merD = { BTC: { funding_apr: g(E, 'BTC').apr, lot_size: g(E, 'BTC').lot_size, min_qty: g(E, 'BTC').min_qty }, ETH: { funding_apr: g(E, 'ETH').apr, lot_size: g(E, 'ETH').lot_size, min_qty: g(E, 'ETH').min_qty } }
  const mode = cfg.mode || 'pair'
  const lev = cfg.leverage, capV = cfg.capital_variational_usd, capM = cfg.capital_meridian_usd
  const marginLeg = cfg.margin_per_leg_usd || Math.min(capV, capM) / 2
  const legNotional = marginLeg * lev
  const buffer = Math.min(capV, capM) - 2 * marginLeg
  const dLiq = Math.min(capV, capM) / legNotional
  const slDiv = dLiq * 0.8
  const btcPx = varD.BTC.mark_price, ethPx = varD.ETH.mark_price
  const px = { BTC: btcPx, ETH: ethPx }

  const cfgs = buildConfigs(varD, merD)
  const configs = {}
  for (const name of ['A', 'B']) {
    const legs = cfgs[name].map(([plat, asset, side, f]) => ({ platform: plat, asset, side, funding_apr: f, usd_day: legNotional * legEarnApr(side, f) / 365 }))
    const apr = netApr(cfgs[name])
    configs[name] = { legs, apr, usd_day: legNotional * 4 * apr / 365 }
  }
  const best = configs.A.apr >= configs.B.apr ? 'A' : 'B'

  const tips = {}
  for (const a of ['BTC', 'ETH']) {
    const fv = varD[a].funding_apr, fm = merD[a].funding_apr
    const splat = fv > fm ? 'Variational' : 'Ethereal'
    tips[a] = { short_on: splat, long_on: splat === 'Variational' ? 'Ethereal' : 'Variational', edge_apr: Math.abs(fv - fm), edge_usd_day: legNotional * Math.abs(fv - fm) / 365 }
  }
  const perfectCross = tips.BTC.short_on !== tips.ETH.short_on

  const qtyBtc = roundLot(legNotional / btcPx, merD.BTC.lot_size)
  const qtyEth = roundLot(legNotional / ethPx, merD.ETH.lot_size)
  const showCfg = (cfg.active_config === 'A' || cfg.active_config === 'B') ? cfg.active_config : best
  const sl = cfgs[showCfg].map(([plat, asset, side]) => ({ platform: plat, asset, side, price: side === 'LONG' ? px[asset] * (1 - slDiv) : px[asset] * (1 + slDiv) }))

  let div = null
  if (cfg.entry_price_btc && cfg.entry_price_eth) {
    const cb = btcPx / cfg.entry_price_btc - 1, ce = ethPx / cfg.entry_price_eth - 1, d = ce - cb
    div = { chg_btc: cb, chg_eth: ce, div: d, used: Math.abs(d) / dLiq }
  }

  const active = cfg.active_config
  const alerts = []; let reb = null, same = null

  if (mode === 'same') {
    const asset = cfg.same_asset || 'ENA'
    const vaN = cfg.same_va || 'Variational', vbN = cfg.same_vb || 'Ethereal'
    const A = venueData(vaN, asset), B = venueData(vbN, asset)
    if (A && B && A.apr != null && B.apr != null) {
      const aApr = A.apr, bApr = B.apr
      const shortNow = aApr > bApr ? vaN : vbN
      const longNow = shortNow === vaN ? vbN : vaN
      const shortApr = shortNow === vaN ? aApr : bApr
      const longApr = shortNow === vaN ? bApr : aApr
      const diffS = shortApr - longApr   // >=0, ezt keresed
      const priceS = A.price ?? B.price
      const lot = vaN === 'Ethereal' ? A.lot_size : vbN === 'Ethereal' ? B.lot_size : 0
      const minq = vaN === 'Ethereal' ? A.min_qty : vbN === 'Ethereal' ? B.min_qty : 0
      const qtyS = roundLot(legNotional / priceS, lot)
      const isOpen = active === 'SAME'
      let drift = null, usedS = null
      if (isOpen && cfg.entry_price_asset) { drift = priceS / cfg.entry_price_asset - 1; usedS = Math.abs(drift) / dLiq }
      same = {
        asset, price: priceS, va_name: vaN, vb_name: vbN, va_apr: aApr, vb_apr: bApr,
        short_on: shortNow, long_on: longNow, short_apr: shortApr, long_apr: longApr, diff: diffS,
        usd_day: legNotional * diffS / 365, qty: qtyS, leg_notional: legNotional, d_liq: dLiq,
        open: isOpen, entry: cfg.entry_price_asset, opened_short_on: cfg.same_short_on,
        drift, used: usedS, sl_short: priceS * (1 + 0.8 * dLiq), sl_long: priceS * (1 - 0.8 * dLiq), min_qty: minq,
        gap: priceGap(A.price, B.price), entry_gap: cfg.entry_gap ?? null,
      }
      // rebalance csak Variational+Ethereal párra (a napló csak ezt a két egyenleget követi)
      const isVE = (vaN === 'Variational' || vaN === 'Ethereal') && (vbN === 'Variational' || vbN === 'Ethereal') && vaN !== vbN
      if (isVE) reb = rebalanceCalc(openPnl(cfg, priceS))
      if (isOpen) {
        if (usedS != null && usedS >= 0.75) alerts.push({ level: 'red', text: `VESZÉLYZÓNA: az ${asset} ára ${(drift * 100).toFixed(1)}%-ot mozdult a belépőd óta (a likvidációs táv ${Math.round(usedS * 100)}%-a)! Egyenlítsd ki vagy zárj!` + rebTxt(reb) })
        else if (usedS != null && usedS >= 0.5) alerts.push({ level: 'yellow', text: `Az ${asset} drift ${(drift * 100).toFixed(1)}% — a likvidációs táv felénél, készülj kiegyenlítésre.` + rebTxt(reb) })
        if (cfg.same_short_on && cfg.same_short_on !== shortNow && diffS >= 0.05) alerts.push({ level: 'yellow', text: `A funding-spread iránya megfordult: most a ${shortNow}-on érné meg a short. Nézd meg a 7 napos átlagot, mielőtt fordítasz.` })
        if (diffS < 0.10) alerts.push({ level: 'yellow', text: `Az ${asset} spread ${(diffS * 100).toFixed(1)}%-ra szűkült — ha tartósan 10% alatt marad, a szkennerből válassz jobb párt.` })
      }
    } else {
      // Melyik oldal hiányzik, és hol lenne meg? Ennélkül a felhasználó találgat:
      // a RARE például csak Asteren van, tehát a Lighter-oldal sosem fog bejönni.
      const hol = VENUE_OPTS.filter((v) => { const x = venueData(v, asset); return x && x.apr != null })
      const hiany = [!A || A.apr == null ? vaN : null, !B || B.apr == null ? vbN : null].filter(Boolean)
      same = { asset, error: `A(z) ${asset} nincs meg itt: ${hiany.join(' és ')}.` +
        (hol.length >= 2 ? ` Ezeken elérhető: ${hol.join(', ')} — válassz kéttőt közülük.`
                         : hol.length === 1 ? ` Csak egyetlen platformon van (${hol[0]}), tehát erre nem lehet keresztet nyitni.`
                         : ' Egyik követett platformon sincs meg.') }
    }
  } else {
    if ((active === 'A' || active === 'B') && active !== best) alerts.push({ level: 'red', text: `A nyitott konfigod [${active}], de most a [${best}] az optimális (különbség $${Math.abs(configs.A.usd_day - configs.B.usd_day).toFixed(2)}/nap). A következő ciklusnál fordíts!` })
    reb = rebalanceCalc(openPnl(cfg, null, px))
    if (div && div.used >= 0.75) alerts.push({ level: 'red', text: 'VESZÉLYZÓNA: a divergencia a likvidációs táv 75%-a felett! Zárj/egyenlíts ki!' + rebTxt(reb) })
    else if (div && div.used >= 0.5) alerts.push({ level: 'yellow', text: 'Figyelem: a divergencia a likvidációs táv felénél jár — érdemes kiegyenlíteni.' + rebTxt(reb) })
  }

  // funding-tick lábak a countdownhoz (a választott platformok szerint).
  // A Variational fundingja PILLANATKÉP-alapú (2026-08-08-án élesben igazolva): elég a tick
  // pillanatában bent lenni a teljes intervallum kifizetéséhez. Ezért érdemes a lábankénti
  // tick DOLLÁRÉRTÉKÉT is kiküldeni, plusz azt a küszöböt, ami fölött megéri a lábat kizárni
  // a tick elől — a kizárás ugyanis egy EXTRA be-ki kört jelent, az meg könyv-spreadbe kerül.
  const tickAsset = mode === 'same' ? (cfg.same_asset || 'ENA') : 'BTC'
  const tickVSpread = variSpreadFrac(lastVenues?.Vari?.[tickAsset])
  let tickLegs
  if (mode === 'same' && same && !same.error) {
    const mk = (venue, side, apr) => {
      const ivS = venueIvForAsset(venue, tickAsset)
      const notional = same.leg_notional
      // amit EGY tick mozgat ezen a lábon (előjel nélkül, dollárban)
      const tickUsd = apr == null ? null : Math.abs(notional * apr * (ivS / 3600) / 8760)
      // a kizárás ára: egy teljes extra nyit+zár kör EZEN a venue-n
      const dodgeCost = notional * legRoundTripCost(VMAP[venue] ?? venue, tickVSpread)
      return { venue, ivS, side, apr, notional, tick_usd: tickUsd, dodge_cost: dodgeCost }
    }
    // A tick-határok átlépését itt vesszük észre (a szken 90 mp-enként fut), és ilyenkor
    // adjuk hozzá az AKKOR érvényes tick-értéket a labánkénti számlálóhoz.
    akkumulalFunding(same)
    const acc = (loadCfg().fund_acc) || {}
    tickLegs = [mk(same.short_on, same.open ? 'SHORT' : null, same.short_apr),
                mk(same.long_on, same.open ? 'LONG' : null, same.long_apr)]
    for (const L of tickLegs) { const e = acc[L.venue]; L.acc_usd = e ? e.usd : null; L.acc_ticks = e ? e.ticks : 0; L.acc_est = e ? (e.est || 0) : 0 }
  } else if (mode === 'same') {
    // Same-asset mód, de az eszköz nincs meg mindkét választott platformon. Korábban itt
    // némán Variational+Ethereal jelent meg — ami úgy nézett ki, mintha be lenne állítva a
    // kereszt, holott a felhasználó egészen mást választott. A választott platformokat
    // mutatjuk, üres adattal, hogy a hiány látszódjon és ne tűnjön működőnek.
    const vaN = cfg.same_va || 'Variational', vbN = cfg.same_vb || 'Ethereal'
    tickLegs = [
      { venue: vaN, ivS: venueIvForAsset(vaN, tickAsset), side: null, apr: null, missing: !venueData(vaN, tickAsset) },
      { venue: vbN, ivS: venueIvForAsset(vbN, tickAsset), side: null, apr: null, missing: !venueData(vbN, tickAsset) },
    ]
  } else {
    tickLegs = [
      { venue: 'Variational', ivS: variIvS('BTC'), side: null, apr: null },
      { venue: 'Ethereal', ivS: 3600, side: null, apr: null },
    ]
  }
  return {
    mode, same, time: new Date().toLocaleString('hu-HU'),
    funding: { BTC: { var: varD.BTC.funding_apr, mer: merD.BTC.funding_apr }, ETH: { var: varD.ETH.funding_apr, mer: merD.ETH.funding_apr } },
    tips, perfect_cross: perfectCross, configs, best,
    sizing: { leg_notional: legNotional, total: legNotional * 4, qty_btc: qtyBtc, qty_eth: qtyEth, btc_px: btcPx, eth_px: ethPx, margin_leg: marginLeg, buffer },
    sl: { div_pct: slDiv, legs: sl, for_config: showCfg },
    risk: { d_liq: dLiq, divergence: div },
    state: { active_config: active, entry_price_btc: cfg.entry_price_btc, entry_price_eth: cfg.entry_price_eth, entry_price_asset: cfg.entry_price_asset, capital_v: capV, capital_m: capM, margin_per_leg: marginLeg, leverage: lev, same_asset: cfg.same_asset, same_va: cfg.same_va, same_vb: cfg.same_vb, wallet: cfg.wallet || '' },
    rebalance: reb, alerts, live: reconcile(cfg),
    tick: { legs: tickLegs, asset: tickAsset },
  }
}

// ── HTML ──
// A landing külön fájlban van, nem template-literalban: a szövege sok aposztrófot és
// idézőjelet tartalmaz, és így szerkeszthető anélkül, hogy a JS-escapelést kellene követni.
const LANDING = fs.readFileSync(path.join(__dirname, 'landing.html'), 'utf8')

// Venue-logók base64 data-URI-ként (36px PNG, összesen ~17 kB). Direkt beágyazva és
// nem a tőzsdék CDN-jéről hivatkozva: a demó így offline is teljes, és nem szivárog
// referer minden oldalbetöltéskor hét külön tőzsde felé.
const VLOGOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'venue-logos.json'), 'utf8'))
const vth = (key, label, cls = '') =>
  `<th class="vh ${cls}"><span class="vhw">` +
  (VLOGOS[key] ? `<img class="vlogo" src="${VLOGOS[key]}" alt="">` : '') +
  `<span>${label}</span></span></th>`

// ── HTML ──
// A dashboard oldala KÜLÖN fájlban van (app.html), nem template-literalban — ugyanabból
// az okból, amiért a landing is: így szerkeszthető anélkül, hogy a JS-escapelést kellene
// követni, és egy UI-változás diffje nem keveredik össze a szerver-logikáéval. Ugyanabban
// a fájlban eddig egy oldal-átírás 1674 sorral takarta el, ha közben a scan() is módosult.
//
// Két dolgot mégis a szerver tölt bele induláskor, mert base64 logót nem érdemes a
// HTML-be sütni (a venue-logos.json marad az egyetlen forrásuk):
//   <!--VTH:kulcs:felirat[:osztály]-->  → szkenner-tábla venue-fejléce, logóval
//   /*VLOGOS*/null                      → a kliens-oldali VLOGO objektum
const PAGE = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8')
  .replace(/<!--VTH:([^:>]+):([^:>]+)(?::([^>]+))?-->/g, (_, k, l, c) => vth(k, l, c || ''))
  .replace('/*VLOGOS*/null', () => JSON.stringify(VLOGOS))

// ── szerver ──
function readBody(req) { return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')) } catch { res({}) } }) }) }

async function ensureScan() { if (!lastVenues) await cachedScan() }

// ── SZKEN-CACHE ────────────────────────────────────────────────────
// Egy teljes kör hét venue-t kérdez és ~5 másodperc. A kliens 90 mp-enként frissít,
// FÜLENKÉNT — tehát öt egyszerre nyitott néző eddig öt teljes kört indított, és a
// tőzsdék felé is ötször annyi kérést. A cache egy körre fogja őket; a menet közben
// érkezők ugyanarra az ígéretre várnak, nem indítanak másodikat.
const SCAN_TTL_MS = 60_000
let _scanAt = 0, _scanData = null, _scanRunning = null
async function cachedScan() {
  if (_scanData && Date.now() - _scanAt < SCAN_TTL_MS) return _scanData
  if (_scanRunning) return _scanRunning
  _scanRunning = (async () => {
    try { _scanData = await scan(); _scanAt = Date.now(); return _scanData }
    finally { _scanRunning = null }
  })()
  return _scanRunning
}

// A kérés-kezelő ITT áll önmagában, `.listen()` nélkül — így ugyanez a függvény
// szolgálja ki a helyi `node server.js`-t (lásd a fájl végén) ÉS Vercelen a
// serverless függvényt (api/index.js re-exportálja). A Vercel-verzió a
// legtöbb módosítást nem is látja: a handler minden útvonalat ugyanúgy old fel.
async function handler(req, res) {
  const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' }); res.end(JSON.stringify(o)) }
  try {
    const url = req.url.split('?')[0]   // query-string (pl. cache-buster ?_=…) levágása az útvonal-egyeztetéshez
    const html = (body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' }); res.end(body) }
    if (url === '/' || url === '/index.html') { html(LANDING) }
    else if (url === '/app' || url === '/app/') { html(PAGE) }
    // ── auth ──
    else if (url === '/api/me') {
      const u = currentUser(req)
      json({ enabled: AUTH_ON, bot: TG_BOT_NAME, user: u, persistent: SUPA_ON })
    }
    // A Telegram widget GET-tel tér vissza, a mezők a query-stringben ülnek.
    else if (url === '/api/auth/telegram') {
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams)
      const u = tgVerify(q)
      if (!u) { res.writeHead(302, { Location: '/app?auth=failed' }); return res.end() }
      if (SUPA_ON) {
        // upsert: ugyanaz a telegram_id másodszor is beléphet ütközés nélkül
        try {
          await supa('users?on_conflict=telegram_id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({ telegram_id: u.id, username: u.username, first_name: u.first_name }),
          })
        } catch (e) { console.error('user upsert:', e.message) }
      }
      res.writeHead(302, {
        Location: '/app',
        'Set-Cookie': `hl_session=${encodeURIComponent(sign(u))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
      })
      return res.end()
    }
    else if (url === '/api/auth/logout') {
      res.writeHead(302, { Location: '/app', 'Set-Cookie': 'hl_session=; Path=/; HttpOnly; Max-Age=0' })
      return res.end()
    }
    else if (url === '/api/scan') { json(await cachedScan()) }
    // Csak a labor sajat mérése, semmi külső hívás — a dashboard 90 mp-enként kéri a
    // nyitott pozíció eszközére, tehát olcsónak kell lennie. A /api/dive ehhez képest
    // Hyperliquidet, Lighter-könyvet és Phoenixet is kérdez.
    // A mérési történet nyersen, hogy bárki letölthesse és maga is elemezhesse.
    else if (url === '/api/archive') {
      const napok = [...new Set(labHist.map((r) => new Date(r.ts).toISOString().slice(0, 10)))].sort()
      json({ days: napok, snapshots: labHist.length })
    }
    else if (url.startsWith('/api/archive/')) {
      const nap = url.slice(13).replace(/[^0-9-]/g, '')
      json({ rows: labHist.filter((r) => new Date(r.ts).toISOString().slice(0, 10) === nap) })
    }
    else if (url.startsWith('/api/series/')) { json(diveSeries(decodeURIComponent(url.slice(12)).toUpperCase())) }
    else if (url.startsWith('/api/dive/')) {
      // A dive() a lastVenues globálisból olvassa a hét venue APR-ját (lásd az
      // "Amit a táblából..." kommentet fentebb) — ezt KIZÁRÓLAG a scan() tölti fel.
      // Perzisztens szerveren ez sosem volt üres, mert a /api/scan mindig lefutott
      // előbb. Egy Vercel cold starton viszont a mélyfúrás lehet az ELSŐ kérés a
      // példányon, és lastVenues nélkül minden venue "not listed"-ként jött vissza.
      await ensureScan()
      const [path, qs] = url.slice(10).split('?')
      const leg = +new URLSearchParams(qs || '').get('leg') || 3000
      json(await dive(decodeURIComponent(path).toUpperCase().replace(/[^A-Z0-9]/g, ''), leg))
    }
    else if (url.startsWith('/api/data')) { await ensureScan(); json(buildPayload()) }
    else if (url === '/api/naplo' && req.method === 'GET') { const u = currentUser(req); json(await naploList(u && u.id)) }
    else if (url === '/api/naplo' && req.method === 'POST') {
      const u = currentUser(req)
      if (AUTH_ON && !u) return json({ error: 'sign in required' }, 401)
      const b = await readBody(req)
      // `kind`: 'scalp' (irányos, egy platform) vagy 'hedge' (delta-semleges funding-kör).
      // Csak a két ismert érték kerülhet be; bármi más esetén null marad, és a kliens
      // a megjegyzés szövegéből származtatja — ugyanúgy, mint a régi bejegyzéseknél.
      const kind = NAPLO_KINDS.includes(b.kind) ? b.kind : null
      const entry = { date: new Date().toISOString().slice(0, 16).replace('T', ' '), kind, pnl: b.pnl ?? null, note: (b.note || '').trim() }
      json({ ok: true, entry: await naploAdd(u && u.id, entry) })
    }
    else if (url === '/api/naplo/delete' && req.method === 'POST') {
      const u = currentUser(req)
      if (AUTH_ON && !u) return json({ error: 'sign in required' }, 401)
      const b = await readBody(req)
      // Supabase-módban SOR-AZONOSÍTÓ jön, nem tömbindex — és a törlés a
      // telegram_id-re is szűr, tehát idegen sorát senki nem tudja törölni.
      await naploDelete(u && u.id, b.id != null ? b.id : b.index)
      json({ ok: true })
    }
    else if (url === '/api/nyit' && req.method === 'POST') {
      const b = await readBody(req); await ensureScan(); const cfg = loadCfg()
      if ((cfg.mode || 'pair') === 'same') {
        const asset = cfg.same_asset || 'ENA'
        const vaN = cfg.same_va || 'Variational', vbN = cfg.same_vb || 'Ethereal'
        const A = venueData(vaN, asset), B = venueData(vbN, asset)
        if (!A || !B || A.apr == null || B.apr == null) return json({ error: `${asset} nem érhető el mindkét platformon (${vaN} / ${vbN})` }, 400)
        cfg.active_config = 'SAME'; cfg.entry_price_asset = A.price ?? B.price
        cfg.same_short_on = A.apr > B.apr ? vaN : vbN
        // A BELÉPŐ RÉS — enélkül a kör bázis-PnL-je (a rés elmozdulása dollárban) nem
        // számolható, csak a funding-akkumulátor látszik, ami mindig FELFELÉ megy.
        // Élesben ez négy KAITO-körön át félrevezetett: a funding mind a négyszer hozott
        // (+$31/+$29/+$19/+$18), a rés viszont háromszor elvitte (+$5/−$27/−$21/−$26),
        // tehát három nyerőnek látszó kör valójában veszteséges volt. Ugyanaz az irány
        // kell, mint a buildPayload `gap` mezőjének: (va ára − vb ára) / vb ára.
        cfg.entry_gap = priceGap(A.price, B.price)
        cfg.fund_acc = null   // új kör — a számláló nulláról indul
      } else {
        const which = String(b.cfg || 'A').toUpperCase()
        if (which !== 'A' && which !== 'B') return json({ error: 'cfg must be A or B' }, 400)
        cfg.active_config = which; cfg.entry_price_btc = markPrice('BTC'); cfg.entry_price_eth = markPrice('ETH')
      }
      saveCfg(cfg); json({ ok: true })
    }
    else if (url === '/api/zar' && req.method === 'POST') {
      const cfg = loadCfg(); cfg.active_config = null; cfg.entry_price_btc = null; cfg.entry_price_eth = null; cfg.entry_price_asset = null; cfg.same_short_on = null; cfg.entry_gap = null
      saveCfg(cfg); json({ ok: true })
    }
    else if (url === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req); const cfg = loadCfg()
      if (b.capital_v) cfg.capital_variational_usd = b.capital_v
      if (b.capital_m) cfg.capital_meridian_usd = b.capital_m
      if (b.margin_per_leg) cfg.margin_per_leg_usd = b.margin_per_leg
      if (b.leverage) cfg.leverage = b.leverage
      if (b.mode === 'pair' || b.mode === 'same') cfg.mode = b.mode
      if (b.same_asset) cfg.same_asset = String(b.same_asset).toUpperCase().trim()
      if (VENUE_OPTS.includes(b.same_va)) cfg.same_va = b.same_va
      if (VENUE_OPTS.includes(b.same_vb)) cfg.same_vb = b.same_vb
      // tárcacím: üresen hagyva kikapcsolja a pozíció-tükröt; csak érvényes címet fogadunk el
      if (typeof b.wallet === 'string') { const w = b.wallet.trim(); if (w === '' || /^0x[0-9a-fA-F]{40}$/.test(w)) cfg.wallet = w }
      saveCfg(cfg); json({ ok: true })
    }
    else { res.writeHead(404); res.end('not found') }
  } catch (e) { json({ error: e.message }, 500) }
}

// Helyben (`node server.js`) valódi szervert indít. Vercelen require.main !== module
// — ott az api/index.js importálja a handlert, .listen() nélkül.
if (require.main === module) {
  http.createServer(handler).listen(PORT, () => console.log(`⚗ Hedge Lab demo → http://localhost:${PORT}`))
}
module.exports = handler
