/**
 * POST /api/invoice-templates
 *
 * Inserts a row into public.invoice_templates using the service role key,
 * after verifying the caller's JWT is a signed-in team member (admin, sales,
 * or web_designer). Use this when direct browser inserts fail RLS.
 *
 * Env (same as other admin routes):
 *   SUPABASE_SERVICE_ROLE_KEY — required
 *   SUPABASE_URL — optional (defaults to project URL below)
 *
 * Headers:
 *   Authorization: Bearer <supabase_user_access_token>
 * Body JSON:
 *   { name, line_items, terms_html?, plan_id? }
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TEAM_ROLES = new Set(["admin", "sales", "web_designer"]);

function readRoles(u) {
  if (!u) return [];
  const collect = (meta) => {
    if (!meta || typeof meta !== "object") return [];
    if (Array.isArray(meta.roles)) {
      return meta.roles.filter((r) => typeof r === "string");
    }
    if (typeof meta.role === "string" && meta.role) {
      return [meta.role];
    }
    return [];
  };
  return [...new Set([...collect(u.user_metadata), ...collect(u.app_metadata)])];
}

function isTeamMember(caller) {
  return readRoles(caller).some((r) => TEAM_ROLES.has(r));
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

export default async function handler(req, res) {
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Add it in Vercel → Settings → Environment Variables.",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ error: "missing bearer token" });
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) return res.status(401).json({ error: "empty bearer token" });

  const caller = await getCallerUser(jwt);
  if (!caller) {
    return res.status(401).json({ error: "invalid or expired session" });
  }
  if (!isTeamMember(caller)) {
    return res.status(403).json({ error: "team role required (admin, sales, or web_designer)" });
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
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
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
