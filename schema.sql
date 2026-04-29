-- Mini CRM schema. Paste this into Supabase SQL Editor and Run.

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  client_name text,
  business_type text,
  phone text,
  email text,
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

-- No-auth v1 anon policies. Created here for fresh installs; the TEAM AUTH
-- LOCKDOWN block at the bottom drops them and replaces with authenticated-only.
-- Wrapped in drop-if-exists so re-running the whole file never errors.
drop policy if exists "anon read"   on public.clients;
drop policy if exists "anon insert" on public.clients;
drop policy if exists "anon update" on public.clients;
drop policy if exists "anon delete" on public.clients;
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

drop trigger if exists clients_set_updated_at on public.clients;
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

-- Client contact email. Used by the Client Portal (portal.html) for
-- magic-link sign-in: portal.html calls auth.signInWithOtp({email}), and
-- RLS scopes data so each client only sees the row whose email matches
-- auth.email(). Optional; clients without an email simply can't sign in.
alter table public.clients add column if not exists email text;
create index if not exists clients_email_idx on public.clients (lower(email));

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

-- Contract details: selected pricing tier and per-client receipt overrides.
alter table public.clients add column if not exists contract_template text;
alter table public.clients add column if not exists contract jsonb not null default '{}'::jsonb;
alter table public.clients drop constraint if exists clients_contract_template_check;
alter table public.clients add constraint clients_contract_template_check
  check (
    contract_template is null or
    contract_template in ('basic_website', 'premium_website', 'premium_pocket_sekretary')
  );

-- Public signing records. The separate signing page expects contract_html and
-- signer_name, so those names are the source of truth for this table.
create table if not exists public.signed_contracts (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  client_id uuid references public.clients(id) on delete set null,
  template_name text,
  contract_html text not null,
  recipient_name text,
  recipient_email text,
  company_name text,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'viewed', 'signed', 'voided')),
  signer_name text,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  viewed_at timestamptz
);

create index if not exists signed_contracts_client_id_idx
  on public.signed_contracts (client_id);
create index if not exists signed_contracts_token_idx
  on public.signed_contracts (token);

-- Allow the 'saved' status. A "saved" contract is a snapshot generated
-- via the CRM's Contract Builder and parked on the client's profile so
-- the team can re-open it later. It has never been sent to a client and
-- the Client Portal hides these rows. Keeping the migration in its own
-- block (drop+add) so re-running schema.sql is safe.
alter table public.signed_contracts
  drop constraint if exists signed_contracts_status_check;
alter table public.signed_contracts
  add constraint signed_contracts_status_check
  check (status in ('pending', 'saved', 'sent', 'viewed', 'signed', 'voided'));

alter table public.signed_contracts enable row level security;
drop policy if exists "anon all" on public.signed_contracts;
create policy "anon all"
  on public.signed_contracts
  for all to anon
  using (true)
  with check (true);

-- Reusable contract wording templates ("universal" templates) for the
-- Contract Builder. Per-client "custom" templates live inside clients.contract.
create table if not exists public.contract_text_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body_html text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.contract_text_templates enable row level security;
drop policy if exists "anon all" on public.contract_text_templates;
drop policy if exists "authenticated all" on public.contract_text_templates;
create policy "authenticated all"
  on public.contract_text_templates
  for all to authenticated
  using (true)
  with check (true);

-- =============================================================
-- TEAM AUTH RLS LOCKDOWN
-- =============================================================
-- The CRM now requires team members to log in via Supabase Auth.
-- Lock public.clients and public.contract_text_templates to authenticated
-- requests. Leave public.signed_contracts open for anon: the public sign.html
-- page (separate Vercel project) still needs anon read+update by token.
--
-- Re-running this block is safe; every drop/create is idempotent.

-- public.clients: drop the old anon-everything policies and add a single
-- authenticated-everything policy. Anonymous visitors can no longer read,
-- write, update, or delete client records.
--
-- NOTE: this temporary "authenticated all" policy is replaced further
-- down by the CLIENT PORTAL RLS block, which scopes per-row access
-- based on whether the caller is a team member or a portal client.
drop policy if exists "anon read"   on public.clients;
drop policy if exists "anon insert" on public.clients;
drop policy if exists "anon update" on public.clients;
drop policy if exists "anon delete" on public.clients;
drop policy if exists "anon all"    on public.clients;
drop policy if exists "authenticated all" on public.clients;
create policy "authenticated all"
  on public.clients
  for all to authenticated
  using (true)
  with check (true);

