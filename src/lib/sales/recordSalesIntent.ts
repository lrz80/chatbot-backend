// backend/src/lib/sales/recordSalesIntent.ts
import pool from "../db";

export async function recordSalesIntent(opts: {
  tenantId: string;
  contacto: string;
  canal: string;
  mensaje: string;
  intencion: string;
  nivelInteres: number;
  messageId?: string | null;
}) {
  const {
    tenantId,
    contacto,
    canal,
    mensaje,
    intencion,
    nivelInteres,
    messageId = null,
  } = opts;

  if (!tenantId || !contacto || !canal || !intencion) return;

  try {
    await pool.query(
      `
      INSERT INTO sales_intelligence
        (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, fecha, message_id)
      VALUES
        ($1,$2,$3,$4,$5,$6,NOW(),$7)
      ON CONFLICT (tenant_id, canal, message_id)
      WHERE $7 IS NOT NULL
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
  } catch (e: any) {
    console.warn("⚠️ recordSalesIntent error:", {
      msg: e?.message,
      code: e?.code,
      detail: e?.detail,
    });
  }
}
