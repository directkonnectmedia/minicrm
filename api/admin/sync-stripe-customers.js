/**
 * /api/admin/sync-stripe-customers
 *
 * One-shot sync: creates Stripe Customer rows for CRM clients and stores
 * `stripe_customer_id` on each `public.clients` row (requires migration).
 *
 * Auth (same pattern as /api/admin/team):
 *   Authorization: Bearer <supabase_user_jwt>
 *   Caller must have admin role in user_metadata.roles.
 *
 * Env vars (Vercel Project Settings):
 *   - STRIPE_SECRET_KEY           — Stripe secret key (sk_live_… or sk_test_…)
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - SUPABASE_URL               — optional override
 *
 * Method:
 *   POST /api/admin/sync-stripe-customers
 *
 * Only processes clients where `stripe_customer_id` is null or blank (safe to re-run).
 *
 * Stripe Customers use a display name from CRM (client + company); phone and email
 * are attached when present on the row.
 *
 * Idempotency: Idempotency-Key header `minicrm-sync-customer-{client_uuid}`
 * avoids duplicate customers if the request retries before completion.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

function readRoles(u) {
  if (!u || !u.user_metadata) return [];
  const meta = u.user_metadata;
  if (Array.isArray(meta.roles)) {
    return meta.roles.filter((r) => typeof r === "string");
  }
  if (typeof meta.role === "string" && meta.role) return [meta.role];
  return [];
}

function supabaseHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function getCallerUser(jwt) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!r.ok) return null;
  return readJson(r);
}

function customerDisplayName(row) {
  const cn = (row.client_name || "").trim();
  const co = (row.company_name || "").trim();
  if (cn && co) return `${cn} (${co})`;
  return cn || co || "CRM client";
}

async function fetchAllClients() {
  const out = [];
  const pageSize = 500;
  let offset = 0;
  for (;;) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?select=id,company_name,client_name,phone,email,stripe_customer_id&order=created_at.asc&limit=${pageSize}&offset=${offset}`,
      { headers: supabaseHeaders() }
    );
    const rows = await readJson(r);
    if (!r.ok) {
      throw new Error(
        typeof rows?.message === "string"
          ? rows.message
          : `Supabase clients fetch failed (${r.status})`
      );
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

async function stripeCreateCustomer(row) {
  const params = new URLSearchParams();
  params.set("name", customerDisplayName(row));
  const phone = (row.phone || "").trim();
  if (phone) params.set("phone", phone);
  const email = (row.email || "").trim().toLowerCase();
  if (email) params.set("email", email);
  params.set("metadata[crm_client_id]", row.id);

  const r = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `minicrm-sync-customer-${row.id}`,
    },
    body: params.toString(),
  });
  const data = await readJson(r);
  if (!r.ok) {
    const msg =
      data?.error?.message ||
      (typeof data?.raw === "string" ? data.raw : null) ||
      `Stripe error (${r.status})`;
    throw new Error(msg);
  }
  if (!data?.id || typeof data.id !== "string") {
    throw new Error("Stripe returned no customer id");
  }
  return data.id;
}

async function updateClientStripeId(clientId, stripeCustomerId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({ stripe_customer_id: stripeCustomerId }),
    }
  );
  if (!r.ok) {
    const detail = await readJson(r);
    throw new Error(
      typeof detail?.message === "string"
        ? detail.message
        : `Supabase update failed (${r.status})`
    );
  }
}

export default async function handler(req, res) {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not configured. Set it in Vercel and redeploy.",
    });
  }
  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({
      error:
        "STRIPE_SECRET_KEY is not configured. Add your Stripe secret key to Vercel env and redeploy.",
    });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ error: "missing bearer token" });
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) return res.status(401).json({ error: "empty bearer token" });

  const caller = await getCallerUser(jwt);
  if (!caller) return res.status(401).json({ error: "invalid or expired session" });
  if (!readRoles(caller).includes("admin")) {
    return res.status(403).json({ error: "admin role required" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "method not allowed",
      hint: "POST /api/admin/sync-stripe-customers as an admin user",
    });
  }

  let clients;
  try {
    clients = await fetchAllClients();
  } catch (err) {
    return res.status(502).json({
      error: "could not load clients",
      detail: err.message || String(err),
    });
  }

  const summary = {
    ok: true,
    total_clients: clients.length,
    skipped_already_linked: 0,
    created: 0,
    errors: [],
  };

  for (const row of clients) {
    const linked = row.stripe_customer_id && String(row.stripe_customer_id).trim();
    if (linked) {
      summary.skipped_already_linked++;
      continue;
    }

    try {
      const stripeId = await stripeCreateCustomer(row);
      await updateClientStripeId(row.id, stripeId);
      summary.created++;
    } catch (err) {
      summary.errors.push({
        client_id: row.id,
        stage: "stripe_or_db",
        message: err.message || String(err),
      });
    }
  }

  summary.ok = summary.errors.length === 0;
  return res.status(200).json(summary);
}
