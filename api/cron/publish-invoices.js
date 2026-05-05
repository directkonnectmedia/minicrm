/**
 * GET/POST /api/cron/publish-invoices
 *
 * Vercel Cron calls this every minute. Publishes queued invoices whose
 * scheduled_dispatch_time is due: sets portal_published_at + portal_dispatch_status=pushed.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> or ?secret=<CRON_SECRET>
 * Env: CRON_SECRET, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL (optional default)
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const headers = () => ({
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  Accept: "application/json",
  "Content-Type": "application/json",
});

function authorize(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const url = new URL(req.url, "http://localhost");
  if (CRON_SECRET && url.searchParams.get("secret") === CRON_SECRET) return true;
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  if (!CRON_SECRET) {
    return res.status(500).json({
      error: "CRON_SECRET is not set. Add it in Vercel project environment variables.",
    });
  }

  if (!authorize(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not configured. Add it in Vercel environment variables.",
    });
  }

  const nowIso = new Date().toISOString();
  const qs = [
    "portal_dispatch_status=eq.queued",
    "portal_published_at=is.null",
    `scheduled_dispatch_time=lte.${encodeURIComponent(nowIso)}`,
    "select=id,client_id,scheduled_dispatch_time",
  ].join("&");

  const listUrl = `${SUPABASE_URL}/rest/v1/invoices?${qs}`;
  const listRes = await fetch(listUrl, { headers: headers() });
  const listJson = await listRes.json();

  if (!listRes.ok) {
    return res.status(500).json({
      error: "list failed",
      detail: listJson,
    });
  }

  const rows = Array.isArray(listJson) ? listJson : [];
  const publishedAt = new Date().toISOString();
  let ok = 0;
  const errors = [];

  for (const row of rows) {
    const patchUrl = `${SUPABASE_URL}/rest/v1/invoices?id=eq.${row.id}`;
    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        portal_published_at: publishedAt,
        portal_dispatch_status: "pushed",
      }),
    });
    if (patchRes.ok) {
      ok += 1;
    } else {
      const errBody = await patchRes.text();
      errors.push({ id: row.id, status: patchRes.status, body: errBody });
    }
  }

  return res.status(200).json({
    due: rows.length,
    published: ok,
    errors: errors.length ? errors : undefined,
    at: publishedAt,
  });
}
