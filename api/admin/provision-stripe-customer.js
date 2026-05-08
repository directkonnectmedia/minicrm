/**
 * POST /api/admin/provision-stripe-customer
 *
 * Creates a Stripe Customer for one CRM client and saves stripe_customer_id.
 * Idempotent: skips Stripe API when stripe_customer_id is already set.
 *
 * Body: { clientId: "<uuid>" }
 * Auth: Bearer JWT + admin role (same as /api/admin/billing).
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

function readRoles(user) {
  const meta = user?.user_metadata || {};
  const appMeta = user?.app_metadata || {};
  if (Array.isArray(meta.roles)) return meta.roles.filter((role) => typeof role === "string");
  if (typeof meta.role === "string" && meta.role) return [meta.role];
  if (Array.isArray(appMeta.roles)) return appMeta.roles.filter((role) => typeof role === "string");
  if (typeof appMeta.role === "string" && appMeta.role) return [appMeta.role];
  return [];
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

function supabaseHeaders(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}

async function getCallerUser(jwt) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!res.ok) return null;
  const raw = await readJson(res);
  return raw?.user && typeof raw.user === "object" ? raw.user : raw;
}

async function requireAdmin(req, res) {
  if (!SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured." });
    return null;
  }
  if (!STRIPE_SECRET_KEY) {
    res.status(500).json({ error: "STRIPE_SECRET_KEY is not configured." });
    return null;
  }
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "missing bearer token" });
    return null;
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) {
    res.status(401).json({ error: "empty bearer token" });
    return null;
  }
  const caller = await getCallerUser(jwt);
  if (!caller) {
    res.status(401).json({ error: "invalid or expired session" });
    return null;
  }
  if (!readRoles(caller).includes("admin")) {
    res.status(403).json({ error: "admin role required" });
    return null;
  }
  return caller;
}

async function loadClientRow(clientId) {
  const sel =
    "id,company_name,client_name,phone,email,stripe_customer_id";
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=${sel}`,
    { headers: supabaseHeaders() },
  );
  const data = await readJson(res);
  if (!res.ok) throw new Error(data?.message || `client lookup failed (${res.status})`);
  return Array.isArray(data) ? data[0] || null : null;
}

function customerDisplayName(row) {
  const cn = (row.client_name || "").trim();
  const co = (row.company_name || "").trim();
  if (cn && co) return `${cn} (${co})`;
  return cn || co || "CRM client";
}

async function stripeCreateCustomerForProvision(row) {
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
      "Idempotency-Key": `minicrm-provision-customer-${row.id}`,
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

async function patchStripeCustomerId(clientId, stripeCustomerId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ stripe_customer_id: stripeCustomerId }),
    },
  );
  if (!res.ok) {
    const detail = await readJson(res);
    throw new Error(
      typeof detail?.message === "string"
        ? detail.message
        : `Supabase update failed (${res.status})`,
    );
  }
}

export default async function handler(req, res) {
  const caller = await requireAdmin(req, res);
  if (!caller) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const body =
    typeof req.body === "string"
      ? (() => {
          try {
            return JSON.parse(req.body || "{}");
          } catch {
            return {};
          }
        })()
      : req.body || {};
  const clientId = String(body.clientId || "").trim();
  if (!clientId) return res.status(400).json({ error: "clientId is required" });

  try {
    const client = await loadClientRow(clientId);
    if (!client) return res.status(404).json({ error: "client not found" });

    const existing = String(client.stripe_customer_id || "").trim();
    if (existing) {
      return res.status(200).json({
        ok: true,
        alreadyLinked: true,
        stripe_customer_id: existing,
        client: { id: client.id, stripe_customer_id: existing },
      });
    }

    const stripeId = await stripeCreateCustomerForProvision(client);
    await patchStripeCustomerId(client.id, stripeId);

    return res.status(200).json({
      ok: true,
      alreadyLinked: false,
      stripe_customer_id: stripeId,
      client: { id: client.id, stripe_customer_id: stripeId },
    });
  } catch (err) {
    console.error("provision-stripe-customer:", err);
    return res.status(500).json({
      error: err.message || String(err),
    });
  }
}
