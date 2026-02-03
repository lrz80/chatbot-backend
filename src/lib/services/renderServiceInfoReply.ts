import type { ResolvedServiceInfo } from "./resolveServiceInfo";
import type { ServiceInfoNeed } from "./wantsServiceInfo";

function fmtMoney(n: number, currency: string | null) {
  const cur = (currency || "USD").toUpperCase();
  // simple; si quieres, luego lo hacemos con Intl.NumberFormat
  return `$${n.toFixed(2)} ${cur}`;
}

export function renderServiceInfoReply(
  r: Extract<ResolvedServiceInfo, { ok: true }>,
  need: ServiceInfoNeed,
  idioma: "es" | "en"
): string {
  const parts: string[] = [];

  const title = r.label;
  const priceTxt =
    r.price !== null ? fmtMoney(r.price, r.currency) : null;

  const durTxt =
    r.duration_min !== null ? `${r.duration_min} min` : null;

  const desc =
    r.description && r.description.trim() ? r.description.trim() : null;

  if (idioma === "en") {
    if (need === "price") {
      return priceTxt
        ? `${title} is ${priceTxt}.`
        : `I don't have a price saved for ${title} yet.`;
    }
    if (need === "duration") {
      return durTxt
        ? `${title} takes about ${durTxt}.`
        : `I don't have a duration saved for ${title} yet.`;
    }
    if (need === "includes") {
      return desc
        ? `${title} includes: ${desc}`
        : `I don't have details saved for ${title} yet.`;
    }

    // any
    if (priceTxt) parts.push(`Price: ${priceTxt}`);
    if (durTxt) parts.push(`Duration: ${durTxt}`);
    if (desc) parts.push(`Includes: ${desc}`);
    return parts.length ? `${title}\n${parts.join("\n")}` : `${title}`;
  }

  // ES
  if (need === "price") {
    return priceTxt
      ? `El ${title} cuesta ${priceTxt}.`
      : `Todavía no tengo un precio guardado para ${title}.`;
  }
  if (need === "duration") {
    return durTxt
      ? `${title} dura aprox. ${durTxt}.`
      : `Todavía no tengo la duración guardada para ${title}.`;
  }
  if (need === "includes") {
    return desc
      ? `${title} incluye: ${desc}`
      : `Todavía no tengo la descripción guardada para ${title}.`;
  }

  if (priceTxt) parts.push(`Precio: ${priceTxt}`);
  if (durTxt) parts.push(`Duración: ${durTxt}`);
  if (desc) parts.push(`Incluye: ${desc}`);
  return parts.length ? `${title}\n${parts.join("\n")}` : `${title}`;
}
