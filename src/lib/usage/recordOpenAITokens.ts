// backend/src/lib/usage/recordOpenAITokens.ts
import pool from "../db";

export async function recordOpenAITokens(tenantId: string, usedTokens: number): Promise<void> {
  try {
    const used = Number(usedTokens || 0);
    if (!used || used <= 0) return;

    await pool.query(
      `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
       VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
       ON CONFLICT (tenant_id, canal, mes)
       DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
      [tenantId, used]
    );
  } catch (e) {
    console.warn("⚠️ recordOpenAITokens failed:", e);
  }
}
