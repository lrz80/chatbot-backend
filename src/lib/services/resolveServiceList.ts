// src/lib/services/resolveServiceList.ts
import type { Pool } from "pg";

export type ServiceListItem = {
  service_id: string;
  name: string;
  category: string | null;
  duration_min: number | null;
  price_base: null;
  service_url: string | null;
  variants: any[]; // ✅ aquí NO uses ServiceVariantItem
};

export async function resolveServiceList(
  pool: Pool,
  opts: {
    tenantId: string;
    limitServices?: number;
    queryText?: string | null; // opcional
    tipos?: string[] | null;   // ✅ nuevo: filtra por tipo(s)
  }
): Promise<
  { ok: true; items: ServiceListItem[] } |
  { ok: false; reason: "empty" | "error" }
> {
  const tenantId = opts.tenantId;
  const limitServices = Math.min(20, Math.max(1, opts.limitServices ?? 8));

  // filtro opcional por texto (genérico)
  const q = (opts.queryText || "").trim();
  const qLike = q
    ? `%${q
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()}%`
    : null;

  // ✅ tipos opcionales
  const tipos = Array.isArray(opts.tipos) && opts.tipos.length ? opts.tipos : null;

  try {
    const sRes = await pool.query(
      `
      SELECT id, name, category, duration_min, service_url
      FROM services
      WHERE tenant_id = $1
        AND active = TRUE
        AND (
          $2::text[] IS NULL
          OR tipo = ANY($2::text[])
        )
        AND (
          $3::text IS NULL
          OR LOWER(
              REGEXP_REPLACE(
                TRANSLATE(name, 'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑ', 'AAAAAEEEEIIIIOOOOOUUUUN'),
                '\\s+',
                ' ',
                'g'
              )
            ) LIKE $3
        )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT $4
      `,
      [tenantId, tipos, qLike, limitServices]
    );

    const services = sRes.rows || [];
    if (!services.length) return { ok: false, reason: "empty" };

    const items: ServiceListItem[] = services.map((s: any) => ({
      service_id: String(s.id),
      name: String(s.name),
      category: s.category ? String(s.category) : null,
      duration_min: s.duration_min == null ? null : Number(s.duration_min),
      price_base: null,
      service_url: s.service_url ? String(s.service_url) : null,
      variants: [],
    }));

    return { ok: true, items };
  } catch (e) {
    console.warn("resolveServiceList failed:", e);
    return { ok: false, reason: "error" };
  }
}
