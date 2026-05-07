/**
 * POST /api/stripe/webhook
 *
 * Stripe reporting loop for MiniCRM billing:
 * - verifies Stripe-Signature when STRIPE_WEBHOOK_SECRET is configured
 * - mirrors subscription status onto public.clients
 * - links Stripe invoices into public.invoices for a unified portal timeline
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_WEBHOOK_SECRET
 */

import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function supabaseHeaders(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json",
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

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function verifyStripeSignature(rawBody, signatureHeader) {
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  }
  if (!signatureHeader) throw new Error("Missing Stripe-Signature header.");

  const parts = String(signatureHeader)
    .split(",")
    .map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || signatures.length === 0) throw new Error("Invalid Stripe-Signature header.");

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    throw new Error("Stripe webhook signature timestamp is outside tolerance.");
  }

  const expected = crypto
    .createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  const ok = signatures.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate, "hex");
    return (
      candidateBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
    );
  });
  if (!ok) throw new Error("Stripe webhook signature verification failed.");
}

function centsToMoney(cents) {
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents) / 100;
}

function unixToIso(unix) {
  return unix ? new Date(unix * 1000).toISOString() : null;
}

function unixToDate(unix) {
  return unix ? new Date(unix * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function stripeId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

function stripeCollectionMode(subscription) {
  return subscription?.collection_method === "charge_automatically" ? "auto_pay" : "manual";
}

function invoiceStatus(invoice, eventType) {
  if (eventType === "invoice.upcoming") return "upcoming";
  if (eventType === "invoice.payment_failed") return "past_due";
  if (invoice?.status === "paid") return "paid";
  if (invoice?.status === "void") return "void";
  if (invoice?.status === "uncollectible") return "uncollectible";
  if (invoice?.status === "open") {
    const dueDate = invoice.due_date ? invoice.due_date * 1000 : null;
    if (dueDate && dueDate < Date.now()) return "past_due";
    return "open";
  }
  if (invoice?.status === "draft") return "upcoming";
  return "due";
}

function invoiceHtml(invoice, status) {
  const number = invoice.number || invoice.id || "Stripe invoice";
  const amount = centsToMoney(invoice.amount_due ?? invoice.total ?? 0) || 0;
  const url = invoice.hosted_invoice_url || "";
  const pay = url
    ? `<p><a href="${url}" target="_blank" rel="noopener">Open secure Stripe invoice</a></p>`
    : "";
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
      <h2 style="margin:0 0 8px;">Invoice ${number}</h2>
      <p style="margin:0 0 8px;">Status: ${status.replace("_", " ")}</p>
      <p style="margin:0 0 8px;">Amount due: $${amount.toFixed(2)}</p>
      ${pay}
    </div>
  `;
}

async function patchRows(table, query, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(data?.message || `${table} patch failed (${res.status})`);
  return Array.isArray(data) ? data : [];
}

async function insertRow(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(data?.message || `${table} insert failed (${res.status})`);
  return Array.isArray(data) ? data[0] || null : data;
}

async function findClientForStripe({ clientId, customerId, subscriptionId }) {
  if (clientId) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=*`,
      { headers: supabaseHeaders() },
    );
    const data = await readJson(res);
    if (res.ok && Array.isArray(data) && data[0]) return data[0];
  }

  const filters = [];
  if (customerId) filters.push(`stripe_customer_id=eq.${encodeURIComponent(customerId)}`);
  if (subscriptionId) filters.push(`stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`);
  for (const filter of filters) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/clients?${filter}&select=*`, {
      headers: supabaseHeaders(),
    });
    const data = await readJson(res);
    if (res.ok && Array.isArray(data) && data[0]) return data[0];
  }
  return null;
}

async function syncSubscription(subscription) {
  const customerId = stripeId(subscription?.customer);
  const client = await findClientForStripe({
    clientId: subscription?.metadata?.client_id || subscription?.metadata?.crm_client_id,
    customerId,
    subscriptionId: subscription?.id,
  });
  if (!client) return { clientUpdated: false };

  const alert = ["past_due", "unpaid"].includes(subscription.status)
    ? `Subscription is ${subscription.status.replace("_", " ")}.`
    : null;
  await patchRows(
    "clients",
    `id=eq.${encodeURIComponent(client.id)}`,
    {
      stripe_customer_id: customerId || client.stripe_customer_id || null,
      stripe_subscription_id: subscription.id,
      billing_collection_mode: stripeCollectionMode(subscription),
      stripe_subscription_status: subscription.status || null,
      stripe_billing_synced_at: new Date().toISOString(),
      stripe_billing_alert: alert,
    },
  );
  return { clientUpdated: true, clientId: client.id };
}

async function syncInvoice(invoice, eventType) {
  const customerId = stripeId(invoice?.customer);
  const subscriptionId = stripeId(invoice?.subscription);
  const paymentIntentId = stripeId(invoice?.payment_intent);
  const client = await findClientForStripe({
    clientId: invoice?.metadata?.client_id || invoice?.subscription_details?.metadata?.client_id,
    customerId,
    subscriptionId,
  });
  if (!client) return { invoiceUpdated: false, reason: "client_not_found" };

  const status = invoiceStatus(invoice, eventType);
  const amountDue = centsToMoney(invoice.amount_due ?? invoice.total ?? 0);
  const amountRemaining = centsToMoney(invoice.amount_remaining ?? 0);
  const paidAt =
    status === "paid"
      ? unixToIso(invoice.status_transitions?.paid_at || invoice.created)
      : null;
  const patch = {
    client_id: client.id,
    stripe_invoice_id: invoice.id || null,
    stripe_subscription_id: subscriptionId || client.stripe_subscription_id || null,
    stripe_payment_intent_id: paymentIntentId,
    stripe_status: invoice.status || status,
    stripe_hosted_invoice_url: invoice.hosted_invoice_url || null,
    stripe_invoice_pdf: invoice.invoice_pdf || null,
    due_at: unixToIso(invoice.due_date || invoice.next_payment_attempt),
    amount_due: amountDue,
    amount_remaining: amountRemaining,
    amount_paid: centsToMoney(invoice.amount_paid ?? 0) || 0,
    status,
    paid_at: paidAt,
    portal_published_at: new Date().toISOString(),
    portal_dispatch_status: "pushed",
    rendered_html: invoiceHtml(invoice, status),
  };

  let rows = [];
  if (invoice.id) {
    rows = await patchRows("invoices", `stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}`, patch);
  }
  if (!rows.length && invoice?.metadata?.invoice_id) {
    rows = await patchRows("invoices", `id=eq.${encodeURIComponent(invoice.metadata.invoice_id)}`, patch);
  }
  if (!rows.length && invoice.id) {
    await insertRow("invoices", {
      ...patch,
      receipt_no: invoice.number || invoice.id,
      issued_at: unixToDate(invoice.created),
      billed_to_name: client.company_name || client.client_name || null,
      line_items: [],
      payment_methods: [],
      terms_html: null,
    });
  }

  const clientPatch = {
    stripe_customer_id: customerId || client.stripe_customer_id || null,
    stripe_subscription_id: subscriptionId || client.stripe_subscription_id || null,
    stripe_subscription_status: status === "past_due" ? "past_due" : client.stripe_subscription_status || null,
    stripe_next_invoice_amount_cents: null,
    stripe_next_invoice_at: null,
    stripe_billing_synced_at: new Date().toISOString(),
    stripe_billing_alert: status === "past_due" ? "Invoice is past due." : null,
  };
  if (eventType === "invoice.upcoming") {
    clientPatch.stripe_next_invoice_amount_cents = invoice.amount_due ?? invoice.total ?? null;
    clientPatch.stripe_next_invoice_at = unixToIso(invoice.next_payment_attempt || invoice.due_date || invoice.created);
    clientPatch.stripe_billing_alert = null;
  }
  await patchRows("clients", `id=eq.${encodeURIComponent(client.id)}`, clientPatch);
  return { invoiceUpdated: true, clientId: client.id, status };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured." });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
    verifyStripeSignature(rawBody, req.headers["stripe-signature"]);
  } catch (err) {
    return res.status(400).json({ error: err.message || "Webhook signature verification failed." });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid webhook JSON." });
  }

  try {
    const object = event?.data?.object || {};
    let result = { ignored: true };
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
      result = await syncSubscription(object);
    } else if (
      [
        "invoice.created",
        "invoice.finalized",
        "invoice.paid",
        "invoice.payment_failed",
        "invoice.marked_uncollectible",
        "invoice.voided",
        "invoice.upcoming",
      ].includes(event.type)
    ) {
      result = await syncInvoice(object, event.type);
    }
    return res.status(200).json({ received: true, type: event.type, result });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
