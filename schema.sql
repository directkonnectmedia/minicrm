-- Mini CRM schema. Paste this into Supabase SQL Editor and Run.

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  client_name text,
  business_type text,
  phone text,
  link text,
  notes text,
  manager text,
  status text not null default 'Prospect'
    check (status in ('Finished', 'In Progress', 'Prospect')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clients enable row level security;

-- No-auth v1: allow anon role full access.
-- Swap these for auth-gated policies when you add login.
create policy "anon read"   on public.clients for select to anon using (true);
create policy "anon insert" on public.clients for insert to anon with check (true);
create policy "anon update" on public.clients for update to anon using (true) with check (true);
create policy "anon delete" on public.clients for delete to anon using (true);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create trigger clients_set_updated_at
before update on public.clients
for each row execute function public.set_updated_at();

-- Migrations (safe to re-run): add new columns to existing tables.
alter table public.clients add column if not exists business_type text;
alter table public.clients add column if not exists manager text;
