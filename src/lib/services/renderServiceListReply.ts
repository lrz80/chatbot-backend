// src/lib/services/renderServiceListReply.ts
import type { ServiceListItem } from "./resolveServiceList";

export function renderServiceListReply(args: {
  lang: "es" | "en";
  items: ServiceListItem[];
  maxItems?: number;          // default 8
  includeLinks?: boolean;     // default true (si hay url)
}): string {
  const lang = args.lang;
  const maxItems = Math.min(20, Math.max(1, args.maxItems ?? 8));
  const includeLinks = args.includeLinks !== false;

  const items = (args.items || []).slice(0, maxItems);

  if (!items.length) {
    return lang === "en"
      ? "What are you looking for?"
      : "¿Qué estás buscando?";
  }

  const lines = items.map((s) => {
    const name = s.name;
    const dur = s.duration_min ? (lang === "en" ? `${s.duration_min} min` : `${s.duration_min} min`) : null;
    const parts = [name, dur].filter(Boolean).join(" — ");

    if (includeLinks && s.service_url) return `• ${parts}\n  ${s.service_url}`;
    return `• ${parts}`;
  });

  const header =
    lang === "en" ? "Here are some of our services:" : "Estos son algunos de nuestros servicios:";

  const tail =
    lang === "en"
      ? "Which one are you interested in?"
      : "¿Cuál te interesa?";

  return [header, ...lines, tail].join("\n");
}
