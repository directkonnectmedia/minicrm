/**
 * /api/admin/team
 *
 * Vercel serverless endpoint that the CRM calls when an Admin manages team
 * accounts. Holds the Supabase service_role key on the server (Vercel env var)
 * so the browser never sees it.
 *
 * Required Vercel env vars:
 *   - SUPABASE_SERVICE_ROLE_KEY  (Project Settings -> Environment Variables)
 *   - SUPABASE_URL  (optional; defaults to the Direct Konnect project URL)
 *
 * Every request must:
 *   1. Send `Authorization: Bearer <user_jwt>` (the caller's session token,
 *      obtained from supabase.auth.getSession() in the browser).
 *   2. Belong to a user whose `user_metadata.roles` array includes "admin".
 *
 * Methods:
 *   GET    /api/admin/team
 *     -> { members: [{ id, email, name, roles, banned_until, created_at,
 *                      last_sign_in_at }] }
 *
 *   POST   /api/admin/team
 *     body: { name, email, pin, roles: string[] }
 *     -> { ok: true, id }
 *
 *   PATCH  /api/admin/team
 *     body: { id, banned?: boolean, roles?: string[], pin?, name? }
 *     -> { ok: true }
 *
 *   DELETE /api/admin/team
 *     body: { id }
 *     -> { ok: true }
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ROLES = new Set(["admin", "sales", "web_designer"]);

// Reads roles[] from a Supabase Auth user. Falls back to legacy single `role`
// string if a user was created before the multi-role migration.
function readRoles(u) {
  if (!u || !u.user_metadata) return [];
  const meta = u.user_metadata;
  if (Array.isArray(meta.roles)) {
    return meta.roles.filter((r) => typeof r === "string");
  }
  if (typeof meta.role === "string" && meta.role) {
    return [meta.role];
  }
  return [];
}

// Validates a roles array submitted by the client. Returns null on success or
// an error string on failure.
function validateRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    return "roles must be a non-empty array";
  }
  const invalid = roles.filter((r) => !ALLOWED_ROLES.has(r));
  if (invalid.length) {
    return `invalid role(s): ${JSON.stringify(invalid)}. allowed: ${[...ALLOWED_ROLES].join(", ")}`;
  }
  // Deduplicate
  return null;
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
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Validates the caller's JWT and returns the user record, or null if invalid.
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

function slimUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: (u.user_metadata && u.user_metadata.display_name) || u.email,
    roles: readRoles(u),
    banned_until: u.banned_until || null,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at || null,
  };
}

async function listMembers(req, res) {
  const r = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?per_page=200`,
    { headers: adminHeaders() }
  );
  const data = await readJson(r);
  if (!r.ok) {
    return res
      .status(r.status)
      .json({ error: "supabase list failed", detail: data });
  }
  const users = (data && Array.isArray(data.users) ? data.users : []).map(
    slimUser
  );
  return res.status(200).json({ members: users });
}

async function createMember(req, res) {
  const { name, email, pin, roles } = req.body || {};
  if (!name || !email || !pin) {
    return res
      .status(400)
      .json({ error: "name, email, and pin are required" });
  }
  const roleErr = validateRoles(roles);
  if (roleErr) return res.status(400).json({ error: roleErr });
  if (!/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: "pin must be exactly 4 digits" });
  }
  const dedupedRoles = [...new Set(roles)];
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      email,
      password: String(pin),
      email_confirm: true,
      user_metadata: { display_name: name, roles: dedupedRoles },
    }),
  });
  const data = await readJson(r);
  if (!r.ok) {
    return res
      .status(r.status)
      .json({ error: "supabase create failed", detail: data });
  }
  return res.status(200).json({ ok: true, id: data && data.id });
}

async function updateMember(req, res) {
  const { id, banned, roles, pin, name } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });

  const body = {};

  if (typeof banned === "boolean") {
    body.ban_duration = banned ? "876000h" : "none";
  }

  if (roles !== undefined || name !== undefined) {
    let dedupedRoles;
    if (roles !== undefined) {
      const roleErr = validateRoles(roles);
      if (roleErr) return res.status(400).json({ error: roleErr });
      dedupedRoles = [...new Set(roles)];
    }
    // Merge with existing metadata: fetch the user first so we don't blow away
    // unrelated keys when we PUT the new metadata object.
    const existing = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${id}`,
      { headers: adminHeaders() }
    );
    const existingData = await readJson(existing);
    if (!existing.ok) {
      return res
        .status(existing.status)
        .json({ error: "supabase user lookup failed", detail: existingData });
    }
    const meta = {
      ...((existingData && existingData.user_metadata) || {}),
    };
    if (dedupedRoles !== undefined) {
      meta.roles = dedupedRoles;
      // Drop the legacy single-role key so we don't leave conflicting data.
      delete meta.role;
    }
    if (name !== undefined) meta.display_name = name;
    body.user_metadata = meta;
  }

  if (pin !== undefined) {
    if (!/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ error: "pin must be exactly 4 digits" });
    }
    body.password = String(pin);
  }

  if (Object.keys(body).length === 0) {
    return res.status(400).json({ error: "no updatable fields supplied" });
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  const data = await readJson(r);
  if (!r.ok) {
    return res
      .status(r.status)
      .json({ error: "supabase update failed", detail: data });
  }
  return res.status(200).json({ ok: true });
}

async function deleteMember(req, res) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });
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
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
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

  switch (req.method) {
    case "GET":
      return listMembers(req, res);
    case "POST":
      return createMember(req, res);
    case "PATCH":
      return updateMember(req, res);
    case "DELETE":
      return deleteMember(req, res);
    default:
      res.setHeader("Allow", "GET, POST, PATCH, DELETE");
      return res.status(405).json({ error: "method not allowed" });
  }
}
