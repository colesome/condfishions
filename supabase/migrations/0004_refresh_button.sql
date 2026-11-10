-- 0004: "Refresh now" button without any command-line setup.
-- The app calls request_rescore(); Postgres asks GitHub to start the scoring workflow.
--
-- One-off setup (SQL editor):
--   1. Run this file.
--   2. Create a fine-grained GitHub token: repository access = only condfishions,
--      permission "Actions: Read and write". Then store it (replace the placeholder):
--        select vault.create_secret('github_pat_XXXX', 'github_token');
--   To replace a token later:
--        select vault.update_secret((select id from vault.secrets where name = 'github_token'), 'github_pat_NEW');

create extension if not exists pg_net with schema extensions;

create table if not exists rescore_requests (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now()
);
alter table rescore_requests enable row level security;   -- no policies: only the function touches it

create or replace function request_rescore() returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  tok text;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_token' limit 1;
  if tok is null then
    return 'not_configured';
  end if;
  -- at most one request every 5 minutes
  if exists (select 1 from rescore_requests where created_at > now() - interval '5 minutes') then
    return 'requested';
  end if;
  insert into rescore_requests default values;
  perform net.http_post(
    url     := 'https://api.github.com/repos/colesome/condfishions/actions/workflows/score.yml/dispatches',
    body    := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'condfishions',
      'Content-Type', 'application/json')
  );
  return 'requested';
end;
$$;

revoke all on function request_rescore() from public, anon;
grant execute on function request_rescore() to authenticated;
