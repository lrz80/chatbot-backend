import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirTexto } from "../../traducirTexto";

export type ServiceMatch = {
  id: string;
  name: string;
  score: number;
};

type Candidate = {
  serviceId: string;
  label: string;
  serviceNameTokens: string[];
  catalogTokens: string[];
};

const FUNCTION_WORDS = new Set([
  // ES
  "de","del","la","el","los","las","un","una","unos","unas",
  "para","por","en","y","o","u","a","que","q","este","esta",
  "ese","esa","esto","eso","le","lo","al","como","con","sin",
  "sobre","mi","tu","su","me","te","se",

  // EN
  "the","a","an","and","or","to","for","in","of","what","does",
  "do","is","are","with","without","about","my","your","their",
  "me","you","it",
]);

// Tokens universales de ATRIBUTO de consulta.
// No son de negocio. Son del lenguaje.
const ATTRIBUTE_TOKENS = new Set([
  // ES pricing
  "precio",
  "precios",
  "cuanto",
  "cuanta",
  "cuánto",
  "cuánta",
  "cuesta",
  "cuestan",
  "vale",
  "valen",
  "costo",
  "costos",
  "mensual",
  "mensuales",
  "mes",
  "meses",
  "mensualidad",
  "desde",

  // EN pricing
  "price",
  "prices",
  "pricing",
  "cost",
  "costs",
  "how",
  "much",
  "monthly",
  "month",
  "months",
  "from",
  "starting",
  "starts",

  // universales de pregunta
  "what",
  "which",
  "quiero",
  "quieres",
  "want",
  "looking",
]);

function normalize(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenize(raw: string): string[] {
  return normalize(raw)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => {
      if (!w) return false;
      if (/^\d+$/.test(w)) return true;
      return w.length >= 2 && !FUNCTION_WORDS.has(w);
    });
}

