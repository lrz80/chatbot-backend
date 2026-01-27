// backend/src/lib/tenants/resolveTenantFromInbound.ts
import type { Pool } from "pg";
import { normalizeToNumber } from "../whatsapp/normalize";

type Origen = "twilio" | "meta";

export type ResolveTenantContext = {
  tenant?: any;        // si ya viene resuelto (Meta / otros)
  canal?: string;      // opcional
  origen?: Origen;     // opcional
};

export async function resolveTenantFromInbound(opts: {
  pool: Pool;
  toRaw: string;               // body.To
  origen: Origen;              // calculado en whatsapp.ts
  context?: ResolveTenantContext;
}): Promise<any | null> {
  const { pool, toRaw, origen, context } = opts;

  // 1) Si viene tenant en contexto, úsalo (Meta / otros pipelines)
  const ctxTenant = context?.tenant;
  if (ctxTenant) return ctxTenant;

  // 2) Normaliza el "To" (número del negocio)
  const { numero, numeroSinMas } = normalizeToNumber(String(toRaw || ""));
  const numeroLower = numero.toLowerCase();
  const numeroSinMasLower = numeroSinMas.toLowerCase();

  // 3) Lookup por origen
  try {
    if (origen === "twilio") {
    // Queremos comparar SOLO dígitos para soportar:
    // 'whatsapp:+1775...', '+1775...', 'tel:+1775...', '1775...'
    const toDigits = numeroSinMas; // ya es sin '+'

    const tenantRes = await pool.query(
      `
      SELECT *
      FROM tenants
      WHERE REGEXP_REPLACE(
              REGEXP_REPLACE(LOWER(COALESCE(twilio_number, '')), '^(whatsapp:|tel:)', ''),
              '[^0-9]',
              '',
              'g'
            ) = $1
      LIMIT 1
      `,
      [toDigits]
    );

    return tenantRes.rows[0] || null;
  }

    // origen === "meta"
    // Para Meta NO se resuelve por "To" (no es número).
    // Debe venir resuelto por context.tenant en el pipeline de Meta.
    // Si no viene, devolvemos null.
    return null;

  } catch (e: any) {
    console.warn("⚠️ resolveTenantFromInbound failed:", {
      origen,
      toRaw,
      err: e?.message,
    });
    return null;
  }
}
