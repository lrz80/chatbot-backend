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
  entityTokens: string[];   // service_name + variant_name
  catalogTokens: string[];  // entity + descriptions
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

const GENERIC_CATALOG_TOKENS = new Set([
  // ES
  "clase", "clases",
  "plan", "planes",
  "paquete", "paquetes",
  "pase", "pases",
  "servicio", "servicios",
  "programa", "programas",
  "membresia", "membresias",
  "membresía", "membresías",

  // EN
  "class", "classes",
  "plan", "plans",
  "package", "packages",
  "pass", "passes",
  "service", "services",
  "program", "programs",
  "membership", "memberships",
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

function buildEntityTokenDf(candidates: Candidate[]): Map<string, number> {
  const df = new Map<string, number>();

  for (const cand of candidates) {
    const seen = new Set(cand.entityTokens || []);
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
  entityDfMap: Map<string, number>,
  catalogDfMap: Map<string, number>,
  totalCandidates: number
): string[] {
  if (!queryTokens.length || totalCandidates <= 0) return [];

  const usable = queryTokens.filter((t) => !ATTRIBUTE_TOKENS.has(t));
  if (!usable.length) return [];

  // ===============================
  // 1) PRIORIDAD TOTAL: tokens respaldados por ENTITY
  // ===============================
  const entityBacked = usable
    .map((token) => {
      const entityDf = entityDfMap.get(token) || 0;
      if (entityDf <= 0) return null;

      const catalogDf = catalogDfMap.get(token) || entityDf;
      const isGenericCatalog = GENERIC_CATALOG_TOKENS.has(token);

      return {
        token,
        entityDf,
        catalogDf,
        isGenericCatalog,
      };
    })
    .filter(Boolean) as Array<{
      token: string;
      entityDf: number;
      catalogDf: number;
      isGenericCatalog: boolean;
    }>;

  if (entityBacked.length > 0) {
    entityBacked.sort((a, b) => {
      // 1) no genérico gana
      if (a.isGenericCatalog !== b.isGenericCatalog) {
        return a.isGenericCatalog ? 1 : -1;
      }

      // 2) menor DF en entity gana
      if (a.entityDf !== b.entityDf) {
        return a.entityDf - b.entityDf;
      }

      // 3) menor DF en catálogo gana
      if (a.catalogDf !== b.catalogDf) {
        return a.catalogDf - b.catalogDf;
      }

      // 4) token más largo como desempate
      return b.token.length - a.token.length;
    });

    return entityBacked.slice(0, 2).map((x) => x.token);
  }

  // ===============================
  // 2) FALLBACK: catálogo
  // Solo si no hubo ningún token de entidad
  // ===============================
  const catalogBacked = usable
    .map((token) => {
      const catalogDf = catalogDfMap.get(token) || 0;
      if (catalogDf <= 0) return null;

      const isGenericCatalog = GENERIC_CATALOG_TOKENS.has(token);

      return {
        token,
        catalogDf,
        isGenericCatalog,
      };
    })
    .filter(Boolean) as Array<{
      token: string;
      catalogDf: number;
      isGenericCatalog: boolean;
    }>;

  if (!catalogBacked.length) return [];

  catalogBacked.sort((a, b) => {
    if (a.isGenericCatalog !== b.isGenericCatalog) {
      return a.isGenericCatalog ? 1 : -1;
    }

    if (a.catalogDf !== b.catalogDf) {
      return a.catalogDf - b.catalogDf;
    }

    return b.token.length - a.token.length;
  });

  return catalogBacked.slice(0, 2).map((x) => x.token);
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
        entityTokenSet: Set<string>;
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
        entityTokenSet: new Set<string>(),
        catalogTokenSet: new Set<string>(),
      };
      grouped.set(serviceId, entry);
    }

    const serviceNameTokens = tokenize(serviceName);
    const serviceDescTokens = tokenize(String(r.service_description || ""));
    const variantNameTokens = tokenize(String(r.variant_name || ""));
    const variantDescTokens = tokenize(String(r.variant_description || ""));

    // entity = lo que nombra la oferta
    for (const tk of serviceNameTokens) entry.entityTokenSet.add(tk);
    for (const tk of variantNameTokens) entry.entityTokenSet.add(tk);

    // catalog = todo el universo textual
    for (const tk of serviceNameTokens) entry.catalogTokenSet.add(tk);
    for (const tk of serviceDescTokens) entry.catalogTokenSet.add(tk);
    for (const tk of variantNameTokens) entry.catalogTokenSet.add(tk);
    for (const tk of variantDescTokens) entry.catalogTokenSet.add(tk);
  }

  const candidates: Candidate[] = Array.from(grouped.values()).map((g) => ({
    serviceId: g.serviceId,
    label: g.serviceLabel || "",
    entityTokens: Array.from(g.entityTokenSet),
    catalogTokens: Array.from(g.catalogTokenSet),
  }));

  if (!candidates.length) return [];

  const catalogDfMap = buildTenantTokenDf(candidates);
  const entityDfMap = buildEntityTokenDf(candidates);
  const totalCandidates = candidates.length;
  const anchorTokens = pickAnchorTokens(
    queryTokens,
    entityDfMap,
    catalogDfMap,
    totalCandidates
  );

  const scored = candidates
    .map((cand) => {
      const entityScore = scoreTokensWeighted(
        queryTokens,
        cand.entityTokens,
        entityDfMap,
        totalCandidates
      );

      const catalogScore = scoreTokensWeighted(
        queryTokens,
        cand.catalogTokens,
        catalogDfMap,
        totalCandidates
      );

      const exactEntityHits = countExactHits(queryTokens, cand.entityTokens);
      const exactCatalogHits = countExactHits(queryTokens, cand.catalogTokens);

      const anchorHits = anchorTokens.length
        ? countExactHits(anchorTokens, cand.entityTokens)
        : 0;

      const nonGenericQueryTokens = queryTokens.filter(
        (t) => !ATTRIBUTE_TOKENS.has(t) && !GENERIC_CATALOG_TOKENS.has(t)
      );
      const discriminativeHits = countExactHits(nonGenericQueryTokens, cand.entityTokens);

      let score = 0;
      score += entityScore * 0.65;
      score += catalogScore * 0.35;
      score += exactEntityHits * 0.22;
      score += exactCatalogHits * 0.06;
      score += anchorHits * 0.30;
      score += discriminativeHits * 0.42;

      if (anchorTokens.length > 0 && anchorHits === 0) {
        score -= 0.28;
      }

      return {
        id: cand.serviceId,
        name: cand.label,
        score,
        anchorHits,
        exactEntityHits,
        exactCatalogHits,
        discriminativeHits,
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

    const eligible = scored.filter((x) => x.score >= minScore);

    const discriminativeFirst = eligible.filter((x) => x.discriminativeHits > 0);
    const remaining = eligible.filter((x) => x.discriminativeHits <= 0);

    const merged = [...discriminativeFirst, ...remaining];

    const seen = new Set<string>();
    const deduped = merged.filter((x) => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return true;
    });

    const relaxedWindow =
      discriminativeFirst.length > 0
        ? Math.max(relativeWindow, 0.5)
        : relativeWindow;

    let matches = deduped
      .filter((x) => best.score - x.score <= relaxedWindow)
      .slice(0, Math.min(maxResults, 4))
      .map((x) => ({
        id: x.id,
        name: x.name,
        score: x.score,
    }));

    // Garantizar que los matches con token discriminante entren si existen
    const mustInclude = eligible.filter((x) => x.discriminativeHits > 0);
    const matchMap = new Map(matches.map((m) => [m.id, m]));

    for (const item of mustInclude) {
      if (!matchMap.has(item.id)) {
        matchMap.set(item.id, {
          id: item.id,
          name: item.name,
          score: item.score,
        });
      }
    }

    matches = Array.from(matchMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(maxResults, 4));

    console.log("[RESOLVE-SERVICE-MATCHES] debug", {
      userText,
      idioma,
      queryTokens,
      anchorTokens,
      scored: scored.slice(0, 8).map((x) => ({
        id: x.id,
        name: x.name,
        score: x.score,
        anchorHits: x.anchorHits,
        exactEntityHits: x.exactEntityHits,
        exactCatalogHits: x.exactCatalogHits,
        discriminativeHits: x.discriminativeHits,
      })),
      matches,
    });

    return matches;
}