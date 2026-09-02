// api/mark-payout-paid.js
// Manually triggered endpoint that pays out EITHER the doctor OR the MR
// for all their eligible unpaid referrals, and emails a confirmation.
//
// Call with POST body: { "doctor_id": "uuid", "recipient_type": "doctor" }
// recipient_type must be "doctor" or "mr"
//
// Protected by ADMIN_SECRET header: x-admin-secret

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Send an email via Brevo API ─────────────────────────────────────────────
async function sendEmail({ to, toName, subject, htmlContent }) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        name: process.env.SENDER_NAME || "Referral System",
        email: process.env.SENDER_EMAIL,
      },
      to: [{ email: to, name: toName }],
      subject,
      htmlContent,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Brevo send failed: ${response.status} ${errText}`);
  }
  return response.json();
}

// ── Build payout confirmation email ─────────────────────────────────────────
function buildPayoutEmailHtml({ recipientLabel, doctorName, referrals, totalPayout, amountField, rateField }) {
  const rows = referrals
    .map(
      (r) => `
      <tr>
        <td style="padding:8px;border:1px solid #ddd;">${r.shopify_order_number}</td>
        <td style="padding:8px;border:1px solid #ddd;">₹${r.untaxed_amount}</td>
        <td style="padding:8px;border:1px solid #ddd;">${r[rateField]}%</td>
        <td style="padding:8px;border:1px solid #ddd;">₹${r[amountField]}</td>
      </tr>`
    )
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2>Referral Payout Processed</h2>
      <p>Hi, your referral payout ${recipientLabel === "MR" ? `for Dr. ${doctorName}'s referrals` : ""} has been processed.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Order</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Order Value (untaxed)</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Rate</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Payout</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p><strong>Total Payout: ₹${totalPayout.toFixed(2)}</strong></p>
      <p style="color:#666;font-size:13px;">This is an automated notification.</p>
    </div>
  `;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const providedSecret = req.headers["x-admin-secret"];
  if (providedSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { doctor_id, recipient_type } = req.body;

  if (!doctor_id || !["doctor", "mr"].includes(recipient_type)) {
    return res.status(400).json({
      error: "doctor_id and recipient_type ('doctor' or 'mr') are required",
    });
  }

  // 1. Get doctor + linked MR details (via mrs table)
  const { data: doctor, error: doctorError } = await supabase
    .from("doctors")
    .select("id, name, email, mrs(name, email)")
    .eq("id", doctor_id)
    .single();

  if (doctorError || !doctor) {
    return res.status(404).json({ error: "Doctor not found" });
  }

  const isDoctor = recipient_type === "doctor";
  const payoutIdColumn = isDoctor ? "doctor_payout_id" : "mr_payout_id";
  const amountField = isDoctor ? "doctor_payout_amount" : "mr_payout_amount";
  const rateField = isDoctor ? "doctor_referral_rate" : "mr_referral_rate";
  const recipientEmail = isDoctor ? doctor.email : doctor.mrs?.email;
  const recipientName = isDoctor ? doctor.name : doctor.mrs?.name;

  if (!recipientEmail) {
    return res.status(400).json({ error: `No email on file for ${recipient_type}` });
  }

  // 2. Find eligible unpaid referrals for THIS recipient type only
  const { data: referrals, error: referralsError } = await supabase
    .from("referrals")
    .select(`id, shopify_order_number, untaxed_amount, ${amountField}, ${rateField}`)
    .eq("doctor_id", doctor_id)
    .eq("status", "delivered")
    .is(payoutIdColumn, null)
    .lte("eligible_at", new Date().toISOString());

  if (referralsError) {
    console.error(referralsError);
    return res.status(500).json({ error: "Failed to fetch referrals" });
  }

  if (!referrals || referrals.length === 0) {
    return res.status(200).json({ message: "No eligible referrals to pay out" });
  }

  const totalPayout = referrals.reduce((sum, r) => sum + parseFloat(r[amountField]), 0);

  // 3. Create payout_log entry
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - 30);

  const { data: payout, error: payoutError } = await supabase
    .from("payout_log")
    .insert({
      doctor_id: doctor.id,
      recipient_type,
      recipient_name: recipientName,
      recipient_email: recipientEmail,
      period_start: periodStart.toISOString().split("T")[0],
      period_end: periodEnd.toISOString().split("T")[0],
      total_payout: totalPayout,
      paid_on: periodEnd.toISOString().split("T")[0],
      payment_method: "Bank Transfer",
    })
    .select()
    .single();

  if (payoutError) {
    console.error("Payout insert error:", payoutError);
    return res.status(500).json({ error: "Failed to create payout log" });
  }

  // 4. Link referrals to this payout (only the relevant payout column)
  const referralIds = referrals.map((r) => r.id);
  const { error: linkError } = await supabase
    .from("referrals")
    .update({ [payoutIdColumn]: payout.id })
    .in("id", referralIds);

  if (linkError) {
    console.error("Referral link error:", linkError);
    return res.status(500).json({ error: "Failed to link referrals to payout" });
  }

  // 5. Email the recipient
  let emailError = null;
  try {
    await sendEmail({
      to: recipientEmail,
      toName: recipientName,
      subject: `Referral Payout Processed — ₹${totalPayout.toFixed(2)}`,
      htmlContent: buildPayoutEmailHtml({
        recipientLabel: isDoctor ? "Doctor" : "MR",
        doctorName: doctor.name,
        referrals,
        totalPayout,
        amountField,
        rateField,
      }),
    });
  } catch (err) {
    console.error(`${recipient_type} payout email failed:`, err);
    emailError = recipient_type;
  }

  return res.status(200).json({
    message: "Payout processed successfully",
    payout_id: payout.id,
    recipient_type,
    total_payout: totalPayout,
    referral_count: referrals.length,
    email_error: emailError,
  });
}
