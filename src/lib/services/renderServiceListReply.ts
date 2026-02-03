import type { ServiceListItem } from "./resolveServiceList";

function money(n: number, currency: string) {
  // simple, sin Intl para no depender de locale
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `${currency} ${v.toFixed(0)}`;
}

export function renderServiceListReply(items: ServiceListItem[], idioma: "es"|"en"): string {
  const currency = "USD"; // por ahora fijo; tu DB no tiene currency en services
  const top = items.slice(0, 8);

  const header =
    idioma === "en"
      ? "Here are our services:"
      : "Estos son nuestros servicios:";

  const lines: string[] = [];

  for (const s of top) {
    const basePrice = (typeof s.price_base === "number") ? money(s.price_base, currency) : null;
    const baseDur = (typeof s.duration_min === "number") ? `${s.duration_min} min` : null;

    // línea principal
    let main = `• ${s.name}`;
    const meta = [basePrice, baseDur].filter(Boolean).join(" · ");
    if (meta) main += ` — ${meta}`;
    lines.push(main);

    // variantes (máx 3) con indent
    for (const v of (s.variants || []).slice(0, 3)) {
      const vp = (typeof v.price === "number") ? money(v.price, currency) : null;
      const vd = (typeof v.duration_min === "number") ? `${v.duration_min} min` : null;
      const vmeta = [vp, vd].filter(Boolean).join(" · ");
      lines.push(`  - ${v.variant_name}${vmeta ? ` — ${vmeta}` : ""}`);
    }
  }

  const footer =
    idioma === "en"
      ? "If you tell me the service name, I can share price, duration, and what it includes."
      : "Si me dices el nombre del servicio, te digo precio, duración y qué incluye.";

  return [header, ...lines, "", footer].join("\n");
}
