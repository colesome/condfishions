-- 0010: booked fishing slots (with change alerts), bait/lure on catches, editing finished trips
-- and logging trips after the fact. Safe to run more than once.

-- ── 1. Bait or lure for each catch ───────────────────────────────────────────
-- catches.method already exists (free text, never used): it now holds 'bait' or 'lure'.
-- tackle is which one, e.g. 'Prawn', 'Soft plastic'.
alter table catches add column if not exists tackle text;
do $$ begin
  alter table catches add constraint catches_method_check check (method is null or method in ('bait', 'lure'));
exception when duplicate_object then null; end $$;

-- ── 2. Trips: logged afterwards, edited times, rating for the actual time ────
alter table sessions add column if not exists logged_after boolean not null default false;
alter table sessions add column if not exists times_edited_at timestamptz;
-- Worked out overnight from measured conditions for the trip's real hours (after an edit too).
-- score_shown stays what the app showed before the trip; this is the hindsight rating.
alter table sessions add column if not exists score_at_time numeric;
alter table sessions add column if not exists score_at_time_version text;

-- ── 3. Booked slots ──────────────────────────────────────────────────────────
create table if not exists planned_trips (
  id                 uuid primary key default gen_random_uuid(),
  spot_id            text not null references spots(id) on delete cascade,
  block_start        timestamptz not null,
  block_hours        int not null default 3,
  part               text,
  -- what the app showed when you booked
  score_booked       numeric,
  safety_booked      text,
  conditions_booked  jsonb not null default '{}'::jsonb,
  -- latest check by the scorer (every run)
  score_now          numeric,
  safety_now         text,
  safety_text_now    text,
  conditions_now     jsonb,
  checked_at         timestamptz,
  changes            jsonb not null default '[]'::jsonb,   -- [{kind, severity, text}] vs booking
  alert_level        int not null default 0,              -- highest severity already pushed
  alerted_kinds      text[] not null default '{}',
  alerted_at         timestamptz,
  seen_at            timestamptz,                          -- you opened it in the app after the last alert
  status             text not null default 'planned' check (status in ('planned', 'done', 'cancelled', 'past')),
  session_id         uuid references sessions(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists planned_trips_upcoming_idx on planned_trips (status, block_start);
alter table sessions add column if not exists planned_trip_id uuid references planned_trips(id) on delete set null;

alter table planned_trips enable row level security;
drop policy if exists rw_planned_trips on planned_trips;
create policy rw_planned_trips on planned_trips for all to authenticated using (true) with check (true);

-- ── 4. Calendar files ────────────────────────────────────────────────────────
-- The app uploads a small .ics per booking and opens a signed link, which iPhone hands
-- straight to Calendar ("Add to Calendar").
insert into storage.buckets (id, name, public) values ('calendar', 'calendar', false) on conflict do nothing;
drop policy if exists calendar_rw on storage.objects;
create policy calendar_rw on storage.objects for all to authenticated
  using (bucket_id = 'calendar') with check (bucket_id = 'calendar');
