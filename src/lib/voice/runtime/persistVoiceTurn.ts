//src/lib/voice/runtime/persistVoiceTurn.ts
import pool from "../../db";
import { incrementarUsoPorNumero } from "../../incrementUsage";

type PersistVoiceTurnParams = {
  tenantId: string;
  userText: string;
  assistantText: string;
  callerE164: string | null;
  didNumber: string | null;
};

export async function persistVoiceTurn({
  tenantId,
  userText,
  assistantText,
  callerE164,
  didNumber,
}: PersistVoiceTurnParams): Promise<void> {
  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
     VALUES ($1, 'user', $2, NOW(), 'voz', $3)`,
    [tenantId, userText, callerE164 || "anónimo"]
  );

  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
     VALUES ($1, 'assistant', $2, NOW(), 'voz', $3)`,
    [tenantId, assistantText, didNumber || "sistema"]
  );

  await pool.query(
    `INSERT INTO interactions (tenant_id, canal, created_at)
     VALUES ($1, 'voz', NOW())`,
    [tenantId]
  );

  if (didNumber) {
    await incrementarUsoPorNumero(didNumber);
  }
}