-- 0007: species you add from the app ("Other…" when logging a catch).
alter table species add column if not exists source text not null default 'config'
  check (source in ('config','user'));

drop policy if exists user_species_insert on species;
create policy user_species_insert on species for insert to authenticated with check (source = 'user');
drop policy if exists user_species_update on species;
create policy user_species_update on species for update to authenticated
  using (source = 'user') with check (source = 'user');
