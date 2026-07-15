-- Adds `rename_requested` so naming can be DEFERRED: an upload lands with its
-- original filename and sets this flag; a local worker on the desktop (the
-- `syncdrop autoname` pass, or the Electron app's background poll) later claims
-- flagged rows, generates a name with a local vision model, writes filename_ai,
-- and clears the flag. This lets phone uploads get real names whenever the
-- desktop is next online, with zero API cost.
--
-- Safe to run against an already-deployed database. Run once in the Supabase
-- SQL editor (or via the CLI). The column defaults to false so existing rows
-- and any client that doesn't set it are simply never picked up by the worker.

alter table public.files
  add column if not exists rename_requested boolean not null default false;

-- The worker scans for pending rows; keep that lookup cheap. Partial index so it
-- only tracks the handful of rows actually awaiting naming.
create index if not exists files_rename_requested_idx
  on public.files (rename_requested)
  where rename_requested;
