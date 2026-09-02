// api/check-payout-status.js
// Runs once a day at 11:30pm IST (6pm UTC) via Vercel cron
// Checks all processing payouts and updates status in Supabase

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CASHFREE_API_URL = process.env.CASHFREE_API_URL;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  // Allow GET (cron) and POST (manual trigger)
  if (req.method === "POST") {
    const providedSecret = req.headers["x-admin-secret"];
    if (providedSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    console.log("Starting daily payout status check...");

    // Get all processing payouts
    const { data: processingPayouts, error } = await supabase
      .from("payout_log")
      .select("id, cashfree_transfer_id, cf_transfer_id, recipient_name, total_payout, doctor_id")
      .eq("status", "processing")
      .eq("recipient_type", "doctor");

    if (error) throw new Error(`Supabase error: ${error.message}`);
    if (!processingPayouts || processingPayouts.length === 0) {
      return res.status(200).json({ message: "No processing payouts to check", checked: 0 });
    }

    console.log(`Found ${processingPayouts.length} processing payouts to check`);

    const results = { paid: [], failed: [], still_processing: [] };

    for (const payout of processingPayouts) {
      if (!payout.cf_transfer_id && !payout.cashfree_transfer_id) {
        results.still_processing.push({ name: payout.recipient_name, reason: "No transfer ID" });
        continue;
      }

      try {
        const cfId = payout.cf_transfer_id || payout.cashfree_transfer_id;
        const statusRes = await fetch(
          `${CASHFREE_API_URL}/transfer-status/${payout.cashfree_transfer_id}?cf_transfer_id=${cfId}`,
          { headers: { "x-admin-secret": process.env.ADMIN_SECRET } }
        );

        const statusData = await statusRes.json();
        const transferStatus = statusData.status;

        console.log(`${payout.recipient_name}: ${transferStatus}`);

        if (transferStatus === "SUCCESS") {
          await supabase.from("payout_log")
            .update({ status: "paid" })
            .eq("id", payout.id);

          results.paid.push({ name: payout.recipient_name, amount: payout.total_payout });

        } else if (["FAILED", "REJECTED", "REVERSED"].includes(transferStatus)) {
          await supabase.from("payout_log")
            .update({ status: "failed", failure_reason: transferStatus })
            .eq("id", payout.id);

          // Unlink referrals so they can be retried
          await supabase.from("referrals")
            .update({ doctor_payout_id: null })
            .eq("doctor_id", payout.doctor_id);

          // Mark bank details as unverified so system skips next time
          await supabase.from("doctor_bank_details")
            .update({ cashfree_verified: false })
            .eq("doctor_id", payout.doctor_id);

          results.failed.push({ name: payout.recipient_name, amount: payout.total_payout, reason: transferStatus });

        } else {
          results.still_processing.push({ name: payout.recipient_name, status: transferStatus });
        }

      } catch (err) {
        console.error(`Status check failed for ${payout.recipient_name}:`, err.message);
        results.still_processing.push({ name: payout.recipient_name, reason: err.message });
      }

      await sleep(500);
    }

    return res.status(200).json({
      message: "Daily status check complete",
      paid: results.paid.length,
      failed: results.failed.length,
      still_processing: results.still_processing.length,
      details: results,
    });

  } catch (err) {
    console.error("Status check error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
