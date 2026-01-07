import { appendMemoryArrayItem } from "../clientMemory";
import pool from "../db";

export async function rememberTurn(opts: {
  tenantId: string;
  canal: string;
  senderId: string;
  userText: string;
  assistantText: string;
  keepLast?: number;
}) {
  const {
    tenantId,
    canal,
    senderId,
    userText,
    assistantText,
    keepLast = 20,
  } = opts;

  // 1) Append atómico → NO se pierden turns aunque lleguen mensajes seguidos
  await appendMemoryArrayItem({
    tenantId,
    canal,
    senderId,
    key: "turns",
    item: {
      u: String(userText || "").slice(0, 1500),
      a: String(assistantText || "").slice(0, 1500),
      at: new Date().toISOString(),
    },
  });

  // 2) Incrementa summary_meta.turnsSinceRefresh
  await pool.query(
    `
    INSERT INTO client_memory (tenant_id, canal, sender_id, "key", value)
    VALUES ($1, $2, $3, 'summary_meta', jsonb_build_object(
      'turnsSinceRefresh', 1,
      'lastTurnAt', now()
    ))
    ON CONFLICT (tenant_id, canal, sender_id, "key")
    DO UPDATE SET
      value = jsonb_set(
        client_memory.value,
        '{turnsSinceRefresh}',
        to_jsonb( COALESCE((client_memory.value->>'turnsSinceRefresh')::int, 0) + 1 )
      )
      || jsonb_build_object('lastTurnAt', now()),
      updated_at = now()
    `,
    [tenantId, canal, senderId]
  );

    // 3) Trim a los últimos N turns (seguro, post-append)
  await pool.query(
    `
    UPDATE client_memory
    SET value = (
      SELECT jsonb_agg(elem)
      FROM (
        SELECT elem
        FROM jsonb_array_elements(value) WITH ORDINALITY t(elem, ord)
        ORDER BY ord DESC
        LIMIT $4::int
      ) s
    ),
    updated_at = now()
    WHERE tenant_id = $1
      AND canal = $2
      AND sender_id = $3
      AND "key" = 'turns'
      AND jsonb_array_length(value) > $4::int
    `,
    [tenantId, canal, senderId, keepLast]
  );
}
