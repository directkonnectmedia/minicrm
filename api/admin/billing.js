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
const SUBSCRIPTION_INTERVALS = {
  daily: { interval: "day", interval_count: 1 },
  weekly: { interval: "week", interval_count: 1 },
  biweekly: { interval: "week", interval_count: 2 },
  monthly: { interval: "month", interval_count: 1 },
  every_3_months: { interval: "month", interval_count: 3 },
  every_6_months: { interval: "month", interval_count: 6 },
  yearly: { interval: "year", interval_count: 1 },
};

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

function stripeId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

/** Ensures API responses stay JSON-serializable (Stripe/Supabase error blobs can break res.json). */
function safeDetailForResponse(detail) {
  if (detail == null) return null;
  if (typeof detail !== "object" || Array.isArray(detail)) {
    return { preview: String(detail).slice(0, 500) };
  }
  if (typeof detail.step === "string" && Number.isFinite(detail.httpStatus)) {
    const body = detail.body;
    let compactBody = null;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      compactBody = {
        message: typeof body.message === "string" ? body.message : null,
        hint: typeof body.hint === "string" ? body.hint : null,
        code: typeof body.code === "string" ? body.code : null,
      };
    }
    return { step: detail.step, httpStatus: detail.httpStatus, body: compactBody };
  }
  const e = detail.error;
  if (e && typeof e === "object" && !Array.isArray(e)) {
    return {
      stripe_error: {
        type: typeof e.type === "string" ? e.type : null,
        code: typeof e.code === "string" ? e.code : null,
        message: typeof e.message === "string" ? e.message : null,
        param: typeof e.param === "string" ? e.param : null,
      },
    };
  }
  try {
    JSON.stringify(detail);
    return detail;
  } catch {
    return { error: "detail omitted (not JSON-serializable)" };
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

/** Stripe idempotency keys: unreserved chars; keep segments short. */
function idempotencySegment(segment) {
  return String(segment || "x")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 72);
}

/** Subscriptions items.price_data requires `product` (Product id); inline product_data is no longer accepted. */
async function ensureStripeProductForSubscriptionLine(client, plan, line) {
  const params = new URLSearchParams();
  const name = String(line.label || plan.name || "MiniCRM subscription").trim().slice(0, 250);
  params.set("name", name || "MiniCRM subscription");
  params.set("metadata[client_id]", client.id);
  params.set("metadata[plan_id]", plan.id);
  params.set("metadata[service_id]", String(line.serviceId));
  params.set("metadata[source]", "minicrm");
  const idem = `minicrm-prod-${idempotencySegment(client.id)}-${idempotencySegment(plan.id)}-${idempotencySegment(line.serviceId)}`;
  const product = await stripeRequest("products", {
    method: "POST",
    params,
    idempotencyKey: idem.slice(0, 255),
  });
  const productId = product?.id;
  if (!productId) throw new Error("Stripe product create returned no id");
  return productId;
}

function httpError(status, message, code, detail = null) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.detail = detail;
  return err;
}

function throwSupabaseFailure(step, httpStatus, data, fallbackMsg) {
  const msg =
    (typeof data?.message === "string" && data.message) ||
    (typeof data?.hint === "string" && data.hint) ||
    fallbackMsg ||
    `Supabase request failed (${httpStatus})`;
  const status = httpStatus >= 500 || httpStatus === 429 ? 503 : 502;
  throw httpError(status, msg, "supabase_error", { step, httpStatus, body: data });
}

async function loadClient(clientId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=*`,
    { headers: supabaseHeaders() },
  );
  const data = await readJson(res);
  if (!res.ok) throwSupabaseFailure("load_client", res.status, data, `client lookup failed (${res.status})`);
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
  if (!res.ok) throwSupabaseFailure("patch_client", res.status, data, `client update failed (${res.status})`);
  return Array.isArray(data) ? data[0] || null : data;
}

async function loadFirstClientPlanId(clientId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/client_plans?client_id=eq.${encodeURIComponent(clientId)}&select=plan_id&order=created_at.asc&limit=1`,
    { headers: supabaseHeaders() },
  );
  const data = await readJson(res);
  if (!res.ok)
    throwSupabaseFailure("load_client_plans", res.status, data, `client plan lookup failed (${res.status})`);
  return Array.isArray(data) ? data[0]?.plan_id || null : null;
}

