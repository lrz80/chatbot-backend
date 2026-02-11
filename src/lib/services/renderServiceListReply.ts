import type { ServiceListItem } from "./resolveServiceList";

type Lang = "es" | "en";

function fmtMoney(amount: number, currency?: string | null) {
  const v = Number(amount);
  if (!Number.isFinite(v)) return null;

  // ✅ si no tienes currency en DB, NO inventes códigos raros
  // usa $ por defecto SOLO si currency es USD o no existe.
  const cur = (currency || "USD").toUpperCase();
  if (cur === "USD") return `$${Math.round(v)}`;

  // fallback genérico (mejor: guardar currency por tenant)
  return `${cur} ${Math.round(v)}`;
}

export function renderServiceListReply(args: {
  items: ServiceListItem[];
  lang: Lang;
  max?: number;              // default 6 (para "qué servicios ofrecen")
  numbered?: boolean;        // default false (bullets)
  includeMeta?: boolean;     // default false (NO precio/duración por defecto)
  currency?: string | null;  // pásalo desde tenant/config si lo tienes
  includeVariants?: boolean; // default false (solo cuando convenga)
  maxVariants?: number;      // default 2
}): string {
  const lang = args.lang || "es";
  const max = Number.isFinite(args.max as any) ? (args.max as number) : 6;
  const numbered = args.numbered === true; // default false (bullets)
  const includeMeta = args.includeMeta === true; // default false
  const includeVariants = args.includeVariants === true; // default false
  const maxVariants = Number.isFinite(args.maxVariants as any) ? (args.maxVariants as number) : 2;

  const items = Array.isArray(args.items) ? args.items.slice(0, max) : [];
  if (!items.length) {
    return lang === "en"
      ? "I can help—what service or product are you looking for?"
      : "Puedo ayudarte—¿qué servicio o producto estás buscando?";
  }

  const header =
    lang === "en"
      ? "Here are some of our services:"
      : "Estos son algunos de nuestros servicios:";

  const footer =
    lang === "en"
      ? "If you tell me which one you’re interested in, I’ll help you with details."
      : "Si deseas información de algún servicio en específico, dime cuál y te ayudo.";

  const lines: string[] = [];

  items.forEach((s, idx) => {
    const name = String(s.name || "").trim();
    if (!name) return;

    const prefix = numbered ? `${idx + 1}) ` : "• ";
    let line = `${prefix}${name}`;

    if (includeMeta) {
      const p = (typeof (s as any).price_base === "number")
        ? fmtMoney((s as any).price_base, args.currency)
        : null;

      const d = (typeof (s as any).duration_min === "number")
        ? `${Math.round((s as any).duration_min)} min`
        : null;

      const meta = [p, d].filter(Boolean).join(" · ");
      if (meta) line += ` — ${meta}`;
    }

    lines.push(line);

    // Variants SOLO si lo pides (para no spamear)
    if (includeVariants && Array.isArray((s as any).variants) && (s as any).variants.length) {
      for (const v of (s as any).variants.slice(0, maxVariants)) {
        const vName = String(v?.variant_name || "").trim();
        if (!vName) continue;

        let vLine = `   - ${vName}`;

        if (includeMeta) {
          const vp = (typeof v?.price === "number") ? fmtMoney(v.price, args.currency) : null;
          const vd = (typeof v?.duration_min === "number") ? `${Math.round(v.duration_min)} min` : null;
          const vMeta = [vp, vd].filter(Boolean).join(" · ");
          if (vMeta) vLine += ` — ${vMeta}`;
        }

        lines.push(vLine);
      }
    }
  });

  return `${header}\n${lines.join("\n")}\n\n${footer}`;
}
