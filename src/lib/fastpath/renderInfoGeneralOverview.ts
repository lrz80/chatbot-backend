//src/lib/fastpath/renderInfoGeneralOverview.ts
import type { Pool } from "pg";
import type { Lang } from "../channels/engine/clients/clientDb";

function normalizeValue(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function isAddonRole(value: unknown): boolean {
  const v = normalizeValue(value);
  return v === "addon" || v === "add on" || v === "add-on";
}

function isAddonCategory(value: unknown): boolean {
  const v = normalizeValue(value);
  return v === "addon" || v === "add on" || v === "add-on";
}

export async function renderInfoGeneralOverview(args: {
  pool: Pool;
  tenantId: string;
  lang: Lang;
}): Promise<string> {
  const { pool, tenantId, lang } = args;

  const sRes = await pool.query(
    `
    SELECT
      s.name,
      s.category,
      s.catalog_role,
      s.parent_service_id
    FROM services s
    WHERE s.tenant_id = $1
      AND (s.active IS NULL OR s.active = TRUE)
      AND s.name IS NOT NULL
    ORDER BY s.created_at ASC, s.name ASC
    LIMIT 200
    `,
    [tenantId]
  );

  const rows = (sRes.rows || [])
    .map((r) => ({
      name: String(r.name || "").trim(),
      category: normalizeValue((r as any).category),
      catalogRole: normalizeValue((r as any).catalog_role),
      parentServiceId: (r as any).parent_service_id
        ? String((r as any).parent_service_id)
        : null,
    }))
    .filter((r) => r.name);

  const mainServices = unique(
    rows
      .filter((r) => {
        if (r.parentServiceId) return false;
        if (isAddonRole(r.catalogRole)) return false;
        if (isAddonCategory(r.category)) return false;
        return true;
      })
      .map((r) => r.name)
  );

  const count = mainServices.length;

  if (count === 0) {
    return lang === "en"
      ? "• Services: overview not available in the catalog"
      : "• Servicios: resumen no disponible en el catálogo";
  }

  if (count === 1) {
    return `• ${mainServices[0]}`;
  }

  return mainServices
    .slice(0, 7)
    .map((name) => `• ${name}`)
    .join("\n");
}