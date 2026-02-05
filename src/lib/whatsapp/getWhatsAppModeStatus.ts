import pool from "../db";

export type WhatsAppMode = "twilio" | "cloudapi";
export type WhatsAppStatus = "enabled" | "disabled";

export async function getWhatsAppModeStatus(tenantId: string): Promise<{
  mode: WhatsAppMode;
  status: WhatsAppStatus;
}> {
  const { rows } = await pool.query(
    `SELECT whatsapp_mode, whatsapp_status
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );

  const row = rows[0] || {};
  const modeRaw = String(row.whatsapp_mode || "twilio").trim().toLowerCase();
  const statusRaw = String(row.whatsapp_status || "disabled").trim().toLowerCase();

  const mode: WhatsAppMode = modeRaw === "cloudapi" ? "cloudapi" : "twilio";

  const status: WhatsAppStatus =
    statusRaw === "enabled" || statusRaw === "active" || statusRaw === "connected"
      ? "enabled"
      : "disabled";

  return { mode, status };
}
