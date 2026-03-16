//src/lib/services/pricing/resolveServiceIdFromText.ts
import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirTexto } from "../../traducirTexto";

export type Hit = { id: string; name: string };

export type ResolveServiceResult = {
  hit: Hit | null;
  ambiguous: boolean;
  candidates: Array<{
    id: string;
    name: string;
    score: number;
  }>;
};

type Candidate = {
  serviceId: string;
  label: string;
  category: string;
  tipo: string;
  parentServiceId: string | null;
  serviceNameTokens: string[];
  supportTokens: string[];
  catalogTokens: string[];
  categoryTokens: string[];
  tipoTokens: string[];
};

const FUNCTION_WORDS = new Set([
  // ES
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "para",
  "por",
  "en",
  "y",
  "o",
  "u",
  "a",
  "que",
  "q",
  "este",
  "esta",
  "ese",
  "esa",
  "esto",
  "eso",
  "le",
  "lo",
  "al",
  "como",
  "con",
  "sin",
  "sobre",
  "mi",
  "tu",
  "su",
  "me",
  "te",
  "se",

  // EN
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "in",
  "of",
  "what",
  "does",
  "do",
  "is",
  "are",
  "with",
  "without",
  "about",
  "my",
  "your",
  "their",
  "me",
  "you",
  "it",
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
      if (/^\d+$/.test(w)) return false;
      return w.length >= 2 && !FUNCTION_WORDS.has(w);
    });
}

