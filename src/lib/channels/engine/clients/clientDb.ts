// backend/src/lib/channels/engine/clients/clientDb.ts
import type { Pool } from "pg";
import { normalizeLangCode, type LangCode } from "../../../i18n/lang";

export type Lang = LangCode;
export type SelectedChannel = "whatsapp" | "instagram" | "facebook" | "multi";

export function normalizeLang(code?: string | null): Lang | null {
  return normalizeLangCode(code);
}

/**
 * Crea (si no existe) el registro base del cliente por (tenant_id, canal, contacto).
 * Retorna true si fue INSERT (primer mensaje), false si ya existía.
 */
export async function ensureClienteBase(
  pool: Pool,
  tenantId: string,
  canal: string,
  contacto: string
): Promise<boolean> {
  try {
    const r = await pool.query(
      `
      INSERT INTO clientes (tenant_id, canal, contacto, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET updated_at = NOW()
      RETURNING (xmax = 0) AS inserted
      `,
      [tenantId, canal, contacto]
    );

    return r.rows?.[0]?.inserted === true;
  } catch (e: any) {
    console.warn("⚠️ ensureClienteBase FAILED", e?.message);
    return false;
  }
}

export async function getIdiomaClienteDB(
  pool: Pool,
  tenantId: string,
  canal: string,
  contacto: string,
  fallback: Lang
): Promise<Lang> {
  try {
    const { rows } = await pool.query(
      `SELECT idioma
       FROM clientes
       WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
       LIMIT 1`,
      [tenantId, canal, contacto]
    );

    const dbLang = normalizeLangCode(rows[0]?.idioma);
    if (dbLang) return dbLang;
  } catch (e: any) {
    console.warn("⚠️ getIdiomaClienteDB FAILED", e?.message);
  }

  return normalizeLangCode(fallback) ?? "es";
}

export async function upsertIdiomaClienteDB(
  pool: Pool,
  tenantId: string,
  canal: string,
  contacto: string,
  idioma: Lang
): Promise<void> {
  try {
    const normalizedIdioma = normalizeLangCode(idioma);
    if (!normalizedIdioma) return;

    await pool.query(
      `INSERT INTO clientes (tenant_id, canal, contacto, idioma, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tenant_id, canal, contacto)
       DO UPDATE SET
         idioma = EXCLUDED.idioma,
         updated_at = NOW()`,
      [tenantId, canal, contacto, normalizedIdioma]
    );
  } catch (e: any) {
    console.warn("⚠️ No se pudo guardar idioma del cliente:", e?.message);
  }
}

export async function getSelectedChannelDB(
  pool: Pool,
  tenantId: string,
  canal: string,
  contacto: string
): Promise<SelectedChannel | null> {
  try {
    const { rows } = await pool.query(
      `SELECT selected_channel
       FROM clientes
       WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
       LIMIT 1`,
      [tenantId, canal, contacto]
    );

    const v = String(rows[0]?.selected_channel || "").trim().toLowerCase();

    if (
      v === "whatsapp" ||
      v === "instagram" ||
      v === "facebook" ||
      v === "multi"
    ) {
      return v;
    }
  } catch (e: any) {
    console.warn("⚠️ getSelectedChannelDB FAILED", e?.message);
  }

  return null;
}

export async function upsertSelectedChannelDB(
  pool: Pool,
  tenantId: string,
  canal: string,
  contacto: string,
  selected: SelectedChannel
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO clientes (
         tenant_id,
         canal,
         contacto,
         selected_channel,
         selected_channel_updated_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (tenant_id, canal, contacto)
       DO UPDATE SET
         selected_channel = EXCLUDED.selected_channel,
         selected_channel_updated_at = NOW(),
         updated_at = NOW()`,
      [tenantId, canal, contacto, selected]
    );
  } catch (e: any) {
    console.warn("⚠️ No se pudo guardar selected_channel:", e?.message);
  }
}