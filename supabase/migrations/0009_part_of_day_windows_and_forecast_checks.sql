-- 0009: (1) every window per spot, so the app can show the best morning / day / evening / night;
--       (2) daily forecast-vs-measured checks, kept for the learning layer.
-- Safe to run more than once.

-- ── 1. forecast checks ───────────────────────────────────────────────────────
-- One row per day, kind and station. `summary` has the bias (forecast minus measured) and
-- mean absolute error; `pairs` keeps every forecast/measured pair it was worked out from.
create table if not exists forecast_checks (
  check_date  date not null,
  kind        text not null check (kind in ('wind', 'wave', 'tide')),
  station     text not null,
  spot_id     text,
  n           int  not null default 0,
  summary     jsonb not null default '{}'::jsonb,
  pairs       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  primary key (check_date, kind, station)
);
alter table forecast_checks enable row level security;
drop policy if exists read_forecast_checks on forecast_checks;
create policy read_forecast_checks on forecast_checks for select to authenticated using (true);

-- ── 2. best window per spot, plus every other window in the range ────────────
-- The scorer now writes one window per part of the day (morning / day / evening / night),
-- slid to the best 3 hours. A spot's rating is still the average of its species, but species
-- in a closed season no longer drag it down.
drop function if exists best_spot_windows(text[], timestamptz, timestamptz);
create function best_spot_windows(p_spots text[], p_from timestamptz, p_to timestamptz)
returns table (
  spot_id      text,
  block_start  timestamptz,
  block_hours  int,
  top_score    numeric,
  p_any        numeric,
  safety       text,
  safety_text  text,
  species      jsonb,
  windows      jsonb
)
language sql stable security invoker as $$
  with blocks as (
    select f.spot_id,
           f.block_start,
           max(f.block_hours)                                              as block_hours,
           coalesce(round(avg(f.score) filter (
             where not f.regulations @> '[{"action": "closed"}]'::jsonb), 1), 0) as top_score,
           max(f.p_success)                                                as p_any,
           case when bool_or(f.safety = 'caution') then 'caution' else 'ok' end as safety,
           max(f.safety_text)                                              as safety_text,
           max(f.conditions ->> 'part')                                    as part,
           max(f.conditions ->> 'comfort')                                 as comfort,
           jsonb_agg(jsonb_build_object(
             'species_id', f.species_id, 'score', f.score, 'p_success', f.p_success,
             'reasons', f.reasons, 'regulations', f.regulations, 'conditions', f.conditions
           ) order by f.score desc)                                        as species
    from forecast_scores f
    where f.spot_id = any(p_spots)
      and f.block_start >= p_from and f.block_start < p_to
      and f.safety <> 'no_go'
    group by f.spot_id, f.block_start
  ),
  ranked as (
    select b.*, row_number() over (partition by b.spot_id order by b.top_score desc, b.block_start) as rn
    from blocks b
  )
  select r.spot_id, r.block_start, r.block_hours, r.top_score, r.p_any, r.safety, r.safety_text, r.species,
         (select jsonb_agg(jsonb_build_object('block_start', w.block_start, 'block_hours', w.block_hours,
                                              'score', w.top_score, 'part', w.part, 'comfort', w.comfort) order by w.block_start)
          from blocks w where w.spot_id = r.spot_id) as windows
  from ranked r
  where r.rn = 1
$$;
grant execute on function best_spot_windows(text[], timestamptz, timestamptz) to authenticated;
