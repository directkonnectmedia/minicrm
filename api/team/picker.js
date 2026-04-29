/**
 * /api/team/picker
 *
 * Public, unauthenticated endpoint that returns the minimum information
 * needed to render the login picker: each team member's display name and
 * email. The login overlay calls this on page load so newly-created
 * accounts appear without requiring a code change to the static
 * TEAM_MEMBERS array in index.html.
 *
 * SECURITY NOTE
 * This endpoint deliberately exposes display name + email of every active
 * team account to anyone hitting the URL. That is the same information the
 * picker has always shown directly in the page source (the static array
 * was visible to anyone with view-source). PINs are never sent. Banned /
 * deactivated accounts are filtered out so they cannot appear in the
 * picker at all.
 *
 * Required Vercel env var: SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ROLES = new Set(["admin", "sales", "web_designer"]);

function isBanned(u) {
  if (!u || !u.banned_until) return false;
  const t = Date.parse(u.banned_until);
  return Number.isFinite(t) && t > Date.now();
}

// Mirrors api/admin/team.js readRoles: tolerate legacy single-role users.
function readRoles(u) {
  if (!u || !u.user_metadata) return [];
  const meta = u.user_metadata;
  if (Array.isArray(meta.roles)) {
    return meta.roles.filter((r) => typeof r === "string");
  }
  if (typeof meta.role === "string" && meta.role) return [meta.role];
  return [];
}

function hasTeamRole(u) {
  return readRoles(u).some((r) => ALLOWED_ROLES.has(r));
}

function pickerEntry(u) {
  const meta = u.user_metadata || {};
  const name =
    (typeof meta.display_name === "string" && meta.display_name.trim()) ||
    (typeof u.email === "string" ? u.email.split("@")[0] : "Member");
  return { name, email: u.email };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Set it in Vercel Project Settings -> Environment Variables and redeploy.",
    });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?per_page=200`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
      }
    );
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return res
        .status(r.status)
        .json({ error: "supabase list failed", detail: data });
    }
    const users = data && Array.isArray(data.users) ? data.users : [];

    // Only include accounts that look like real team members:
    //   - have a confirmed email
    //   - have a display_name (set by the admin script and the panel)
    //   - are not currently banned/deactivated
    const members = users
      .filter((u) => u && u.email && !isBanned(u))
      .filter((u) => u.user_metadata && typeof u.user_metadata.display_name === "string" && u.user_metadata.display_name.trim() !== "")
      .filter(hasTeamRole)
      .map(pickerEntry)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Short browser cache: new members should show up quickly, but we don't
    // want every page load hammering the admin API.
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=15, stale-while-revalidate=60");
    return res.status(200).json({ members });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "picker lookup failed", detail: err && err.message ? err.message : String(err) });
  }
}
