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
      const tenantRes = await pool.query(
        `
        SELECT *
          FROM tenants
        WHERE REPLACE(LOWER(twilio_number),'whatsapp:','') = $1
           OR REPLACE(LOWER(twilio_number),'whatsapp:','') = $2
        LIMIT 1
        `,
        [numeroLower, numeroSinMasLower]
      );

      return tenantRes.rows[0] || null;
    }

    // origen === "meta"
    const tenantRes = await pool.query(
      `
      SELECT *
        FROM tenants
      WHERE REPLACE(LOWER(whatsapp_phone_number_id::text),'whatsapp:','') = $1
      LIMIT 1
      `,
      [numeroLower]
    );

    return tenantRes.rows[0] || null;
  } catch (e: any) {
    console.warn("⚠️ resolveTenantFromInbound failed:", {
      origen,
      toRaw,
      err: e?.message,
    });
    return null;
  }
}
