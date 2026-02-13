// src/lib/services/renderServiceListReply.ts
import type { ServiceListItem } from "./resolveServiceList";

type Args = {
  lang: "es" | "en";
  items: ServiceListItem[];
  maxItems: number;

  includeLinks?: boolean; // cuando quieras mostrar urls junto al ítem
  title?: string;

  // ✅ controla el formato
  style?: "bullets" | "plain" | "numbered";

  // ✅ pregunta al final
  askPick?: boolean;

  // ✅ NUEVO: tono del copy (default: conversational)
  tone?: "conversational" | "neutral";

  // ✅ NUEVO: tipo de cierre (default: "pick")
  // pick: que elija uno
  // ask_details: pregunta si quiere precios/detalles
  // none: sin cierre
  closing?: "pick" | "ask_details" | "none";

  // ✅ NUEVO: si truncas por maxItems, puedes avisar
  mentionMore?: boolean;
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
    tone = "conversational",
    closing = "pick",
    mentionMore = true,
  } = args;

  const list = (items || []).filter(Boolean);
  const slice = list.slice(0, Math.max(0, maxItems || 0));

  const hasCustomTitle = Boolean(title && String(title).trim());

  const head =
    (hasCustomTitle ? String(title).trim() : null) ||
    (tone === "neutral"
      ? lang === "en"
        ? "Here are some options:"
        : "Aquí tienes algunas opciones:"
      : lang === "en"
        ? "Sure — these are the options I have for you:"
        : "¡Claro! Estas son las opciones que tengo para ti:");

  const lines = slice
    .map((it, idx) => {
      const name = String(it?.name || "").trim();
      if (!name) return null;

      const link = includeLinks && it.service_url ? String(it.service_url).trim() : "";
      const suffix = link ? (style === "plain" ? ` (${link})` : ` — ${link}`) : "";

      if (style === "numbered") return `${idx + 1}) ${name}${suffix}`;
      if (style === "bullets") return `• ${name}${suffix}`;
      return `${name}${suffix}`;
    })
    .filter(Boolean) as string[];

  const truncated = mentionMore && list.length > slice.length;

  const moreLine =
    truncated
      ? (lang === "en"
          ? "If you tell me what you're looking for, I can narrow it down."
          : "Si me dices qué estás buscando, te lo reduzco a lo más relevante.")
      : "";

  const shouldClose = askPick && closing !== "none";

  const pickLine =
    shouldClose && closing === "pick"
      ? (tone === "neutral"
          ? lang === "en"
            ? "Which one are you interested in?"
            : "¿Cuál te interesa?"
          : lang === "en"
            ? "Which one catches your eye? You can reply with the name (or the number)."
            : "¿Cuál te interesa más? Puedes responder con el nombre (o con el número).")
      : "";

  const detailsLine =
    shouldClose && closing === "ask_details"
      ? (lang === "en"
          ? "Do you want prices, details, or help choosing?"
          : "¿Quieres precios, más detalles o te ayudo a elegir?")
      : "";

  const out: string[] = [head];

  if (lines.length) out.push(...lines);

  if (moreLine) out.push("", moreLine);

  const tail = pickLine || detailsLine;
  if (tail) out.push("", tail);

  return out.join("\n").trim();
}
