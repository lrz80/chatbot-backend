//src/lib/fastpath/renderInfoGeneralOverview.ts

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

  // 1️⃣ Traer tenant (nombre + info_clave para horarios)
  const tRes = await pool.query(
    `SELECT name, info_clave
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId]
  );

  const tenantName = String(tRes.rows?.[0]?.name || "").trim();
  const infoClave = String(tRes.rows?.[0]?.info_clave || "").trim();

  // 2️⃣ Traer todos los servicios
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

  // 3️⃣ Filtros genéricos (sin hardcode por negocio)
  const isPlan = (n: string) =>
    /\b(plan|membership|membres[ií]a|suscripci[oó]n|subscription)\b/i.test(n);

  const isPackage = (n: string) =>
    /\b(paquete|pack|bundle)\b/i.test(n) || /\b\d+\s*clases?\b/i.test(n);

  const isTrial = (n: string) =>
    /\b(prueba|trial|demo|gratis|free)\b/i.test(n);

  const isSingleClass = (n: string) =>
    /\b(clase\s+u[nñ]ica|single\s+class|drop[-\s]?in)\b/i.test(n);

  const isVariantNoise = (n: string) =>
    /\b(autopay|por\s+mes|mensual|per\s+month|monthly)\b/i.test(n);

  // ✅ SOLO servicios principales
  const mainServices = rows.filter((n) => {
    if (isPlan(n)) return false;
    if (isPackage(n)) return false;
    if (isTrial(n)) return false;
    if (isSingleClass(n)) return false;
    if (isVariantNoise(n)) return false;
    return true;
  });

  // 4️⃣ Extraer horarios desde info_clave (si existen)
  let horarios = "";
  if (infoClave) {
    const m = infoClave.match(/(horarios?|hours?)\s*[:\n]([\s\S]*?)(\n{2,}|$)/i);
    if (m?.[2]) horarios = m[2].trim();
  }

  // 5️⃣ Render final (solo servicios + horarios)
  const header =
    lang === "en"
      ? `Hi${tenantName ? `, welcome to ${tenantName}` : ""}! 😊`
      : `Hola${tenantName ? `, bienvenido a ${tenantName}` : ""}! 😊`;

  const servicesBlock =
    mainServices.length > 0
      ? lineJoin([
          lang === "en" ? `*Main services:*` : `*Servicios principales:*`,
          ...mainServices.slice(0, 30).map((s) => `• ${s}`),
        ])
      : "";

  const hoursBlock =
    horarios
      ? lineJoin([
          "",
          lang === "en" ? `*Hours / Schedule:*` : `*Horarios:*`,
          horarios,
        ])
      : "";

  return lineJoin([header, servicesBlock, hoursBlock]).trim();
}
