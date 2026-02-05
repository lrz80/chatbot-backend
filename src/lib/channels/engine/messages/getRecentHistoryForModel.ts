// backend/src/lib/channels/engine/messages/getRecentHistoryForModel.ts
import pool from "../../../db";
import type { Canal } from "../../../detectarIntencion";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export async function getRecentHistoryForModel(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  excludeMessageId?: string | null;
  limit?: number;
}): Promise<ChatCompletionMessageParam[]> {
  const { tenantId, canal, fromNumber, excludeMessageId = null, limit = 12 } = opts;

  try {
    const whereExclude = excludeMessageId ? `AND message_id <> $4` : "";
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
          AND role IN ('user','assistant')
        ORDER BY timestamp DESC
        LIMIT $4
      `;

    const { rows } = await pool.query(sql, params);

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
