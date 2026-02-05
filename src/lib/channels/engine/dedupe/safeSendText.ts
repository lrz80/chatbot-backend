// backend/src/lib/channels/engine/dedupe/safeSendText.ts

export function outboundId(messageId: string | null) {
  return messageId ? `${messageId}-out` : null;
}

// Evita enviar duplicado si el proveedor reintenta el webhook
export async function safeSendText(opts: {
  pool: any;

  tenantId: string;
  canal: string;

  messageId: string | null; // inbound messageId (si existe)
  to: string;
  text: string;

  send: (to: string, text: string, tenantId: string) => Promise<boolean>;
  incrementUsage: (tenantId: string, canal: string) => Promise<void>;
}): Promise<boolean> {
  const { pool, tenantId, canal, messageId, to, text, send, incrementUsage } = opts;

  try {
    const dedupeId = outboundId(messageId);

    // Sin messageId: no podemos deduplicar confiable → enviamos 1 vez y contamos si ok.
    if (!dedupeId) {
      const ok = await send(to, text, tenantId);
      if (ok) await incrementUsage(tenantId, canal);
      return !!ok;
    }

    // ✅ RESERVA ATÓMICA: si ya existe, no envía
    const ins = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
       RETURNING 1`,
      [tenantId, canal, dedupeId]
    );

    if ((ins.rowCount ?? 0) === 0) {
      console.log("⏩ safeSendText: ya reservado/enviado este outbound message_id. No envío ni cuento.");
      return true;
    }

    const ok = await send(to, text, tenantId);
    if (ok) await incrementUsage(tenantId, canal);

    // Si falló el envío, libera la reserva para permitir retry real
    if (!ok) {
      await pool.query(
        `DELETE FROM interactions WHERE tenant_id=$1 AND canal=$2 AND message_id=$3`,
        [tenantId, canal, dedupeId]
      );
    }

    return !!ok;
  } catch (e) {
    console.error("❌ safeSendText error:", e);
    return false;
  }
}
