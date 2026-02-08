import type { CatalogNeed, Lang } from "./types";

export function detectCatalogNeed(textRaw: string, lang: Lang): CatalogNeed | null {
  const t = String(textRaw || "").toLowerCase();

  // universal ES/EN (sin hardcode por negocio)
  const wantsPrice =
    /\b(precio|precios|cuesta|cost|price|pricing|how much)\b/.test(t);

  const wantsIncludes =
    /\b(que incluye|qué incluye|incluye|includes|what's included|what is included)\b/.test(t);

  const wantsDuration =
    /\b(dura|duracion|duración|duration|how long|minutes|minutos)\b/.test(t);

  const wantsLink =
    /\b(link|enlace|url|booking link|reservar|reserva|agendar|book|booking|schedule)\b/.test(t);

  const wantsList =
    /\b(lista|menu|menú|catalogo|catálogo|servicios|services|productos|products)\b/.test(t);

  if (wantsPrice) return "price";
  if (wantsIncludes) return "includes";
  if (wantsDuration) return "duration";
  if (wantsLink) return "link";
  if (wantsList) return "list";

  // “any” si parece catálogo pero no cae en categoría (ej: “info de deluxe bath”)
  const looksCatalog =
    /\b(servicio|service|producto|product|paquete|package|bath|groom|trim|membership|plan)\b/.test(t);

  if (looksCatalog) return "any";
  return null;
}
