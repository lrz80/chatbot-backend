export function normalize(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard simple por tokens */
export function jaccard(a: string, b: string): number {
  const A = new Set(normalize(a).split(" ").filter(Boolean));
  const B = new Set(normalize(b).split(" ").filter(Boolean));
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size || 1;
  return inter / union;
}

/** Devuelve mejor patrón ≥ umbral */
export function bestPatternScore(userMsg: string, patrones: string[], umbral = 0.55) {
  let best = { score: 0, pattern: "" };
  for (const p of (patrones || [])) {
    const s = jaccard(userMsg, p);
    if (s > best.score) best = { score: s, pattern: p };
  }
  return best.score >= umbral ? best : null;
}
