import type { Lang } from "../../channels/engine/clients/clientDb";
import { normalizeVariantLabel } from "./normalizeVariantLabel";

type PriceOption = { label: string; amount: number; currency: string };

function formatMoney(amount: number, currency: string) {
  const a = Math.round(Number(amount) || 0);
  const c = String(currency || "USD").toUpperCase();
  if (c === "USD") return `$${a}`;
  return `${a} ${c}`;
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
  const money = formatMoney(args.amount, args.currency);

  const name =
    args.serviceName && String(args.serviceName).trim()
      ? String(args.serviceName).trim()
      : null;

  const hasOptions = Array.isArray(args.options) && args.options.length > 0;

  const fmtLine = (o: PriceOption) => {
    const m = formatMoney(o.amount, o.currency || args.currency);
    const label = normalizeVariantLabel(String(o.label || "").trim(), args.lang);
    return `• ${label}: ${m}`;
  };

  // FIXED (services.price_base)
  if (args.mode === "fixed") {
    if (args.lang === "en") {
      return name ? `${name}: ${money}` : `Price: ${money}`;
    }
    return name ? `${name}: ${money}` : `El precio es ${money}`;
  }

  // FROM (service_variants.price)
  if (args.lang === "en") {
    if (hasOptions) {
      const header = name ? `${name} — starts at ${money}` : `Starts at ${money}`;
      const list = args.options!.map(fmtLine).join("\n");
      const more =
        typeof args.optionsCount === "number" && args.optionsCount > args.options!.length
          ? `\n…plus ${args.optionsCount - args.options!.length} more option(s).`
          : "";
      return `${header}\n\nOptions:\n${list}${more}\n\nWhich option are you interested in?`;
    }
    return name ? `${name} — starts at ${money}` : `Starts at ${money}`;
  }

  // ES
  if (hasOptions) {
    const header = name ? `${name} — desde ${money}` : `Desde ${money}`;
    const list = args.options!.map(fmtLine).join("\n");
    const more =
      typeof args.optionsCount === "number" && args.optionsCount > args.options!.length
        ? `\n…y ${args.optionsCount - args.options!.length} opción(es) más.`
        : "";
    return `${header}\n\nOpciones:\n${list}${more}\n\n¿Cuál opción te interesa?`;
  }

  return name ? `${name} — desde ${money}` : `Desde ${money}`;
}
