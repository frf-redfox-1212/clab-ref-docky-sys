// api/cashfree-webhook.js
// Receives Cashfree transfer status webhooks
// Updates payout_log status and emails doctor on success

import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

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

function buildPayoutEmailHtml({ doctorName, amount, transferId, referralCount }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <h2>Referral Honorarium Processed</h2>
      <p>Dear Dr. <strong>${doctorName}</strong>,</p>
      <p>We are pleased to inform you that your referral honorarium has been successfully processed.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Amount</strong></td><td style="padding:8px;border:1px solid #ddd;">₹${amount}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Orders Covered</strong></td><td style="padding:8px;border:1px solid #ddd;">${referralCount}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;"><strong>Transfer Reference</strong></td><td style="padding:8px;border:1px solid #ddd;">${transferId}</td></tr>
      </table>
      <p>The amount will reflect in your bank account within 1-2 business days.</p>
      <p>Thank you for your continued support and patronage.</p>
      <p style="color:#666;font-size:12px;">This is an automated notification from KLAB Nutra.</p>
    </div>`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const rawBody = await getRawBody(req);

  try {
    const payload = JSON.parse(rawBody);
    console.log("Cashfree webhook received:", JSON.stringify(payload));

    const transferId = payload.transferId || payload.data?.transfer?.transferId;
    const status = payload.transferStatus || payload.data?.transfer?.status;

    if (!transferId) {
      return res.status(200).json({ message: "No transferId, ignoring" });
    }

    // Find matching payout log
    const { data: payoutLog, error } = await supabase
      .from("payout_log")
      .select("*, doctors(name, email)")
      .eq("cashfree_transfer_id", transferId)
      .single();

    if (error || !payoutLog) {
      console.log(`No payout log found for transferId: ${transferId}`);
      return res.status(200).json({ message: "No matching payout log" });
    }

    if (status === "SUCCESS") {
      // Mark payout as paid
      await supabase.from("payout_log")
        .update({ status: "paid", paid_on: new Date().toISOString().split("T")[0] })
        .eq("id", payoutLog.id);

      // Count referrals linked to this payout
      const { count } = await supabase
        .from("referrals")
        .select("id", { count: "exact" })
        .eq("doctor_payout_id", payoutLog.id);

      // Email doctor — disabled for now, enable when ready
      // try {
      //   if (payoutLog.recipient_email) {
      //     await sendEmail({
      //       to: payoutLog.recipient_email,
      //       toName: payoutLog.recipient_name,
      //       subject: `Referral Honorarium Credited — ₹${payoutLog.total_payout}`,
      //       htmlContent: buildPayoutEmailHtml({
      //         doctorName: payoutLog.recipient_name,
      //         amount: payoutLog.total_payout,
      //         transferId,
      //         referralCount: count || 0,
      //       }),
      //     });
      //   }
      // } catch (emailErr) {
      //   console.error("Payout email failed:", emailErr.message);
      // }

      console.log(`✓ Payout confirmed for ${payoutLog.recipient_name} — ₹${payoutLog.total_payout}`);

    } else if (status === "FAILED" || status === "REVERSED" || status === "REJECTED") {
      await supabase.from("payout_log")
        .update({ status: "failed", failure_reason: status })
        .eq("id", payoutLog.id);

      // Unlink referrals so they can be retried
      await supabase.from("referrals")
        .update({ doctor_payout_id: null })
        .eq("doctor_payout_id", payoutLog.id);

      console.log(`✗ Payout failed for ${payoutLog.recipient_name}: ${status}`);
    }

    return res.status(200).json({ message: "Webhook processed" });

  } catch (err) {
    console.error("Cashfree webhook error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
