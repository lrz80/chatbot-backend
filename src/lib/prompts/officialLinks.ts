// backend/src/lib/prompts/officialLinks.ts
import pool from "../db";
import type { LangCode } from "../i18n/lang";

export type OfficialLink = {
  label: string;
  url: string;
};

/**
 * Devuelve una lista de enlaces oficiales para el tenant
 * a partir de services y service_variants.
 *
 * NO hay lógica por negocio, solo:
 *  - servicios activos del tenant
 *  - que tengan algún URL (service_url o variant_url)
 */
export async function getOfficialLinksForTenant(
  tenantId: string
): Promise<OfficialLink[]> {
  const { rows } = await pool.query(
    `
    SELECT
      s.id                         AS service_id,
      s.name                       AS service_name,
      s.category                   AS service_category,
      s.service_url                AS service_url,

      v.id                         AS variant_id,
      v.variant_name               AS variant_name,
      v.variant_url                AS variant_url

    FROM services s
    LEFT JOIN service_variants v
      ON v.service_id = s.id
     AND v.active = TRUE

    WHERE
      s.tenant_id = $1
      AND s.active = TRUE
      AND (
        (s.service_url IS NOT NULL AND s.service_url <> '')
        OR (v.variant_url IS NOT NULL AND v.variant_url <> '')
      )
    `,
    [tenantId]
  );

  // 🔁 Dedupe por URL
  const map = new Map<string, OfficialLink>();

  for (const row of rows) {
    const url: string =
      row.variant_url && String(row.variant_url).trim() !== ""
        ? String(row.variant_url).trim()
        : row.service_url && String(row.service_url).trim() !== ""
        ? String(row.service_url).trim()
        : "";

    if (!url) continue;

    const serviceName = String(row.service_name || "").trim();
    const variantName = String(row.variant_name || "").trim();

    let label = serviceName;
    if (variantName && variantName.toLowerCase() !== serviceName.toLowerCase()) {
      label = `${serviceName} — ${variantName}`;
    }

    // recortar labels muy largos
    if (label.length > 90) {
      label = label.slice(0, 87) + "...";
    }

    if (!map.has(url)) {
      map.set(url, { label, url });
    }
  }

  return Array.from(map.values());
}

/**
 * Renderiza sección de enlaces para inyectarla en el prompt.
 * 100% genérico y multitenant.
 */
export function renderOfficialLinksSection(
  links: OfficialLink[],
  lang: LangCode
): string {
  if (!links.length) return "";

  const header =
    lang === "es"
      ? "ENLACES_OFICIALES (usa SOLO estos enlaces cuando quieras proponer un siguiente paso al usuario; no inventes otros links):"
      : "OFFICIAL_LINKS (use ONLY these URLs when you want to propose a next step to the user; do not invent other links):";

  const lines = links.map((l) => `- ${l.label}: ${l.url}`);

  return [header, ...lines].join("\n");
}