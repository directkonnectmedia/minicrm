-- Mini CRM schema. Paste this into Supabase SQL Editor and Run.

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  client_name text,
  business_type text,
  phone text,
  profile_link text,
  post_link text,
  finished_website text,
  notes text,
  manager text,
  follow_up_date date,
  client_status text not null default 'New Lead'
    check (client_status in (
      'New Lead','Contacted','Interested','Proposal Sent',
      'Negotiation','Follow Up','Closed Won','Closed Lost','Nurture'
    )),
  status text not null default 'Prospect'
    check (status in ('Finished', 'In Progress', 'Prospect', 'Dead Lead')),
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
alter table public.clients add column if not exists finished_website text;

-- Expand status options to include 'Dead Lead'.
alter table public.clients drop constraint if exists clients_status_check;
alter table public.clients add constraint clients_status_check
  check (status in ('Finished', 'In Progress', 'Prospect', 'Dead Lead'));

-- Rename old source link to profile_link (preserves existing data).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'link'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'profile_link'
  ) then
    alter table public.clients rename column link to profile_link;
  end if;
end $$;

alter table public.clients add column if not exists profile_link text;
alter table public.clients add column if not exists post_link text;

-- Follow-up date for calendar/overdue tracking.
alter table public.clients add column if not exists follow_up_date date;

-- Client status (sales pipeline stage).
alter table public.clients add column if not exists client_status text not null default 'New Lead';
alter table public.clients drop constraint if exists clients_client_status_check;
alter table public.clients add constraint clients_client_status_check
  check (client_status in (
    'New Lead','Contacted','Interested','Proposal Sent',
    'Negotiation','Follow Up','Closed Won','Closed Lost','Nurture'
  ));
