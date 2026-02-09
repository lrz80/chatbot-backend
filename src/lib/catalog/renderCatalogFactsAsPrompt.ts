// backend/src/lib/catalog/renderCatalogFactsAsPrompt.ts
type Lang = "es" | "en";

function money(n: number | null, currency = "USD") {
  if (n == null || !Number.isFinite(n)) return "";
  const v = Number(n);
  const sym = currency === "USD" ? "$" : "";
  return `${sym}${v.toFixed(2)}`;
}

function clean(s: any) {
  const t = String(s || "").trim();
  return t ? t : "";
}

// facts esperado (ajústalo a tu shape real):
// {
//   kind: "service" | "variant",
//   label: "Bath" | "Bronze Cycling" | "Deluxe Bath",
//   url?: string | null,
//   price?: number | null,
//   currency?: string | null,
//   duration_min?: number | null,
//   includes?: string | null,
//   variants?: Array<{ label, url, price, currency, duration_min, includes }>
// }
export function renderCatalogFactsAsPrompt(facts: any, idioma: Lang): string {
  if (!facts) return "";

  const title = idioma === "en" ? "DATABASE_CATALOG_FACTS" : "HECHOS_DE_CATALOGO_DESDE_DB";
  const lines: string[] = [];

  lines.push(title);
  lines.push(idioma === "en"
    ? "Use ONLY this info for price/duration/includes. If missing, ask ONE question."
    : "Usa SOLO esto para precio/duración/qué incluye. Si falta, haz UNA pregunta."
  );

  const label = clean(facts.label);
  const url = clean(facts.url);

  if (label) lines.push(`ITEM: ${label}`);
  if (url) lines.push(`LINK: ${url}`);

  // Caso: variant único resuelto
  const p = facts.price ?? null;
  const cur = clean(facts.currency) || "USD";
  const dur = facts.duration_min ?? null;
  const inc = clean(facts.includes) || clean(facts.description);

  if (p != null || dur != null || inc) {
    if (p != null) lines.push(`PRICE: ${money(p, cur)} ${cur}`);
    if (dur != null) lines.push(`DURATION_MIN: ${dur}`);
    if (inc) lines.push(`INCLUDES: ${inc}`);
    return lines.join("\n");
  }

  // Caso: service con variants
  const variants = Array.isArray(facts.variants) ? facts.variants : [];
  if (variants.length) {
    lines.push(idioma === "en" ? "OPTIONS:" : "OPCIONES:");
    // ✅ límite duro para no spamear
    for (const v of variants.slice(0, 5)) {
      const vLabel = clean(v.label) || clean(v.variant_name) || "Option";
      const vUrl = clean(v.url);
      const vP = v.price ?? null;
      const vCur = clean(v.currency) || cur;
      const vDur = v.duration_min ?? null;
      const vInc = clean(v.includes) || clean(v.description);

      const row: string[] = [];
      row.push(`- ${vLabel}`);
      if (vP != null) row.push(`${money(vP, vCur)} ${vCur}`);
      if (vDur != null) row.push(`${vDur} min`);
      if (vUrl) row.push(vUrl);

      lines.push(row.join(" | "));

      // includes en línea aparte si existe (para “leer como prompt”)
      if (vInc) lines.push(`  INCLUDES: ${vInc}`);
    }

    lines.push(idioma === "en"
      ? "Rule: If user asked price/includes, answer using ONE best matching option or ask them to pick one."
      : "Regla: Si pidió precio/qué incluye, responde usando UNA opción o pide que elija una."
    );

    return lines.join("\n");
  }

  return lines.join("\n");
}
