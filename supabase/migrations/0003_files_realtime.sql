-- Streams public.files row changes to signed-in clients, so the desktop app can
-- show a phone upload the moment it lands and show the AI name the moment the
-- worker writes it. Before this the list was only ever a snapshot taken when the
-- app opened, so uploads from the phone appeared to arrive only at startup.
--
-- Safe to run against an already-deployed database, and safe to re-run. Run once
-- in the Supabase SQL editor (or via the CLI). Without it the app still works:
-- the live subscription reports an error and the client falls back to refreshing
-- when the app opens or the naming worker reports in.

-- Realtime only publishes tables that belong to this publication, and files is
-- not one of them by default.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  alter publication supabase_realtime add table public.files;
exception
  when duplicate_object then null; -- already published
end $$;

-- Ship the whole old row on update/delete. Realtime checks it against the RLS
-- select policy before delivering, and applies the client's user_id filter to
-- it; the default replica identity carries only the primary key, so there is no
-- user_id to check or match and those events are dropped instead of sent.
alter table public.files replica identity full;
