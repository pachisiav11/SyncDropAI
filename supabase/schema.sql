create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  filename_ai text not null,
  filename_original text not null,
  storage_path text not null unique,
  mime_type text,
  size bigint not null check (size >= 0),
  uploaded_from text not null check (uploaded_from in ('windows', 'android', 'web')),
  created_at timestamptz not null default now()
);

alter table public.files enable row level security;

create policy "users can read their own files"
  on public.files for select
  using (auth.uid() = user_id);

create policy "users can insert their own files"
  on public.files for insert
  with check (auth.uid() = user_id);

create policy "users can delete their own files"
  on public.files for delete
  using (auth.uid() = user_id);

create index if not exists files_user_created_at_idx
  on public.files (user_id, created_at desc);

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
