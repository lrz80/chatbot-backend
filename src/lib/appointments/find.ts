// src/lib/appointments/find.ts
import pool from "../../lib/db";

function normalizePhone(raw: any) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/[^\d]/g, "");
  return (hasPlus ? "+" : "") + digits;
}

export async function findActiveAppointmentsByPhone(
  tenantId: string,
  phone: string
): Promise<any[]> {

  const normalized = normalizePhone(phone);  // 🔥 CRÍTICO

  const { rows } = await pool.query(
    `
    SELECT *
    FROM appointments
    WHERE tenant_id = $1
      AND customer_phone = $2
      AND status IN ('pending','confirmed')
    ORDER BY start_time ASC
    LIMIT 10
    `,
    [tenantId, normalized]   // 🔥 buscar siempre normalizado
  );

  return rows || [];
}
