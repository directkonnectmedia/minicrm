-- =============================================================================
-- Run this entire script in Supabase → SQL Editor (one shot). Safe to re-run.
-- Fixes invoice template saves blocked by RLS / missing grants / stale policies.
-- =============================================================================

-- 1) Team check used by RLS on invoice_templates, clients, plans, etc.
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

-- 2) Ensure table exists (matches schema.sql; no-op if already there)
create table if not exists public.invoice_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  line_items jsonb not null default '[]'::jsonb,
  terms_html text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.invoice_templates enable row level security;

alter table public.invoice_templates
  add column if not exists plan_id uuid references public.plans(id) on delete set null;

-- 3) Drop ALL policies on invoice_templates (clears duplicates / old names)
do $$
declare
  pol text;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_templates'
  loop
    execute format('drop policy if exists %I on public.invoice_templates', pol);
  end loop;
end $$;

-- 4) Single canonical policy: team-only CRUD for authenticated sessions
create policy "team only invoice templates"
  on public.invoice_templates for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

-- 5) Table privileges for the Supabase "authenticated" role
grant select, insert, update, delete on table public.invoice_templates to authenticated;
