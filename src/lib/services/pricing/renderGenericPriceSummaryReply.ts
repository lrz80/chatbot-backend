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

function normalizeCatalogRole(role: string | null | undefined): "primary" | "secondary" {
  const v = String(role || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  if (
    v === "primary" ||
    v === "servicio principal" ||
    v === "principal" ||
    v === "main"
  ) {
    return "primary";
  }

  if (
    v === "secondary" ||
    v === "complemento" ||
    v === "complemento / extra" ||
    v === "extra" ||
    v === "addon"
  ) {
    return "secondary";
  }

  return "primary";
}

function getSortPrice(minP: number, maxP: number) {
  if (Number.isFinite(minP)) return minP;
  if (Number.isFinite(maxP)) return maxP;
  return Number.POSITIVE_INFINITY;
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
        catalog_role: normalizeCatalogRole(r.catalog_role),
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

  // runFastpath ya envía los servicios en el orden correcto.
  // Aquí NO debemos reordenar.
  const selected = normalized.slice(0, 6);

  const clean = selected.map((r) => {
    const priceText = formatPrice(lang, r.minP, r.maxP);
    return `• ${r.name}: ${priceText}`;
  });

  const header =
    lang === "en"
      ? "Here are some of our most requested options:"
      : "Estas son algunas de nuestras opciones más solicitadas:";

  const footer =
    lang === "en"
      ? "Which of these options are you interested in? 😊"
      : "¿Cuál de estas opciones te interesa? 😊";

  return [header, "", ...clean, "", footer].join("\n");
}