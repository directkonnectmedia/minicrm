/**
 * POST /api/invoices/create-calendar-draft
 *
 * Creates a pending draft invoice for an invoice_calendar_events row and links it
 * back to the calendar event. Uses the Supabase service role so draft creation
 * is not blocked by browser-side RLS or stale receipt counts.
 *
 * Body JSON:
 *   { calendarEventId, issuedAt, invoice }
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function normalizeIssuedDate(value) {
  const raw = String(value || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : new Date().toISOString().slice(0, 10);
}

async function nextReceiptNoForIssuedDate(issuedAt, offset = 0) {
  const day = normalizeIssuedDate(issuedAt);
  const stamp = day.replace(/-/g, "");
  const countRes = await fetch(
    `${SUPABASE_URL}/rest/v1/invoices?issued_at=eq.${encodeURIComponent(day)}&select=id`,
    {
      method: "HEAD",
      headers: {
        ...restHeaders(),
        Prefer: "count=exact",
      },
    },
  );
  if (!countRes.ok) {
    const detail = await readJson(countRes);
    throw new Error(
      `receipt count failed: ${detail?.message || detail?.raw || countRes.statusText}`,
    );
  }
  const range = countRes.headers.get("content-range") || "";
  const total = Number(range.split("/").pop()) || 0;
  const seq = String(total + 1 + offset).padStart(3, "0");
  return `DCL-${stamp}-${seq}`;
}

function isDuplicateReceiptError(status, detail) {
  if (status === 409) return true;
  const code = detail && typeof detail === "object" ? detail.code : "";
  const msg = JSON.stringify(detail || "").toLowerCase();
  return code === "23505" || msg.includes("duplicate key") || msg.includes("receipt_no");
}

function withReceiptNo(invoice, oldReceiptNo, receiptNo) {
  const next = {
    ...invoice,
    receipt_no: receiptNo,
    portal_dispatch_status: "pending_time",
    portal_published_at: null,
    scheduled_dispatch_time: null,
  };
  if (
    next.rendered_html &&
    oldReceiptNo &&
    oldReceiptNo !== receiptNo &&
    typeof next.rendered_html === "string"
  ) {
    next.rendered_html = next.rendered_html.split(oldReceiptNo).join(receiptNo);
  }
  return next;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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
  const issuedAt = normalizeIssuedDate(body.issuedAt);
  const invoice = body.invoice;

  if (!calendarEventId) {
    return res.status(400).json({ error: "calendarEventId is required" });
  }
  if (!invoice || typeof invoice !== "object") {
    return res.status(400).json({ error: "invoice payload is required" });
  }

  const calRes = await fetch(
    `${SUPABASE_URL}/rest/v1/invoice_calendar_events?id=eq.${encodeURIComponent(calendarEventId)}&select=*`,
    { headers: restHeaders() },
  );
  const calJson = await readJson(calRes);
  if (!calRes.ok) {
    return res.status(500).json({ error: "failed to load calendar event", detail: calJson });
  }
  const calRow = Array.isArray(calJson) ? calJson[0] : null;
  if (!calRow) return res.status(404).json({ error: "calendar event not found" });

  if (String(invoice.client_id || "") !== String(calRow.client_id || "")) {
    return res.status(400).json({ error: "invoice client_id must match calendar row" });
  }

  const originalReceiptNo = String(invoice.receipt_no || "");
  let lastError = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    let receiptNo;
    try {
      receiptNo = await nextReceiptNoForIssuedDate(issuedAt, attempt);
    } catch (e) {
      return res.status(500).json({ error: e.message || "receipt generation failed" });
    }

    const insertBody = withReceiptNo(invoice, originalReceiptNo, receiptNo);
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
      lastError = postJson;
      if (isDuplicateReceiptError(postRes.status, postJson)) continue;
      return res.status(500).json({ error: "invoice insert failed", detail: postJson });
    }

    const saved = (Array.isArray(postJson) ? postJson[0] : postJson) || null;
    if (!saved?.id) {
      return res.status(500).json({ error: "invoice insert did not return a row" });
    }

    const linkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/invoice_calendar_events?id=eq.${encodeURIComponent(calendarEventId)}`,
      {
        method: "PATCH",
        headers: restHeaders(),
        body: JSON.stringify({ invoice_id: saved.id }),
      },
    );
    if (!linkRes.ok) {
      const linkErr = await readJson(linkRes);
      await fetch(`${SUPABASE_URL}/rest/v1/invoices?id=eq.${encodeURIComponent(saved.id)}`, {
        method: "DELETE",
        headers: restHeaders(),
      });
      return res.status(500).json({
        error: "invoice saved but calendar link failed",
        detail: linkErr,
      });
    }

    return res.status(200).json({ ok: true, invoice: saved });
  }

  return res.status(409).json({
    error: "could not generate a unique receipt number",
    detail: lastError,
  });
}
