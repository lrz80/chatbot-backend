// backend/src/lib/cta/ctaEngine.ts
import pool from "../db";
import { normalizeIntentAlias } from "../intentSlug";

type CtaRow = { cta_text?: string; cta_url?: string } | null;

// CTA por intención (usa tenant_ctas.intent_slug en TEXT, no UUID)
  export async function getTenantCTA(tenantId: string, intent: string, channel: string) {
    const inten = normalizeIntentAlias((intent || '').trim().toLowerCase());

    // 1) Coincidencia exacta por canal o comodín '*'
    let q = await pool.query(
      `SELECT cta_text, cta_url
      FROM tenant_ctas
      WHERE tenant_id = $1
        AND intent_slug = $2
        AND (canal = $3 OR canal = '*')
      ORDER BY CASE WHEN canal=$3 THEN 0 ELSE 1 END
      LIMIT 1`,
      [tenantId, inten, channel]
    );
    if (q.rows[0]) return q.rows[0];

    // 2) Fallback 'global' del mismo canal (o '*')
    q = await pool.query(
      `SELECT cta_text, cta_url
      FROM tenant_ctas
      WHERE tenant_id = $1
        AND intent_slug = 'global'
        AND (canal = $2 OR canal = '*')
      ORDER BY CASE WHEN canal=$2 THEN 0 ELSE 1 END
      LIMIT 1`,
      [tenantId, channel]
    );
    return q.rows[0] || null;
  }

export function isValidUrl(u?: string): boolean {
  try {
    if (!u) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    // eslint-disable-next-line no-new
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

export function getGlobalCTAFromTenant(tenant: any): CtaRow {
  const t = (tenant?.cta_text || "").trim();
  const u = (tenant?.cta_url || "").trim();
  if (t && isValidUrl(u)) return { cta_text: t, cta_url: u };
  return null;
}

 export async function pickCTA(tenant: any, intent: string | null, channel: string) {
  if (intent) {
    const byIntent = await getTenantCTA(tenant.id, intent, channel);
    if (byIntent) return byIntent;
  }
  // fallback opcional desde columnas del tenant (si las usas)
  const t = (tenant?.cta_text || '').trim();
  const u = (tenant?.cta_url  || '').trim();
  if (t && isValidUrl(u)) return { cta_text: t, cta_url: u };
  return null;
}