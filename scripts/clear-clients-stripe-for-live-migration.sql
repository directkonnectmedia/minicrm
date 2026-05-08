-- =============================================================================
-- Clear Stripe links on public.clients (test → live migration helper)
-- =============================================================================
-- Run in Supabase: SQL Editor → New query → paste ONE section at a time.
--
-- After this: use MiniCRM admin to run sync or provision so live Stripe
-- customers are created (requires sk_live_… on Vercel).
--
-- You cannot tell test vs live from a customer id string alone (both look like
-- cus_…). Only clear rows you intend to re-link in LIVE Stripe.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1 — Preview rows that currently have a Stripe customer id (run first)
-- -----------------------------------------------------------------------------
select id,
       coalesce(company_name, '') as company_name,
       coalesce(email, '') as email,
       stripe_customer_id,
       stripe_subscription_id
from public.clients
where stripe_customer_id is not null
order by created_at asc;


-- -----------------------------------------------------------------------------
-- STEP 2 — Uncomment EXACTLY ONE update block, then run again.
-- -----------------------------------------------------------------------------

-- OPTION A — Minimal: only clears stripe_customer_id (prefer B for clean test→live).
--
-- update public.clients
-- set stripe_customer_id = null
-- where stripe_customer_id is not null;


-- OPTION B — Recommended for test→live: clear customer id AND mirrored billing
-- fields from Stripe webhooks (avoids ghost test subscription state in CRM).
-- Uncomment the block below for STEP 2 (after you reviewed STEP 1 results).
--
-- update public.clients
-- set
--   stripe_customer_id = null,
--   stripe_subscription_id = null,
--   billing_collection_mode = 'manual',
--   stripe_subscription_status = null,
--   stripe_default_payment_method_present = false,
--   stripe_next_invoice_amount_cents = null,
--   stripe_next_invoice_at = null,
--   stripe_billing_synced_at = null,
--   stripe_billing_alert = null,
--   payment_method_requested_at = null
-- where stripe_customer_id is not null;


-- OPTION C — Same as B but only specific clients (replace UUIDs).
--
-- update public.clients
-- set
--   stripe_customer_id = null,
--   stripe_subscription_id = null,
--   billing_collection_mode = 'manual',
--   stripe_subscription_status = null,
--   stripe_default_payment_method_present = false,
--   stripe_next_invoice_amount_cents = null,
--   stripe_next_invoice_at = null,
--   stripe_billing_synced_at = null,
--   stripe_billing_alert = null,
--   payment_method_requested_at = null
-- where id in (
--   '00000000-0000-0000-0000-000000000001'::uuid,
--   '00000000-0000-0000-0000-000000000002'::uuid
-- );


-- -----------------------------------------------------------------------------
-- Notes
-- -----------------------------------------------------------------------------
-- • Existing public.invoices rows may still contain test stripe_invoice_id /
--   stripe_subscription_id. Live webhooks create/update rows for live activity;
--   cleaning old invoice rows is optional and separate from this script.
-- • After OPTION B/C, run POST /api/admin/sync-stripe-customers or provision
--   each client from admin while STRIPE_SECRET_KEY is live on Vercel.
