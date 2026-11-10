-- 0003: spot-first recommendations.
-- For each spot, the best 3-hour block in a time window, with every species' score in that
-- block. Block quality = the best species score; p_any = the best single-species chance of
-- catching at least one (not combined across species, which would overstate certainty).

create or replace function best_spot_windows(p_spots text[], p_from timestamptz, p_to timestamptz)
returns table (
  spot_id      text,
  block_start  timestamptz,
  block_hours  int,
  top_score    numeric,
  p_any        numeric,
  safety       text,
  safety_text  text,
  species      jsonb
)
language sql stable security invoker as $$
  with blocks as (
    select f.spot_id,
           f.block_start,
           max(f.block_hours)                                              as block_hours,
           max(f.score)                                                    as top_score,
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
  )
  select distinct on (b.spot_id) b.*
  from blocks b
  order by b.spot_id, b.top_score desc, b.block_start
$$;
grant execute on function best_spot_windows(text[], timestamptz, timestamptz) to authenticated;
