-- Billing subscription audit (manual checklist — aligns with billing_subscription_debug_audit plan)
-- Paste your CRM client UUID everywhere you see REPLACE_WITH_CLIENT_UUID (same id as POST clientId).

-- Phase 2 — Client row used by POST create_subscription
select id,
       focus_plan_id,
       stripe_customer_id,
       stripe_subscription_id,
       billing_collection_mode,
       billing_philosophy->'dispatcherContext' as dispatcher_context_snapshot,
       billing_philosophy->'dispatcherContext'->'start_dates'->>'red' as wizard_red_date,
       billing_philosophy->'dispatcherContext'->'start_times'->>'red' as wizard_red_time
from public.clients
where id = 'REPLACE_WITH_CLIENT_UUID'::uuid;

-- Phase 2 — Tier fallback order when focus_plan_id is null (oldest client_plans row wins)
select cp.plan_id,
       cp.created_at,
       p.name as plan_name
from public.client_plans cp
left join public.plans p on p.id = cp.plan_id
where cp.client_id = 'REPLACE_WITH_CLIENT_UUID'::uuid
order by cp.created_at asc;

-- Phase 3 — Plan tier subscription blob (compare priced lines to API resolvedPlan.priced_lines in Network response)
select id,
       name,
       subscription
from public.plans
where id = coalesce(
  (select focus_plan_id
   from public.clients
   where id = 'REPLACE_WITH_CLIENT_UUID'::uuid),
  (select cp.plan_id
   from public.client_plans cp
   where cp.client_id = 'REPLACE_WITH_CLIENT_UUID'::uuid
   order by cp.created_at asc
   limit 1)
);

-- Phase 4 / Phase 5 — Notes only:
-- Phase 4: In Stripe Dashboard, open stripe_customer_id from clients row (same mode as STRIPE_SECRET_KEY).
-- Check existing subscriptions before expecting POST subscriptions to create a new object.
