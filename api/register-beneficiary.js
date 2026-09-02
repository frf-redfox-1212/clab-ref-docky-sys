// api/register-beneficiary.js
// Registers a doctor's bank details with Cashfree as a beneficiary
// Call via POST with body: { "doctor_id": "uuid" }
// Stores the returned beneficiary_id in doctor_bank_details

import { createClient } from "@supabase/supabase-js";
import { getCashfreeToken, CASHFREE_BASE } from "./cashfree-auth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Register beneficiary with Cashfree ───────────────────────────────────────
async function registerBeneficiary(token, { beneficiaryId, name, bankAccount, ifsc, phone, email }) {
  const res = await fetch(`${CASHFREE_BASE}/payout/v1/addBeneficiary`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      beneId: beneficiaryId,
      name,
      email: email || "noreply@klabnutra.com",
      phone: phone || "9999999999",
      bankAccount,
      ifsc,
      address1: "India",
    }),
  });
  return await res.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const providedSecret = req.headers["x-admin-secret"];
  if (providedSecret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });

  const { doctor_id } = req.body;
  if (!doctor_id) return res.status(400).json({ error: "doctor_id required" });

  try {
    // 1. Get doctor details
    const { data: doctor, error: docError } = await supabase
      .from("doctors")
      .select("id, name, email, phone")
      .eq("id", doctor_id)
      .single();

    if (docError || !doctor) return res.status(404).json({ error: "Doctor not found" });

    // 2. Get bank details
    const { data: bank, error: bankError } = await supabase
      .from("doctor_bank_details")
      .select("*")
      .eq("doctor_id", doctor_id)
      .single();

    if (bankError || !bank) return res.status(404).json({ error: "Bank details not found for this doctor" });

    if (bank.cashfree_registered) {
      return res.status(200).json({
        message: "Already registered",
        beneficiary_id: bank.cashfree_beneficiary_id
      });
    }

    // 3. Get Cashfree token
    const token = await getCashfreeToken();

    // 4. Create a unique beneficiary ID
    const beneficiaryId = `KLAB_${doctor_id.replace(/-/g, '').substring(0, 16).toUpperCase()}`;

    // 5. Register with Cashfree
    const result = await registerBeneficiary(token, {
      beneficiaryId,
      name: bank.account_holder_name,
      bankAccount: bank.bank_account,
      ifsc: bank.bank_ifsc,
      phone: doctor.phone,
      email: doctor.email,
    });

    console.log("Cashfree register result:", JSON.stringify(result));

    if (result.status !== "SUCCESS") {
      // Check if already exists
      if (result.subCode === "409") {
        await supabase.from("doctor_bank_details").update({
          cashfree_beneficiary_id: beneficiaryId,
          cashfree_registered: true,
        }).eq("doctor_id", doctor_id);
        return res.status(200).json({ message: "Already exists in Cashfree", beneficiary_id: beneficiaryId });
      }
      return res.status(400).json({ error: "Cashfree registration failed", details: result });
    }

    // 6. Store beneficiary ID in Supabase
    await supabase.from("doctor_bank_details").update({
      cashfree_beneficiary_id: beneficiaryId,
      cashfree_registered: true,
    }).eq("doctor_id", doctor_id);

    return res.status(200).json({
      message: "Beneficiary registered successfully",
      beneficiary_id: beneficiaryId,
      doctor: doctor.name,
    });

  } catch (err) {
    console.error("Register beneficiary error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
