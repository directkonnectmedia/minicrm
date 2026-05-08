/**
 * GET /api/portal/invoices
 *
 * Returns published invoices for the client portal user identified by the
 * Supabase session JWT email. Uses the service role so portal invoice reads do
 * not depend on browser-side RLS behavior.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Columns returned to the portal (keep in sync with portal UI). */
const INVOICE_SELECT =
  "id,client_id,receipt_no,issued_at,due_at,status,portal_published_at,stripe_payment_link,stripe_invoice_id,stripe_status,stripe_hosted_invoice_url,amount_due,amount_remaining,paid_at,rendered_html";

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
    (body && typeof body.hint === "string" && body.hint.trim()) ||
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
      `${SUPABASE_URL}/rest/v1/clients?select=id,company_name,email,created_at&email=ilike.${encodeURIComponent(`*${email}*`)}&order=created_at.desc`,
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
    const clientIds = clients.map((client) => client.id).filter(Boolean);
    if (!clientIds.length) {
      return res.status(200).json({ rows: [], clientIds: [], email, clients: [] });
    }

    const sb = serviceSupabase();
    const { data: invoiceRows, error: invoiceError } = await sb
      .from("invoices")
      .select(INVOICE_SELECT)
      .in("client_id", clientIds)
      .not("portal_published_at", "is", null)
      .order("portal_published_at", { ascending: false });

    if (invoiceError) {
      const extra = restErrorPayload(400, {
        message: invoiceError.message,
        details: invoiceError.details,
        hint: invoiceError.hint,
        code: invoiceError.code,
      });
      return res.status(500).json({
        error: "invoice lookup failed",
        ...extra,
      });
    }

    return res.status(200).json({
      rows: Array.isArray(invoiceRows) ? invoiceRows : [],
      clientIds,
      email,
      clients,
    });
  } catch (err) {
    console.error("portal/invoices:", err);
    return res.status(500).json({
      error: "invoice route failed",
      message: err?.message || String(err),
    });
  }
}
