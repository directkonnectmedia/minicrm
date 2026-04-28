/**
 * setup-team-accounts.js
 *
 * One-shot script to create the Direct Konnect CRM team accounts in Supabase Auth.
 * Uses the Auth Admin API directly with built-in fetch (Node 18+, no dependencies).
 *
 * Each user is created with `email_confirm: true`, which marks the account as
 * confirmed at creation time and bypasses the global "Confirm email" toggle in
 * Supabase entirely. So you do NOT need to flip that toggle in the dashboard.
 *
 * Usage (PowerShell, from the project root):
 *
 *   $env:SUPABASE_SERVICE_ROLE_KEY="paste-the-service-role-key-here"
 *   node scripts/setup-team-accounts.js
 *
 * Get the service role key from:
 *   Supabase Dashboard -> Project Settings -> API -> "service_role" secret
 *   (NOT the anon/public key. The service role key starts with "eyJ..." and
 *   is labeled `service_role`.)
 *
 * The script is idempotent: re-running it will skip users that already exist
 * instead of failing.
 *
 * To add a new teammate later, append a row to TEAM_MEMBERS below and re-run.
 */

const SUPABASE_URL = "https://ljghuyeugzmduzzvngkc.supabase.co";

// Mirror of TEAM_MEMBERS in index.html. PINs are stored as Supabase passwords.
// `roles` is an array; valid entries are "admin" (can manage team accounts),
// "sales", and "web_designer". A user can hold any combination.
const TEAM_MEMBERS = [
  { name: "Jesus",  email: "chucho.alberto17@gmail.com", pin: "1718", roles: ["admin"] },
  { name: "Ivan",   email: "ivan@directkonnect.local",   pin: "0000", roles: ["admin"] },
  { name: "Hector", email: "hector@directkonnect.local", pin: "0001", roles: ["sales"] },
];

const VALID_ROLES = new Set(["admin", "sales", "web_designer"]);

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceRoleKey) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is not set.");
  console.error("");
  console.error("In PowerShell, run:");
  console.error('  $env:SUPABASE_SERVICE_ROLE_KEY="paste-the-key-here"');
  console.error("  node scripts/setup-team-accounts.js");
  console.error("");
  console.error("Get the key from Supabase Dashboard -> Project Settings -> API -> service_role.");
  process.exit(1);
}

if (typeof fetch !== "function") {
  console.error("ERROR: Built-in fetch is not available. This script requires Node.js 18 or newer.");
  console.error("Run `node --version` to check; upgrade Node if it's below 18.");
  process.exit(1);
}

const adminHeaders = {
  "Content-Type": "application/json",
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
};

async function parseResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function findUserIdByEmail(email) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: adminHeaders });
  const payload = await parseResponse(res);
  if (!res.ok) return null;
  const users = payload && Array.isArray(payload.users) ? payload.users : [];
  const match = users.find((u) => u && typeof u.email === "string" && u.email.toLowerCase() === email.toLowerCase());
  return match ? match.id : null;
}

async function updateUserMetadata(userId, member) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users/${userId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      user_metadata: { display_name: member.name, roles: member.roles },
    }),
  });
  const payload = await parseResponse(res);
  if (res.ok) return { ok: true };
  const message =
    payload && (payload.msg || payload.message || payload.error_description || payload.error);
  return { ok: false, message: message || `HTTP ${res.status} ${res.statusText}` };
}

async function createUser(member) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users`;
  const body = {
    email: member.email,
    password: member.pin,
    email_confirm: true,
    user_metadata: { display_name: member.name, roles: member.roles },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify(body),
  });
  const payload = await parseResponse(res);

  if (res.ok) {
    return { status: "created" };
  }

  const errorCode = payload && (payload.error_code || payload.code || payload.msg || payload.error);
  const message = payload && (payload.msg || payload.message || payload.error_description || payload.error);
  const looksLikeAlreadyExists =
    res.status === 422 ||
    (typeof errorCode === "string" && /already|exists|registered/i.test(errorCode)) ||
    (typeof message === "string" && /already|exists|registered/i.test(message));

  if (looksLikeAlreadyExists) {
    const userId = await findUserIdByEmail(member.email);
    if (!userId) {
      return { status: "exists", message: "user exists but lookup by email failed; metadata not updated" };
    }
    const upd = await updateUserMetadata(userId, member);
    if (upd.ok) {
      return { status: "updated" };
    }
    return { status: "failed", message: `metadata update failed: ${upd.message}` };
  }

  return {
    status: "failed",
    message: `HTTP ${res.status} ${res.statusText} - ${message || errorCode || "unknown error"}`,
  };
}

(async function main() {
  console.log(`Syncing ${TEAM_MEMBERS.length} team accounts in ${SUPABASE_URL}`);
  console.log("");

  let created = 0;
  let updated = 0;
  let existed = 0;
  let failed = 0;

  for (let i = 0; i < TEAM_MEMBERS.length; i++) {
    const m = TEAM_MEMBERS[i];
    if (!Array.isArray(m.roles) || m.roles.length === 0) {
      console.log(`[${i + 1}/${TEAM_MEMBERS.length}] ${m.email} ... FAILED: roles must be a non-empty array`);
      failed++;
      continue;
    }
    const invalid = m.roles.filter((r) => !VALID_ROLES.has(r));
    if (invalid.length) {
      console.log(`[${i + 1}/${TEAM_MEMBERS.length}] ${m.email} ... FAILED: invalid role(s) ${JSON.stringify(invalid)}; allowed: ${[...VALID_ROLES].join(", ")}`);
      failed++;
      continue;
    }
    const label = `[${i + 1}/${TEAM_MEMBERS.length}] ${m.email} (roles=${m.roles.join("+")})`;
    try {
      const result = await createUser(m);
      if (result.status === "created") {
        console.log(`${label} ... created`);
        created++;
      } else if (result.status === "updated") {
        console.log(`${label} ... already existed, role/metadata updated`);
        updated++;
      } else if (result.status === "exists") {
        console.log(`${label} ... already exists (no metadata update)`);
        existed++;
      } else {
        console.log(`${label} ... FAILED: ${result.message}`);
        failed++;
      }
    } catch (err) {
      console.log(`${label} ... FAILED: ${err && err.message ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log("");
  console.log(
    `Done. ${created} created, ${updated} updated, ${existed} unchanged, ${failed} failed.`
  );

  if (failed > 0) {
    console.log("");
    console.log("Next step: fix the failed entries above, then re-run this script.");
    process.exit(2);
  }
})();
