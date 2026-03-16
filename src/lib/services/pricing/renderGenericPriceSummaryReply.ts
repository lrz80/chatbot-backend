// backend/src/lib/services/pricing/renderGenericPriceSummaryReply.ts

import type { Lang } from "../../channels/engine/clients/clientDb";

type Row = {
  service_name: string;
  min_price: number | string | null;
  max_price: number | string | null;
  category?: string | null;
  catalog_role?: string | null;
};

function money(n: number) {
  if (!Number.isFinite(n)) return "";
  const isInt = Math.abs(n - Math.trunc(n)) < 1e-9;
  return isInt ? `$${Math.trunc(n)}` : `$${n.toFixed(2)}`;
}

function normalizeLocal(s: string) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// 🔹 Formatea el texto de precio, incluyendo el caso "gratis/free"
function formatPrice(lang: Lang, minRaw: number, maxRaw: number): string {
  const min = Number(minRaw ?? 0);
  const max = Number(maxRaw ?? minRaw ?? 0);

  if ((min <= 0 || !Number.isFinite(min)) && (max <= 0 || !Number.isFinite(max))) {
    return lang === "en" ? "free" : "gratis";
  }

  if (Number.isFinite(min) && Number.isFinite(max) && min.toFixed(2) === max.toFixed(2)) {
    return money(min);
  }

  if (Number.isFinite(min)) {
    return lang === "en" ? `from ${money(min)}` : `desde ${money(min)}`;
  }

  return lang === "en" ? "ask for price" : "consulta el precio";
}

function getSortPrice(minP: number, maxP: number) {
  if (Number.isFinite(minP)) return minP;
  if (Number.isFinite(maxP)) return maxP;
  return Number.POSITIVE_INFINITY;
}

// 🔹 Heurística GENÉRICA para priorizar servicios principales en vertical pet grooming
// sin depender de nombres exactos del tenant.
function getCoreServiceScore(name: string, category?: string | null): number {
  const n = normalizeLocal(name);
  const c = normalizeLocal(category || "");

  let score = 0;

  // categorías principales
  if (c.includes("groom")) score += 100;
  if (c.includes("haircut")) score += 100;
  if (c.includes("bath")) score += 90;

  // nombres principales
  if (n.includes("groom")) score += 100;
  if (n.includes("haircut")) score += 100;
  if (n.includes("bath")) score += 90;
  if (n.includes("baño") || n.includes("bano")) score += 90;
  if (n.includes("corte")) score += 90;

  // penalizar add-ons / extras / tratamientos menores
  if (n.includes("mascarilla")) score -= 40;
  if (n.includes("hidratante")) score -= 40;
  if (n.includes("orejas")) score -= 40;
  if (n.includes("oidos") || n.includes("oídos")) score -= 40;
  if (n.includes("uñas") || n.includes("unas")) score -= 40;
  if (n.includes("dientes")) score -= 40;
  if (n.includes("glandulas") || n.includes("glándulas")) score -= 40;
  if (n.includes("anal")) score -= 20;
  if (n.includes("nariz")) score -= 20;

  if (c.includes("add")) score -= 120;
  if (c.includes("extra")) score -= 80;
  if (c.includes("treatment")) score -= 30;
  if (c.includes("specialty")) score -= 20;

  return score;
}

export function renderGenericPriceSummaryReply(args: {
  lang: Lang;
  rows: Row[];
}): string {
  const lang: Lang = args.lang === "en" ? "en" : "es";

  const normalized = (args.rows || [])
    .filter((r) => r?.service_name)
    .map((r) => {
      const name = String(r.service_name).trim();
      const minP = r.min_price == null ? NaN : Number(r.min_price);
      const maxP = r.max_price == null ? NaN : Number(r.max_price);

      return {
        name,
        minP,
        maxP,
        category: r.category || null,
        catalog_role: String(r.catalog_role || "primary").trim().toLowerCase(),
      };
    })
    .filter((r) => {
      return (
        r.name &&
        (Number.isFinite(r.minP) ||
          Number.isFinite(r.maxP) ||
          r.minP === 0 ||
          r.maxP === 0)
      );
    });

  if (!normalized.length) {
    return lang === "en"
      ? "To help you, tell me which product or service you’re interested in."
      : "Para ayudarte, dime qué producto o servicio te interesa.";
  }

  const primary = normalized.filter((r) => r.catalog_role === "primary");
  const secondary = normalized.filter((r) => r.catalog_role !== "primary");

  primary.sort((a, b) => {
    const aCore = getCoreServiceScore(a.name, a.category);
    const bCore = getCoreServiceScore(b.name, b.category);

    // primero score de principalidad
    if (aCore !== bCore) return bCore - aCore;

    // luego precio más bajo
    return getSortPrice(a.minP, a.maxP) - getSortPrice(b.minP, b.maxP);
  });

  secondary.sort((a, b) => {
    return getSortPrice(a.minP, a.maxP) - getSortPrice(b.minP, b.maxP);
  });

  const selected = [...primary, ...secondary].slice(0, 6);

  const clean = selected.map((r) => {
    const priceText = formatPrice(lang, r.minP, r.maxP);
    return `• ${r.name}: ${priceText}`;
  });

  const header =
    lang === "en"
      ? "Here are some options:"
      : "Aquí tienes algunas opciones:";

  const footer =
    lang === "en"
      ? "Which of these options are you interested in? 😊"
      : "¿Cuál de estas opciones te interesa? 😊";

  return [header, "", ...clean, "", footer].join("\n");
}