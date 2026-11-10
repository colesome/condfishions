-- 0006: tide curves per spot (for the Tide tab) and "other good times" per spot.

create table if not exists tides (
  spot_id     text primary key references spots(id) on delete cascade,
  run_id      text,
  updated_at  timestamptz not null default now(),
  series      jsonb not null,   -- [[iso_time, height_m], ...] hourly, modelled sea level
  extremes    jsonb not null    -- [[iso_time, "high"|"low", height_m], ...]
);
alter table tides enable row level security;
drop policy if exists read_tides on tides;
create policy read_tides on tides for select to authenticated using (true);

-- Best block per spot in a window (rating = average of its species), plus the best block on
-- each OTHER day in the window, so you can see if a better time is coming.
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
  alt_blocks   jsonb
)
language sql stable security invoker as $$
  with blocks as (
    select f.spot_id,
           f.block_start,
           max(f.block_hours)                                              as block_hours,
           round(avg(f.score), 1)                                          as top_score,
           max(f.p_success)                                                as p_any,
           case when bool_or(f.safety = 'caution') then 'caution' else 'ok' end as safety,
           max(f.safety_text)                                              as safety_text,
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
    select b.*,
           (b.block_start at time zone 'Australia/Brisbane')::date as day,
           row_number() over (partition by b.spot_id order by b.top_score desc, b.block_start) as rn
    from blocks b
  ),
  best_per_day as (
    select distinct on (r.spot_id, r.day) r.spot_id, r.day, r.block_start, r.block_hours, r.top_score
    from ranked r
    order by r.spot_id, r.day, r.top_score desc, r.block_start
  )
  select r.spot_id, r.block_start, r.block_hours, r.top_score, r.p_any, r.safety, r.safety_text,
         r.species,
         coalesce((
           select jsonb_agg(jsonb_build_object('block_start', d.block_start, 'block_hours', d.block_hours,
                                               'score', d.top_score) order by d.top_score desc)
           from (select * from best_per_day d0
                 where d0.spot_id = r.spot_id and d0.day <> r.day
                 order by d0.top_score desc limit 3) d
         ), '[]'::jsonb) as alt_blocks
  from ranked r
  where r.rn = 1
$$;
grant execute on function best_spot_windows(text[], timestamptz, timestamptz) to authenticated;
