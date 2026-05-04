/**
 * GET  /api/invoice-templates  -> { rows: [...] }
 * POST /api/invoice-templates  -> { ok, row }
 *
 * Requires a valid Supabase user JWT only (no admin/team role checks).
 * Uses service role to read/write Postgres (bypasses RLS on the server).
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY (required), SUPABASE_URL (optional)
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

async function getCallerUser(jwt) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!r.ok) return null;
  return readJson(r);
}

const restHeaders = () => ({
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  Accept: "application/json",
});

/** Valid signed-in Supabase user only. */
async function requireSessionJwtOrRespond(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "missing bearer token" });
    return false;
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) {
    res.status(401).json({ error: "empty bearer token" });
    return false;
  }

  const caller = await getCallerUser(jwt);
  if (!caller) {
    res.status(401).json({ error: "invalid or expired session" });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Add it in Vercel → Settings → Environment Variables and redeploy.",
    });
  }

  const authorized = await requireSessionJwtOrRespond(req, res);
  if (!authorized) return;

  if (req.method === "GET") {
    const listUrl = `${SUPABASE_URL}/rest/v1/invoice_templates?select=*&order=name.asc`;
    const list = await fetch(listUrl, { headers: restHeaders() });
    const data = await readJson(list);
    if (!list.ok) {
      const msg =
        (data && typeof data.message === "string" && data.message) || "list failed";
      return res.status(list.status >= 400 ? list.status : 500).json({
        error: msg,
        detail: data,
      });
    }
    const rows = Array.isArray(data) ? data : [];
    return res.status(200).json({ rows });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const body =
    typeof req.body === "string"
      ? (() => {
          try {
            return JSON.parse(req.body);
          } catch {
            return {};
          }
        })()
      : req.body || {};

  const name = String(body.name || "").trim();
  const line_items = body.line_items;
  const terms_html =
    body.terms_html === undefined || body.terms_html === null
      ? null
      : String(body.terms_html);
  const plan_id =
    body.plan_id === undefined ||
    body.plan_id === null ||
    body.plan_id === ""
      ? null
      : String(body.plan_id);

  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!Array.isArray(line_items) || line_items.length === 0) {
    return res.status(400).json({
      error: "line_items must be a non-empty array",
    });
  }

  const insertPayload = {
    name,
    line_items,
    terms_html,
    plan_id,
  };

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/invoice_templates`, {
    method: "POST",
    headers: {
      ...restHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(insertPayload),
  });

  const data = await readJson(ins);
  if (!ins.ok) {
    const msg =
      (data && typeof data.message === "string" && data.message) ||
      (typeof data === "object" && data !== null && data.details) ||
      "insert failed";
    return res.status(ins.status >= 400 ? ins.status : 500).json({
      error: msg,
      detail: data,
    });
  }

  const row = Array.isArray(data) ? data[0] : data;
  return res.status(200).json({ ok: true, row });
}
