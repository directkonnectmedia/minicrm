/**
 * POST /api/portal/payment-method-setup
 *
 * Body JSON: { op: "mint" | "clear" }
 *   mint  — create Stripe Billing Portal or Checkout (setup) session; returns { url }.
 *   clear — set clients.payment_method_requested_at to null (after successful Stripe return).
 *
 * Auth: Supabase session JWT (client portal). Uses service role for DB writes on clear.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const restHeaders = () => ({
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  Accept: "application/json",
  "Content-Type": "application/json",
});

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function originFor(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}` : "https://minicrm-kappa.vercel.app";
}

async function getUserFromJwt(jwt) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!r.ok) return null;
  const raw = await readJson(r);
  return raw?.user && typeof raw.user === "object" ? raw.user : raw;
}

async function stripeRequest(path, { method = "GET", params, idempotencyKey } = {}) {
  const query = method === "GET" && params ? `?${params.toString()}` : "";
  const res = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "GET" ? undefined : params?.toString(),
  });
  const data = await readJson(res);
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      (typeof data?.raw === "string" ? data.raw : null) ||
      `Stripe request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

async function resolveClientRow(email) {
  const clientsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?select=id,email,stripe_customer_id,payment_method_requested_at&email=ilike.${encodeURIComponent(`*${email}*`)}&order=created_at.desc`,
    { headers: restHeaders() },
  );
  const clientsJson = await readJson(clientsRes);
  if (!clientsRes.ok) {
    throw new Error(clientsJson?.message || "client lookup failed");
  }
  const clients = Array.isArray(clientsJson)
    ? clientsJson.filter((c) => normalizeEmail(c.email) === email)
    : [];
  return clients[0] || null;
}

async function patchClient(clientId, patch) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`,
    {
      method: "PATCH",
      headers: { ...restHeaders(), Prefer: "return=representation" },
      body: JSON.stringify(patch),
    },
  );
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(data?.message || "client update failed");
  }
  return Array.isArray(data) ? data[0] || null : data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not configured. Add it in Vercel → Environment Variables.",
    });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ error: "missing bearer token" });
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) return res.status(401).json({ error: "empty bearer token" });

  const user = await getUserFromJwt(jwt);
  if (!user) return res.status(401).json({ error: "invalid or expired session" });

  const email = normalizeEmail(user.email || user?.user_metadata?.email);
  if (!email) return res.status(400).json({ error: "session email is required" });

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
  const op = String(body.op || "").trim().toLowerCase();
  if (!["mint", "clear"].includes(op)) {
    return res.status(400).json({ error: 'body.op must be "mint" or "clear"' });
  }

  let client;
  try {
    client = await resolveClientRow(email);
  } catch (err) {
    return res.status(502).json({ error: err.message || String(err) });
  }
  if (!client) {
    return res.status(404).json({ error: "no client record for this account" });
  }

  if (op === "clear") {
    try {
      await patchClient(client.id, { payment_method_requested_at: null });
    } catch (err) {
      return res.status(500).json({ error: err.message || String(err) });
    }
    return res.status(200).json({ ok: true });
  }

  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "STRIPE_SECRET_KEY is not configured." });
  }

  const customerId = String(client.stripe_customer_id || "").trim();
  if (!customerId) {
    return res.status(409).json({
      error: "Billing is not ready yet — no Stripe customer on file.",
      code: "customer_required",
    });
  }

  const origin = originFor(req);
  const returnUrl = `${origin}/portal.html`;
  const portalParams = new URLSearchParams({
    customer: customerId,
    return_url: `${returnUrl}?billing=payment_method_added`,
  });

  try {
    const session = await stripeRequest("billing_portal/sessions", {
      method: "POST",
      params: portalParams,
      idempotencyKey: `minicrm-portal-pm-portal-${client.id}-${Date.now()}`,
    });
    return res.status(200).json({ ok: true, type: "billing_portal", url: session.url });
  } catch (err) {
    try {
      const setupParams = new URLSearchParams({
        mode: "setup",
        customer: customerId,
        success_url: `${returnUrl}?billing=payment_method_added`,
        cancel_url: `${returnUrl}?billing=payment_method_cancelled`,
      });
      const session = await stripeRequest("checkout/sessions", {
        method: "POST",
        params: setupParams,
        idempotencyKey: `minicrm-portal-pm-setup-${client.id}-${Date.now()}`,
      });
      return res.status(200).json({ ok: true, type: "setup_checkout", url: session.url });
    } catch (err2) {
      const status = err2.status && err2.status >= 400 && err2.status < 600 ? err2.status : 500;
      return res.status(status).json({
        error: err2.message || String(err2),
        detail: err2.detail || null,
      });
    }
  }
}
