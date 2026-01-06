import pool from "./db";
import { getAllMemory, setMemoryValuesBulk } from "./clientMemory";

type Canal = "whatsapp" | "facebook" | "instagram" | "sms" | "voice";

export async function getConversationSummary(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
}): Promise<string> {
  const { tenantId, canal, senderId } = params;

  const res = await pool.query(
    `SELECT summary_text
       FROM conversation_summaries
      WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
      LIMIT 1`,
    [tenantId, canal, senderId]
  );

  return res.rows[0]?.summary_text ?? "";
}

export async function upsertConversationSummary(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  summaryText: string;
}): Promise<void> {
  const { tenantId, canal, senderId, summaryText } = params;

  await pool.query(
    `
    INSERT INTO conversation_summaries (tenant_id, canal, sender_id, summary_text)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, canal, sender_id)
    DO UPDATE SET summary_text = EXCLUDED.summary_text, updated_at = now()
    `,
    [tenantId, canal, senderId, summaryText]
  );
}

/**
 * Contexto listo para prompt. Esto es lo que te da "memoria estilo ChatGPT".
 */
export async function readMemoryContext(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
}) {
  const { tenantId, canal, senderId } = params;

  const [facts, summary] = await Promise.all([
    getAllMemory({ tenantId, canal, senderId }),
    getConversationSummary({ tenantId, canal, senderId }),
  ]);

  return {
    facts,      // KV: nombre, tipo_negocio, preferencias, flags
    summary,    // texto: resumen rolling
  };
}

/**
 * Write-back “sin LLM” (MVP): guarda señales simples.
 * Luego, cuando quieras, metemos extractor con LLM para hechos más ricos.
 */
export async function writeBackSignals(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  lang: "es" | "en";
  userText: string;
}) {
  const { tenantId, canal, senderId, lang, userText } = params;

  const items: Array<{ key: string; value: any }> = [];

  // Ejemplo: persistir idioma detectado
  items.push({ key: "preferred_language", value: lang });

  // Ejemplo: si usuario pide humano
  const t = (userText || "").toLowerCase();
  if (t.includes("humano") || t.includes("asesor") || t.includes("agent") || t.includes("human")) {
    items.push({ key: "handoff_human", value: true });
  }

  await setMemoryValuesBulk({ tenantId, canal, senderId, items });
}
