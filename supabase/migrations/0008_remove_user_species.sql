-- 0008: allow removing species you added yourself (the app only offers this when there are
-- no photos of that species; any photo-less catch records of it are removed first).
drop policy if exists user_species_delete on species;
create policy user_species_delete on species for delete to authenticated using (source = 'user');
