import type { Pool } from "pg";
import type { Lang } from "../channels/engine/clients/clientDb";

function normCat(s: unknown) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/-/g, " ");
}

function unique(arr: string[]) {
  return Array.from(new Set(arr));
}

export async function renderInfoGeneralOverview(args: {
  pool: Pool;
  tenantId: string;
  lang: Lang;
}): Promise<string> {
  const { pool, tenantId, lang } = args;

  // 1️⃣ Tenant name
  const tRes = await pool.query(
    `SELECT name
     FROM tenants
     WHERE id = $1
     LIMIT 1`,
    [tenantId]
  );

  const tenantName = String(tRes.rows?.[0]?.name || "").trim();

  // 2️⃣ Servicios activos
  const sRes = await pool.query(
    `SELECT name, category
     FROM services
     WHERE tenant_id = $1
       AND (active IS NULL OR active = TRUE)
     ORDER BY name ASC
     LIMIT 200`,
    [tenantId]
  );

  const rows = (sRes.rows || [])
    .map((r) => ({
      name: String(r.name || "").trim(),
      category: normCat((r as any).category),
    }))
    .filter((r) => r.name);

  // 3️⃣ Filtros genéricos
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

  const isAddonCategory = (cat: string) =>
    cat === "add on" || cat === "addon";

  const mainServices = unique(
    rows
      .filter((r) => {
        if (isAddonCategory(r.category)) return false;

        const n = r.name;

        if (isPlan(n)) return false;
        if (isPackage(n)) return false;
        if (isTrial(n)) return false;
        if (isSingleClass(n)) return false;
        if (isVariantNoise(n)) return false;

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

  const list = mainServices.slice(0, 7).map((s) => `• ${s}`).join("\n");
  return list;
}