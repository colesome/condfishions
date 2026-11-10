-- 0002: changeable home/range with saved places, user-added spots, fast suggestion query.

-- Saved places (e.g. Home, Holiday house) — the active one is home_* on settings.
alter table settings add column if not exists saved_places jsonb not null
  default '[{"name":"Brisbane CBD","lat":-27.4698,"lon":153.0251,"max_travel_min":120}]'::jsonb;

-- Spots can come from config/spots.yaml ('config') or be added in the app ('user').
alter table spots add column if not exists source text not null default 'config'
  check (source in ('config','user'));
alter table spots add column if not exists created_at timestamptz not null default now();
alter table spots drop constraint if exists spots_state_check;   -- allow holidays outside QLD/NSW

drop policy if exists user_spots_insert on spots;
create policy user_spots_insert on spots for insert to authenticated with check (source = 'user');
drop policy if exists user_spots_update on spots;
create policy user_spots_update on spots for update to authenticated
  using (source = 'user') with check (source = 'user');
drop policy if exists user_spots_delete on spots;
create policy user_spots_delete on spots for delete to authenticated using (source = 'user');

-- Best (non no-go) block per spot × species inside a time window. Keeps phone data
-- usage tiny: ~1 row per spot-species instead of every 3-hour block.
create or replace function best_blocks(p_spots text[], p_species text[],
                                       p_from timestamptz, p_to timestamptz)
returns setof forecast_scores
language sql stable security invoker as $$
  select distinct on (spot_id, species_id) *
  from forecast_scores
  where spot_id = any(p_spots)
    and (p_species is null or species_id = any(p_species))
    and block_start >= p_from and block_start < p_to
    and safety <> 'no_go'
  order by spot_id, species_id, score desc, block_start
$$;
grant execute on function best_blocks(text[], text[], timestamptz, timestamptz) to authenticated;