function buildTenantTokenDf(candidates: Candidate[]): Map<string, number> {
  const df = new Map<string, number>();

  for (const cand of candidates) {
    const seen = new Set([...(cand.catalogTokens || [])]);
    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  return df;
}

function normalizeLabel(raw: string): string {
  return normalize(raw).replace(/[\s_-]+/g, " ").trim();
}

function scoreTokensWeighted(
  queryTokens: string[],
  candidateTokens: string[],
  dfMap: Map<string, number>,
  totalCandidates: number
): number {
  if (!queryTokens.length || !candidateTokens.length || totalCandidates <= 0) return 0;

  const candidateSet = new Set(candidateTokens);

  let matchedWeight = 0;
  let totalWeight = 0;

  for (const t of queryTokens) {
    const df = dfMap.get(t) || 1;
    const weight = Math.log(1 + totalCandidates / df);

    totalWeight += weight;
    if (candidateSet.has(t)) matchedWeight += weight;
  }

  return totalWeight > 0 ? matchedWeight / totalWeight : 0;
}

function countExactHits(queryTokens: string[], candidateTokens: string[]): number {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const qSet = new Set(queryTokens);
  return candidateTokens.filter((t) => qSet.has(t)).length;
}

function uniqueOverlapTokens(queryTokens: string[], candidateTokens: string[]): string[] {
  if (!queryTokens.length || !candidateTokens.length) return [];
  const qSet = new Set(queryTokens);
  return Array.from(new Set(candidateTokens.filter((t) => qSet.has(t))));
}

export async function resolveServiceCandidatesFromText(
  pool: Pool,
  tenantId: string,
  userText: string,
  opts?: { mode?: "strict" | "loose" }
): Promise<ResolveServiceResult> {
  const mode: "strict" | "loose" = opts?.mode || "strict";
  const t = String(userText || "").trim();
  if (!t) {
    return { hit: null, ambiguous: false, candidates: [] };
  }

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
    console.log("[RESOLVE-SERVICE] sin tokens útiles, devolviendo null");
    return { hit: null, ambiguous: false, candidates: [] };
  }

  const { rows } = await pool.query<{
    service_id: string;
    service_name: string | null;
    service_description: string | null;
    service_category: string | null;
    service_tipo: string | null;
    parent_service_id: string | null;
    variant_name: string | null;
    variant_description: string | null;
    size_token: string | null;
  }>(
    `
    SELECT
      s.id AS service_id,
      s.name AS service_name,
      s.description AS service_description,
      s.category AS service_category,
      s.tipo AS service_tipo,
      s.parent_service_id,
      v.variant_name,
      v.description AS variant_description,
      v.size_token
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
    console.log("[RESOLVE-SERVICE] sin candidatos en DB, devolviendo null");
    return { hit: null, ambiguous: false, candidates: [] };
  }

  const grouped = new Map<
    string,
    {
      serviceId: string;
      serviceLabel: string | null;
      category: string | null;
      tipo: string | null;
      parentServiceId: string | null;
      serviceNameTokenSet: Set<string>;
      supportTokenSet: Set<string>;
      catalogTokenSet: Set<string>;
      categoryTokenSet: Set<string>;
      tipoTokenSet: Set<string>;
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
        category: String(r.service_category || "").trim(),
        tipo: String(r.service_tipo || "").trim(),
        parentServiceId: r.parent_service_id ? String(r.parent_service_id) : null,
        serviceNameTokenSet: new Set<string>(),
        supportTokenSet: new Set<string>(),
        catalogTokenSet: new Set<string>(),
        categoryTokenSet: new Set<string>(),
        tipoTokenSet: new Set<string>(),
      };
      grouped.set(serviceId, entry);
    }

    const serviceNameTokens = tokenize(serviceName);
    const serviceDescTokens = tokenize(String(r.service_description || ""));
    const variantNameTokens = tokenize(String(r.variant_name || ""));
    const variantDescTokens = tokenize(String(r.variant_description || ""));
    const categoryTokens = tokenize(String(r.service_category || ""));
    const tipoTokens = tokenize(String(r.service_tipo || ""));
    const sizeTokenTokens = tokenize(String(r.size_token || ""));

    for (const tk of serviceNameTokens) entry.serviceNameTokenSet.add(tk);

    for (const tk of serviceDescTokens) entry.supportTokenSet.add(tk);
    for (const tk of variantNameTokens) entry.supportTokenSet.add(tk);
    for (const tk of variantDescTokens) entry.supportTokenSet.add(tk);

    for (const tk of serviceNameTokens) entry.catalogTokenSet.add(tk);
    for (const tk of serviceDescTokens) entry.catalogTokenSet.add(tk);
    for (const tk of variantNameTokens) entry.catalogTokenSet.add(tk);
    for (const tk of variantDescTokens) entry.catalogTokenSet.add(tk);

    for (const tk of categoryTokens) entry.catalogTokenSet.add(tk);
    for (const tk of tipoTokens) entry.catalogTokenSet.add(tk);
    for (const tk of sizeTokenTokens) entry.catalogTokenSet.add(tk);
    for (const tk of categoryTokens) entry.categoryTokenSet.add(tk);
    for (const tk of tipoTokens) entry.tipoTokenSet.add(tk);

    for (const tk of sizeTokenTokens) entry.supportTokenSet.add(tk);
  }

  const candidates: Candidate[] = Array.from(grouped.values()).map((g) => ({
    serviceId: g.serviceId,
    label: g.serviceLabel || "",
    category: g.category || "",
    tipo: g.tipo || "",
    parentServiceId: g.parentServiceId,
    serviceNameTokens: Array.from(g.serviceNameTokenSet),
    supportTokens: Array.from(g.supportTokenSet),
    catalogTokens: Array.from(g.catalogTokenSet),
    categoryTokens: Array.from(g.categoryTokenSet),
    tipoTokens: Array.from(g.tipoTokenSet),
  }));

  if (!candidates.length) {
    console.log("[RESOLVE-SERVICE] candidatos sin tokens, devolviendo null");
    return { hit: null, ambiguous: false, candidates: [] };
  }

  const dfMap = buildTenantTokenDf(candidates);
  const totalCandidates = candidates.length;

  type Scored = {
    cand: Candidate;
    score: number;
    exactNameHits: number;
    exactCatalogHits: number;
    overlapNameTokens: string[];
    overlapCatalogTokens: string[];
  };

  const scored: Scored[] = candidates.map((cand) => {
    const nameScore = scoreTokensWeighted(
      queryTokens,
      cand.serviceNameTokens,
      dfMap,
      totalCandidates
    );

    const supportScore = scoreTokensWeighted(
      queryTokens,
      cand.supportTokens,
      dfMap,
      totalCandidates
    );

    const catalogScore = scoreTokensWeighted(
      queryTokens,
      cand.catalogTokens,
      dfMap,
      totalCandidates
    );

    const categoryScore = scoreTokensWeighted(
      queryTokens,
      cand.categoryTokens,
      dfMap,
      totalCandidates
    );

    const tipoScore = scoreTokensWeighted(
      queryTokens,
      cand.tipoTokens,
      dfMap,
      totalCandidates
    );

    const exactNameHits = countExactHits(queryTokens, cand.serviceNameTokens);
    const exactCatalogHits = countExactHits(queryTokens, cand.catalogTokens);

    const overlapNameTokens = uniqueOverlapTokens(queryTokens, cand.serviceNameTokens);
    const overlapCatalogTokens = uniqueOverlapTokens(queryTokens, cand.catalogTokens);

    const queryCoverage =
      queryTokens.length > 0
        ? overlapCatalogTokens.length / queryTokens.length
        : 0;

    let score = 0;

    // texto
    score += nameScore * 0.28;
    score += supportScore * 0.32;
    score += catalogScore * 0.18;

    // estructura del catálogo
    score += categoryScore * 0.12;
    score += tipoScore * 0.10;

    // evidencia múltiple
    if (exactNameHits >= 2) score += 0.08;
    if (exactCatalogHits >= 2) score += 0.08;

    // cobertura del query
    score += queryCoverage * 0.12;

    // ajustes universales multitenant-safe
    const tipoNorm = normalizeLabel(cand.tipo || "");
    const hasParent = !!cand.parentServiceId;

    const isAddOn =
      tipoNorm === "add on" ||
      tipoNorm === "addon" ||
      tipoNorm === "add-on";

    if (isAddOn) score -= 0.18;
    if (hasParent) score -= 0.08;

    const isPrimary = !isAddOn && !hasParent;
    if (isPrimary) score += 0.06;

    return {
      cand,
      score,
      exactNameHits,
      exactCatalogHits,
      overlapNameTokens,
      overlapCatalogTokens,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  console.log("[RESOLVE-SERVICE] debug", {
    userText,
    idioma,
    queryTokens,
    best: best
      ? {
          label: best.cand.label,
          score: best.score,
          serviceId: best.cand.serviceId,
          category: best.cand.category,
          tipo: best.cand.tipo,
          parentServiceId: best.cand.parentServiceId,
          exactNameHits: best.exactNameHits,
          exactCatalogHits: best.exactCatalogHits,
          overlapNameTokens: best.overlapNameTokens,
          overlapCatalogTokens: best.overlapCatalogTokens,
        }
      : null,
    second: second
      ? {
          label: second.cand.label,
          score: second.score,
          serviceId: second.cand.serviceId,
          exactNameHits: second.exactNameHits,
          exactCatalogHits: second.exactCatalogHits,
          overlapNameTokens: second.overlapNameTokens,
          overlapCatalogTokens: second.overlapCatalogTokens,
        }
      : null,
  });

  const BASE_THRESHOLD = mode === "strict" ? 0.52 : 0.3;
  const SINGLE_TOKEN_THRESHOLD = mode === "strict" ? 0.62 : 0.3;
  const MARGIN = mode === "strict" ? 0.2 : 0.1;

  const topCandidates = scored
    .filter((s) => s.score > 0)
    .slice(0, 3)
    .map((s) => ({
      id: s.cand.serviceId,
      name: s.cand.label,
      score: s.score,
    }));

  if (queryTokens.length === 1) {
    const token = queryTokens[0];

    const withToken = scored.filter((s) => {
      const allTokens = [...(s.cand.catalogTokens || [])];
      return s.score > 0 && allTokens.includes(token);
    });

    if (mode === "strict") {
      if (withToken.length !== 1) {
        console.log(
          "[RESOLVE-SERVICE] (strict) 1 token útil pero",
          withToken.length,
          "candidatos → ambiguo, devolviendo null"
        );
        return {
          hit: null,
          ambiguous: withToken.length > 1,
          candidates: withToken.slice(0, 3).map((s) => ({
            id: s.cand.serviceId,
            name: s.cand.label,
            score: s.score,
          })),
        };
      }

      const only = withToken[0];

      const enoughEvidence =
        only.score >= SINGLE_TOKEN_THRESHOLD &&
        only.exactNameHits >= 1 &&
        withToken.length === 1;

      if (enoughEvidence) {
        console.log("[RESOLVE-SERVICE] (strict) match único por token útil", {
          userText,
          token,
          label: only.cand.label,
          score: only.score,
        });
        return {
          hit: { id: only.cand.serviceId, name: only.cand.label },
          ambiguous: false,
          candidates: topCandidates,
        };
      }

      console.log(
        "[RESOLVE-SERVICE] (strict) evidencia insuficiente con 1 token útil, devolviendo null",
        {
          userText,
          token,
          label: only.cand.label,
          score: only.score,
        }
      );
      return {
        hit: null,
        ambiguous: false,
        candidates: topCandidates,
      };
    }

    console.log(
      "[RESOLVE-SERVICE] (loose) 1 token útil → no auto-resolver, devolviendo null",
      { userText, token, candidates: withToken.length }
    );
    return {
      hit: null,
      ambiguous: withToken.length > 1,
      candidates: withToken.slice(0, 3).map((s) => ({
        id: s.cand.serviceId,
        name: s.cand.label,
        score: s.score,
      })),
    };
  }

  const bestEvidenceCount = Math.max(
    best?.exactNameHits || 0,
    best?.exactCatalogHits || 0
  );

  const enoughEvidence =
    bestEvidenceCount >= 2 ||
    (best?.score || 0) >= 0.68;

  if (!best || best.score < BASE_THRESHOLD || !enoughEvidence) {
    console.log("[RESOLVE-SERVICE] evidencia insuficiente, devolviendo null", {
      userText,
      bestScore: best?.score,
      threshold: BASE_THRESHOLD,
      bestEvidenceCount,
    });

    const ambiguous =
      !!second &&
      second.score > 0 &&
      Math.abs((best?.score || 0) - second.score) < MARGIN;

    return {
      hit: null,
      ambiguous,
      candidates: topCandidates,
    };
  }

  if (second && second.score > 0 && Math.abs(best.score - second.score) < MARGIN) {
    console.log(
      "[RESOLVE-SERVICE] empate entre best y second (margin pequeño), devolviendo null",
      {
        userText,
        best: { label: best.cand.label, score: best.score },
        second: { label: second.cand.label, score: second.score },
        margin: Math.abs(best.score - second.score),
        requiredMargin: MARGIN,
      }
    );
    return {
      hit: null,
      ambiguous: true,
      candidates: topCandidates,
    };
  }

  console.log("[RESOLVE-SERVICE] match aceptado (>=2 tokens útiles)", {
    userText,
    label: best.cand.label,
    score: best.score,
  });

  return {
    hit: { id: best.cand.serviceId, name: best.cand.label },
    ambiguous: false,
    candidates: topCandidates,
  };
}

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string,
  opts?: { mode?: "strict" | "loose" }
): Promise<Hit | null> {
  const result = await resolveServiceCandidatesFromText(
    pool,
    tenantId,
    userText,
    opts
  );
  return result.hit;
}