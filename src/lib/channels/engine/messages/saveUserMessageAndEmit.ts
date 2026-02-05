// backend/src/lib/channels/engine/messages/saveUserMessageAndEmit.ts
import pool from "../../../db";
import { getIO } from "../../../socket";
import type { Canal } from "../../../detectarIntencion";

export async function saveUserMessageAndEmit(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  messageId: string | null;
  content: string;
  intent?: string | null;
  interest_level?: number | null;
  emotion?: string | null;
}) {
  const { tenantId, canal, fromNumber, messageId, content, emotion } = opts;

  // ✅ Mantén el mismo comportamiento: si no hay messageId, no guardes (dedupe)
  if (!messageId) return;

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (
        tenant_id, role, content, timestamp, canal, from_number, message_id, intent, interest_level, emotion
      )
      VALUES ($1, 'user', $2, NOW(), $3, $4, $5, $6, $7, $8)
      ON CONFLICT (tenant_id, message_id) DO NOTHING
      RETURNING id, timestamp, role, content, canal, from_number, intent, interest_level, emotion`,
      [
        tenantId,
        content,
        canal,
        fromNumber || "anónimo",
        messageId,
        opts.intent || null,
        (typeof opts.interest_level === "number" ? opts.interest_level : null),
        (typeof emotion === "string" && emotion.trim() ? emotion.trim() : null),
      ]
    );

    const inserted = rows[0];
    if (!inserted) return;

    const io = getIO();
    if (!io) return;

    io.emit("message:new", {
      id: inserted.id,
      created_at: inserted.timestamp,
      timestamp: inserted.timestamp,
      role: inserted.role,
      content: inserted.content,
      canal: inserted.canal,
      from_number: inserted.from_number,
      intent: inserted.intent,
      interest_level: inserted.interest_level,
      emotion: inserted.emotion,
    });
  } catch (e) {
    console.warn("⚠️ No se pudo registrar mensaje user + socket:", e);
  }
}
