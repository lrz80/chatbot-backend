// backend/src/lib/channels/engine/messages/saveAssistantMessageAndEmit.ts
import pool from "../../../db";
import { getIO } from "../../../socket";
import type { Canal } from "../../../detectarIntencion";

export async function saveAssistantMessageAndEmit(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  messageId: string | null;
  content: string;
  intent?: string | null;
  interest_level?: number | null;
}) {
  const { tenantId, canal, fromNumber, messageId, content, intent, interest_level } = opts;

  try {
    const finalMessageId = messageId ? `${messageId}-bot` : null;

    console.log("[SAVE_ASSISTANT_MESSAGE_AND_EMIT][INPUT_DEBUG]", {
      tenantId,
      canal,
      fromNumber,
      messageId,
      contentPreview: String(content || "").slice(0, 300),
    });

    const { rows } = await pool.query(
      `INSERT INTO messages (
        tenant_id, role, content, timestamp, canal, from_number, message_id, intent, interest_level
      )
      VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, message_id) DO NOTHING
      RETURNING id, timestamp, role, content, canal, from_number`,
      [
        tenantId,
        content,
        canal,
        fromNumber || "anónimo",
        finalMessageId,
        intent || null,
        (typeof interest_level === "number" ? interest_level : null),
      ]
    );

    const inserted = rows[0];
    if (!inserted) {
      // ya existía → no emitimos nada
      return;
    }

    const io = getIO();
    if (!io) {
      console.warn("⚠️ [SOCKET] getIO() devolvió null al guardar assistant.");
      return;
    }

    const payload = {
      id: inserted.id,
      created_at: inserted.timestamp,
      timestamp: inserted.timestamp,
      role: inserted.role,
      content: inserted.content,
      canal: inserted.canal,
      from_number: inserted.from_number,
    };

    console.log("📡 [SOCKET] Emitting message:new (assistant)", payload);
    io.emit("message:new", payload);
  } catch (e) {
    console.warn("⚠️ No se pudo registrar mensaje assistant + socket:", e);
  }
}
