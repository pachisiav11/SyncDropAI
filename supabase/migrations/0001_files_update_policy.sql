-- Enables `syncdrop rename` (and any future metadata edits) by allowing an
-- authenticated user to UPDATE their own rows in public.files. The original
-- schema only granted select/insert/delete, so UPDATEs were rejected.
--
-- Safe to run against an already-deployed database. Run once in the Supabase
-- SQL editor (or via the CLI) if your project predates this change.

grant update on public.files to authenticated;

drop policy if exists "users can update their own files" on public.files;

create policy "users can update their own files"
  on public.files for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
