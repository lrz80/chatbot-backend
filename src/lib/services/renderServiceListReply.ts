// src/lib/services/renderServiceListReply.ts
import type { Pool } from "pg";

export type ServiceVariantItem = {
  variant_id: string;
  variant_name: string;
  price: number | null;
  price_base?: number | null; // por compat si tu schema lo tiene
  currency: string | null;
  duration_min: number | null;
};

export type ServiceListItem = {
  service_id: string;
  name: string;
  category: string | null;
  duration_min: number | null;
  price_base: number | null;
  service_url: string | null;
  variants: ServiceVariantItem[];
};

export type ResolveServiceListOpts = {
  limit?: number;               // default 50
  includeVariants?: boolean;    // default false
  maxVariantsPerService?: number; // default 5
  queryText?: string | null;    // opcional: filtra por texto (sin hardcode)
};

function safeInt(n: any, fallback: number) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

// Normalización simple para búsquedas sin depender de extensiones (pg_trgm)
function normalizeForSearch(s: string) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export async function resolveServiceList(
  pool: Pool,
  tenantId: string,
  opts: ResolveServiceListOpts = {}
): Promise<ServiceListItem[]> {
  const limit = safeInt(opts.limit, 50);
  const includeVariants = opts.includeVariants === true;
  const maxVariantsPerService = safeInt(opts.maxVariantsPerService, 5);

  const qNorm = opts.queryText ? normalizeForSearch(opts.queryText) : null;
  const qLike = qNorm ? `%${qNorm}%` : null;

  // 1) SERVICES (base)
  // Nota: usamos un filtro “flexible” por texto solo si se provee queryText
  const servicesRes = await pool.query(
    `
    SELECT
      s.id::text AS service_id,
      s.name AS name,
      s.category AS category,
      s.duration_min::int AS duration_min,
      s.price_base::numeric AS price_base,
      s.service_url AS service_url
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = true
      AND s.name IS NOT NULL
      AND (
        $2::text IS NULL
        OR LOWER(
            REGEXP_REPLACE(
              TRANSLATE(s.name, 'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑ', 'AAAAAEEEEIIIIOOOOOUUUUN'),
              '\\s+',
              ' ',
              'g'
            )
          ) LIKE $2
      )
    ORDER BY s.name ASC
    LIMIT $3;
    `,
    [tenantId, qLike, limit]
  );

  const items: ServiceListItem[] = (servicesRes.rows || [])
    .map((r: any) => ({
      service_id: String(r.service_id),
      name: String(r.name || "").trim(),
      category: r.category != null ? String(r.category) : null,
      duration_min: r.duration_min != null ? Number(r.duration_min) : null,
      price_base: r.price_base != null ? Number(r.price_base) : null,
      service_url: r.service_url != null ? String(r.service_url) : null,
      variants: [],
    }))
    .filter((s) => s.service_id && s.name);

  if (!items.length) return [];

  if (!includeVariants) return items;

  // 2) VARIANTS (por cada service) — simple y seguro (sin hardcode)
  // Para evitar un query gigante, hacemos 1 query con IN + ranking por precio/nombre y luego recortamos por service.
  const serviceIds = items.map((s) => s.service_id);

  // Si no hay ids, salimos
  if (!serviceIds.length) return items;

  const variantsRes = await pool.query(
    `
    SELECT
      v.id::text AS variant_id,
      v.service_id::text AS service_id,
      COALESCE(NULLIF(v.variant_name,''), NULLIF(v.name,''), 'Option') AS variant_name,
      COALESCE(v.price, v.price_base)::numeric AS price,
      COALESCE(NULLIF(v.currency,''), NULL) AS currency,
      v.duration_min::int AS duration_min
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1
      AND v.active = true
      AND v.service_id = ANY($2::uuid[])
    ORDER BY
      v.service_id ASC,
      COALESCE(v.price, v.price_base) ASC NULLS LAST,
      COALESCE(NULLIF(v.variant_name,''), NULLIF(v.name,''), 'Option') ASC;
    `,
    [tenantId, serviceIds]
  );

  const byService: Record<string, ServiceVariantItem[]> = {};

  for (const r of variantsRes.rows || []) {
    const sid = String(r.service_id);
    if (!byService[sid]) byService[sid] = [];
    byService[sid].push({
      variant_id: String(r.variant_id),
      variant_name: String(r.variant_name || "Option").trim() || "Option",
      price: r.price != null ? Number(r.price) : null,
      currency: r.currency != null ? String(r.currency) : null,
      duration_min: r.duration_min != null ? Number(r.duration_min) : null,
    });
  }

  // Recorta a maxVariantsPerService
  for (const s of items) {
    const arr = byService[s.service_id] || [];
    s.variants = arr.slice(0, maxVariantsPerService);
  }

  return items;
}
