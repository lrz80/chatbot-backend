// backend/src/lib/channels/engine/messages/getRecentHistoryForModel.ts
import pool from "../../../db";
import type { Canal } from "../../../detectarIntencion";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// TTL de historial que verá el modelo (15 minutos)
const HISTORY_TTL_MINUTES = 15;

export async function getRecentHistoryForModel(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  excludeMessageId?: string | null;
  limit?: number;
}): Promise<ChatCompletionMessageParam[]> {
  const {
    tenantId,
    canal,
    fromNumber,
    excludeMessageId = null,
    limit = 12,
  } = opts;

  try {
    const whereExclude = excludeMessageId ? `AND message_id <> $4` : "";

    // Solo queremos mensajes recientes dentro del TTL
    const ttlClause = `AND timestamp >= NOW() - INTERVAL '${HISTORY_TTL_MINUTES} minutes'`;

    const params = excludeMessageId
      ? [tenantId, canal, fromNumber, excludeMessageId, limit]
      : [tenantId, canal, fromNumber, limit];

    const sql = excludeMessageId
      ? `
        SELECT role, content
        FROM messages
        WHERE tenant_id = $1
          AND canal = $2
          AND from_number = $3
          ${whereExclude}
          ${ttlClause}
          AND role IN ('user','assistant')
        ORDER BY timestamp DESC
        LIMIT $5
      `
      : `
        SELECT role, content
        FROM messages
        WHERE tenant_id = $1
          AND canal = $2
          AND from_number = $3
          ${ttlClause}
          AND role IN ('user','assistant')
        ORDER BY timestamp DESC
        LIMIT $4
      `;

    const { rows } = await pool.query(sql, params);

    // Se devuelve en orden cronológico (viejo → nuevo)
    return rows.reverse().map((m: any) => {
      const content = String(m.content || "");
      return m.role === "assistant"
        ? ({ role: "assistant" as const, content })
        : ({ role: "user" as const, content });
    });
  } catch (e) {
    console.warn("⚠️ getRecentHistoryForModel failed:", e);
    return [];
  }
}