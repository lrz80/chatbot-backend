import type { Pool } from "pg";
import { getTenantFallbackLink } from "../../tenants/getTenantFallbackLink";

type Lang = "es" | "en";

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

function askWhatNeed(lang: Lang) {
  if (lang === "en") {
    return "What do you need help with: services, prices, schedule, location, or booking?";
  }
  return "¿Qué necesitas exactamente: servicios, precios, horarios, ubicación o reservar?";
}

export async function renderServiceSummaryReply(args: {
  pool: Pool;
  tenantId: string;
  lang: Lang;
}): Promise<string> {
  const { pool, tenantId, lang } = args;

  // Conteo total servicios activos
  const sCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM services WHERE tenant_id = $1 AND active = TRUE`,
    [tenantId]
  );

  const totalServices = Number(sCount.rows?.[0]?.n || 0);

  // Conteo total variantes activas (para esos servicios)
  const vCount = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1 AND s.active = TRUE AND v.active = TRUE
    `,
    [tenantId]
  );

  const totalVariants = Number(vCount.rows?.[0]?.n || 0);

  // Ejemplos (máx 6 nombres recientes)
  const examplesQ = await pool.query(
    `
    SELECT s.name
    FROM services s
    WHERE s.tenant_id = $1 AND s.active = TRUE
    ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC NULLS LAST
    LIMIT 6
    `,
    [tenantId]
  );

  const examples = uniq((examplesQ.rows || []).map((r: any) => String(r.name || ""))).slice(0, 6);

  // Si no hay servicios guardados, NO digas “no tengo”; manda link fallback
  if (!totalServices) {
    const link = await getTenantFallbackLink(pool, tenantId);

    if (lang === "en") {
      return (
        `I don’t have specific details loaded here yet. ` +
        (link ? `You can view more info here:\n${link}\n\n` : "\n") +
        `${askWhatNeed(lang)}`
      );
    }

    return (
      `No tengo detalles específicos cargados aquí todavía. ` +
      (link ? `Puedes ver más información aquí:\n${link}\n\n` : "\n") +
      `${askWhatNeed(lang)}`
    );
  }

  // Mensaje genérico + ejemplos cortos
  if (lang === "en") {
    return (
      `Sure 🙂 We currently have ${totalServices} service${totalServices === 1 ? "" : "s"} ` +
      (totalVariants ? `and ${totalVariants} option${totalVariants === 1 ? "" : "s"} ` : "") +
      `available.\n\n` +
      (examples.length ? `Examples: ${examples.slice(0, 4).join(", ")}.\n\n` : "") +
      `${askWhatNeed(lang)}`
    );
  }

  return (
    `¡Claro! 🙂 Ahora mismo tenemos ${totalServices} servicio${totalServices === 1 ? "" : "s"} ` +
    (totalVariants ? `y ${totalVariants} variante${totalVariants === 1 ? "" : "s"} ` : "") +
    `disponible${totalServices === 1 ? "" : "s"}.\n\n` +
    (examples.length ? `Ejemplos: ${examples.slice(0, 4).join(", ")}.\n\n` : "") +
    `${askWhatNeed(lang)}`
  );
}
