import pool from "../db";
import type { Canal } from "../detectarIntencion";

export async function recordSalesIntent(opts: {
  tenantId: string;
  contacto: string;
  canal: Canal | string;
  mensaje: string;
  intencion: string;
  nivelInteres: number;
  messageId: string | null;
}): Promise<{ inserted: boolean; rowCount: number }> {
  const {
    tenantId,
    contacto,
    canal,
    mensaje,
    intencion,
    nivelInteres,
    messageId,
  } = opts;

  const intent = (intencion || "").trim().toLowerCase();
  const lvl = Math.min(3, Math.max(1, Number(nivelInteres) || 1));

  // Si no hay intención real, no guardes basura
  if (!intent) return { inserted: false, rowCount: 0 };

  try {
    const r = await pool.query(
      `
      INSERT INTO sales_intelligence
        (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, fecha, message_id)
      VALUES
        ($1, $2, $3, $4, $5, $6, NOW(), $7)
      ON CONFLICT (tenant_id, canal, message_id)
      DO NOTHING
      `,
      [
        tenantId,
        contacto,
        canal,
        mensaje,
        intencion,
        nivelInteres,
        messageId,
      ]
    );
    return { inserted: true, rowCount: r.rowCount || 0 };
  } catch (e: any) {
    console.warn("❌ recordSalesIntent SQL failed:", {
      msg: e?.message,
      code: e?.code,
      detail: e?.detail,
      constraint: e?.constraint,
    });
    throw e;
  }
}
