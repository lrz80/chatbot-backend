export function looksLikeVariantPick(text: string) {
  const t = String(text || "").trim().toLowerCase();

  // Respuestas cortas típicas ("small", "pequeño", "20 lbs", "up to 20")
  const short = t.length <= 24;

  const hasWeight = /\b\d{1,3}\s*(lb|lbs|pounds|kg|kgs)\b/.test(t);
  const upTo = /\b(up\s*to|hasta)\b/.test(t);

  // Tamaños universales (ES/EN) — no depende del negocio
  const sizeWord =
    /\b(small|sm|medium|md|large|lg|xl|xxl|pequeñ[oa]|pequeno|mediano|grande)\b/.test(t);

  return short && (sizeWord || hasWeight || upTo);
}
