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

  // 1) Tenant: nombre + info_clave (para horarios)
  const tRes = await pool.query(
    `SELECT name, info_clave
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId]
  );

  const tenantName = String(tRes.rows?.[0]?.name || "").trim();
  const infoClave = String(tRes.rows?.[0]?.info_clave || "").trim();

  // 2) Servicios: traer catálogo
  const sRes = await pool.query(
    `SELECT name
     FROM services
     WHERE tenant_id = $1
     ORDER BY name ASC
     LIMIT 200`,
    [tenantId]
  );

  const rows = (sRes.rows || [])
    .map((r) => String(r.name || "").trim())
    .filter(Boolean);

  // 3) Filtros genéricos (sin hardcode por negocio)
  const isPlan = (n: string) =>
    /\b(plan|membership|membres[ií]a|suscripci[oó]n|subscription)\b/i.test(n);

  const isPackage = (n: string) =>
    /\b(paquete|pack|bundle)\b/i.test(n) || /\b\d+\s*clases?\b/i.test(n);

  const isTrial = (n: string) => /\b(prueba|trial|demo|gratis|free)\b/i.test(n);

  const isSingleClass = (n: string) =>
    /\b(clase\s+u[nñ]ica|single\s+class|drop[-\s]?in)\b/i.test(n);

  const isVariantNoise = (n: string) =>
    /\b(autopay|por\s+mes|mensual|per\s+month|monthly)\b/i.test(n);

  // ✅ Solo servicios principales
  const mainServices = rows.filter((n) => {
    if (isPlan(n)) return false;
    if (isPackage(n)) return false;
    if (isTrial(n)) return false;
    if (isSingleClass(n)) return false;
    if (isVariantNoise(n)) return false;
    return true;
  });

  // 4) Horarios: extraer sección de info_clave si existe
  let horarios = "";
  if (infoClave) {
    const m = infoClave.match(/(horarios?|hours?)\s*[:\n]([\s\S]*?)(\n{2,}|$)/i);
    if (m?.[2]) horarios = m[2].trim();
  }

  // 5) Render más humano (sin CTA)
  const greet =
    lang === "en"
      ? `Hi${tenantName ? `! Welcome to ${tenantName}` : ""} 😊`
      : `Hola${tenantName ? `! Bienvenido a ${tenantName}` : ""} 😊`;

  const intro =
    lang === "en"
      ? `Here’s what we offer:`
      : `Esto es lo que ofrecemos:`;

  const servicesBlock =
    mainServices.length > 0
      ? lineJoin([
          `${intro}`,
          ...mainServices.slice(0, 30).map((s) => `• ${s}`),
        ])
      : lang === "en"
        ? `Here’s an overview of our services.`
        : `Aquí tienes un resumen de nuestros servicios.`;

  // Horarios en tono humano
  const hoursHeader =
    lang === "en" ? `\nAnd these are our class times:` : `\nY estos son nuestros horarios:`;

  const hoursBlock =
    horarios
      ? lineJoin([hoursHeader, horarios])
      : "";

  return lineJoin([greet, servicesBlock, hoursBlock]).trim();
}
