-- Hedge Lab demo — Supabase schema.
-- Run once in the Supabase SQL editor.
--
-- Only the server talks to these tables, using the service key, and it always
-- filters by telegram_id. The browser never holds a Supabase key, so there is
-- no client-side path to another user's rows.

create table if not exists users (
  telegram_id text primary key,
  username    text,
  first_name  text,
  created_at  timestamptz not null default now()
);

create table if not exists journal (
  id          bigint generated always as identity primary key,
  telegram_id text not null references users(telegram_id) on delete cascade,
  kind        text,                       -- 'hedge' | 'hiba'
  pnl         numeric,                    -- the round's net result in USD
  note        text,
  created_at  timestamptz not null default now()
);

-- The journal is always read for one user at a time, newest last.
create index if not exists journal_user_idx on journal (telegram_id, id);

-- RLS is on with no policies: the anon key can reach nothing at all, while the
-- service key the server uses bypasses RLS. If the anon key ever leaks, the
-- tables stay closed.
alter table users   enable row level security;
alter table journal enable row level security;

-- ── A felhasználó beállítása és nyitott köre ──────────────────────────────
-- Ugyanaz a séma, mint a naplónál: telegram_id-hez kötve, a szerver mindig
-- arra szűr. Enélkül a config a szerver memóriájában élt, és egy újraindítás
-- (Vercelen minden cold start) elfelejtette a nyitott kört a belépő árával,
-- belépő résével és a nyitás idejével együtt.
create table if not exists user_config (
  telegram_id text primary key references users(telegram_id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ── A mérési történet ─────────────────────────────────────────────────────
-- Ez NEM felhasználói adat: a funding és az árak mindenkinek ugyanazok, tehát
-- közös tábla, telegram_id nélkül.
--
-- Óránként EGY sor, nem egyetlen nagy JSON. Egy pillanatkép ~46 kB, és egy
-- közös tömböt óránként újraírni napok alatt megabájtokat mozgatna; így minden
-- órában egy kis beszúrás megy. Az óra a kulcs, tehát ugyanaz az óra kétszer
-- nem kerülhet be, akkor sem, ha két példány futna egyszerre.
create table if not exists lab_snapshot (
  hour text primary key,          -- '2026-08-31T19' — UTC óra
  ts   bigint not null,           -- epoch ms, ebből megy a 30 napos szűrés
  d    jsonb  not null            -- { SZIMBÓLUM: { v,e,n,l,a,g,r,x, pv,pl,pn,… } }
);
create index if not exists lab_snapshot_ts_idx on lab_snapshot (ts);

-- Ugyanaz a védelem, mint fent: RLS bekapcsolva, policy nélkül. Az anon kulcs
-- semmit nem ér el, a szerver service kulcsa megkerüli.
alter table user_config  enable row level security;
alter table lab_snapshot enable row level security;
