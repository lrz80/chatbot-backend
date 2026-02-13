// src/lib/services/resolveServiceList.ts
import type { Pool } from "pg";

export type ServiceListItem = {
  service_id: string;
  name: string;
  tipo: "plan" | "service" | string;
  category: string | null;
  duration_min: number | null;
  service_url: string | null;
};

export async function resolveServiceList(
  pool: Pool,
  opts: {
    tenantId: string;
    limitServices?: number;
    queryText?: string | null;
    tipos?: string[] | null; // ✅ NUEVO: ['plan'] | ['service'] | ['plan','service']
  }
): Promise<{ ok: true; items: ServiceListItem[] } | { ok: false; reason: "empty" | "error" }> {
  const tenantId = opts.tenantId;
  const limitServices = Math.min(20, Math.max(1, opts.limitServices ?? 8));

  const q = (opts.queryText || "").trim();
  const qLike = q
    ? `%${q
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()}%`
    : null;

  // default: ambos
  const tipos = (opts.tipos && opts.tipos.length ? opts.tipos : ["plan", "service"]).map((t) =>
    String(t || "").toLowerCase()
  );

  try {
    const sRes = await pool.query(
      `
      SELECT id, name, tipo, category, duration_min, service_url
      FROM services
      WHERE tenant_id = $1
        AND active = TRUE
        AND (LOWER(tipo) = ANY($4::text[]))
        AND (
          $2::text IS NULL
          OR LOWER(
              REGEXP_REPLACE(
                TRANSLATE(name, 'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑ', 'AAAAAEEEEIIIIOOOOOUUUUN'),
                '\\s+',
                ' ',
                'g'
              )
            ) LIKE $2
        )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT $3
      `,
      [tenantId, qLike, limitServices, tipos]
    );

    const services = sRes.rows || [];
    if (!services.length) return { ok: false, reason: "empty" };

    const items: ServiceListItem[] = services.map((s: any) => ({
      service_id: String(s.id),
      name: String(s.name),
      tipo: String(s.tipo || "").toLowerCase(),
      category: s.category ? String(s.category) : null,
      duration_min: s.duration_min == null ? null : Number(s.duration_min),
      service_url: s.service_url ? String(s.service_url) : null,
    }));

    return { ok: true, items };
  } catch (e) {
    console.warn("resolveServiceList failed:", e);
    return { ok: false, reason: "error" };
  }
}
