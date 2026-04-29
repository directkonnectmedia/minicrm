/**
 * /api/admin/auth-user
 *
 * Admin-gated helper for wiping a Supabase Auth account by email. Used by
 * the CRM when a client row is deleted: we want to remove the matching
 * portal sign-in account so re-adding the client later starts from a
 * truly clean slate (no orphan banned accounts, no leftover sessions).
 *
 * The endpoint holds the Supabase service_role key on the server (Vercel
 * env var) so the browser never sees it. The caller must send a valid
 * admin session JWT, just like /api/admin/team.
 *
 * Required Vercel env vars:
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - SUPABASE_URL  (optional; defaults to the Direct Konnect project URL)
 *
 * Methods:
 *   DELETE /api/admin/auth-user
 *     body: { email: string }
 *     -> { ok: true, deleted: boolean }
 *
 *   `deleted: true`  means an auth.users row matched and was removed.
 *   `deleted: false` means no auth row existed for that email -- the
 *                    operation is idempotent so callers don't have to
 *                    care whether the client ever signed into the portal.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function readRoles(u) {
  if (!u || !u.user_metadata) return [];
  const meta = u.user_metadata;
  if (Array.isArray(meta.roles)) {
    return meta.roles.filter((r) => typeof r === "string");
  }
  if (typeof meta.role === "string" && meta.role) return [meta.role];
  return [];
}

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
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

// Look up an auth user by email. Supabase's admin list endpoint accepts
// a `?email=` filter, but we fall back to scanning the first page just in
// case the project version doesn't support the filter.
async function findUserIdByEmail(email) {
  const lowered = String(email).trim().toLowerCase();
  if (!lowered) return null;

  const r = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?per_page=200&email=${encodeURIComponent(lowered)}`,
    { headers: adminHeaders() }
  );
  if (!r.ok) return null;
  const data = await readJson(r);
  const users = (data && Array.isArray(data.users)) ? data.users : [];
  const match = users.find(
    (u) => u && typeof u.email === "string" && u.email.toLowerCase() === lowered
  );
  return match ? match.id : null;
}

export default async function handler(req, res) {
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Set it in Vercel Project Settings -> Environment Variables and redeploy.",
    });
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
  if (!readRoles(caller).includes("admin")) {
    return res.status(403).json({ error: "admin role required" });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email required" });
  }

  const id = await findUserIdByEmail(email);
  if (!id) {
    // No matching auth row -- nothing to do. Treat as success so callers
    // can wire this up unconditionally after deleting a CRM client.
    return res.status(200).json({ ok: true, deleted: false });
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  if (!r.ok) {
    const detail = await readJson(r);
    return res
      .status(r.status)
      .json({ error: "supabase delete failed", detail });
  }
  return res.status(200).json({ ok: true, deleted: true });
}
