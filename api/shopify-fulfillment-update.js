// api/shopify-fulfillment-update.js
// Receives Shopify "fulfillments/update" webhook (fired by ShipRocket sync)
// When status becomes "delivered", sets delivered_at + eligible_at (delivered_at + 15 days)

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

  const fulfillment = JSON.parse(rawBody);

  // Only act when ShipRocket/Shopify marks the fulfillment as delivered.
  // Shopify fulfillment status values include: pending, success/delivered, cancelled, failure
  const fulfillmentStatus = (fulfillment.status || "").toLowerCase();
  const shipmentStatus = (fulfillment.shipment_status || "").toLowerCase();

  const isDelivered =
    fulfillmentStatus === "delivered" || shipmentStatus === "delivered";

  if (!isDelivered) {
    return res.status(200).json({ message: "Not a delivered status, skipping" });
  }

  const shopifyOrderId = String(fulfillment.order_id);
  const deliveredAt = new Date();
  const eligibleAt = new Date(deliveredAt);
  eligibleAt.setDate(eligibleAt.getDate() + 15); // 15-day hold period

  const { data, error } = await supabase
    .from("referrals")
    .update({
      status: "delivered",
      delivered_at: deliveredAt.toISOString(),
      eligible_at: eligibleAt.toISOString(),
    })
    .eq("shopify_order_id", shopifyOrderId)
    .neq("status", "cancelled") // don't revive a cancelled order
    .select();

  if (error) {
    console.error("Supabase update error:", error);
    return res.status(500).json({ error: "Failed to update referral" });
  }

  if (!data || data.length === 0) {
    return res.status(200).json({ message: "No matching referral, skipping" });
  }

  console.log(
    `Referral marked delivered for order ${shopifyOrderId}, eligible on ${eligibleAt.toISOString()}`
  );
  return res.status(200).json({ message: "Referral marked as delivered" });
}