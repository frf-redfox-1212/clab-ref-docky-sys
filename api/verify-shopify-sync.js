// api/verify-shopify-sync.js
// Fetches all Shopify codes, then updates a SMALL chunk of Supabase rows per call
// Call repeatedly until done = true

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getShopifyToken() {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type: "client_credentials",
      }).toString(),
    }
  );
  if (!response.ok) throw new Error(`Token exchange failed: ${await response.text()}`);
  const data = await response.json();
  return data.access_token;
}

async function getAllShopifyCodes(token) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyCodes = new Set();

  // Get all price rules
  const rulesRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json?limit=250`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  const rulesData = await rulesRes.json();
  const priceRules = rulesData.price_rules || [];

  for (const rule of priceRules) {
    let pageInfo = null;
    do {
      let url = `https://${domain}/admin/api/2024-04/price_rules/${rule.id}/discount_codes.json?limit=250`;
      if (pageInfo) url += `&page_info=${pageInfo}`;

      const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
      const linkHeader = res.headers.get("Link") || "";
      const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
      pageInfo = nextMatch ? nextMatch[1] : null;

      const data = await res.json();
      (data.discount_codes || []).forEach(c => shopifyCodes.add(c.code.toUpperCase()));
      if (pageInfo) await sleep(400);
    } while (pageInfo);
  }

  return shopifyCodes;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const providedSecret = req.headers["x-admin-secret"];
  if (providedSecret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });

  try {
    const offset = parseInt(req.body?.offset ?? 0);
    const chunkSize = 300; // small chunk to avoid timeout

    // 1. Fetch all Shopify codes
    const token = await getShopifyToken();
    const shopifyCodes = await getAllShopifyCodes(token);
    console.log(`Shopify codes: ${shopifyCodes.size}, processing Supabase offset ${offset}`);

    // 2. Fetch one small chunk from Supabase
    const { data: codes, error, count } = await supabase
      .from("doctor_codes")
      .select("id, discount_code", { count: "exact" })
      .order("created_at", { ascending: true })
      .range(offset, offset + chunkSize - 1);

    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
    if (!codes || codes.length === 0) {
      return res.status(200).json({ message: "All done!", done: true, shopify_total: shopifyCodes.size });
    }

    // 3. Split into synced vs not synced
    const syncedIds = codes.filter(c => shopifyCodes.has(c.discount_code.toUpperCase())).map(c => c.id);
    const unsyncedIds = codes.filter(c => !shopifyCodes.has(c.discount_code.toUpperCase())).map(c => c.id);

    // 4. Update Supabase
    if (syncedIds.length > 0) {
      await supabase.from("doctor_codes").update({ shopify_synced: true }).in("id", syncedIds);
    }
    if (unsyncedIds.length > 0) {
      await supabase.from("doctor_codes").update({ shopify_synced: false }).in("id", unsyncedIds);
    }

    const nextOffset = offset + codes.length;
    const done = nextOffset >= count;

    return res.status(200).json({
      shopify_total: shopifyCodes.size,
      processed: nextOffset,
      total: count,
      synced_this_batch: syncedIds.length,
      unsynced_this_batch: unsyncedIds.length,
      next_offset: nextOffset,
      done,
    });

  } catch (err) {
    console.error("Verify error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}