/**
 * POST /api/leads
 * 
 * Webhook endpoint to receive leads from the DirectKonnect website.
 * 
 * Env: SUPABASE_SERVICE_ROLE_KEY (required), SUPABASE_URL (optional), WEBHOOK_API_KEY (required)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ljghuyeugzmduzzvngkc.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.directkonnect.com",
  "Access-Control-Allow-Methods": "OPTIONS, POST",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization",
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    for (const [key, value] of Object.entries(corsHeaders)) {
      res.setHeader(key, value);
    }
    return res.status(200).end();
  }

  // Set CORS headers for actual response
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!WEBHOOK_API_KEY) {
    return res.status(500).json({ error: "Server configuration error: WEBHOOK_API_KEY is missing." });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server configuration error: SUPABASE_SERVICE_ROLE_KEY is missing." });
  }

  // Verify API Key
  const providedKey = req.headers["x-api-key"] || req.headers.authorization;
  const cleanProvidedKey = providedKey ? providedKey.replace("Bearer ", "").trim() : "";
  
  if (!cleanProvidedKey || cleanProvidedKey !== WEBHOOK_API_KEY) {
    return res.status(401).json({ error: "Unauthorized: Invalid API key" });
  }

  // Parse Body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const { company_name, client_name, email, phone, business_type, notes } = body || {};

  if (!company_name) {
    return res.status(400).json({ error: "Missing required field: company_name" });
  }

  // Format notes into jsonb array if provided
  let client_notes = [];
  if (notes) {
    client_notes = [
      {
        at: new Date().toISOString(),
        text: notes
      }
    ];
  }

  // Prepare payload for Supabase
  const payload = {
    company_name,
    client_name: client_name || null,
    email: email || null,
    phone: phone || null,
    business_type: business_type || null,
    client_notes,
    client_status: "New Lead",
    web_status: "Not Started",
    motivation: "Not Set"
  };

  // Insert into Supabase
  const insertUrl = `${SUPABASE_URL}/rest/v1/clients`;
  const insertRes = await fetch(insertUrl, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });

  const responseText = await insertRes.text();
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = { raw: responseText };
  }

  if (!insertRes.ok) {
    return res.status(insertRes.status >= 400 ? insertRes.status : 500).json({
      error: "Failed to insert lead into database",
      detail: responseData
    });
  }

  return res.status(201).json({
    success: true,
    message: "Lead created successfully",
    data: Array.isArray(responseData) ? responseData[0] : responseData
  });
}
