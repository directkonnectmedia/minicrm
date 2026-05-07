/**
 * POST /api/invoices/publish-calendar
 *
 * Requires a valid Supabase session JWT. Uses the Supabase service role
 * (bypasses RLS), so portal publish succeeds even if JWT role metadata is
 * missing or browser-side RLS blocks direct writes.
 *
 * Body JSON:
 *   { calendarEventId, publishNow, dispatchAtIso|null, invoice }
 *   `invoice` = row for insert (no id) or update (include id)
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

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function requestOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}` : "https://minicrm-kappa.vercel.app";
}

function invoiceLineItemsForStripe(invoice) {
  const lines = Array.isArray(invoice?.line_items) ? invoice.line_items : [];
  return lines
    .map((line) => {
      const amount = Number(line.amount) || 0;
      const unitAmount = Math.round(amount * 100);
      if (!(unitAmount > 0)) return null;
      return {
        name: String(line.description || "Invoice line item").trim() || "Invoice line item",
        description: String(line.subtitle || line.status_pill || "").trim(),
        unitAmount,
      };
    })
    .filter(Boolean);
}

async function createStripeCheckoutSession({ invoice, client, req }) {
  if (!STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured. Add it in Vercel and redeploy.");
  }

  const stripeLines = invoiceLineItemsForStripe(invoice);
  if (!stripeLines.length) {
    throw new Error("Invoice has no positive line items for Stripe Checkout.");
  }

  const origin = requestOrigin(req);
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${origin}/portal.html?stripe=success&invoice=${encodeURIComponent(invoice.id)}`);
  params.set("cancel_url", `${origin}/portal.html?stripe=cancel&invoice=${encodeURIComponent(invoice.id)}`);
  params.set("client_reference_id", invoice.id);

  const clientEmail = normalizeEmail(client?.email);
  if (clientEmail) params.set("customer_email", clientEmail);

  params.set("metadata[invoice_id]", invoice.id);
  params.set("metadata[client_id]", invoice.client_id || "");
  params.set("metadata[receipt_no]", invoice.receipt_no || "");
  params.set("payment_intent_data[metadata][invoice_id]", invoice.id);
  params.set("payment_intent_data[metadata][client_id]", invoice.client_id || "");
  params.set("payment_intent_data[metadata][receipt_no]", invoice.receipt_no || "");

  stripeLines.forEach((line, index) => {
    params.set(`line_items[${index}][quantity]`, "1");
    params.set(`line_items[${index}][price_data][currency]`, "usd");
    params.set(`line_items[${index}][price_data][unit_amount]`, String(line.unitAmount));
    params.set(`line_items[${index}][price_data][product_data][name]`, line.name);
    if (line.description) {
      params.set(`line_items[${index}][price_data][product_data][description]`, line.description);
    }
  });

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `minicrm-invoice-checkout-${invoice.id}`,
    },
    body: params.toString(),
  });
  const stripeJson = await readJson(stripeRes);
  if (!stripeRes.ok) {
    const msg =
      stripeJson?.error?.message ||
      (typeof stripeJson?.raw === "string" ? stripeJson.raw : null) ||
      `Stripe Checkout failed (${stripeRes.status})`;
    throw new Error(msg);
  }
  if (!stripeJson?.url) throw new Error("Stripe did not return a checkout URL.");
  return stripeJson;
}

function injectStripeLinkIntoInvoiceHtml(html, stripeUrl) {
  const source = String(html || "");
  if (!source || !stripeUrl) return source;
  const safeUrl = escapeHtmlAttr(stripeUrl);
  let out = source;
  out = out.replace(/border:2px dashed #9ca3af/g, "border:2px solid #635BFF");
  out = out.replace(/background:#9ca3af;color:#ffffff/g, "background:#635BFF;color:#ffffff");
  out = out.replace(
    /<span style="([^"]*)cursor:not-allowed;?([^"]*)">Pay with Stripe<\/span>/,
    `<a href="${safeUrl}" target="_blank" rel="noopener" style="$1$2text-decoration:none;">Pay with Stripe</a>`,
  );
  out = out.replace("Pay link will appear once configured.", "Secure checkout powered by Stripe");
  return out;
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
  // Some auth stacks wrap as { user: { … } }; CRM session JWT uses the same shape as Postgres is_team_member().
  if (raw.user && typeof raw.user === "object") return raw.user;
  return raw;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Add it in Vercel → Environment Variables.",
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

  const calendarEventId = String(body.calendarEventId || "").trim();
  const publishNow = !!body.publishNow;
  const dispatchAtIso =
    body.dispatchAtIso === undefined || body.dispatchAtIso === null
      ? null
      : String(body.dispatchAtIso);
  const invoice = body.invoice;

  if (!calendarEventId) {
    return res.status(400).json({ error: "calendarEventId is required" });
  }
  if (!invoice || typeof invoice !== "object") {
    return res.status(400).json({ error: "invoice payload is required" });
  }

  const nowIso = new Date().toISOString();
  const schedIso = publishNow ? nowIso : dispatchAtIso;
  if (!schedIso) {
    return res.status(400).json({ error: "dispatchAtIso is required when scheduling" });
  }

  const calUrl = `${SUPABASE_URL}/rest/v1/invoice_calendar_events?id=eq.${encodeURIComponent(calendarEventId)}&select=*`;
  const calRes = await fetch(calUrl, { headers: { ...restHeaders(), Accept: "application/json" } });
  const calJson = await readJson(calRes);
  if (!calRes.ok) {
    return res.status(500).json({
      error: "failed to load calendar event",
      detail: calJson,
    });
  }
  const calRow = Array.isArray(calJson) ? calJson[0] : null;
  if (!calRow) {
    return res.status(404).json({ error: "calendar event not found" });
  }

  const invClientId = String(invoice.client_id || "");
  if (!invClientId || invClientId !== String(calRow.client_id)) {
    return res.status(400).json({ error: "invoice client_id must match calendar row" });
  }

  const invPayload = {
    ...invoice,
    scheduled_dispatch_time: schedIso,
    portal_dispatch_status: publishNow ? "pushed" : "queued",
    portal_published_at: publishNow ? nowIso : null,
  };

  let saved;

  const invoiceId = invoice.id ? String(invoice.id) : null;
  if (invoiceId) {
    const { id: _omitId, ...patchBody } = invPayload;
    const patchUrl = `${SUPABASE_URL}/rest/v1/invoices?id=eq.${encodeURIComponent(invoiceId)}`;
    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        ...restHeaders(),
        Prefer: "return=representation",
      },
      body: JSON.stringify(patchBody),
    });
    const patchJson = await readJson(patchRes);
    if (!patchRes.ok) {
      return res.status(500).json({
        error: "invoice update failed",
        detail: patchJson,
      });
    }
    const arr = Array.isArray(patchJson) ? patchJson : [];
    saved = arr[0] || null;
  } else {
    const { id: _dropId, ...insertBody } = invPayload;
    const postRes = await fetch(`${SUPABASE_URL}/rest/v1/invoices`, {
      method: "POST",
      headers: {
        ...restHeaders(),
        Prefer: "return=representation",
      },
      body: JSON.stringify(insertBody),
    });
    const postJson = await readJson(postRes);
    if (!postRes.ok) {
      return res.status(500).json({
        error: "invoice insert failed",
        detail: postJson,
      });
    }
    const arr = Array.isArray(postJson) ? postJson : [postJson];
    saved = arr[0] || null;
  }

  if (!saved || !saved.id) {
    return res.status(500).json({ error: "save did not return invoice row" });
  }

  const clientRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(saved.client_id)}&select=id,company_name,email,created_at,stripe_subscription_id,billing_collection_mode`,
    { headers: restHeaders() },
  );
  const clientJson = await readJson(clientRes);
  const client = clientRes.ok && Array.isArray(clientJson) ? clientJson[0] || null : null;
  const subscriptionManaged = !!String(client?.stripe_subscription_id || "").trim();

  if (!saved.stripe_payment_link && !subscriptionManaged) {
    let checkoutSession;
    try {
      checkoutSession = await createStripeCheckoutSession({ invoice: saved, client, req });
    } catch (err) {
      return res.status(500).json({
        error: "stripe checkout creation failed",
        detail: err.message || String(err),
      });
    }

    const stripePatch = {
      stripe_payment_link: checkoutSession.url,
      stripe_status: "checkout_created",
      rendered_html: injectStripeLinkIntoInvoiceHtml(saved.rendered_html, checkoutSession.url),
    };
    const stripePatchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices?id=eq.${encodeURIComponent(saved.id)}`,
      {
        method: "PATCH",
        headers: {
          ...restHeaders(),
          Prefer: "return=representation",
        },
        body: JSON.stringify(stripePatch),
      },
    );
    const stripePatchJson = await readJson(stripePatchRes);
    if (!stripePatchRes.ok) {
      return res.status(500).json({
        error: "stripe checkout created but invoice update failed",
        detail: stripePatchJson,
      });
    }
    const patched = Array.isArray(stripePatchJson) ? stripePatchJson[0] : stripePatchJson;
    if (patched?.id) saved = patched;
  } else if (subscriptionManaged && !saved.stripe_status) {
    const subPatchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices?id=eq.${encodeURIComponent(saved.id)}`,
      {
        method: "PATCH",
        headers: {
          ...restHeaders(),
          Prefer: "return=representation",
        },
        body: JSON.stringify({ stripe_status: "subscription_managed" }),
      },
    );
    const subPatchJson = await readJson(subPatchRes);
    if (!subPatchRes.ok) {
      return res.status(500).json({
        error: "invoice saved but subscription-managed marker failed",
        detail: subPatchJson,
      });
    }
    const patched = Array.isArray(subPatchJson) ? subPatchJson[0] : subPatchJson;
    if (patched?.id) saved = patched;
  }

  const calPatch = {
    invoice_id: saved.id,
    scheduled_dispatch_time: schedIso,
  };
  const calPatchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/invoice_calendar_events?id=eq.${encodeURIComponent(calendarEventId)}`,
    {
      method: "PATCH",
      headers: restHeaders(),
      body: JSON.stringify(calPatch),
    },
  );
  if (!calPatchRes.ok) {
    const calErr = await readJson(calPatchRes);
    return res.status(500).json({
      error: "invoice saved but calendar link failed — contact support",
      invoiceId: saved.id,
      detail: calErr,
    });
  }

  if (publishNow && !saved.portal_published_at) {
    const verifyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices?id=eq.${encodeURIComponent(saved.id)}&select=id,portal_published_at`,
      { headers: restHeaders() },
    );
    const verifyJson = await readJson(verifyRes);
    const row = Array.isArray(verifyJson) ? verifyJson[0] : null;
    if (!row?.portal_published_at) {
      return res.status(500).json({
        error: "portal publish not confirmed (portal_published_at missing)",
        invoiceId: saved.id,
      });
    }
  }

  const portalEmail = normalizeEmail(client?.email);
  let duplicateClientCount = 0;
  let duplicateClientIds = [];
  if (portalEmail) {
    const dupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?select=id,email&email=ilike.${encodeURIComponent(`*${portalEmail}*`)}`,
      { headers: restHeaders() },
    );
    const dupJson = await readJson(dupRes);
    const dupRows = Array.isArray(dupJson)
      ? dupJson.filter((row) => normalizeEmail(row.email) === portalEmail)
      : [];
    duplicateClientCount = dupRows.length;
    duplicateClientIds = dupRows.map((row) => row.id);
  }

  return res.status(200).json({
    ok: true,
    invoice: saved,
    publishNow,
    portalTarget: {
      client_id: saved.client_id,
      client_email: client?.email || null,
      normalized_email: portalEmail || null,
      portal_published_at: saved.portal_published_at || null,
      duplicate_client_count: duplicateClientCount,
      duplicate_client_ids: duplicateClientIds,
    },
  });
}
