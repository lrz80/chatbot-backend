// backend/src/lib/services/pricing/renderGenericPriceSummaryReply.ts

import type { Lang } from "../../channels/engine/clients/clientDb";

type Row = {
  service_name: string;
  min_price: number | string | null;
  max_price: number | string | null;
};

function money(n: number) {
  // sin locales raros, WhatsApp friendly
  return `$${Math.round(n)}`;
}

// 🔹 Formatea el texto de precio, incluyendo el caso "gratis/free"
function formatPrice(lang: Lang, minRaw: number, maxRaw: number): string {
  const min = Number(minRaw ?? 0);
  const max = Number(maxRaw ?? minRaw ?? 0);

  // Caso GRATIS: todo <= 0
  if ((min <= 0 || !Number.isFinite(min)) && (max <= 0 || !Number.isFinite(max))) {
    return lang === "en" ? "free" : "gratis";
  }

  // Mismo precio (sin rango)
  if (Number.isFinite(min) && Number.isFinite(max) && Math.round(min) === Math.round(max)) {
    return money(min);
  }

  // Rango dentro del servicio (variante) => muestra "desde"
  if (Number.isFinite(min)) {
    return lang === "en"
      ? `from ${money(min)}`
      : `desde ${money(min)}`;
  }

  // fallback raro
  return lang === "en" ? "ask for price" : "consulta el precio";
}

export function renderGenericPriceSummaryReply(args: {
  lang: Lang;
  rows: Row[];
}): string {
  const lang: Lang = args.lang === "en" ? "en" : "es";

  // 1) Normalizamos filas y nos quedamos con las que tengan precio válido
  const normalized = (args.rows || [])
    .filter((r) => r?.service_name)
    .map((r) => {
      const name = String(r.service_name).trim();
      const minP = r.min_price == null ? NaN : Number(r.min_price);
      const maxP = r.max_price == null ? NaN : Number(r.max_price);
      return { name, minP, maxP };
    })
    .filter((r) => {
      return (
        r.name &&
        (Number.isFinite(r.minP) ||
          Number.isFinite(r.maxP) ||
          // permitimos también el caso explícito 0/NaN para poder marcar "gratis"
          r.minP === 0 ||
          r.maxP === 0)
      );
    });

  // 2) Ordenamos SIEMPRE de menor a mayor precio (usando min_price)
  normalized.sort((a, b) => {
    const aVal = Number.isFinite(a.minP) ? a.minP : a.maxP ?? 0;
    const bVal = Number.isFinite(b.minP) ? b.minP : b.maxP ?? 0;
    return aVal - bVal;
  });

  // 3) Construimos las líneas de texto ya ordenadas
  const clean = normalized.map((r) => {
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

  // Si por alguna razón no hay items, pregunta directo sin inventar
  if (!clean.length) {
    return lang === "en"
      ? "To help you, tell me which product or service you’re interested in."
      : "Para ayudarte, dime qué producto o servicio te interesa.";
  }

  // Máx 6 opciones para no saturar el WhatsApp
  return [header, "", ...clean.slice(0, 6), "", footer].join("\n");
}