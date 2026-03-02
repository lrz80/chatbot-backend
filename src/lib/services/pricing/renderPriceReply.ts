// src/lib/services/pricing/renderPriceReply.ts
import type { Lang } from "../../channels/engine/clients/clientDb";
import { normalizeVariantLabel } from "./normalizeVariantLabel";

type PriceOption = { label: string; amount: number; currency: string };

function formatMoney(amount: number, currency: string) {
  const n = Number(amount) || 0;

  // ✅ Mantener 2 decimales pero sin .00 cuando es entero
  const rounded = Math.round(n * 100) / 100;
  let s = rounded.toFixed(2).replace(/\.00$/, "");

  const c = String(currency || "USD").toUpperCase();
  if (c === "USD") return `$${s}`;
  return `${s} ${c}`;
}

function formatPrice(amount: number, currency: string, lang: Lang) {
  const n = Number(amount) || 0;
  if (n <= 0) return lang === "en" ? "Free" : "Gratis";
  return formatMoney(n, currency);
}

function isFreeLabel(m: string) {
  const s = String(m || "").trim().toLowerCase();
  return s === "free" || s === "gratis";
}

function opener(lang: Lang) {
  return lang === "en" ? "Sure! 😊" : "¡Claro! 😊";
}

function fixedLine(name: string | null, money: string, lang: Lang) {
  const free = isFreeLabel(money);

  if (lang === "en") {
    if (name) return free ? `${name} is free.` : `${name} is ${money}.`;
    return free ? `It’s free.` : `It’s ${money}.`;
  }

  // ES
  if (name) return free ? `${name} es gratis.` : `${name} cuesta ${money}.`;
  return free ? `Es gratis.` : `Cuesta ${money}.`;
}

function fromHeader(name: string | null, money: string, lang: Lang) {
  const free = isFreeLabel(money);

  if (lang === "en") {
    if (name) return free ? `${name} has free options.` : `${name} starts at ${money}.`;
    return free ? `There are free options.` : `Starting at ${money}.`;
  }

  // ES
  if (name) return free ? `${name} tiene opciones gratis.` : `${name} empieza desde ${money}.`;
  return free ? `Hay opciones gratis.` : `Desde ${money}.`;
}

function moreLine(extra: number, lang: Lang) {
  if (extra <= 0) return "";
  return lang === "en"
    ? `\n…plus ${extra} more option(s).`
    : `\n…y ${extra} opción(es) más.`;
}

function questionLine(lang: Lang) {
  return lang === "en"
    ? "Which one would you like—or tell me what you need and I’ll point you to the best option."
    : "¿Cuál te interesa—o cuéntame qué necesitas y te recomiendo la mejor opción?";
}

function linkLine(url: string | null | undefined, lang: Lang) {
  const u = String(url || "").trim();
  if (!u) return "";
  return lang === "en" ? `\n\nHere’s the link:\n${u}` : `\n\nAquí está el link:\n${u}`;
}

export function renderPriceReply(args: {
  lang: Lang;
  mode: "fixed" | "from";
  amount: number;
  currency: string;
  serviceName?: string | null;
  options?: PriceOption[];
  optionsCount?: number;
  url?: string | null; // ✅ link hacia el servicio/plan
}) {
  const name =
    args.serviceName && String(args.serviceName).trim()
      ? String(args.serviceName).trim()
      : null;

  const money = formatPrice(args.amount, args.currency, args.lang);

  const hasOptions = Array.isArray(args.options) && args.options.length > 0;

  // ✅ Siempre ordenamos las opciones de menor a mayor
  const sortedOptions: PriceOption[] = hasOptions
    ? [...(args.options as PriceOption[])].sort(
        (a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0)
      )
    : [];

  const fmtLine = (o: PriceOption) => {
    const m = formatPrice(o.amount, o.currency || args.currency, args.lang);
    const label = normalizeVariantLabel(String(o.label || "").trim(), args.lang);
    return `• ${label}: ${m}`;
  };

  // 🔹 Precio simple (services.price_base)
  if (args.mode === "fixed") {
    return `${opener(args.lang)}\n${fixedLine(name, money, args.lang)}${linkLine(
      args.url,
      args.lang
    )}`;
  }

  // 🔹 Variantes / rangos (FROM)
  if (hasOptions) {
    const header = fromHeader(name, money, args.lang);
    const list = sortedOptions.map(fmtLine).join("\n");

    const extra =
      typeof args.optionsCount === "number"
        ? Math.max(0, args.optionsCount - sortedOptions.length)
        : 0;

    const more = moreLine(extra, args.lang);

    return `${opener(args.lang)}\n${header}\n${list}${more}\n\n${questionLine(
      args.lang
    )}${linkLine(args.url, args.lang)}`;
  }

  // 🔹 Sin lista de opciones: fallback humano
  return `${opener(args.lang)}\n${fromHeader(name, money, args.lang)}\n\n${questionLine(
    args.lang
  )}${linkLine(args.url, args.lang)}`;
}