import type { Pool } from "pg";
import { getTenantFallbackLink } from "../../tenants/getTenantFallbackLink";

type Lang = "es" | "en";

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

export async function renderServiceSummaryReply(args: {
  pool: Pool;
  tenantId: string;
  lang: Lang;
}): Promise<string> {
  const { pool, tenantId, lang } = args;

  // ✅ Top servicios recientes (máx 6) — multitenant (tenant_id) y sin hardcode por vertical
  const topQ = await pool.query(
    `
    SELECT s.name
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = TRUE
    ORDER BY
      s.updated_at DESC NULLS LAST,
      s.created_at DESC NULLS LAST
    LIMIT 6
    `,
    [tenantId]
  );

  const top = uniq((topQ.rows || []).map((r: any) => String(r.name || ""))).slice(0, 6);

  // ✅ Si no hay servicios guardados, manda link fallback (no “no tengo” seco)
  if (!top.length) {
    const link = await getTenantFallbackLink(pool, tenantId);

    if (!top.length) {
      const link = await getTenantFallbackLink(pool, tenantId);

      if (lang === "en") {
        return (
        "I don’t have service details loaded here yet.\n" +
        (link ? `You can check more information here:\n${link}` : "")
        );
      }

      return (
        "Aún no tengo detalles de servicios cargados aquí.\n" +
        (link ? `Puedes ver más información aquí:\n${link}` : "")
      );
    }
  }

  // ✅ Respuesta: lista corta numerada + CTA (sin conteos ni “variantes”)
  const lines = top.map((name, i) => `${i + 1}) ${name}`).join("\n");

  if (lang === "en") {
    return (
      "Sure 😊 Here are a few popular options:\n\n" +
      `${lines}\n\n` +
      "Reply with a number (1–6) or type the name.\n" +
      "Do you want prices, what it includes, or help booking?"
    );
  }

  return (
    "¡Claro! 😊 Estas son algunas opciones populares:\n\n" +
    `${lines}\n\n` +
    "Respóndeme con un número (1–6) o escribe el nombre.\n" +
    "¿Quieres precios, qué incluye, o ayuda para reservar?"
  );
}
