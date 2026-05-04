-- =============================================================================
-- Run in Supabase → SQL Editor (one shot). Safe to re-run.
-- Opens public.invoice_templates to ANY signed-in user (authenticated role).
-- No team roles / is_team_member — avoids RLS failures when saving templates.
-- =============================================================================

-- 1) Ensure table exists
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

-- 2) Drop ALL policies on invoice_templates
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

-- 3) Open table to every authenticated session (logged-in CRM user)
create policy "authenticated all invoice templates"
  on public.invoice_templates for all to authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on table public.invoice_templates to authenticated;
