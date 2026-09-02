// api/run-monthly-payouts.js
// Runs automatically on 1st of every month via Vercel cron
// OR manually triggered via POST with x-admin-secret header
// Calls Oracle VM to process payouts via Cashfree

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CASHFREE_API_URL = process.env.CASHFREE_API_URL;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendEmail({ to, toName, subject, htmlContent }) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: process.env.SENDER_NAME || "KLAB Nutra", email: process.env.SENDER_EMAIL },
      to: [{ email: to, name: toName }],
      subject,
      htmlContent,
    }),
  });
  if (!res.ok) throw new Error(`Brevo failed: ${await res.text()}`);
}

export default async function handler(req, res) {
  if (req.method === "POST") {
    const providedSecret = req.headers["x-admin-secret"];
    if (providedSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    console.log("Starting monthly payout run...");

    // Get all doctors with eligible unpaid referrals
    const { data: eligibleDoctors, error } = await supabase
      .from("unpaid_referrals")
      .select("doctor_id, doctor_name, doctor_email, doctor_total_owed, doctor_unpaid_order_count")
      .gt("doctor_total_owed", 0);

    if (error) throw new Error(`Failed to fetch eligible doctors: ${error.message}`);
    if (!eligibleDoctors || eligibleDoctors.length === 0) {
      return res.status(200).json({ message: "No eligible payouts this month", processed: 0 });
    }
    console.log(`Found ${eligibleDoctors.length} doctors with eligible payouts`);

    const results = { success: [], failed: [], skipped: [] };
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split("T")[0];
    const periodEnd = now.toISOString().split("T")[0];

    for (const doc of eligibleDoctors) {
      // Check if doctor has registered bank details
      const { data: bank } = await supabase
        .from("doctor_bank_details")
        .select("cashfree_beneficiary_id, cashfree_registered, cashfree_verified")
        .eq("doctor_id", doc.doctor_id)
        .single();

      if (!bank || !bank.cashfree_registered || !bank.cashfree_beneficiary_id) {
        results.skipped.push({ doctor: doc.doctor_name, reason: "No registered bank details" });
        console.log(`Skipped ${doc.doctor_name} — no bank details`);
        continue;
      }

      if (bank.cashfree_verified === false) {
        results.skipped.push({ doctor: doc.doctor_name, reason: "Bank details unverified — please update" });
        console.log(`Skipped ${doc.doctor_name} — bank details unverified`);
        continue;
      }

      const amount = parseFloat(doc.doctor_total_owed);
      const transferId = `KLAB_${doc.doctor_id.replace(/-/g, '').substring(0, 12).toUpperCase()}_${Date.now()}`;

      try {
        // Get referral details for payout log
        const { data: referrals } = await supabase
          .from("referrals")
          .select("id, shopify_order_number, discount_code")
          .eq("doctor_id", doc.doctor_id)
          .is("doctor_payout_id", null)
          .lte("eligible_at", now.toISOString())
          .neq("status", "cancelled");

        const orderNumbers = referrals?.map(r => r.shopify_order_number).join(", ") || "";
        const discountCodes = [...new Set(referrals?.map(r => r.discount_code).filter(Boolean))].join(", ") || "";

        // Create payout_log entry
        const { data: payoutLog, error: logError } = await supabase
          .from("payout_log")
          .insert({
            doctor_id: doc.doctor_id,
            recipient_type: "doctor",
            recipient_name: doc.doctor_name,
            recipient_email: doc.doctor_email,
            period_start: periodStart,
            period_end: periodEnd,
            total_payout: amount,
            payment_method: "Cashfree",
            status: "processing",
            cashfree_transfer_id: transferId,
            shopify_order_numbers: orderNumbers,
            discount_codes: discountCodes,
          })
          .select()
          .single();

        if (logError) throw new Error(`Failed to create payout log: ${logError.message}`);

        // Call Oracle VM to initiate transfer
        const payoutRes = await fetch(`${CASHFREE_API_URL}/request-transfer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-secret": process.env.ADMIN_SECRET,
          },
          body: JSON.stringify({
            transfer_id: transferId,
            transfer_amount: amount,
            beneficiary_id: bank.cashfree_beneficiary_id,
            transfer_remarks: `KLAB Nutra referral payout ${doc.doctor_unpaid_order_count} orders`,
          }),
        });

        const payoutResult = await payoutRes.json();
        console.log(`Payout result for ${doc.doctor_name}:`, JSON.stringify(payoutResult));

        if (payoutRes.ok && payoutResult.status === "RECEIVED") {
          const cfTransferId = payoutResult.cf_transfer_id;

          // Link referrals to this payout
          if (referrals && referrals.length > 0) {
            await supabase
              .from("referrals")
              .update({ doctor_payout_id: payoutLog.id })
              .in("id", referrals.map(r => r.id));
          }

          await supabase.from("payout_log")
            .update({ 
              status: "processing", 
              paid_on: periodEnd,
              cf_transfer_id: cfTransferId,
            })
            .eq("id", payoutLog.id);

          // Poll for transfer status after 15 seconds
          await sleep(15000);
          try {
            const statusRes = await fetch(
              `${CASHFREE_API_URL}/transfer-status/${transferId}?cf_transfer_id=${cfTransferId}`, 
              { headers: { "x-admin-secret": process.env.ADMIN_SECRET } }
            );
            const statusData = await statusRes.json();
            console.log(`Transfer status for ${doc.doctor_name}:`, JSON.stringify(statusData));

            const transferStatus = statusData.status || statusData.transfer_status;

            if (transferStatus === "SUCCESS") {
              await supabase.from("payout_log")
                .update({ status: "paid" })
                .eq("id", payoutLog.id);
              results.success.push({ doctor: doc.doctor_name, amount, transfer_id: transferId, status: "paid" });
              console.log(`✓ Payout confirmed for ${doc.doctor_name} — ₹${amount}`);
            } else if (transferStatus === "FAILED" || transferStatus === "REJECTED" || transferStatus === "REVERSED") {
              await supabase.from("payout_log")
                .update({ status: "failed", failure_reason: transferStatus })
                .eq("id", payoutLog.id);
              await supabase.from("referrals")
                .update({ doctor_payout_id: null })
                .in("id", referrals.map(r => r.id));
              results.failed.push({ doctor: doc.doctor_name, amount, error: transferStatus });
            } else {
              results.success.push({ doctor: doc.doctor_name, amount, transfer_id: transferId, status: transferStatus });
            }
          } catch (pollErr) {
            console.error(`Status poll failed for ${doc.doctor_name}:`, pollErr.message);
            results.success.push({ doctor: doc.doctor_name, amount, transfer_id: transferId, status: "processing" });
          }

        } else {
          await supabase.from("payout_log")
            .update({ status: "failed", failure_reason: JSON.stringify(payoutResult) })
            .eq("id", payoutLog.id);

          results.failed.push({ doctor: doc.doctor_name, amount, error: JSON.stringify(payoutResult) });
        }

      } catch (err) {
        results.failed.push({ doctor: doc.doctor_name, amount, error: err.message });
        console.error(`✗ Error processing ${doc.doctor_name}:`, err.message);
      }

      await sleep(500);
    }

    return res.status(200).json({
      message: "Monthly payout run complete",
      success: results.success.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
      details: results,
    });

  } catch (err) {
    console.error("Monthly payout error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
