/**
 * GET /api/portal/invoices
 *
 * Returns published invoices for the client portal user identified by the
 * Supabase session JWT email. Uses the service role so portal invoice reads do
 * not depend on browser-side RLS behavior.
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
  return raw.user && typeof raw.user === "object" ? raw.user : raw;
}

export default async function handler(req, res) {
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
    return res.status(500).json({ error: "client lookup failed", detail: clientsJson });
  }

  const clients = Array.isArray(clientsJson)
    ? clientsJson.filter((client) => normalizeEmail(client.email) === email)
    : [];
  const clientIds = clients.map((client) => client.id).filter(Boolean);
  if (!clientIds.length) {
    return res.status(200).json({ rows: [], clientIds: [], email, clients: [] });
  }

  const invoicesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/invoices?select=id,client_id,receipt_no,issued_at,status,portal_published_at,stripe_payment_link,rendered_html&client_id=in.(${clientIds.join(",")})&portal_published_at=not.is.null&order=portal_published_at.desc`,
    { headers: restHeaders() },
  );
  const invoicesJson = await readJson(invoicesRes);
  if (!invoicesRes.ok) {
    return res.status(500).json({ error: "invoice lookup failed", detail: invoicesJson });
  }

  return res.status(200).json({
    rows: Array.isArray(invoicesJson) ? invoicesJson : [],
    clientIds,
    email,
    clients,
  });
}
