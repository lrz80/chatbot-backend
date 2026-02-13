// src/lib/services/pricing/renderPriceReply.ts
import type { Lang } from "../../channels/engine/clients/clientDb";
import { normalizeVariantLabel } from "./normalizeVariantLabel";

type PriceOption = { label: string; amount: number; currency: string };

function formatMoney(amount: number, currency: string) {
  const a = Math.round(Number(amount) || 0);
  const c = String(currency || "USD").toUpperCase();
  if (c === "USD") return `$${a}`;
  return `${a} ${c}`;
}

function formatPrice(amount: number, currency: string, lang: Lang) {
  const n = Number(amount) || 0;
  if (n <= 0) return lang === "en" ? "Free" : "Gratis";
  return formatMoney(n, currency);
}

export function renderPriceReply(args: {
  lang: Lang;
  mode: "fixed" | "from";
  amount: number;
  currency: string;
  serviceName?: string | null;
  options?: PriceOption[];
  optionsCount?: number;
}) {
  const name =
    args.serviceName && String(args.serviceName).trim()
      ? String(args.serviceName).trim()
      : null;

  const money = formatPrice(args.amount, args.currency, args.lang);

  const hasOptions = Array.isArray(args.options) && args.options.length > 0;

  const fmtLine = (o: PriceOption) => {
    const m = formatPrice(o.amount, o.currency || args.currency, args.lang);
    const label = normalizeVariantLabel(String(o.label || "").trim(), args.lang);
    return `• ${label}: ${m}`;
  };

  // FIXED (services.price_base)
  if (args.mode === "fixed") {
    if (args.lang === "en") {
      return name ? `${name}: ${money}` : `Price: ${money}`;
    }
    return name ? `${name}: ${money}` : `Precio: ${money}`;
  }

  // FROM (variants / ranges)
  if (args.lang === "en") {
    if (hasOptions) {
      const header = name ? `${name} — starts at ${money}` : `Starts at ${money}`;
      const list = args.options!.map(fmtLine).join("\n");

      const more =
        typeof args.optionsCount === "number" && args.optionsCount > args.options!.length
          ? `\n…plus ${args.optionsCount - args.options!.length} more option(s).`
          : "";

      return `${header}\n${list}${more}\n\nWhich option are you interested in?`;
    }

    return name
      ? `${name} — starts at ${money}\n\nWhich option are you interested in?`
      : `Starts at ${money}\n\nWhich option are you interested in?`;
  }

  // ES
  if (hasOptions) {
    const header = name ? `${name} — desde ${money}` : `Desde ${money}`;
    const list = args.options!.map(fmtLine).join("\n");

    const more =
      typeof args.optionsCount === "number" && args.optionsCount > args.options!.length
        ? `\n…y ${args.optionsCount - args.options!.length} opción(es) más.`
        : "";

    return `${header}\n${list}${more}\n\n¿Cuál opción te interesa?`;
  }

  return name
    ? `${name} — desde ${money}\n\n¿Cuál opción te interesa?`
    : `Desde ${money}\n\n¿Cuál opción te interesa?`;
}