async function loadPlan(planId) {
  if (!planId) return null;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/plans?id=eq.${encodeURIComponent(planId)}&select=id,name,subscription`,
    { headers: supabaseHeaders() },
  );
  const data = await readJson(res);
  if (!res.ok) throwSupabaseFailure("load_plan", res.status, data, `plan lookup failed (${res.status})`);
  return Array.isArray(data) ? data[0] || null : null;
}

async function resolveBillingPlanForClient(client) {
  const focusedPlanId = String(client?.focus_plan_id || "").trim();
  const fallbackUsed = !focusedPlanId;
  const planId = focusedPlanId || (await loadFirstClientPlanId(client.id));
  const plan = await loadPlan(planId);
  if (!plan) {
    throw httpError(
      409,
      "Link a Plan Builder tier with a priced subscription before creating a Stripe subscription.",
      "plan_required",
    );
  }
  return { plan, fallbackUsed };
}

function subscriptionFrequencyParts(slug) {
  return SUBSCRIPTION_INTERVALS[String(slug || "monthly").trim()] || SUBSCRIPTION_INTERVALS.monthly;
}

function pricedSubscriptionLines(plan) {
  const subscription = plan?.subscription;
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) return [];
  return Object.entries(subscription)
    .map(([serviceId, cfg]) => {
      if (!cfg || typeof cfg !== "object" || cfg.state !== "priced") return null;
      const raw = cfg.subscription_rate != null ? cfg.subscription_rate : cfg.price;
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const frequency = cfg.subscription_frequency || cfg.finance_frequency || "monthly";
      const parts = subscriptionFrequencyParts(frequency);
      return {
        serviceId,
        label: String(cfg.label || plan.name || "MiniCRM subscription").trim() || "MiniCRM subscription",
        amountCents: Math.round(amount * 100),
        frequency,
        ...parts,
      };
    })
    .filter(Boolean);
}

function ensureSingleSubscriptionFrequency(lines) {
  const first = lines[0];
  const mixed = lines.some(
    (line) => line.interval !== first.interval || line.interval_count !== first.interval_count,
  );
  if (mixed) {
    throw httpError(
      409,
      "This plan has subscription lines with mixed billing frequencies. Use one frequency for now.",
      "mixed_frequency_not_supported",
      { lines: lines.map(({ label, frequency }) => ({ label, frequency })) },
    );
  }
}

function dispatcherContextFromClient(client) {
  let bp = client?.billing_philosophy;
  if (typeof bp === "string") {
    try {
      bp = JSON.parse(bp);
    } catch {
      bp = null;
    }
  }
  if (!bp || typeof bp !== "object" || Array.isArray(bp)) return null;
  const dc = bp.dispatcherContext;
  if (!dc || typeof dc !== "object") return null;
  return dc;
}

function normalizeWizardRedTimeHm(v) {
  const s = String(v ?? "").trim();
  return /^\d{2}:\d{2}$/.test(s) ? s : "09:00";
}

/** Stripe billing_cycle_anchor (unix sec) from wizard red phase, or null if missing / not in the future. */
function wizardRedBillingAnchor(client) {
  const dc = dispatcherContextFromClient(client);
  if (!dc) {
    return { anchorUnix: null, redDate: null, redTime: null };
  }
  const sd = dc.start_dates || dc.startDates;
  const st = dc.start_times || dc.startTimes;
  const redDate = sd?.red != null ? String(sd.red).slice(0, 10) : null;
  if (!redDate || !/^\d{4}-\d{2}-\d{2}$/.test(redDate)) {
    return { anchorUnix: null, redDate: null, redTime: null };
  }
  const redTime = normalizeWizardRedTimeHm(st?.red);
  const [y, m, day] = redDate.split("-").map((x) => parseInt(x, 10));
  const [hh, mi] = redTime.split(":").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, day, Number.isFinite(hh) ? hh : 9, Number.isFinite(mi) ? mi : 0, 0, 0);
  const anchorUnix = Math.floor(dt.getTime() / 1000);
  const nowUnix = Math.floor(Date.now() / 1000);
  if (anchorUnix <= nowUnix) {
    return { anchorUnix: null, redDate, redTime };
  }
  return { anchorUnix, redDate, redTime };
}

function buildResolvedPlanAudit(client, plan, lines, wr, fallbackUsed, state, extra = {}) {
  const hasPm = !!state?.hasPaymentMethod;
  const collMode = client.billing_collection_mode === "auto_pay" && hasPm ? "auto_pay" : "manual";
  return {
    client_id: client.id,
    clients_focus_plan_id: client.focus_plan_id || null,
    resolved_plan_id: plan.id,
    resolved_plan_name: plan.name || null,
    plan_fallback_used: fallbackUsed,
    stripe_customer_linked: !!String(client.stripe_customer_id || "").trim(),
    priced_line_count: lines.length,
    priced_lines: lines.map((l) => ({
      service_id: l.serviceId,
      label: l.label,
      amount_dollars: Math.round(l.amountCents) / 100,
      frequency: l.frequency,
      interval: l.interval,
      interval_count: l.interval_count,
    })),
    wizard_dispatcher_context_present: !!dispatcherContextFromClient(client),
    wizard_red_date: wr.redDate || null,
    wizard_red_time: wr.redTime || null,
    billing_cycle_anchor_unix: wr.anchorUnix,
    billing_cycle_anchor_will_apply: wr.anchorUnix != null,
    stripe_subscription_create_collection_mode: collMode,
    existing_subscription_before_create: state.subscription?.id
      ? { id: state.subscription.id, status: state.subscription.status }
      : null,
    ...extra,
  };
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
    stripeId(customer?.invoice_settings?.default_payment_method) ||
    stripeId(customer?.default_source) ||
    stripeId(paymentMethods[0]) ||
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
    defaultPaymentMethod,
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
      defaultPaymentMethod: state.defaultPaymentMethod || null,
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

function parseRequestBody(req, label) {
  const raw = req.body;
  if (raw == null || raw === "") return {};
  const isBuf = typeof Buffer !== "undefined" && Buffer.isBuffer(raw);
  if (typeof raw === "object" && raw !== null && !isBuf) return raw;
  if (isBuf) {
    const str = raw.toString("utf8");
    try {
      return str ? JSON.parse(str) : {};
    } catch {
      throw httpError(400, `Invalid JSON in ${label}`, "invalid_json");
    }
  }
  if (typeof raw === "string") {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw httpError(400, `Invalid JSON in ${label}`, "invalid_json");
    }
  }
  return {};
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
  const body = parseRequestBody(req, "PATCH body");
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

async function createStripeSubscriptionFromPlan(client, state, plan, fallbackUsed) {
  const customerId = String(client.stripe_customer_id || "").trim();
  const wr = wizardRedBillingAnchor(client);
  const lines = pricedSubscriptionLines(plan);

  if (!customerId) {
    throw httpError(
      409,
      "Create or sync a Stripe customer before creating a subscription.",
      "customer_required",
    );
  }

  if (state.subscription?.id && !["canceled", "incomplete_expired"].includes(state.subscription.status)) {
    const auditLines = [...lines];
    if (auditLines.length) {
      try {
        ensureSingleSubscriptionFrequency(auditLines);
      } catch (freqErr) {
        freqErr.resolvedPlanAudit = buildResolvedPlanAudit(client, plan, auditLines, wr, fallbackUsed, state, {
          reused_existing_stripe_subscription: true,
          frequency_validation_failed: true,
        });
        throw freqErr;
      }
    }
    const resolvedPlanAudit = buildResolvedPlanAudit(client, plan, auditLines, wr, fallbackUsed, state, {
      reused_existing_stripe_subscription: true,
      reused_subscription_id: state.subscription.id,
      reused_subscription_status: state.subscription.status,
    });
    console.info("[admin/billing] create_subscription resolved (reuse existing)", resolvedPlanAudit);
    return { subscription: state.subscription, resolvedPlanAudit };
  }

  if (!lines.length) {
    const err = httpError(
      409,
      "The selected Plan Builder tier does not have any priced subscription lines.",
      "plan_subscription_required",
    );
    err.resolvedPlanAudit = buildResolvedPlanAudit(client, plan, [], wr, fallbackUsed, state, {
      priced_lines_missing: true,
    });
    throw err;
  }

  try {
    ensureSingleSubscriptionFrequency(lines);
  } catch (freqErr) {
    freqErr.resolvedPlanAudit = buildResolvedPlanAudit(client, plan, lines, wr, fallbackUsed, state, {});
    throw freqErr;
  }

  const resolvedPlanAudit = buildResolvedPlanAudit(client, plan, lines, wr, fallbackUsed, state, {
    reused_existing_stripe_subscription: false,
  });
  console.info("[admin/billing] create_subscription resolved", resolvedPlanAudit);

  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("metadata[client_id]", client.id);
  params.set("metadata[crm_client_id]", client.id);
  params.set("metadata[plan_id]", plan.id);
  params.set("metadata[source]", "minicrm");
  if (wr.redDate) {
    params.set("metadata[source_runtime]", "invoice_plan_wizard");
    params.set("metadata[red_start_date]", wr.redDate);
    params.set("metadata[red_start_time]", wr.redTime || "09:00");
  }
  if (wr.anchorUnix != null) {
    params.set("billing_cycle_anchor", String(wr.anchorUnix));
  }

  const mode = state.hasPaymentMethod && client.billing_collection_mode === "auto_pay" ? "auto_pay" : "manual";
  if (mode === "auto_pay") {
    params.set("collection_method", "charge_automatically");
    const dpm = stripeId(state.defaultPaymentMethod);
    if (dpm) params.set("default_payment_method", dpm);
  } else {
    params.set("collection_method", "send_invoice");
    params.set("days_until_due", String(MANUAL_DAYS_UNTIL_DUE));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const productId = await ensureStripeProductForSubscriptionLine(client, plan, line);
    params.set(`items[${i}][price_data][currency]`, "usd");
    params.set(`items[${i}][price_data][unit_amount]`, String(line.amountCents));
    params.set(`items[${i}][price_data][product]`, productId);
    params.set(`items[${i}][price_data][recurring][interval]`, line.interval);
    params.set(`items[${i}][price_data][recurring][interval_count]`, String(line.interval_count));
  }

  const anchorBucket = wr.anchorUnix != null ? String(wr.anchorUnix) : "immediate";
  const rtPart = (wr.redTime || "").replace(/:/g, "");
  const idempotencyKey = `minicrm-create-sub-${client.id}-${plan.id}-${wr.redDate || "na"}-${rtPart || "na"}-${anchorBucket}`;

  try {
    const subscription = await stripeRequest("subscriptions", {
      method: "POST",
      params,
      idempotencyKey,
    });
    return { subscription, resolvedPlanAudit };
  } catch (stripeErr) {
    stripeErr.resolvedPlanAudit = resolvedPlanAudit;
    throw stripeErr;
  }
}

async function handlePost(req, res) {
  const body = parseRequestBody(req, "POST body");
  const clientId = String(body.clientId || "").trim();
  const action = String(body.action || "").trim();
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  if (!["request_payment_method", "create_subscription"].includes(action)) {
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

  if (action === "create_subscription") {
    const state = await resolveBillingState(client);
    const { plan, fallbackUsed } = await resolveBillingPlanForClient(client);
    const { subscription, resolvedPlanAudit } = await createStripeSubscriptionFromPlan(
      client,
      state,
      plan,
      fallbackUsed,
    );
    const clientWithSub = { ...client, stripe_subscription_id: subscription.id };
    try {
      const nextState = await resolveBillingState(clientWithSub);
      const patched = await syncClientBillingCache(client, nextState);
      return res.status(200).json({
        ok: true,
        created: subscription.id !== state.subscription?.id,
        plan: { id: plan.id, name: plan.name || null },
        resolvedPlan: resolvedPlanAudit,
        ...publicBillingPayload(patched || client, nextState),
      });
    } catch (syncErr) {
      console.error("[admin/billing] sync after subscription create", syncErr?.stack || syncErr);
      const stripeBody =
        syncErr.detail?.error && typeof syncErr.detail.error === "object"
          ? syncErr.detail.error
          : null;
      return res.status(502).json({
        ok: false,
        error:
          syncErr.message ||
          "Stripe subscription was created but MiniCRM could not save billing state to the database.",
        code: "client_cache_sync_failed",
        stripe_subscription_id: subscription.id,
        resolvedPlan: resolvedPlanAudit,
        detail: safeDetailForResponse(syncErr.detail),
        stripe_message: stripeBody?.message || null,
      });
    }
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
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "PATCH") return await handlePatch(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    res.setHeader("Allow", "GET, PATCH, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("[admin/billing]", req.method, req.url || "", err?.message || err, err?.stack || "");
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    const stripeBody = err.detail?.error && typeof err.detail.error === "object" ? err.detail.error : null;
    const stripeMessage = stripeBody?.message || null;
    const stripeCode = stripeBody?.code || null;
    try {
      return res.status(status).json({
        error: err.message || String(err),
        code: err.code || stripeCode || null,
        detail: safeDetailForResponse(err.detail),
        stripe_message: stripeMessage,
        resolvedPlan: err.resolvedPlanAudit || null,
      });
    } catch (jsonErr) {
      console.error("[admin/billing] res.json failed in catch", jsonErr?.message || jsonErr);
      const minimal = JSON.stringify({
        error: err.message || String(err),
        code: err.code || stripeCode || null,
        stripe_message: stripeMessage,
      });
      return res.status(status).type("application/json").send(minimal);
    }
  }
}
