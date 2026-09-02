// cashfree-auth.js
// Cashfree REST authentication (SDK-free)

import crypto from "crypto";

export const CASHFREE_BASE =
  process.env.CASHFREE_ENV === "PRODUCTION"
    ? "https://payout-api.cashfree.com"
    : "https://payout-gamma.cashfree.com";

function generateSignature() {
  const publicKey = process.env.CASHFREE_PUBLIC_KEY;

  if (!publicKey) {
    throw new Error("CASHFREE_PUBLIC_KEY is missing");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const plainText = `${process.env.CASHFREE_CLIENT_ID}.${timestamp}`;

  const encrypted = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(plainText)
  );

  return encrypted.toString("base64");
}

export async function getCashfreeToken() {
  const signature = generateSignature();

  console.log("Requesting Cashfree auth token...");

  const response = await fetch(`${CASHFREE_BASE}/payout/v1/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": process.env.CASHFREE_CLIENT_ID,
      "X-Client-Secret": process.env.CASHFREE_CLIENT_SECRET,
      "X-Cf-Signature": signature,
    },
    body: JSON.stringify({}),
  });

  const data = await response.json();

  console.log("Cashfree auth response:", JSON.stringify(data));

  if (!response.ok || data.status !== "SUCCESS") {
    throw new Error(JSON.stringify(data));
  }

  return data.data.token;
}