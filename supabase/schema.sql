-- FadeBot schema. Run in Supabase SQL Editor.

create table if not exists whales (
  address        text primary key,          -- lowercase 0x proxy wallet
  name           text,
  profile_image  text,
  tier           text not null default 'neutral',  -- smart | fade | neutral
  win_rate       numeric,
  streak         int not null default 0,           -- + win streak / - loss streak
  closed_count   int not null default 0,
  total_pnl      numeric not null default 0,
  lb_pnl         numeric,
  lb_vol         numeric,
  updated_at     timestamptz not null default now()
);

create table if not exists tg_users (
  tg_id       bigint primary key,
  username    text,
  pm_address  text,                                -- linked Polymarket wallet (read-only)
  created_at  timestamptz not null default now()
);

create table if not exists follows (
  tg_id          bigint not null references tg_users(tg_id) on delete cascade,
  whale_address  text   not null references whales(address) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (tg_id, whale_address)
);

create table if not exists seen_events (
  id          text primary key,                    -- tx hash
  created_at  timestamptz not null default now()
);

create index if not exists idx_whales_tier on whales(tier);
create index if not exists idx_follows_whale on follows(whale_address);

-- App only talks to the DB through the service-role key on the server,
-- so lock everything down for anon/authenticated roles.
alter table whales enable row level security;
alter table tg_users enable row level security;
alter table follows enable row level security;
alter table seen_events enable row level security;
