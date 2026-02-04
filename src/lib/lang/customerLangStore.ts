// src/lib/lang/customerLangStore.ts
import pool from "../db"; // ajusta el path si tu pool está en otro lado
import type { Lang } from "./threadLang";

export async function getCustomerLangDB(args: { tenantId: string; canal: string; contacto: string }): Promise<Lang | null> {
  const { tenantId, canal, contacto } = args;
  const q = `
    SELECT lang
    FROM customer_languages
    WHERE tenant_id=$1 AND canal=$2 AND contacto=$3
    LIMIT 1
  `;
  try {
    const r = await pool.query(q, [tenantId, canal, contacto]);
    const v = r.rows?.[0]?.lang;
    if (!v) return null;
    return String(v).toLowerCase() === "en" ? "en" : "es";
  } catch (e) {
    return null;
  }
}

export async function upsertCustomerLangDB(args: { tenantId: string; canal: string; contacto: string; lang: Lang }) {
  const { tenantId, canal, contacto, lang } = args;
  const q = `
    INSERT INTO customer_languages (tenant_id, canal, contacto, lang, updated_at)
    VALUES ($1,$2,$3,$4, NOW())
    ON CONFLICT (tenant_id, canal, contacto)
    DO UPDATE SET lang=EXCLUDED.lang, updated_at=NOW()
  `;
  await pool.query(q, [tenantId, canal, contacto, lang]);
}
