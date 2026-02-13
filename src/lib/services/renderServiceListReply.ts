// src/lib/services/renderServiceListReply.ts
import type { ServiceListItem } from "./resolveServiceList";

type Args = {
  lang: "es" | "en";
  items: ServiceListItem[];
  maxItems: number;

  includeLinks?: boolean; // cuando quieras mostrar urls junto al ítem
  title?: string;

  // ✅ NUEVO: controla el formato (por defecto bullets)
  style?: "bullets" | "plain";

  // ✅ NUEVO: pregunta corta al final (por defecto true)
  askPick?: boolean;

  // ✅ NUEVO: si quieres NO poner pregunta al final
  // (por ejemplo, cuando vas a mandar link directo)
};

export function renderServiceListReply(args: Args) {
  const {
    lang,
    items,
    maxItems,
    includeLinks = false,
    title,
    style = "bullets",
    askPick = true,
  } = args;

  const head =
    (title && String(title).trim()) ||
    (lang === "en" ? "Here are some options:" : "Aquí tienes algunas opciones:");

  const list = (items || []).slice(0, maxItems);

  const lines = list
    .map((it) => {
      const name = String(it?.name || "").trim();
      if (!name) return null;

      const link = includeLinks && it.service_url ? ` — ${it.service_url}` : "";
      if (style === "bullets") return `• ${name}${link}`;
      return `${name}${link}`;
    })
    .filter(Boolean) as string[];

  const pickLine = askPick
    ? (lang === "en" ? "Which one are you interested in?" : "¿Cuál te interesa?")
    : "";

  // Construcción final
  const out = [head, ...lines];

  if (pickLine) {
    out.push("", pickLine);
  }

  return out.join("\n").trim();
}
