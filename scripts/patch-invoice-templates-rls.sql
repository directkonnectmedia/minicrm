-- Run in Supabase SQL Editor if saving an invoice template fails with:
--   new row violates row-level security policy for table "invoice_templates"
--
-- Fixes: (1) is_team_member() now matches app logic — checks user_metadata.roles[]
--        and legacy user_metadata.role string; (2) explicit grants on invoice_templates.
-- Safe to re-run.

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
    )
  end;
$$;

grant select, insert, update, delete on table public.invoice_templates to authenticated;
