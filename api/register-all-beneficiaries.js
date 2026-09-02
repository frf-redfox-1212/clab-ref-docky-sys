// api/register-all-beneficiaries.js
// Registers all doctors with bank details who aren't yet registered with Cashfree
// Calls the Oracle VM which has the static IP whitelisted with Cashfree

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CASHFREE_API_URL = process.env.CASHFREE_API_URL;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const providedSecret = req.headers["x-admin-secret"];
  if (providedSecret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Get all doctors with bank details not yet registered
    const { data: bankDetails, error } = await supabase
      .from("doctor_bank_details")
      .select("*, doctors(id, name, email, phone)")
      .eq("cashfree_registered", false);

    if (error) throw new Error(`Supabase error: ${error.message}`);
    if (!bankDetails || bankDetails.length === 0) {
      return res.status(200).json({ 
        message: "All doctors already registered", 
        registered: 0, 
        already_registered: 0, 
        failed: 0 
      });
    }

    console.log(`Found ${bankDetails.length} unregistered doctors`);

    let registered = 0, already_registered = 0;
    const failed_details = [];

    for (const bank of bankDetails) {
      const doctor = bank.doctors;
      if (!doctor) continue;

      const beneficiaryId = `KLAB_${doctor.id.replace(/-/g, '').substring(0, 16).toUpperCase()}`;

      try {
        // Call Oracle VM to register with Cashfree
        const regRes = await fetch(`${CASHFREE_API_URL}/register-beneficiary`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "x-admin-secret": process.env.ADMIN_SECRET,
          },
          body: JSON.stringify({
            beneficiary_id: beneficiaryId,
            name: bank.account_holder_name,
            email: doctor.email || "noreply@klabnutra.com",
            phone: doctor.phone || "9999999999",
            bank_account_number: bank.bank_account,
            bank_ifsc: bank.bank_ifsc,
          }),
        });

        const result = await regRes.json();
        console.log(`${doctor.name}:`, JSON.stringify(result));

        if (regRes.ok && result.beneficiary_id) {
          await supabase.from("doctor_bank_details").update({
            cashfree_beneficiary_id: beneficiaryId,
            cashfree_registered: true,
          }).eq("id", bank.id);
          registered++;
        } else if (result.error?.code === "beneficiary_already_exists") {
          await supabase.from("doctor_bank_details").update({
            cashfree_beneficiary_id: beneficiaryId,
            cashfree_registered: true,
          }).eq("id", bank.id);
          already_registered++;
        } else {
          failed_details.push({ doctor: doctor.name, error: JSON.stringify(result) });
        }
      } catch (err) {
        failed_details.push({ doctor: doctor.name, error: err.message });
      }

      await sleep(300);
    }

    return res.status(200).json({
      message: "Registration complete",
      registered,
      already_registered,
      failed: failed_details.length,
      failed_details,
    });

  } catch (err) {
    console.error("Register all error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
