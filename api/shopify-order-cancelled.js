// api/shopify-order-cancelled.js
// Receives Shopify "orders/cancelled" webhook
// Marks the matching referral as cancelled (no payout)

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!hmacHeader || !verifyShopifyWebhook(rawBody, hmacHeader, secret)) {
    console.error("Webhook verification failed");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const order = JSON.parse(rawBody);
  const shopifyOrderId = String(order.id);

  // Find the matching referral and mark it cancelled.
  // Only updates if NEITHER doctor nor MR has already been paid out — safety check.
  const { data, error } = await supabase
    .from("referrals")
    .update({ status: "cancelled" })
    .eq("shopify_order_id", shopifyOrderId)
    .is("doctor_payout_id", null)
    .is("mr_payout_id", null)
    .select();

  if (error) {
    console.error("Supabase update error:", error);
    return res.status(500).json({ error: "Failed to update referral" });
  }

  if (!data || data.length === 0) {
    // No matching referral found (order had no doctor code) — fine, nothing to do
    return res.status(200).json({ message: "No matching referral, skipping" });
  }

  console.log(`Referral cancelled for order ${order.name}`);
  return res.status(200).json({ message: "Referral marked as cancelled" });
}
