// backend/src/lib/notifications/sendSmsToTenantPhone.ts
import pool from "../db";
import twilio from "twilio";

function normalizePhone(p: string) {
  // deja + y dígitos
  return String(p || "").trim().replace(/[^\d+]/g, "");
}

export async function sendSmsToTenantPhone(opts: {
  tenantId: string;
  text: string;
}) {
  const { tenantId, text } = opts;

  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
  const TWILIO_SMS_NUMBER = process.env.TWILIO_SMS_NUMBER || "";

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO creds missing");
  }
  if (!TWILIO_SMS_NUMBER) {
    throw new Error("TWILIO_SMS_NUMBER missing");
  }

  // 1) Busca teléfono del negocio en tenants
  const { rows } = await pool.query(
    `SELECT telefono_negocio
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );

  const toRaw = rows[0]?.telefono_negocio;
  const to = normalizePhone(toRaw);

  if (!to) {
    throw new Error("telefono_negocio missing for tenant");
  }

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // 2) Envía SMS
  // ⚠️ IMPORTANTE: el FROM debe ser un número SMS-capable del MISMO account/subaccount
  await client.messages.create({
    from: TWILIO_SMS_NUMBER,
    to,
    body: String(text || "").slice(0, 1500), // evita overflow
  });

  return true;
}
