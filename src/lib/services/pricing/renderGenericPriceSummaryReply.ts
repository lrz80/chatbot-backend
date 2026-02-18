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

export function renderGenericPriceSummaryReply(args: {
  lang: Lang;
  rows: Row[];
}): string {
  const lang = args.lang === "en" ? "en" : "es";

  const clean = (args.rows || [])
    .filter(r => r?.service_name)
    .map(r => {
      const name = String(r.service_name).trim();
      const minP = r.min_price == null ? NaN : Number(r.min_price);
      const maxP = r.max_price == null ? NaN : Number(r.max_price);

      if (!Number.isFinite(minP) && !Number.isFinite(maxP)) {
        return null;
      }

      // precio fijo
      if (Number.isFinite(minP) && Number.isFinite(maxP) && Math.round(minP) === Math.round(maxP)) {
        return `• ${name}: ${money(minP)}`;
      }

      // rango dentro del servicio (variante) => muestra "desde"
      if (Number.isFinite(minP)) {
        return lang === "en"
          ? `• ${name}: from ${money(minP)}`
          : `• ${name}: desde ${money(minP)}`;
      }

      // fallback raro
      return null;
    })
    .filter(Boolean) as string[];

  const header =
    lang === "en"
      ? "Here are some current prices:"
      : "Aquí tienes algunos precios actuales:";

  const footer =
    lang === "en"
        ? "Which of these options are you interested in? 😊"
        : "¿Cuál de estas opciones te interesa? 😊";

  // Si por alguna razón no hay items, pregunta directo sin inventar
  if (!clean.length) {
    return lang === "en"
      ? "To help you, tell me what product/service you’re interested in."
      : "Para ayudarte, dime qué producto o servicio te interesa.";
  }

  return [header, "", ...clean.slice(0, 6), "", footer].join("\n");
}
