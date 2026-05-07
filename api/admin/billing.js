/**
 * /api/admin/billing
 *
 * Admin-only Stripe Billing control plane for a CRM client.
 *
 * GET   ?clientId=uuid
 *   Live-sync Stripe customer/subscription state and upcoming invoice.
 *
 * PATCH body: { clientId, mode: "auto_pay" | "manual" }
 *   Toggle the Stripe Subscription collection_method.
 *
 * POST  body: { clientId, action: "request_payment_method" }
 *   Sets payment_method_requested_at so the client sees an Add payment method CTA in portal.html.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const MANUAL_DAYS_UNTIL_DUE = Number(process.env.STRIPE_MANUAL_DAYS_UNTIL_DUE || 7);

function readRoles(user) {
  const meta = user?.user_metadata || {};
  const appMeta = user?.app_metadata || {};
  if (Array.isArray(meta.roles)) return meta.roles.filter((role) => typeof role === "string");
  if (typeof meta.role === "string" && meta.role) return [meta.role];
  if (Array.isArray(appMeta.roles)) return appMeta.roles.filter((role) => typeof role === "string");
  if (typeof appMeta.role === "string" && appMeta.role) return [appMeta.role];
  return [];
}

function originFor(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}` : "https://minicrm-kappa.vercel.app";
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

async function loadClient(clientId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=*`,
    { headers: supabaseHeaders() },
  );
  const data = await readJson(res);
  if (!res.ok) throw new Error(data?.message || `client lookup failed (${res.status})`);
  return Array.isArray(data) ? data[0] || null : null;
}

async function patchClient(clientId, patch) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify(patch),
    },
  );
  const data = await readJson(res);
  if (!res.ok) throw new Error(data?.message || `client update failed (${res.status})`);
  return Array.isArray(data) ? data[0] || null : data;
}

async function listCustomerPaymentMethods(customerId) {
  const params = new URLSearchParams({ customer: customerId, type: "card", limit: "10" });
  const data = await stripeRequest("payment_methods", { params });
  return Array.isArray(data?.data) ? data.data : [];
}

async function resolveBillingState(client) {
  const customerId = String(client?.stripe_customer_id || "").trim();
  if (!customerId) {
    return {
      configured: false,
      customer: null,
      subscription: null,
      upcomingInvoice: null,
      hasPaymentMethod: false,
      alert: "Stripe customer is not linked yet.",
    };
  }

  const customer = await stripeRequest(`customers/${encodeURIComponent(customerId)}`);
  const paymentMethods = await listCustomerPaymentMethods(customerId);
  const defaultPaymentMethod =
    customer?.invoice_settings?.default_payment_method ||
    customer?.default_source ||
    null;
  const hasPaymentMethod = !!defaultPaymentMethod || paymentMethods.length > 0;

  let subscription = null;
  const storedSubId = String(client?.stripe_subscription_id || "").trim();
  if (storedSubId) {
    try {
      subscription = await stripeRequest(`subscriptions/${encodeURIComponent(storedSubId)}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  if (!subscription) {
    const params = new URLSearchParams({
      customer: customerId,
      status: "all",
      limit: "10",
    });
    const listed = await stripeRequest("subscriptions", { params });
    const rows = Array.isArray(listed?.data) ? listed.data : [];
    subscription =
      rows.find((row) => !["canceled", "incomplete_expired"].includes(row.status)) ||
      rows[0] ||
      null;
  }

  let upcomingInvoice = null;
  if (subscription?.id) {
    const params = new URLSearchParams({
      customer: customerId,
      subscription: subscription.id,
    });
    try {
      upcomingInvoice = await stripeRequest("invoices/upcoming", { params });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  return {
    configured: true,
    customer,
    subscription,
    upcomingInvoice,
    hasPaymentMethod,
    alert:
      subscription && ["past_due", "unpaid"].includes(subscription.status)
        ? `Subscription is ${subscription.status.replace("_", " ")}.`
        : null,
  };
}

function invoiceAmountCents(invoice) {
  if (!invoice) return null;
  if (Number.isFinite(invoice.amount_due)) return invoice.amount_due;
  if (Number.isFinite(invoice.total)) return invoice.total;
  return null;
}

function invoiceDateIso(invoice) {
  const unix = invoice?.next_payment_attempt || invoice?.due_date || invoice?.created;
  return unix ? new Date(unix * 1000).toISOString() : null;
}

async function syncClientBillingCache(client, state) {
  const subscription = state.subscription || null;
  const upcoming = state.upcomingInvoice || null;
  const collectionMethod = subscription?.collection_method || null;
  const patch = {
    stripe_subscription_id: subscription?.id || client.stripe_subscription_id || null,
    billing_collection_mode: collectionMethod === "charge_automatically" ? "auto_pay" : "manual",
    stripe_subscription_status: subscription?.status || null,
    stripe_default_payment_method_present: !!state.hasPaymentMethod,
    stripe_next_invoice_amount_cents: invoiceAmountCents(upcoming),
    stripe_next_invoice_at: invoiceDateIso(upcoming),
    stripe_billing_synced_at: new Date().toISOString(),
    stripe_billing_alert: state.alert,
  };
  return patchClient(client.id, patch);
}

function publicBillingPayload(client, state) {
  const subscription = state.subscription || null;
  const upcoming = state.upcomingInvoice || null;
  return {
    client: {
      id: client.id,
      stripe_customer_id: client.stripe_customer_id || null,
      stripe_subscription_id: client.stripe_subscription_id || null,
      billing_collection_mode: client.billing_collection_mode || "manual",
      stripe_subscription_status: client.stripe_subscription_status || null,
      stripe_default_payment_method_present: !!client.stripe_default_payment_method_present,
      stripe_next_invoice_amount_cents: client.stripe_next_invoice_amount_cents ?? null,
      stripe_next_invoice_at: client.stripe_next_invoice_at || null,
      stripe_billing_synced_at: client.stripe_billing_synced_at || null,
      stripe_billing_alert: client.stripe_billing_alert || null,
    },
    live: {
      configured: !!state.configured,
      hasPaymentMethod: !!state.hasPaymentMethod,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            collection_method: subscription.collection_method,
            current_period_end: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000).toISOString()
              : null,
          }
        : null,
      upcomingInvoice: upcoming
        ? {
            id: upcoming.id || null,
            amount_due: invoiceAmountCents(upcoming),
            due_at: invoiceDateIso(upcoming),
            hosted_invoice_url: upcoming.hosted_invoice_url || null,
          }
        : null,
      alert: state.alert || null,
    },
  };
}

async function handleGet(req, res) {
  const clientId = String(req.query?.clientId || "").trim();
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  const client = await loadClient(clientId);
  if (!client) return res.status(404).json({ error: "client not found" });

  const state = await resolveBillingState(client);
  const patched = await syncClientBillingCache(client, state);
  return res.status(200).json(publicBillingPayload(patched || client, state));
}

async function handlePatch(req, res) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const clientId = String(body.clientId || "").trim();
  const mode = String(body.mode || "").trim();
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  if (!["auto_pay", "manual"].includes(mode)) {
    return res.status(400).json({ error: "mode must be auto_pay or manual" });
  }

  const client = await loadClient(clientId);
  if (!client) return res.status(404).json({ error: "client not found" });
  const state = await resolveBillingState(client);
  if (!state.subscription?.id) {
    return res.status(409).json({
      error: "No active Stripe subscription is linked for this client.",
      code: "subscription_required",
    });
  }
  if (mode === "auto_pay" && !state.hasPaymentMethod) {
    return res.status(409).json({
      error: "This client needs a card on file before Auto Pay can be enabled.",
      code: "payment_method_required",
    });
  }

  const params = new URLSearchParams();
  params.set("collection_method", mode === "auto_pay" ? "charge_automatically" : "send_invoice");
  if (mode === "manual") params.set("days_until_due", String(MANUAL_DAYS_UNTIL_DUE));
  const subscription = await stripeRequest(
    `subscriptions/${encodeURIComponent(state.subscription.id)}`,
    {
      method: "POST",
      params,
      idempotencyKey: `minicrm-billing-mode-${clientId}-${mode}-${Date.now()}`,
    },
  );

  const nextState = await resolveBillingState({
    ...client,
    stripe_subscription_id: subscription.id,
  });
  const patched = await syncClientBillingCache(client, nextState);
  return res.status(200).json(publicBillingPayload(patched || client, nextState));
}

async function handlePost(req, res) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const clientId = String(body.clientId || "").trim();
  const action = String(body.action || "").trim();
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  if (action !== "request_payment_method") {
    return res.status(400).json({ error: "unsupported action" });
  }

  const client = await loadClient(clientId);
  if (!client) return res.status(404).json({ error: "client not found" });
  const customerId = String(client.stripe_customer_id || "").trim();
  if (!customerId) {
    return res.status(409).json({
      error: "Create or sync a Stripe customer before requesting a payment method.",
      code: "customer_required",
    });
  }

  const nowIso = new Date().toISOString();
  const patched = await patchClient(clientId, { payment_method_requested_at: nowIso });
  return res.status(200).json({
    ok: true,
    portal_notified: true,
    client: patched || { id: clientId, payment_method_requested_at: nowIso },
  });
}

export default async function handler(req, res) {
  const caller = await requireAdmin(req, res);
  if (!caller) return;

  try {
    if (req.method === "GET") return handleGet(req, res);
    if (req.method === "PATCH") return handlePatch(req, res);
    if (req.method === "POST") return handlePost(req, res);
    res.setHeader("Allow", "GET, PATCH, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return res.status(status).json({
      error: err.message || String(err),
      detail: err.detail || null,
    });
  }
}
