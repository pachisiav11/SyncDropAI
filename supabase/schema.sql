create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  filename_ai text not null,
  filename_original text not null,
  storage_path text not null unique,
  mime_type text,
  size bigint not null check (size >= 0),
  uploaded_from text not null check (uploaded_from in ('windows', 'android', 'web')),
  -- Set at upload when auto-rename is on; a local worker on the desktop names the
  -- file from its content later and clears this. See migration 0002.
  rename_requested boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.files enable row level security;

grant select, insert, update, delete on public.files to authenticated;

create policy "users can read their own files"
  on public.files for select
  using (auth.uid() = user_id);

create policy "users can insert their own files"
  on public.files for insert
  with check (auth.uid() = user_id);

create policy "users can update their own files"
  on public.files for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users can delete their own files"
  on public.files for delete
  using (auth.uid() = user_id);

create index if not exists files_user_created_at_idx
  on public.files (user_id, created_at desc);

-- Partial index: the naming worker only ever scans rows still awaiting a name.
create index if not exists files_rename_requested_idx
  on public.files (rename_requested)
  where rename_requested;

-- Create a private Supabase Storage bucket named "files" separately.
-- Client uploads use paths shaped as: {auth.uid()}/{file-id}-{filename}

create policy "users can read their own storage objects"
  on storage.objects for select
  using (
    bucket_id = 'files'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "users can upload their own storage objects"
  on storage.objects for insert
  with check (
    bucket_id = 'files'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "users can delete their own storage objects"
  on storage.objects for delete
  using (
    bucket_id = 'files'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
