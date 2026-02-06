import type { Pool } from "pg";

type Lang = "es" | "en";

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

function asLabel(row: any) {
  // Si viene variante, la mostramos “Servicio - Variante”
  if (row.variant_name) return `${row.service_name} - ${row.variant_name}`;
  return String(row.service_name || row.name || "").trim();
}

export async function renderMoreInfoClarifier(args: {
  pool: Pool;
  tenantId: string;
  lang: Lang;
}): Promise<string> {
  const { pool, tenantId, lang } = args;

  // Trae ejemplos reales del tenant (servicios + variantes con precio o descripción)
  const { rows } = await pool.query(
    `
    WITH svc AS (
      SELECT
        s.id,
        s.name AS service_name,
        NULL::text AS variant_name,
        s.price_base AS price,
        s.description AS description,
        s.updated_at
      FROM services s
      WHERE s.tenant_id = $1
        AND s.active = TRUE
    ),
    var AS (
      SELECT
        s.id,
        s.name AS service_name,
        v.variant_name,
        v.price AS price,
        v.description AS description,
        v.updated_at
      FROM services s
      JOIN service_variants v ON v.service_id = s.id
      WHERE s.tenant_id = $1
        AND s.active = TRUE
        AND v.active = TRUE
    )
    SELECT * FROM (
      SELECT * FROM var
      UNION ALL
      SELECT * FROM svc
    ) x
    WHERE (x.price IS NOT NULL) OR (x.description IS NOT NULL AND length(trim(x.description)) > 0)
    ORDER BY x.updated_at DESC
    LIMIT 6
    `,
    [tenantId]
  );

  const examples = uniq(rows.map(asLabel)).slice(0, 5);

  // Si no hay ejemplos, igual responde humano sin inventar
  if (!examples.length) {
    if (lang === "en") {
      return (
        "Sure! What information do you need?\n" +
        "Tell me what you’re interested in (prices, schedule, what a class includes, or a specific service/plan), and I’ll help."
      );
    }
    return (
      "¡Claro! ¿Qué información necesitas exactamente?\n" +
      "Dime si buscas precios, horarios, qué incluye, o el nombre del servicio/plan y te ayudo."
    );
  }

  if (lang === "en") {
    return (
      "Sure! What information do you need?\n" +
      "Are you looking for prices, schedule, what it includes, or details about a specific option?\n\n" +
      `For example: ${examples.join(", ")}.`
    );
  }

  return (
    "¡Claro! ¿Qué información necesitas exactamente?\n" +
    "¿Buscas precios, horarios, qué incluye, o detalles de alguna opción en específico?\n\n" +
    `Por ejemplo: ${examples.join(", ")}.`
  );
}