-- =============================================================
-- CLIENT PORTAL RLS
-- =============================================================
-- The Client Portal (portal.html) signs clients in via Supabase Auth
-- magic links. Both the team and the client hit the database as the
-- `authenticated` role; we tell them apart by inspecting the JWT:
--   - team members have user_metadata.roles containing
--     'admin', 'sales', or 'web_designer'
--   - clients have no roles array, or an empty one
--
-- The helper public.is_team_member() centralises that check so policies
-- stay terse. Re-running this block is safe -- every drop/create is
-- idempotent.

create or replace function public.is_team_member() returns boolean
  language sql stable
as $$
  select case
    when auth.jwt() is null then false
    when (auth.jwt() #> '{user_metadata,roles}') is null then false
    when jsonb_typeof(auth.jwt() #> '{user_metadata,roles}') = 'array'
      then (auth.jwt() #> '{user_metadata,roles}') ?| array['admin', 'sales', 'web_designer']
    else false
  end;
$$;

-- public.clients: team gets full access, portal clients see only their
-- own row (matched by email). Replaces the broad "authenticated all"
-- policy created above so portal clients cannot enumerate other clients.
drop policy if exists "authenticated all" on public.clients;
drop policy if exists "team or own row"   on public.clients;
create policy "team or own row"
  on public.clients for all to authenticated
  using (
    public.is_team_member()
    or lower(email) = lower(auth.email())
  )
  with check (
    public.is_team_member()
  );

-- public.signed_contracts: team gets full read+write; portal clients
-- can read contracts attached to their own client row. The existing
-- "anon all" policy stays so the public sign.html page (separate Vercel
-- project) keeps working with the anonymous token.
drop policy if exists "team or own contracts" on public.signed_contracts;
create policy "team or own contracts"
  on public.signed_contracts for all to authenticated
  using (
    public.is_team_member()
    or client_id in (
      select id from public.clients where lower(email) = lower(auth.email())
    )
  )
  with check (
    public.is_team_member()
  );

-- public.contract_text_templates: lock down to team only. Portal clients
-- have no business reading internal contract wording presets.
drop policy if exists "authenticated all"   on public.contract_text_templates;
drop policy if exists "team only templates" on public.contract_text_templates;
create policy "team only templates"
  on public.contract_text_templates for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

-- =============================================================
-- PROVIDER SIGNATURE + DELIVERY TRACKING
-- =============================================================
-- Adds two new lifecycle stages to signed_contracts:
--   provider_signed -- the team has signed; not yet sent to client
--   received        -- the client's portal has fetched the row; this is
--                      a delivery confirmation distinct from "sent"
-- Plus columns to record when the provider signed and who, and when
-- the contract was first received in the client portal. Re-running
-- this block is safe (idempotent drop + add).

alter table public.signed_contracts
  drop constraint if exists signed_contracts_status_check;
alter table public.signed_contracts
  add constraint signed_contracts_status_check
  check (status in ('pending', 'saved', 'provider_signed', 'sent', 'received', 'viewed', 'signed', 'voided'));

alter table public.signed_contracts
  add column if not exists provider_signed_at  timestamptz;
alter table public.signed_contracts
  add column if not exists provider_signer_name text;
alter table public.signed_contracts
  add column if not exists received_at         timestamptz;

-- Client-portal status bumps. Run as SECURITY DEFINER so portal clients
-- (who only have SELECT under "team or own contracts") can still
-- progress the lifecycle on their own contracts. Each function
-- enforces that the row belongs to the calling user (matched by email)
-- AND that the source status is exactly the expected one, so a client
-- can never skip stages or touch someone else's contract.

create or replace function public.mark_contract_received(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.signed_contracts
     set status      = 'received',
         received_at = coalesce(received_at, now())
   where id = p_contract_id
     and status = 'sent'
     and client_id in (
       select id from public.clients where lower(email) = lower(auth.email())
     );
end;
$$;

create or replace function public.mark_contract_viewed(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.signed_contracts
     set status    = 'viewed',
         viewed_at = coalesce(viewed_at, now())
   where id = p_contract_id
     and status in ('sent', 'received')
     and client_id in (
       select id from public.clients where lower(email) = lower(auth.email())
     );
end;
$$;

grant execute on function public.mark_contract_received(uuid) to authenticated;
grant execute on function public.mark_contract_viewed(uuid)   to authenticated;
