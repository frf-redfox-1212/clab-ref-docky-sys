// api/shopify-webhook.js
// Receives Shopify "orders/paid" webhook and logs referral to Supabase

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// ── Supabase client (uses service role key — bypasses RLS) ──────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Disable default body parsing so we can verify Shopify HMAC signature ────
export const config = {
  api: { bodyParser: false },
};

// ── Read raw request body ────────────────────────────────────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ── Verify the request is genuinely from Shopify ────────────────────────────
function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

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

// ── Build "order paid" notification email ───────────────────────────────────
function buildOrderPaidEmailHtml({ recipientRole, doctorName, mrName, orderNumber, untaxedAmount, rate, payoutAmount, customerName, orderType, discountCode, orderItems }) {

  if (recipientRole === "Doctor") {
    return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <p>Dear Dr. <strong>${doctorName}</strong>,</p>
      <p>We note from our records that you have recently prescribed our prestige product. This communication is to express our heartfelt gratitude for your trust and recommendation.</p>
      <p>Please find the details of your prescription below:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Sr. no</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Product Name</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Quantity</th>
          </tr>
        </thead>
        <tbody>
          ${orderItems && orderItems.length > 0
            ? orderItems.map((item, idx) => `
          <tr>
            <td style="padding:8px;border:1px solid #ddd;">${idx + 1}</td>
            <td style="padding:8px;border:1px solid #ddd;">${item.name}</td>
            <td style="padding:8px;border:1px solid #ddd;">${item.quantity}</td>
          </tr>`).join('')
            : `<tr>
            <td style="padding:8px;border:1px solid #ddd;">1</td>
            <td style="padding:8px;border:1px solid #ddd;">—</td>
            <td style="padding:8px;border:1px solid #ddd;">—</td>
          </tr>`}
        </tbody>
      </table>
      <p>We are pleased to inform you that based on your prescription generated the patient <strong>${customerName || "your patient"}</strong> will avail of a 10% discount on purchase price when he uses the KLAB Nutra coupon code provided by you.</p>
      <p>We once again thank you for your patronage and look forward to a long association with you.</p>
      <p style="color:#666;font-size:12px;">Order: ${orderNumber} | Referral Amount: ₹${payoutAmount}</p>
    </div>`;
  }

  // MR email
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <p>Dear Mr <strong>${mrName || "MR"}</strong>,</p>
      <p>We understand from our records that an online order has been received for a prescription written by a doctor Dr. <strong>${doctorName}</strong> on your prescriber list. The order is currently being processed and will soon be delivered to the patient <strong>${customerName || "the patient"}</strong>.</p>
      <p><strong>Please find the Order & Prescription Details below:</strong></p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Sr no.</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Product Ordered</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Quantity</th>
          </tr>
        </thead>
        <tbody>
          ${orderItems && orderItems.length > 0
            ? orderItems.map((item, idx) => `
          <tr>
            <td style="padding:8px;border:1px solid #ddd;">${idx + 1}</td>
            <td style="padding:8px;border:1px solid #ddd;">${item.name}</td>
            <td style="padding:8px;border:1px solid #ddd;">${item.quantity}</td>
          </tr>`).join('')
            : `<tr>
            <td style="padding:8px;border:1px solid #ddd;">1</td>
            <td style="padding:8px;border:1px solid #ddd;">—</td>
            <td style="padding:8px;border:1px solid #ddd;">—</td>
          </tr>`}
        </tbody>
      </table>
      <p>You are now advised to meet up with doctor and convey heartfelt thanks to him for his patronage.</p>
      <p>You are also advised to explain the procedure of honorarium and thereby collect the Dr account details and enter them in the Rxcer portal in the provided format. Remember all the details in the Rxcer must be obtained and uploaded.</p>
      <p>Please note the above details are necessary for completion of Honorarium formalities. Besides, please be informed that your incentive for this transaction will be done only after the complete details of the doctor are entered.</p>
      <p style="color:#666;font-size:12px;">Order: ${orderNumber} | Your Incentive Amount: ₹${payoutAmount}</p>
    </div>`;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Read raw body
  const rawBody = await getRawBody(req);

  // 2. Verify Shopify signature
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!hmacHeader || !verifyShopifyWebhook(rawBody, hmacHeader, secret)) {
    console.error("Webhook verification failed");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // 3. Parse order data
  const order = JSON.parse(rawBody);

  // 4. Basic order details
  const customerEmail = (order.email || "").toLowerCase().trim();
  const customerName =
    `${order.billing_address?.first_name || ""} ${order.billing_address?.last_name || ""}`.trim();

  // Shopify's subtotal_price reflects discount already, but if the store uses
  // tax-inclusive pricing (taxes_included = true), that subtotal still has tax
  // baked in. Subtract total_tax in that case to get the true untaxed amount.
  const rawSubtotal = parseFloat(order.subtotal_price);
  const totalTax = parseFloat(order.total_tax || "0");
  const untaxedAmount = order.taxes_included
    ? rawSubtotal - totalTax
    : rawSubtotal;

  const orderValue = parseFloat(order.total_price);

  // GST rate as a percentage — sum all tax lines since Shopify splits CGST + SGST
  const taxLines = order.tax_lines || [];
  const gstPercent = taxLines.length > 0
    ? taxLines.reduce((sum, line) => sum + parseFloat(line.rate) * 100, 0)
    : null;

  // Payment method — captures COD vs prepaid gateway
  const paymentMethod = order.payment_gateway || order.payment_details?.method || "unknown";

  // Payment confirmed timestamp + 7 day eligibility window
  const paidAt = new Date();
  const eligibleAt = new Date(paidAt);
  eligibleAt.setDate(eligibleAt.getDate() + 7);

  if (!customerEmail) {
    return res.status(200).json({ message: "No customer email on order, skipping" });
  }

  const discountCodes = order.discount_codes || [];
  let usedCode = discountCodes.length > 0
    ? discountCodes[0].code.toUpperCase().trim()
    : null;

  let doctor, mrRate, doctorRate, orderType, customerLinkId, codeRow;

  // ── Try the code path first (if a code was used) ──────────────────────────
  if (usedCode) {
    const { data: foundCode } = await supabase
      .from("doctor_codes")
      .select("*")
      .eq("discount_code", usedCode)
      .eq("active", true)
      .single();

    const codeIsActive =
      foundCode && new Date(foundCode.valid_until) > new Date();

    if (codeIsActive) {
      // Check if THIS specific email has already used THIS specific code before.
      // Codes can be reused by different family members/emails — only blocked
      // for the same email reusing the same code.
      const { data: priorUseByThisEmail } = await supabase
        .from("customer_links")
        .select("id")
        .eq("customer_email", customerEmail)
        .eq("doctor_code_id", foundCode.id)
        .limit(1)
        .maybeSingle();

      if (!priorUseByThisEmail) {
        codeRow = foundCode;
      }
    }
  }

  if (codeRow) {
    // ── FIRST ORDER: valid code, not used before by this email ───────────────
    const { data: foundDoctor, error: doctorError } = await supabase
      .from("doctors")
      .select("id, name, email, mrs(name, email)")
      .eq("id", codeRow.doctor_id)
      .eq("active", true)
      .single();

    if (doctorError || !foundDoctor) {
      console.log(`Code ${usedCode} has no active doctor, skipping`);
      return res.status(200).json({ message: "Code has no active doctor, skipping" });
    }

    doctor = foundDoctor;
    mrRate = codeRow.mr_referral_rate;
    doctorRate = codeRow.doctor_referral_rate;
    orderType = "first";

    // Create the customer link so future orders (no code) still pay out
    const { data: link, error: linkError } = await supabase
      .from("customer_links")
      .insert({
        customer_email: customerEmail,
        doctor_id: doctor.id,
        doctor_code_id: codeRow.id,
        mr_referral_rate: mrRate,
        doctor_referral_rate: doctorRate,
        expires_at: codeRow.valid_until,
      })
      .select()
      .single();

    if (linkError) {
      console.error("Failed to create customer link:", linkError);
    } else {
      customerLinkId = link.id;
    }
  } else {
    // ── No usable code: check if this customer is already linked ────────────
    const { data: activeLink } = await supabase
      .from("customer_links")
      .select("*")
      .eq("customer_email", customerEmail)
      .eq("active", true)
      .gt("expires_at", new Date().toISOString())
      .order("linked_at", { ascending: false })
      .limit(1)
      .single();

    if (!activeLink) {
      // Not a referral order at all — ignore
      return res.status(200).json({ message: "No active code or customer link, skipping" });
    }

    const { data: foundDoctor, error: doctorError } = await supabase
      .from("doctors")
      .select("id, name, email, mrs(name, email)")
      .eq("id", activeLink.doctor_id)
      .eq("active", true)
      .single();

    if (doctorError || !foundDoctor) {
      return res.status(200).json({ message: "Linked doctor inactive, skipping" });
    }

    doctor = foundDoctor;
    mrRate = activeLink.mr_referral_rate;
    doctorRate = activeLink.doctor_referral_rate;
    orderType = "repeat";
    customerLinkId = activeLink.id;

    // Pull the original linking code's text for traceability (referrals.discount_code)
    const { data: originalCode } = await supabase
      .from("doctor_codes")
      .select("discount_code")
      .eq("id", activeLink.doctor_code_id)
      .single();

    if (originalCode) {
      usedCode = originalCode.discount_code;
    }
  }

  // 5. Calculate split payouts (on untaxed amount)
  const mrPayoutAmount = Math.round(untaxedAmount * mrRate) / 100;
  const doctorPayoutAmount = Math.round(untaxedAmount * doctorRate) / 100;

  // 6. Log referral to Supabase
  const { error: insertError } = await supabase.from("referrals").insert({
    doctor_id: doctor.id,
    shopify_order_id: String(order.id),
    shopify_order_number: order.name,
    customer_email: customerEmail,
    customer_name: customerName,
    order_value: orderValue,
    discount_code: usedCode,
    customer_link_id: customerLinkId,
    order_type: orderType,
    untaxed_amount: untaxedAmount,
    tax_amount: totalTax,
    gst_percent: gstPercent,
    mr_referral_rate: mrRate,
    doctor_referral_rate: doctorRate,
    mr_payout_amount: mrPayoutAmount,
    doctor_payout_amount: doctorPayoutAmount,
    payment_method: paymentMethod,
    paid_at: paidAt.toISOString(),
    eligible_at: eligibleAt.toISOString(),
  });

  if (insertError) {
    console.error("Supabase insert error:", insertError);
    return res.status(500).json({ error: "Failed to log referral" });
  }

  console.log(
    `Referral logged (${orderType}) — Doctor: ${doctor.name}, Order: ${order.name}, Untaxed: ${untaxedAmount}`
  );

  // 7. Create MR payout log entry as unpaid (MR incentives tracked here for client visibility)
  try {
    const { data: newReferral } = await supabase
      .from("referrals")
      .select("id")
      .eq("shopify_order_id", String(order.id))
      .single();

    if (newReferral && doctor.mrs?.name) {
      const { data: mrPayout } = await supabase
        .from("payout_log")
        .insert({
          doctor_id: doctor.id,
          recipient_type: "mr",
          recipient_name: doctor.mrs.name,
          recipient_email: doctor.mrs.email || null,
          period_start: new Date().toISOString().split("T")[0],
          period_end: new Date().toISOString().split("T")[0],
          total_payout: mrPayoutAmount,
          payment_method: "Internal Salary",
          status: "unpaid",
          shopify_order_numbers: order.name,
          discount_codes: usedCode || null,
          notes: "MR incentive — to be settled via internal salary",
        })
        .select()
        .single();

      if (mrPayout) {
        await supabase
          .from("referrals")
          .update({ mr_payout_id: mrPayout.id })
          .eq("id", newReferral.id);
      }
    }
  } catch (mrErr) {
    console.error("MR payout log creation failed:", mrErr.message);
  }

  // 7. Extract line items from order for the product table
  const orderItems = (order.line_items || []).map(item => ({
    name: item.title,
    quantity: item.quantity,
  }));

  // 8. Email the doctor (best-effort — don't fail the webhook if email fails)
  try {
    if (doctor.email) {
      await sendEmail({
        to: doctor.email,
        toName: doctor.name,
        subject: `KLAB Nutra Loyalty Program ${order.name}`,
        htmlContent: buildOrderPaidEmailHtml({
          recipientRole: "Doctor",
          doctorName: doctor.name,
          mrName: doctor.mrs?.name,
          orderNumber: order.name,
          untaxedAmount,
          rate: doctorRate,
          payoutAmount: doctorPayoutAmount,
          customerName,
          orderType,
          discountCode: usedCode,
          orderItems,
        }),
      });
    }
  } catch (err) {
    console.error("Doctor order-paid email failed:", err);
  }

  // 9. Email the MR (if one is linked to this doctor)
  try {
    if (doctor.mrs?.email) {
      await sendEmail({
        to: doctor.mrs.email,
        toName: doctor.mrs.name || "MR",
        subject: `Prescription alert from your doctor ${order.name}`,
        htmlContent: buildOrderPaidEmailHtml({
          recipientRole: "MR",
          doctorName: doctor.name,
          mrName: doctor.mrs?.name,
          orderNumber: order.name,
          untaxedAmount,
          rate: mrRate,
          payoutAmount: mrPayoutAmount,
          customerName,
          orderType,
          discountCode: usedCode,
          orderItems,
        }),
      });
    }
  } catch (err) {
    console.error("MR order-paid email failed:", err);
  }

  return res.status(200).json({ message: "Referral logged successfully", order_type: orderType });
}
