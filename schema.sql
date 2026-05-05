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

-- Mirrors readUserRoles() in index.html / api/admin/team.js:
--   - user_metadata.roles[] array of strings
--   - legacy user_metadata.role single string
--   - same shapes under app_metadata (some Auth tooling stores roles there)
create or replace function public.is_team_member() returns boolean
  language sql stable
as $$
  select case
    when auth.jwt() is null then false
    else (
      (
        jsonb_typeof(auth.jwt() #> '{user_metadata,roles}') = 'array'
        and exists (
          select 1
          from jsonb_array_elements_text(auth.jwt() #> '{user_metadata,roles}') as r(val)
          where r.val in ('admin', 'sales', 'web_designer')
        )
      )
      or (
        jsonb_typeof(auth.jwt() #> '{user_metadata,role}') = 'string'
        and (auth.jwt() #>> '{user_metadata,role}') in ('admin', 'sales', 'web_designer')
      )
      or (
        jsonb_typeof(auth.jwt() #> '{app_metadata,roles}') = 'array'
        and exists (
          select 1
          from jsonb_array_elements_text(auth.jwt() #> '{app_metadata,roles}') as r(val)
          where r.val in ('admin', 'sales', 'web_designer')
        )
      )
      or (
        jsonb_typeof(auth.jwt() #> '{app_metadata,role}') = 'string'
        and (auth.jwt() #>> '{app_metadata,role}') in ('admin', 'sales', 'web_designer')
      )
    )
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

-- Client-side signing. The client portal calls this with the freshly
-- stamped HTML (provider sigs preserved, client sig images embedded as
-- data URLs) so the row reflects exactly what the client saw on screen
-- when they signed. Same ownership + status guard as the other RPCs:
-- only the client whose email matches can sign, and only while the row
-- is in 'received' or 'viewed'. Already-signed rows are immutable here.

create or replace function public.mark_contract_signed(
  p_contract_id  uuid,
  p_html         text,
  p_signer_name  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.signed_contracts
     set status        = 'signed',
         signed_at     = coalesce(signed_at, now()),
         signer_name   = p_signer_name,
         contract_html = p_html
   where id = p_contract_id
     and status in ('received', 'viewed')
     and client_id in (
       select id from public.clients where lower(email) = lower(auth.email())
     );
end;
$$;

grant execute on function public.mark_contract_signed(uuid, text, text) to authenticated;

-- =============================================================
-- REALTIME
-- =============================================================
-- Enable postgres_changes streaming on signed_contracts so the CRM
-- can subscribe and re-render the Contract Status tab live as the
-- portal bumps statuses (sent -> received -> viewed -> signed).
-- The table is added to the supabase_realtime publication; running
-- this twice will error harmlessly ("already member"), so wrap in a
-- DO block to keep the migration idempotent.

do $$
begin
  alter publication supabase_realtime add table public.signed_contracts;
exception when duplicate_object then
  -- already published, nothing to do
  null;
end $$;

-- =============================================================
-- INVOICES
-- =============================================================
-- Standalone invoice/receipt documents generated from the Contract
-- Builder. Same row represents both faces of the document:
--   status = 'due'  -> renders as INVOICE  (amber DUE TODAY pills)
--   status = 'paid' -> renders as RECEIPT (green PAID pills)
-- The fully styled HTML is generated client-side and stored in
-- rendered_html so listing/viewing requires no re-render and a
-- future PDF export has a stable artifact.

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete set null,
  receipt_no text not null,
  issued_at date not null default current_date,
  billed_to_name text,
  from_company text not null default 'Direct Konnect LLC',
  from_subtitle text not null default 'Web Design & Development Services',
  line_items jsonb not null default '[]'::jsonb,
  payment_methods jsonb not null default '[]'::jsonb,
  terms_html text,
  amount_paid numeric not null default 0,
  status text not null default 'due'
    check (status in ('due', 'paid')),
  rendered_html text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists invoices_receipt_no_idx on public.invoices (receipt_no);
create index if not exists invoices_client_id_idx on public.invoices (client_id);

alter table public.invoices enable row level security;

-- RLS mirrors signed_contracts: team members get full access, portal
-- clients can only read invoices attached to their own client row.
drop policy if exists "team or own invoices" on public.invoices;
create policy "team or own invoices"
  on public.invoices for all to authenticated
  using (
    public.is_team_member()
    or client_id in (select id from public.clients where lower(email) = lower(auth.email()))
  )
  with check (public.is_team_member());

drop trigger if exists invoices_set_updated_at on public.invoices;
create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

-- =============================================================
-- INVOICES: STRIPE-READY SCAFFOLDING (Phase 1)
-- =============================================================
-- Phase 1 stores the columns Stripe will populate later but does
-- not call Stripe yet. The wizard exposes a single text input for
-- a manually-generated Stripe Checkout link; the other columns
-- stay null until Phase 2 wires up the Stripe API + webhook.
-- All columns are nullable; safe to re-run.

alter table public.invoices add column if not exists stripe_payment_link text;
alter table public.invoices add column if not exists stripe_payment_intent_id text;
alter table public.invoices add column if not exists stripe_status text;
alter table public.invoices add column if not exists paid_at timestamptz;

-- =============================================================
-- INVOICE TEMPLATES
-- =============================================================
-- Reusable invoice line-item structures, mirroring the contract
-- template pattern:
--   - Universal templates -> public.invoice_templates table
--     (shared library, e.g. "Website Deposit + Final Balance")
--   - Custom per-client    -> clients.invoice jsonb column,
--     accessed under .custom { name, line_items, terms_html, saved_at }
-- Templates intentionally store ONLY structure (line items + terms),
-- never per-invoice fields like billed_to_name, issued_at, status,
-- or stripe_payment_link -- those are populated when the template
-- is "generated" into an actual invoice via the wizard.

alter table public.clients add column if not exists invoice jsonb not null default '{}'::jsonb;

create table if not exists public.invoice_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  line_items jsonb not null default '[]'::jsonb,
  terms_html text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.invoice_templates enable row level security;
drop policy if exists "team only invoice templates" on public.invoice_templates;
drop policy if exists "authenticated all invoice templates" on public.invoice_templates;
-- Any logged-in Supabase user may CRUD (no team-role check). Tighten later if needed.
create policy "authenticated all invoice templates"
  on public.invoice_templates for all to authenticated
  using (true)
  with check (true);

-- Browser CRM uses the anon key + signed-in JWT; ensure table privileges exist
-- (some projects created this table before default grants were applied).
grant select, insert, update, delete on table public.invoice_templates to authenticated;

drop trigger if exists invoice_templates_set_updated_at on public.invoice_templates;
create trigger invoice_templates_set_updated_at
  before update on public.invoice_templates
  for each row execute function public.set_updated_at();

alter table public.invoice_templates add column if not exists plan_id uuid references public.plans(id) on delete set null;
create index if not exists invoice_templates_plan_id_idx on public.invoice_templates (plan_id);

-- =============================================================
-- Plans (Plan Builder skeleton wizard)
-- =============================================================
-- A Plan is a reusable bundle the team sells. The wizard captures
-- only the *skeleton* (which categories the plan includes via the
-- has_* booleans). The matching jsonb columns are populated later
-- by per-tab editors (TBD) -- they default to empty so the row is
-- always valid even right after wizard save.
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  has_one_time     boolean not null default false,
  has_setup        boolean not null default false,
  has_subscription boolean not null default false,
  has_addons       boolean not null default false,
  has_financing    boolean not null default false,
  one_time     jsonb not null default '{}'::jsonb,
  setup        jsonb not null default '{}'::jsonb,
  subscription jsonb not null default '{}'::jsonb,
  addons       jsonb not null default '[]'::jsonb,
  financing    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.plans enable row level security;
drop policy if exists "team only plans" on public.plans;
create policy "team only plans"
  on public.plans for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

drop trigger if exists plans_set_updated_at on public.plans;
create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

-- Idempotent migration for environments that already ran the
-- previous public.plans create-table block (which didn't include
-- the financing columns).
alter table public.plans add column if not exists has_financing boolean not null default false;
alter table public.plans add column if not exists financing jsonb not null default '{}'::jsonb;

-- v1.7: services array (selected service ids) chosen during the wizard.
-- Each per-tab jsonb column above is now keyed by service_id with shape:
--   { "<service_id>": { "state": "hidden" | "included" | "priced",
--                        "price": 0,
--                        "label": "Display label" } }
-- Existing rows default to '[]' which renders as an empty per-service editor.
--
-- Setup tab only: logical fields (canonical storage: public.plans.setup[<service_uuid>] JSON keys):
--   "label"                 — display string (relational name: service_label).
--   "price"                  — billed setup total when state = priced (total_setup_amount).
--   "finance_frequency"      — text slug for installment cadence when payment_count > 1:
--                              daily | weekly | biweekly | monthly | every_3_months | every_6_months | yearly.
--   "payment_count"        — integer ≥ 1 installments on the financed remainder.
--   "payment_trigger_type" — when payment_count = 1: 'date' (due on calendar date) or 'milestone' (upon completion).
--   "due_date_value"       — ISO date string (YYYY-MM-DD) stored as text/json when trigger = 'date' (relational: date).
--   "state" mirrors service_display_status (priced | included | hidden).
--   "is_down_payment_active_for_service" — when plan-level down is required: false = pay-in-full for this line; omit or true = allow down amount.
--   "down_payment_amount" mirrors service_down_payment_amount (decimal ≥ 0),
--       only when plan wizard flagged down payment AND this service keeps down active.

-- Subscription tab (canonical keys on public.plans.subscription[<service_uuid>] JSON):
--   "label", "state" ("priced" | "included" | "hidden"), "price"
--       — recurring amount when Priced is stored on both subscription_rate and price for compatibility.
--   "subscription_rate" numeric — recurring billed amount when state = priced.
--   "subscription_frequency" text slug matching setup cadence:
--       daily | weekly | biweekly | monthly | every_3_months | every_6_months | yearly.
-- Older rows may set finance_frequency alone; readers accept it as fallback.
--
-- Hypothetical normalized subscription line example (would require plan_subscription_lines table):
-- alter table public.plan_subscription_lines add column if not exists subscription_rate numeric(14, 2);
-- alter table public.plan_subscription_lines add column if not exists subscription_frequency text not null default 'monthly';

-- Hypothetical normalized table example (requires creating public.plan_setup_lines first):
-- alter table public.plan_setup_lines add column if not exists service_label text;
-- alter table public.plan_setup_lines add column if not exists total_setup_amount numeric(14, 2);
-- alter table public.plan_setup_lines add column if not exists finance_frequency text not null default 'monthly';
-- alter table public.plan_setup_lines add column if not exists payment_count integer not null default 1 check (payment_count >= 1);
-- alter table public.plan_setup_lines add column if not exists is_down_payment_active_for_service boolean not null default true;
-- alter table public.plan_setup_lines add column if not exists payment_trigger_type public.setup_payment_trigger_type;
-- alter table public.plan_setup_lines add column if not exists due_date_value date;

alter table public.plans add column if not exists services jsonb not null default '[]'::jsonb;

-- Plan Creation Wizard — Phase 1 payment fork (nullable for legacy rows)
alter table public.plans add column if not exists wizard_payment_receive text;
alter table public.plans add column if not exists wizard_multi_billing text;

-- Wizard — ongoing subscription branch (nullable when path not taken)
alter table public.plans add column if not exists wizard_subscription_has_setup_fee boolean;
alter table public.plans add column if not exists wizard_subscription_setup_down_payment boolean;

-- Wizard — fixed project branch (multiple + NO Fixed Project path)
alter table public.plans add column if not exists wizard_fixed_project_requires_down_payment boolean;

-- Optional enum for documentation, CHECK constraints, or a future normalized table.
-- (Current app stores status + amount inside public.plans.setup jsonb per service id.)
do $$ begin
  create type public.service_display_status as enum ('priced', 'included', 'hidden');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.setup_payment_trigger_type as enum ('date', 'milestone');
exception
  when duplicate_object then null;
end $$;

-- If you normalize setup lines into relational rows (requires public.plan_setup_lines):
-- alter table public.plan_setup_lines add column if not exists service_display_status public.service_display_status not null default 'hidden'::public.service_display_status;
-- alter table public.plan_setup_lines add column if not exists service_down_payment_amount numeric(14, 2);
-- (service_label … payment_trigger_type / due_date_value snippets appear near the hypothetical plan_setup_lines comments above.)

-- =============================================================
-- Services (Plan Builder reusable services library)
-- =============================================================
-- A Service is a named, reusable unit the team can pull into a
-- Plan / Invoice later. v1 captures only the name; richer fields
-- (default fees, default amount, category) come in a later pass
-- when we wire services into plan tabs and invoice line items.
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.services enable row level security;
drop policy if exists "team only services" on public.services;
create policy "team only services"
  on public.services for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

drop trigger if exists services_set_updated_at on public.services;
create trigger services_set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

-- Service add-ons (many rows per service; cascade when parent service is deleted)
create table if not exists public.service_addons (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists service_addons_service_id_idx on public.service_addons (service_id);

alter table public.service_addons enable row level security;
drop policy if exists "team only service_addons" on public.service_addons;
create policy "team only service_addons"
  on public.service_addons for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

drop trigger if exists service_addons_set_updated_at on public.service_addons;
create trigger service_addons_set_updated_at
  before update on public.service_addons
  for each row execute function public.set_updated_at();

-- =============================================================
-- Client ↔ Plan references (Contract Details “tiers” from Plan Builder)
-- =============================================================
-- Linking is by reference only: deleting a link does not delete public.plans.
-- Drop legacy CHECK so older template ids may remain on legacy rows; new UX uses client_plans.

alter table public.clients drop constraint if exists clients_contract_template_check;

alter table public.clients add column if not exists focus_plan_id uuid references public.plans(id) on delete set null;

create table if not exists public.client_plans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  plan_id uuid not null references public.plans(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (client_id, plan_id)
);

create index if not exists client_plans_client_id_idx on public.client_plans (client_id);
create index if not exists client_plans_plan_id_idx on public.client_plans (plan_id);

alter table public.client_plans enable row level security;

drop policy if exists "team only client_plans" on public.client_plans;
create policy "team only client_plans"
  on public.client_plans for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

-- Integrations that expect a "global_plans" name: thin view over the Plan Builder library.
create or replace view public.global_plans as
  select * from public.plans;

grant select on public.global_plans to authenticated;

-- =============================================================
-- One-time data cleanup: legacy static tiers → Plan Builder–ready
-- =============================================================
-- Targets every client whose contract_template is still one of the old
-- fixed CRM tiers (basic_website / premium_website /
-- premium_pocket_sekretary). Example: “Raymond” at “Test company” if
-- he still shows “Legacy receipt (static template)”.
--
-- Does:
--   1) Removes client ↔ plan links for those rows (fresh pills).
--   2) Clears contract_template and focus_plan_id.
--   3) Strips contract.setupOverrides / contract.monthlyOverrides only
--      (keeps contract.company_name, contract.client_name, contract.custom).
--
-- Preview before running:
--   select id, client_name, company_name, contract_template
--   from public.clients
--   where contract_template in ('basic_website','premium_website','premium_pocket_sekretary');
-- =============================================================

delete from public.client_plans cp
using public.clients c
where cp.client_id = c.id
  and c.contract_template in ('basic_website', 'premium_website', 'premium_pocket_sekretary');

update public.clients c
set
  contract_template = null,
  focus_plan_id = null,
  contract = coalesce(c.contract, '{}'::jsonb) - 'setupOverrides' - 'monthlyOverrides'
where c.contract_template in ('basic_website', 'premium_website', 'premium_pocket_sekretary');

-- Stripe Customer sync (CRM links Supabase clients ↔ Stripe customers)
alter table public.clients add column if not exists stripe_customer_id text;
create unique index if not exists clients_stripe_customer_id_uidx
  on public.clients (stripe_customer_id)
  where stripe_customer_id is not null;

-- Invoice plan diagnostic — per-client billing runtime (anchor vs shifter, etc.).
-- Does not modify plan library or invoice templates.
alter table public.clients add column if not exists billing_philosophy jsonb;

-- =============================================================
-- Invoice Calendar (plan wizard commits only — not the follow-up calendar)
-- =============================================================
create table if not exists public.invoice_calendar_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  scheduled_date date not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'paid', 'cancelled')),
  total_amount numeric(14, 2) not null default 0,
  charges jsonb not null default '[]'::jsonb,
  billing_philosophy jsonb,
  template_name text,
  source text not null default 'plan_wizard',
  commit_batch_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists invoice_calendar_events_client_date_idx
  on public.invoice_calendar_events (client_id, scheduled_date);
create index if not exists invoice_calendar_events_batch_idx
  on public.invoice_calendar_events (commit_batch_id);

alter table public.invoice_calendar_events enable row level security;

drop policy if exists "team invoice_calendar_events" on public.invoice_calendar_events;
create policy "team invoice_calendar_events"
  on public.invoice_calendar_events for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());
