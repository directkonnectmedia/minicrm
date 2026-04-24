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
  client_notes jsonb not null default '[]'::jsonb,
  web_notes jsonb not null default '[]'::jsonb,
  manager text,
  follow_up_at timestamptz,
  follow_up_type text not null default 'Follow-up'
    check (follow_up_type in ('Follow-up', 'Appointment')),
  client_status text not null default 'New Lead'
    check (client_status in (
      'New Lead','Contacted','Interested','Proposal Sent',
      'Negotiation','Follow Up','Closed Won','Closed Lost','Nurture'
    )),
  web_status text not null default 'Not Started'
    check (web_status in ('Not Started', 'In Progress', 'Review', 'Needs Fixing', 'Finished')),
  motivation text not null default 'Not Set'
    check (motivation in ('Not Set', 'Dead', 'Cold', 'Warm', 'Hot', 'VIP')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clients enable row level security;

-- No-auth v1: allow anon role full access.
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

-- =============================================================
-- MIGRATIONS (safe to re-run on an existing database)
-- =============================================================

-- --- Previously established columns (kept for idempotency) ---
alter table public.clients add column if not exists business_type text;
alter table public.clients add column if not exists manager text;
alter table public.clients add column if not exists finished_website text;
alter table public.clients add column if not exists post_link text;

-- Rename old source link to profile_link if it still exists.
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

-- Client status pipeline.
alter table public.clients add column if not exists client_status text not null default 'New Lead';
alter table public.clients drop constraint if exists clients_client_status_check;
alter table public.clients add constraint clients_client_status_check
  check (client_status in (
    'New Lead','Contacted','Interested','Proposal Sent',
    'Negotiation','Follow Up','Closed Won','Closed Lost','Nurture'
  ));

-- =============================================================
-- NEW IN THIS RELEASE
-- =============================================================

-- Rename status -> web_status (data preserved). Drop old check first.
alter table public.clients drop constraint if exists clients_status_check;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'status'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'web_status'
  ) then
    alter table public.clients rename column status to web_status;
  end if;
end $$;

-- Ensure web_status exists; relabel 'Prospect' -> 'Not Started'.
alter table public.clients add column if not exists web_status text not null default 'Not Started';
update public.clients set web_status = 'Not Started' where web_status = 'Prospect';
alter table public.clients alter column web_status set default 'Not Started';
alter table public.clients drop constraint if exists clients_web_status_check;
alter table public.clients add constraint clients_web_status_check
  check (web_status in ('Not Started', 'In Progress', 'Review', 'Needs Fixing', 'Finished'));

-- Motivation (lead temperature).
alter table public.clients add column if not exists motivation text not null default 'Not Set';
alter table public.clients drop constraint if exists clients_motivation_check;
alter table public.clients add constraint clients_motivation_check
  check (motivation in ('Not Set', 'Dead', 'Cold', 'Warm', 'Hot', 'VIP'));

-- Convert notes (text) -> client_notes (jsonb array of {at, text}).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'notes'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'client_notes'
  ) then
    alter table public.clients rename column notes to client_notes_text;
    alter table public.clients add column client_notes jsonb not null default '[]'::jsonb;
    update public.clients
      set client_notes = jsonb_build_array(
            jsonb_build_object('at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                               'text', client_notes_text)
          )
      where client_notes_text is not null and btrim(client_notes_text) <> '';
    alter table public.clients drop column client_notes_text;
  end if;
end $$;
alter table public.clients add column if not exists client_notes jsonb not null default '[]'::jsonb;

-- New web_notes field (jsonb array).
alter table public.clients add column if not exists web_notes jsonb not null default '[]'::jsonb;

-- Convert follow_up_date (date) -> follow_up_at (timestamptz @ 09:00 local).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'follow_up_date'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'follow_up_at'
  ) then
    alter table public.clients add column follow_up_at timestamptz;
    update public.clients
      set follow_up_at = (follow_up_date::timestamp + interval '9 hours') at time zone 'UTC'
      where follow_up_date is not null;
    alter table public.clients drop column follow_up_date;
  end if;
end $$;
alter table public.clients add column if not exists follow_up_at timestamptz;

-- Follow-up type toggle (Follow-up vs Appointment).
alter table public.clients add column if not exists follow_up_type text not null default 'Follow-up';
alter table public.clients drop constraint if exists clients_follow_up_type_check;
alter table public.clients add constraint clients_follow_up_type_check
  check (follow_up_type in ('Follow-up', 'Appointment'));
