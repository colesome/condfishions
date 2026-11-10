-- CondFishions — initial schema (Supabase / Postgres)
-- Run once in the Supabase SQL editor (or `supabase db push`).
-- Single-user app: after creating your own login, turn OFF sign-ups in
-- Authentication → Providers → Email so nobody else can create an account.

create extension if not exists pgcrypto;

-- ── Settings (single row, editable from the app) ───────────────────────────────
create table if not exists settings (
  id              int primary key default 1 check (id = 1),
  home_name       text not null default 'Brisbane CBD',
  home_lat        double precision not null default -27.4698,
  home_lon        double precision not null default 153.0251,
  max_travel_min  int not null default 120,
  updated_at      timestamptz not null default now()
);
insert into settings (id) values (1) on conflict do nothing;

-- ── Reference data (synced from config/*.yaml every scoring run) ───────────────
create table if not exists species (
  id         text primary key,
  name       text not null,
  base_rate  numeric not null,
  notes      text,
  rules      jsonb not null
);

create table if not exists spots (
  id         text primary key,
  name       text not null,
  region     text,
  state      text check (state in ('QLD','NSW')),
  lat        double precision not null,
  lon        double precision not null,
  type       text not null,
  tidal      boolean not null,
  facing     numeric,
  shelter    numeric,
  swell_max  numeric,
  extra_min  int default 0,
  access     text,
  permit     text,
  species    text[] not null,
  verified   boolean default false
);

-- ── Forecast scoring ───────────────────────────────────────────────────────────
create table if not exists runs (
  run_id           text primary key,
  created_at       timestamptz not null,
  model_version    text not null,
  feature_version  text not null,
  git_sha          text,
  n_scores         int,
  problems         jsonb,
  archived         boolean default false
);

-- Latest scores only (overwritten each run; old blocks deleted).
create table if not exists forecast_scores (
  spot_id        text not null references spots(id) on delete cascade,
  species_id     text not null references species(id) on delete cascade,
  block_start    timestamptz not null,
  block_hours    int not null,
  best_hour      timestamptz,
  score          numeric not null,
  p_success      numeric not null,
  safety         text not null check (safety in ('ok','caution','no_go')),
  safety_text    text,
  reasons        jsonb,
  regulations    jsonb,
  conditions     jsonb,
  model_version  text not null,
  run_id         text references runs(run_id) on delete set null,
  primary key (spot_id, species_id, block_start)
);
create index if not exists forecast_scores_block_idx on forecast_scores (block_start, score desc);

-- Daily snapshot of what the forecast said for the next 24 h, per spot (including
-- days you don't fish — this is what lets us measure selection bias later).
create table if not exists forecast_archive (
  run_date         date not null,
  spot_id          text not null references spots(id) on delete cascade,
  run_id           text references runs(run_id) on delete set null,
  feature_version  text not null,
  blocks           jsonb not null,
  tide_extremes    jsonb,
  primary key (run_date, spot_id)
);

-- ── Suggestions & sessions (written by the phone app) ──────────────────────────
create table if not exists suggestions (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  user_lat          double precision,
  user_lon          double precision,
  species_id        text references species(id),
  window_start      timestamptz,
  window_end        timestamptz,
  ranked            jsonb not null,        -- [{spot_id, species_id, block_start, score, p_success, rank}]
  wildcard_spot_id  text references spots(id),
  model_version     text not null
);

create table if not exists sessions (
  id                   uuid primary key default gen_random_uuid(),
  client_id            text unique,          -- generated on the phone; makes offline sync idempotent
  spot_id              text not null references spots(id),
  start_ts             timestamptz not null,
  end_ts               timestamptz,
  targeted_species     text[] not null default '{}',
  method               text check (method in ('lure','bait','fly','mixed')),
  rig                  text,
  intensity            text check (intensity in ('casual','focused')),
  why_went             text check (why_went in ('forecast_good','suggested','convenient','random','social','other')),
  suggestion_id        uuid references suggestions(id),
  chosen_rank          int,
  followed_suggestion  boolean,
  score_shown          numeric,              -- baseline score shown at check-in (logged BEFORE the outcome)
  p_shown              numeric,
  model_version_shown  text,
  checkin_lat          double precision,
  checkin_lon          double precision,
  checkin_accuracy_m   numeric,
  anglers              int default 1,
  skunked              boolean,              -- explicit "caught nothing" (null = not finished)
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists sessions_spot_idx on sessions (spot_id, start_ts);

create table if not exists catches (
  id              uuid primary key default gen_random_uuid(),
  client_id       text unique,
  session_id      uuid not null references sessions(id) on delete cascade,
  species_id      text not null references species(id),
  count           int not null default 1 check (count >= 0),
  kept            int default 0,
  released        int default 0,
  max_length_cm   numeric,
  legal_size      boolean,
  caught_at       timestamptz,
  method          text,
  created_at      timestamptz not null default now()
);

create table if not exists photos (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id) on delete cascade,
  catch_id      uuid references catches(id) on delete set null,
  storage_path  text not null,               -- photos bucket
  taken_at      timestamptz,
  lat           double precision,
  lon           double precision,
  created_at    timestamptz not null default now()
);

create table if not exists observed_conditions (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id) on delete cascade,
  source      text not null check (source in ('angler','archive','buoy','gauge','river_gauge')),
  vals        jsonb not null,  -- angler: clarity, wind_feel, swell_feel, current, bait_present...
  created_at  timestamptz not null default now()
);

create table if not exists model_registry (
  model_version  text primary key,
  trained_at     timestamptz not null default now(),
  n_sessions     int,
  metrics        jsonb,         -- forward-chained Brier / log-loss vs baseline, with CIs
  status         text not null check (status in ('champion','challenger','retired')),
  params         jsonb,
  notes          text
);
insert into model_registry (model_version, status, notes)
values ('baseline_v1', 'champion', 'Rules from config/species.yaml')
on conflict do nothing;

create table if not exists push_subscriptions (
  endpoint    text primary key,
  keys        jsonb not null,
  created_at  timestamptz not null default now()
);

-- One row per (session × targeted species): the unit we evaluate on.
create or replace view session_outcomes as
select s.id as session_id, s.spot_id, s.start_ts, s.end_ts,
       extract(epoch from (s.end_ts - s.start_ts)) / 3600.0 as hours_fished,
       t.species_id, s.method, s.intensity, s.why_went, s.followed_suggestion,
       s.score_shown, s.p_shown,
       coalesce(sum(c.count), 0) as n_caught,
       coalesce(sum(c.count), 0) > 0 as success
from sessions s
cross join lateral unnest(s.targeted_species) as t(species_id)
left join catches c on c.session_id = s.id and c.species_id = t.species_id
where s.end_ts is not null
group by s.id, t.species_id;

-- ── Row-level security ────────────────────────────────────────────────────────
-- The scoring job uses the service key (bypasses RLS). The phone app signs in as you.
do $$
declare t text;
begin
  foreach t in array array['settings','species','spots','runs','forecast_scores','forecast_archive',
                           'suggestions','sessions','catches','photos','observed_conditions',
                           'model_registry','push_subscriptions']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
  foreach t in array array['species','spots','runs','forecast_scores','forecast_archive','model_registry']
  loop
    execute format('drop policy if exists read_%1$s on %1$I', t);
    execute format('create policy read_%1$s on %1$I for select to authenticated using (true)', t);
  end loop;
  foreach t in array array['settings','suggestions','sessions','catches','photos',
                           'observed_conditions','push_subscriptions']
  loop
    execute format('drop policy if exists rw_%1$s on %1$I', t);
    execute format('create policy rw_%1$s on %1$I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ── Storage buckets (private) ─────────────────────────────────────────────────
insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict do nothing;
insert into storage.buckets (id, name, public) values ('raw', 'raw', false) on conflict do nothing;

drop policy if exists photos_rw on storage.objects;
create policy photos_rw on storage.objects for all to authenticated
  using (bucket_id = 'photos') with check (bucket_id = 'photos');