function buildTenantTokenDf(candidates: Candidate[]): Map<string, number> {
  const df = new Map<string, number>();

  for (const cand of candidates) {
    const seen = new Set(cand.catalogTokens || []);
    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  return df;
}

function scoreTokensWeighted(
  queryTokens: string[],
  candidateTokens: string[],
  dfMap: Map<string, number>,
  totalCandidates: number
): number {
  if (!queryTokens.length || !candidateTokens.length || totalCandidates <= 0) return 0;

  const qSet = new Set(queryTokens);

  let matchedWeight = 0;
  let totalWeight = 0;

  for (const t of candidateTokens) {
    const df = dfMap.get(t) || 1;
    const weight = Math.log(1 + totalCandidates / df);

    totalWeight += weight;
    if (qSet.has(t)) matchedWeight += weight;
  }

  return totalWeight > 0 ? matchedWeight / totalWeight : 0;
}

function countExactHits(queryTokens: string[], candidateTokens: string[]): number {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const qSet = new Set(queryTokens);
  return candidateTokens.filter((t) => qSet.has(t)).length;
}

function pickAnchorTokens(
  queryTokens: string[],
  dfMap: Map<string, number>,
  totalCandidates: number
): string[] {
  if (!queryTokens.length || totalCandidates <= 0) return [];

  const candidates = queryTokens
    .filter((t) => !ATTRIBUTE_TOKENS.has(t))
    .map((token) => {
      const df = dfMap.get(token) || 0;
      if (df <= 0) return null;

      // ignorar términos demasiado comunes del catálogo
      const ratio = df / totalCandidates;
      if (ratio >= 0.8) return null;

      const idf = Math.log(1 + totalCandidates / df);

      return { token, df, ratio, idf };
    })
    .filter(Boolean) as Array<{ token: string; df: number; ratio: number; idf: number }>;

  if (!candidates.length) return [];

  candidates.sort((a, b) => b.idf - a.idf);

  // Tomamos hasta 2 anchors por si la consulta trae algo como:
  // "gold cycling" / "small deluxe" / etc.
  return candidates.slice(0, 2).map((x) => x.token);
}

export async function resolveServiceMatchesFromText(
  pool: Pool,
  tenantId: string,
  userText: string,
  opts?: {
    minScore?: number;
    maxResults?: number;
    relativeWindow?: number;
  }
): Promise<ServiceMatch[]> {
  const minScore = opts?.minScore ?? 0.3;
  const maxResults = opts?.maxResults ?? 5;
  const relativeWindow = opts?.relativeWindow ?? 0.16;

  const t = String(userText || "").trim();
  if (!t) return [];

  let idioma: "es" | "en" | string = "es";
  try {
    idioma = (await detectarIdioma(t)) as any;
  } catch {
    idioma = "es";
  }

  const tNorm = normalize(t);
  let tAlt = "";

  try {
    if (idioma === "es") {
      tAlt = normalize(await traducirTexto(t, "en"));
    } else if (idioma === "en") {
      tAlt = normalize(await traducirTexto(t, "es"));
    }
  } catch {
    tAlt = "";
  }

  const qTokens1 = tokenize(tNorm);
  const qTokens2 = tAlt ? tokenize(tAlt) : [];
  const queryTokens = Array.from(new Set([...qTokens1, ...qTokens2]));

  if (!queryTokens.length) {
    console.log("[RESOLVE-SERVICE-MATCHES] sin tokens útiles, devolviendo []");
    return [];
  }

  const { rows } = await pool.query<{
    service_id: string;
    service_name: string | null;
    service_description: string | null;
    variant_name: string | null;
    variant_description: string | null;
  }>(
    `
    SELECT
      s.id AS service_id,
      s.name AS service_name,
      s.description AS service_description,
      v.variant_name,
      v.description AS variant_description
    FROM services s
    LEFT JOIN service_variants v
      ON v.service_id = s.id
     AND v.active = true
    WHERE
      s.tenant_id = $1
      AND s.active = true
      AND s.name IS NOT NULL
    ORDER BY s.created_at ASC, v.created_at ASC NULLS LAST, v.id ASC NULLS LAST
    `,
    [tenantId]
  );

  if (!rows.length) {
    console.log("[RESOLVE-SERVICE-MATCHES] sin candidatos en DB, devolviendo []");
    return [];
  }

  const grouped = new Map<
    string,
    {
      serviceId: string;
      serviceLabel: string | null;
      serviceNameTokenSet: Set<string>;
      catalogTokenSet: Set<string>;
    }
  >();

  for (const r of rows) {
    const serviceId = String(r.service_id || "");
    const serviceName = String(r.service_name || "").trim();
    if (!serviceId || !serviceName) continue;

    let entry = grouped.get(serviceId);
    if (!entry) {
      entry = {
        serviceId,
        serviceLabel: serviceName,
        serviceNameTokenSet: new Set<string>(),
        catalogTokenSet: new Set<string>(),
      };
      grouped.set(serviceId, entry);
    }

    const serviceNameTokens = tokenize(serviceName);
    const serviceDescTokens = tokenize(String(r.service_description || ""));
    const variantNameTokens = tokenize(String(r.variant_name || ""));
    const variantDescTokens = tokenize(String(r.variant_description || ""));

    for (const tk of serviceNameTokens) entry.serviceNameTokenSet.add(tk);
    for (const tk of serviceNameTokens) entry.catalogTokenSet.add(tk);
    for (const tk of serviceDescTokens) entry.catalogTokenSet.add(tk);
    for (const tk of variantNameTokens) entry.catalogTokenSet.add(tk);
    for (const tk of variantDescTokens) entry.catalogTokenSet.add(tk);
  }

  const candidates: Candidate[] = Array.from(grouped.values()).map((g) => ({
    serviceId: g.serviceId,
    label: g.serviceLabel || "",
    serviceNameTokens: Array.from(g.serviceNameTokenSet),
    catalogTokens: Array.from(g.catalogTokenSet),
  }));

  if (!candidates.length) return [];

  const dfMap = buildTenantTokenDf(candidates);
  const totalCandidates = candidates.length;
  const anchorTokens = pickAnchorTokens(queryTokens, dfMap, totalCandidates);

  const scored = candidates
    .map((cand) => {
      const nameScore = scoreTokensWeighted(
        queryTokens,
        cand.serviceNameTokens,
        dfMap,
        totalCandidates
      );

      const catalogScore = scoreTokensWeighted(
        queryTokens,
        cand.catalogTokens,
        dfMap,
        totalCandidates
      );

      const exactNameHits = countExactHits(queryTokens, cand.serviceNameTokens);
      const exactCatalogHits = countExactHits(queryTokens, cand.catalogTokens);
      const anchorHits = anchorTokens.length
        ? countExactHits(anchorTokens, cand.catalogTokens)
        : 0;

      let score = 0;
      score += nameScore * 0.50;
      score += catalogScore * 0.50;
      score += exactNameHits * 0.18;
      score += exactCatalogHits * 0.10;
      score += anchorHits * 0.45;

      // si hay anchors y el candidato no contiene ninguno, penalizar fuerte
      if (anchorTokens.length > 0 && anchorHits === 0) {
        score -= 0.60;
      }

      return {
        id: cand.serviceId,
        name: cand.label,
        score,
        anchorHits,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < minScore) {
    console.log("[RESOLVE-SERVICE-MATCHES] best por debajo de threshold", {
      userText,
      queryTokens,
      anchorTokens,
      best: best ? { name: best.name, score: best.score } : null,
      minScore,
    });
    return [];
  }

  const matches = scored
    .filter((x) => x.score >= minScore)
    .filter((x) => best.score - x.score <= relativeWindow)
    .filter((x) => {
      if (!anchorTokens.length) return true;
      return x.anchorHits > 0;
    })
    .slice(0, maxResults)
    .map((x) => ({
      id: x.id,
      name: x.name,
      score: x.score,
    }));

  console.log("[RESOLVE-SERVICE-MATCHES] debug", {
    userText,
    idioma,
    queryTokens,
    anchorTokens,
    best: best ? { name: best.name, score: best.score } : null,
    matches,
  });

  return matches;
}