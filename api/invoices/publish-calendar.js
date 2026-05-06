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

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
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

  const clientRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(saved.client_id)}&select=id,company_name,email,created_at`,
    { headers: restHeaders() },
  );
  const clientJson = await readJson(clientRes);
  const client = clientRes.ok && Array.isArray(clientJson) ? clientJson[0] || null : null;
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
