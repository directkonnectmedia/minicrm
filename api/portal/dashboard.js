/**
 * GET /api/portal/dashboard
 *
 * Plan name (via service role; portal cannot read public.plans under RLS) and
 * Stripe card summary (last4, brand) for the signed-in portal user.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY (optional for PM)
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

function serviceSupabase() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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

const restHeaders = () => ({
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  Accept: "application/json",
  "Content-Type": "application/json",
});

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function restErrorPayload(status, body) {
  const hint =
    (body && typeof body.message === "string" && body.message.trim()) ||
    (body && typeof body.error === "string" && body.error.trim()) ||
    null;
  return {
    message: hint || `Supabase REST HTTP ${status}`,
    detail: body,
    status,
  };
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
  if (!raw) return null;
  return raw.user && typeof raw.user === "object" ? raw.user : raw;
}

function stripeId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

async function stripeRequest(path, { method = "GET", params } = {}) {
  const query = method === "GET" && params ? `?${params.toString()}` : "";
  const res = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
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

async function listCustomerPaymentMethods(customerId) {
  const params = new URLSearchParams({ customer: customerId, type: "card", limit: "10" });
  const data = await stripeRequest("payment_methods", { params });
  return Array.isArray(data?.data) ? data.data : [];
}

function cardSummaryFromPaymentMethod(pm) {
  const card = pm && typeof pm.card === "object" ? pm.card : null;
  if (!card || typeof card.last4 !== "string") return null;
  return {
    brand: typeof card.brand === "string" ? card.brand : null,
    last4: card.last4,
    exp_month: Number.isFinite(card.exp_month) ? card.exp_month : null,
    exp_year: Number.isFinite(card.exp_year) ? card.exp_year : null,
  };
}

async function resolvePortalPaymentMethodSummary(customerId) {
  if (!STRIPE_SECRET_KEY || !customerId) return null;
  try {
    const customer = await stripeRequest(`customers/${encodeURIComponent(customerId)}`);
    const embedded = customer?.invoice_settings?.default_payment_method;
    if (embedded && typeof embedded === "object" && embedded.object === "payment_method") {
      const s = cardSummaryFromPaymentMethod(embedded);
      if (s) return s;
    }
    const defaultPmId =
      stripeId(embedded) ||
      stripeId(customer?.default_source) ||
      null;
    const paymentMethods = await listCustomerPaymentMethods(customerId);
    let pm = null;
    if (defaultPmId) {
      pm = paymentMethods.find((p) => p.id === defaultPmId) || null;
      if (!pm) {
        try {
          pm = await stripeRequest(`payment_methods/${encodeURIComponent(defaultPmId)}`);
        } catch {
          pm = null;
        }
      }
    }
    if (!pm && paymentMethods.length) pm = paymentMethods[0];
    return cardSummaryFromPaymentMethod(pm);
  } catch (err) {
    console.warn("[portal/dashboard] Stripe payment method:", err?.message || err);
    return null;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "method not allowed" });
    }

    if (!SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error:
          "SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Add it in Vercel -> Environment Variables.",
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

    const clientsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?select=id,company_name,email,created_at,focus_plan_id,stripe_customer_id&email=ilike.${encodeURIComponent(`*${email}*`)}&order=created_at.desc`,
      { headers: restHeaders() },
    );
    const clientsJson = await readJson(clientsRes);
    if (!clientsRes.ok) {
      const extra = restErrorPayload(clientsRes.status, clientsJson);
      return res.status(500).json({
        error: "client lookup failed",
        ...extra,
      });
    }

    const clients = Array.isArray(clientsJson)
      ? clientsJson.filter((client) => normalizeEmail(client.email) === email)
      : [];
    const primary = clients[0] || null;
    if (!primary) {
      return res.status(200).json({
        plan: null,
        paymentMethod: null,
        stripeCustomerLinked: false,
        clientId: null,
      });
    }

    let plan = null;
    const focusPlanId = String(primary.focus_plan_id || "").trim();
    if (focusPlanId) {
      const sb = serviceSupabase();
      const { data: planRow, error: planErr } = await sb
        .from("plans")
        .select("id,name")
        .eq("id", focusPlanId)
        .maybeSingle();
      if (planErr) {
        console.warn("[portal/dashboard] plan lookup:", planErr.message || planErr);
      } else if (planRow?.name) {
        plan = { id: planRow.id, name: planRow.name };
      }
    }

    const stripeCustomerId = String(primary.stripe_customer_id || "").trim();
    const paymentMethod = stripeCustomerId
      ? await resolvePortalPaymentMethodSummary(stripeCustomerId)
      : null;

    return res.status(200).json({
      plan,
      paymentMethod,
      stripeCustomerLinked: !!stripeCustomerId,
      clientId: primary.id,
    });
  } catch (err) {
    console.error("portal/dashboard:", err);
    return res.status(500).json({
      error: "dashboard route failed",
      message: err?.message || String(err),
    });
  }
}
