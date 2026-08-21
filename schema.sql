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
