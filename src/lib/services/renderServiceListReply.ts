// src/lib/services/renderServiceListReply.ts
import type { ServiceListItem } from "./resolveServiceList";

export function renderServiceListReply(args: {
  lang: "es" | "en";
  items: ServiceListItem[];
  maxItems: number;
  includeLinks?: boolean; // ✅ NUEVO
  title?: string;         // ✅ opcional
}) {
  const { lang, items, maxItems, includeLinks = false, title } = args;

  const head =
    title ??
    (lang === "en" ? "Here are some options:" : "Aquí tienes algunas opciones:");

  const lines = items.slice(0, maxItems).map((it, i) => {
    // ✅ sin links por defecto
    return `${i + 1}) ${it.name}`;
  });

  const tail =
    lang === "en"
      ? "Reply with the number or the name you want."
      : "Responde con el número o con el nombre del que te interesa.";

  // Si includeLinks = true, puedes agregar otra sección aparte (solo cuando ya eligió)
  if (includeLinks) {
    const linkLines = items
      .slice(0, maxItems)
      .filter((it) => it.service_url)
      .map((it) => `• ${it.name}: ${it.service_url}`);

    return `${head}\n${lines.join("\n")}\n\n${tail}\n\n${linkLines.join("\n")}`.trim();
  }

  return `${head}\n${lines.join("\n")}\n\n${tail}`.trim();
}
