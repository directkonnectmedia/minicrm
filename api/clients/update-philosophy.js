/**
 * POST /api/clients/update-philosophy
 *
 * Bypasses RLS to update a client's billing_philosophy.
 * Requires any valid Supabase user JWT (does not enforce team roles).
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
  return readJson(r);
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

  const clientId = String(body.clientId || "").trim();
  const billing_philosophy = body.billing_philosophy;

  if (!clientId) {
    return res.status(400).json({ error: "clientId is required" });
  }
  if (!billing_philosophy || typeof billing_philosophy !== "object") {
    return res.status(400).json({ error: "billing_philosophy payload is required" });
  }

  const patchUrl = `${SUPABASE_URL}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`;
  const patchRes = await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      ...restHeaders(),
      Prefer: "return=representation",
    },
    body: JSON.stringify({ billing_philosophy }),
  });
  
  const patchJson = await readJson(patchRes);
  
  if (!patchRes.ok) {
    return res.status(500).json({
      error: "client update failed",
      detail: patchJson,
    });
  }

  return res.status(200).json({ ok: true });
}
