import type { Pool } from "pg";
import type { Lang } from "../channels/engine/clients/clientDb";

function lineJoin(lines: string[]) {
  return lines.filter(Boolean).join("\n");
}

export async function renderInfoGeneralOverview(args: {
  pool: Pool;
  tenantId: string;
  lang: Lang;
}): Promise<string> {
  const { pool, tenantId, lang } = args;

  // 1) Trae tenant (para nombre / CTA link si lo guardas)
  const tRes = await pool.query(
    `SELECT name, info_clave
     FROM tenants
     WHERE id=$1
     LIMIT 1`,
    [tenantId]
  );
  const tenantName = String(tRes.rows?.[0]?.name || "").trim();
  const infoClave = String(tRes.rows?.[0]?.info_clave || "").trim();

  // 2) Trae servicios desde DB (catálogo)
  const sRes = await pool.query(
    `SELECT name
     FROM services
     WHERE tenant_id=$1
     ORDER BY name ASC
     LIMIT 30`,
    [tenantId]
  );
  const services = (sRes.rows || []).map((r) => String(r.name || "").trim()).filter(Boolean);

  // 3) Horarios: lo sacamos de info_clave si existe (genérico)
  //    (Luego lo migras a una tabla "business_hours" si quieres)
  let horarios = "";
  if (infoClave) {
    // busca una sección típica. Si no existe, no inventa.
    const m = infoClave.match(/(horarios?|hours?)\s*[:\n]([\s\S]*?)(\n{2,}|$)/i);
    if (m?.[2]) horarios = m[2].trim();
  }

  // 4) Render
  const header =
    lang === "en"
      ? `Hi${tenantName ? `, welcome to ${tenantName}` : ""}! 😊 Here’s a quick overview:`
      : `Hola${tenantName ? `, bienvenido a ${tenantName}` : ""}! 😊 Aquí tienes un resumen:`;

  const servicesBlock =
    services.length > 0
      ? lineJoin([
          lang === "en" ? `*Services:*` : `*Servicios:*`,
          ...services.map((s) => `• ${s}`),
        ])
      : "";

  const hoursBlock =
    horarios
      ? lineJoin([lang === "en" ? `\n*Hours / Schedule:*` : `\n*Horarios:*`, horarios])
      : "";

  const cta =
    lang === "en"
      ? `\nIf you tell me what you’re interested in, I’ll send prices and available times 😊`
      : `\nDime cuál te interesa y te paso precios y horarios disponibles 😊`;

  return lineJoin([header, servicesBlock, hoursBlock, cta]).trim();
}
