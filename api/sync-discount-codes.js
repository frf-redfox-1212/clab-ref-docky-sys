// api/sync-discount-codes.js
// Syncs unsynced codes (shopify_synced = false) to Shopify one by one
// Marks each successfully created code as shopify_synced = true in Supabase

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
  return (await response.json()).access_token;
}

async function getOrCreatePriceRule(token, discountPercent) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const title = `Doctor Referral ${discountPercent}% Off`;

  const listRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json?title=${encodeURIComponent(title)}`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  const listData = await listRes.json();
  if (listData.price_rules?.length > 0) return listData.price_rules[0].id;

  const createRes = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        price_rule: {
          title,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: "percentage",
          value: `-${discountPercent}`,
          customer_selection: "all",
          once_per_customer: true,
          starts_at: new Date().toISOString(),
        },
      }),
    }
  );
  const createData = await createRes.json();
  if (!createData.price_rule) throw new Error(`Failed to create price rule: ${JSON.stringify(createData)}`);
  return createData.price_rule.id;
}

async function createDiscountCode(token, priceRuleId, code) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;

  const res = await fetch(
    `https://${domain}/admin/api/2024-04/price_rules/${priceRuleId}/discount_codes.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ discount_code: { code } }),
    }
  );

  if (res.status === 429) {
    await sleep(1500);
    return createDiscountCode(token, priceRuleId, code);
  }

  const data = await res.json();
  if (data.errors) {
    const errStr = JSON.stringify(data.errors).toLowerCase();
    if (errStr.includes("unique") || errStr.includes("taken") || errStr.includes("already")) {
      return { skipped: true };
    }
    throw new Error(`Failed: ${JSON.stringify(data.errors)}`);
  }
  return { created: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const providedSecret = req.headers["x-admin-secret"];
  if (providedSecret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });

  try {
    const limit = parseInt(req.body?.limit ?? 15); // 15 codes × 600ms = ~9s, safe under timeout

    const { data: codes, error, count } = await supabase
      .from("doctor_codes")
      .select("id, discount_code, customer_discount_rate", { count: "exact" })
      .eq("active", true)
      .eq("shopify_synced", false)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
    if (!codes || codes.length === 0) {
      return res.status(200).json({ message: "All codes synced!", done: true, remaining: 0 });
    }

    const token = await getShopifyToken();

    // Group by rate
    const byRate = {};
    for (const c of codes) {
      const rate = parseFloat(c.customer_discount_rate);
      if (!byRate[rate]) byRate[rate] = [];
      byRate[rate].push(c);
    }

    const successIds = [];
    const failed = [];

    for (const [rate, rateCodes] of Object.entries(byRate)) {
      const priceRuleId = await getOrCreatePriceRule(token, rate);
      for (const c of rateCodes) {
        try {
          const result = await createDiscountCode(token, priceRuleId, c.discount_code);
          if (result.created || result.skipped) successIds.push(c.id);
        } catch (err) {
          console.error(err.message);
          failed.push(c.discount_code);
        }
        await sleep(600);
      }
    }

    // Mark successful ones as synced
    if (successIds.length > 0) {
      await supabase.from("doctor_codes").update({ shopify_synced: true }).in("id", successIds);
    }

    const remaining = count - successIds.length;

    return res.status(200).json({
      message: "Batch complete",
      synced: successIds.length,
      failed: failed.length,
      remaining,
      done: remaining <= 0,
    });

  } catch (err) {
    console.error("Sync error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}