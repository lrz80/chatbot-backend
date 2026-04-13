//src/lib/services/pricing/resolveServiceIdFromText.ts
import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirTexto } from "../../traducirTexto";

export type Hit = { id: string; name: string };

export type ResolveServiceCandidate = {
  id: string;
  name: string;
  score: number;
  category?: string | null;
  tipo?: string | null;
  parentServiceId?: string | null;
  catalogRole?: string | null;

  variantId?: string | null;
  variantName?: string | null;
  candidateKind?: "service" | "variant";
  serviceName?: string | null;

  overlapNameTokens?: string[];
  overlapTipoTokens?: string[];
  overlapSupportTokens?: string[];
  dominantOverlapTokens?: string[];
};

export type ResolveServiceDecision =
  | {
      kind: "resolved_single";
      hit: Hit;
      candidates: ResolveServiceCandidate[];
    }
  | {
      kind: "ambiguous";
      hit: null;
      candidates: ResolveServiceCandidate[];
    }
  | {
      kind: "none";
      hit: null;
      candidates: ResolveServiceCandidate[];
    };

type CandidateVariant = {
  variantId: string | null;
  variantName: string;
  variantNameTokens: string[];
};

type Candidate = {
  serviceId: string;
  label: string;
  category: string;
  tipo: string;
  catalogRole: string;
  parentServiceId: string | null;

  serviceNameTokens: string[];
  variantNameTokens: string[];

  categoryTokens: string[];
  tipoTokens: string[];

  supportTokens: string[];
  variants: CandidateVariant[];
};

type Scored = {
  cand: Candidate;
  score: number;
  exactNameHits: number;
  exactVariantHits: number;

  overlapNameTokens: string[];
  overlapVariantTokens: string[];
  overlapCategoryTokens: string[];
  overlapTipoTokens: string[];
  overlapSupportTokens: string[];

  allOverlapTokens: string[];
  dominantOverlapTokens: string[];
  dominantOverlapCount: number;

  hasResolvableEntityEvidence: boolean;
};

type ResolveServiceOptions = {
  mode?: "strict" | "loose";
  allowedServiceIds?: string[];
};

type DetectLangSafeResult = {
  lang: string | null;
  confidence: number;
  source: "openai" | "none";
};

async function detectarIdiomaSafe(text: string): Promise<DetectLangSafeResult> {
  try {
    const result = await detectarIdioma(text);
    return {
      lang: result?.lang ?? null,
      confidence: Number(result?.confidence ?? 0),
      source: result?.source === "openai" ? "openai" : "none",
    };
  } catch {
    return {
      lang: null,
      confidence: 0,
      source: "none",
    };
  }
}

function stripDiacritics(raw: string): string {
  const normalized = String(raw || "").normalize("NFD");
  let out = "";

  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    const isCombiningMark = code >= 0x0300 && code <= 0x036f;
    if (!isCombiningMark) out += ch;
  }

  return out;
}

function normalize(raw: string): string {
  return stripDiacritics(String(raw || "")).toLowerCase().trim();
}

function isAsciiLetterOrDigit(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  const isDigit = code >= 48 && code <= 57;
  const isLower = code >= 97 && code <= 122;
  return isDigit || isLower;
}

function sanitizeWord(raw: string): string {
  const text = normalize(raw);
  let out = "";

  for (const ch of text) {
    if (isAsciiLetterOrDigit(ch)) out += ch;
  }

  return out.trim();
}

function tokenize(raw: string): string[] {
  const text = normalize(raw);
  if (!text) return [];

  const tokens: string[] = [];
  const seen = new Set<string>();

  const SegmenterCtor = (Intl as any)?.Segmenter;

  if (typeof SegmenterCtor === "function") {
    const segmenter = new SegmenterCtor("en", { granularity: "word" });
    for (const part of segmenter.segment(text)) {
      if (!part?.isWordLike) continue;
      const token = sanitizeWord(part.segment);
      if (!token) continue;
      if (token.length < 2) continue;
      if (/^\d+$/.test(token)) continue;
      if (!seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    }
    return tokens;
  }

  let current = "";
  for (const ch of text) {
    if (isAsciiLetterOrDigit(ch)) {
      current += ch;
    } else if (current) {
      if (current.length >= 2 && !/^\d+$/.test(current) && !seen.has(current)) {
        seen.add(current);
        tokens.push(current);
      }
      current = "";
    }
  }

  if (current.length >= 2 && !/^\d+$/.test(current) && !seen.has(current)) {
    seen.add(current);
    tokens.push(current);
  }

  return tokens;
}

function uniqueUnion(arrays: string[][]): string[] {
  return Array.from(new Set(arrays.flat().filter(Boolean)));
}

function normalizeLabel(raw: string): string {
  const text = normalize(raw);
  let out = "";
  let prevSpace = false;

  for (const ch of text) {
    const isSeparator = ch === " " || ch === "_" || ch === "-";
    if (isSeparator) {
      if (!prevSpace) {
        out += " ";
        prevSpace = true;
      }
      continue;
    }

    if (!isAsciiLetterOrDigit(ch)) {
      if (!prevSpace) {
        out += " ";
        prevSpace = true;
      }
      continue;
    }

    out += ch;
    prevSpace = false;
  }

  return out.trim();
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

function buildTenantTokenDf(candidates: Candidate[]): Map<string, number> {
  const df = new Map<string, number>();

  for (const cand of candidates) {
    const seen = new Set([
      ...(cand.serviceNameTokens || []),
      ...(cand.variantNameTokens || []),
      ...(cand.categoryTokens || []),
      ...(cand.tipoTokens || []),
      ...(cand.supportTokens || []),
    ]);

    for (const token of seen) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  return df;
}

function getTokenWeight(
  token: string,
  dfMap: Map<string, number>,
  totalCandidates: number
): number {
  if (!token || totalCandidates <= 0) return 0;
  const df = dfMap.get(token) || 1;
  return Math.log(1 + totalCandidates / df);
}

function scoreTokensWeighted(
  queryTokens: string[],
  candidateTokens: string[],
  dfMap: Map<string, number>,
  totalCandidates: number
): number {
  if (!queryTokens.length || !candidateTokens.length || totalCandidates <= 0) {
    return 0;
  }

  const candidateSet = new Set(candidateTokens);
  let matchedWeight = 0;
  let totalWeight = 0;

  for (const token of queryTokens) {
    const weight = getTokenWeight(token, dfMap, totalCandidates);
    totalWeight += weight;
    if (candidateSet.has(token)) matchedWeight += weight;
  }

  return totalWeight > 0 ? matchedWeight / totalWeight : 0;
}

function getDominantQueryTokens(
  queryTokens: string[],
  dfMap: Map<string, number>,
  totalCandidates: number
): string[] {
  if (!queryTokens.length || totalCandidates <= 0) return [];

  const weighted = queryTokens
    .map((token) => {
      const df = dfMap.get(token) || 0;
      return {
        token,
        df,
        weight: df > 0 ? getTokenWeight(token, dfMap, totalCandidates) : 0,
      };
    })
    .filter((x) => x.df > 0);

  if (!weighted.length) return [];

  const maxWeight = Math.max(...weighted.map((x) => x.weight), 0);
  if (maxWeight <= 0) return [];

  return weighted
    .filter((x) => x.weight >= maxWeight * 0.85)
    .map((x) => x.token);
}

function buildObservedQueryTokens(
  rawQueryTokens: string[],
  dfMap: Map<string, number>
): string[] {
  return rawQueryTokens.filter((token) => dfMap.has(token));
}

function isDiscriminativeQueryToken(
  token: string,
  dfMap: Map<string, number>,
  totalCandidates: number
): boolean {
  const value = String(token || "").trim();
  if (!value) return false;
  if (value.length <= 2) return false;
  if (totalCandidates <= 0) return false;

  const df = dfMap.get(value) || 0;
  if (df <= 0) return false;

  const coverage = df / totalCandidates;
  const weight = getTokenWeight(value, dfMap, totalCandidates);

  return coverage <= 0.35 && weight >= 0.8;
}

function buildDiscriminativeQueryTokens(
  observedQueryTokens: string[],
  dfMap: Map<string, number>,
  totalCandidates: number
): string[] {
  return observedQueryTokens.filter((token) =>
    isDiscriminativeQueryToken(token, dfMap, totalCandidates)
  );
}

export async function resolveServiceCandidatesFromText(
  pool: Pool,
  tenantId: string,
  userText: string,
  opts?: ResolveServiceOptions
): Promise<ResolveServiceDecision> {
  const mode: "strict" | "loose" = opts?.mode || "strict";
  const allowedServiceIds =
    Array.isArray(opts?.allowedServiceIds) && opts!.allowedServiceIds.length > 0
      ? Array.from(
          new Set(
            opts!.allowedServiceIds
              .map((value) => String(value || "").trim())
              .filter(Boolean)
          )
        )
      : null;
  const input = String(userText || "").trim();

  if (!input) {
    return { kind: "none", hit: null, candidates: [] };
  }

  const detected = await detectarIdiomaSafe(input);
  const idioma = detected.lang ?? "en";

  const textNorm = normalize(input);
  let translatedAlt = "";

  try {
    if (idioma === "es") {
      translatedAlt = normalize(await traducirTexto(input, "en"));
    } else if (idioma === "en") {
      translatedAlt = normalize(await traducirTexto(input, "es"));
    }
  } catch {
    translatedAlt = "";
  }

  const queryTokens = Array.from(
    new Set([
      ...tokenize(textNorm),
      ...(translatedAlt ? tokenize(translatedAlt) : []),
    ])
  );

  if (!queryTokens.length) {
    console.log("[RESOLVE-SERVICE] sin tokens útiles, devolviendo null");
    return { kind: "none", hit: null, candidates: [] };
  }

  const queryParams: any[] = [tenantId];
  let allowedServiceFilterSql = "";

  if (allowedServiceIds && allowedServiceIds.length > 0) {
    queryParams.push(allowedServiceIds);
    allowedServiceFilterSql = `AND s.id = ANY($${queryParams.length}::uuid[])`;
  }

  const { rows } = await pool.query<{
    service_id: string;
    service_name: string | null;
    service_description: string | null;
    service_category: string | null;
    service_tipo: string | null;
    service_catalog_role: string | null;
    parent_service_id: string | null;
    variant_id: string | null;
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
      s.catalog_role AS service_catalog_role,
      s.parent_service_id,
      v.id AS variant_id,
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
      ${allowedServiceFilterSql}
    ORDER BY s.created_at ASC, v.created_at ASC NULLS LAST, v.id ASC NULLS LAST
    `,
    queryParams
  );

  if (!rows.length) {
    console.log("[RESOLVE-SERVICE] sin candidatos en DB, devolviendo null");
    return { kind: "none", hit: null, candidates: [] };
  }

  const grouped = new Map<
    string,
    {
      serviceId: string;
      serviceLabel: string | null;
      category: string | null;
      tipo: string | null;
      catalogRole: string | null;
      parentServiceId: string | null;

      serviceNameTokenSet: Set<string>;
      variantNameTokenSet: Set<string>;

      categoryTokenSet: Set<string>;
      tipoTokenSet: Set<string>;

      supportTokenSet: Set<string>;
      variants: Map<string, CandidateVariant>;
    }
  >();

  for (const row of rows) {
    const serviceId = String(row.service_id || "");
    const serviceName = String(row.service_name || "").trim();
    if (!serviceId || !serviceName) continue;

    let entry = grouped.get(serviceId);

    if (!entry) {
      entry = {
        serviceId,
        serviceLabel: serviceName,
        category: String(row.service_category || "").trim(),
        tipo: String(row.service_tipo || "").trim(),
        catalogRole: String(row.service_catalog_role || "").trim(),
        parentServiceId: row.parent_service_id ? String(row.parent_service_id) : null,

        serviceNameTokenSet: new Set<string>(),
        variantNameTokenSet: new Set<string>(),

        categoryTokenSet: new Set<string>(),
        tipoTokenSet: new Set<string>(),

        supportTokenSet: new Set<string>(),
        variants: new Map<string, CandidateVariant>(),
      };
      grouped.set(serviceId, entry);
    }

    const serviceNameTokens = tokenize(serviceName);
    const serviceDescTokens = tokenize(String(row.service_description || ""));
    const variantNameTokens = tokenize(String(row.variant_name || ""));
    const variantId = row.variant_id ? String(row.variant_id) : null;
    const variantName = String(row.variant_name || "").trim();

    if (variantName) {
      const variantKey = variantId || `name:${normalize(variantName)}`;

      if (!entry.variants.has(variantKey)) {
        entry.variants.set(variantKey, {
          variantId,
          variantName,
          variantNameTokens,
        });
      }
    }
    const variantDescTokens = tokenize(String(row.variant_description || ""));
    const categoryTokens = tokenize(String(row.service_category || ""));
    const tipoTokens = tokenize(String(row.service_tipo || ""));
    const sizeTokenTokens = tokenize(String(row.size_token || ""));

    for (const token of serviceNameTokens) entry.serviceNameTokenSet.add(token);
    for (const token of variantNameTokens) entry.variantNameTokenSet.add(token);

    for (const token of categoryTokens) entry.categoryTokenSet.add(token);
    for (const token of tipoTokens) entry.tipoTokenSet.add(token);

    for (const token of serviceDescTokens) entry.supportTokenSet.add(token);
    for (const token of variantDescTokens) entry.supportTokenSet.add(token);
    for (const token of sizeTokenTokens) entry.supportTokenSet.add(token);
  }

  const candidates: Candidate[] = Array.from(grouped.values()).map((entry) => ({
    serviceId: entry.serviceId,
    label: entry.serviceLabel || "",
    category: entry.category || "",
    tipo: entry.tipo || "",
    catalogRole: entry.catalogRole || "",
    parentServiceId: entry.parentServiceId,

    serviceNameTokens: Array.from(entry.serviceNameTokenSet),
    variantNameTokens: Array.from(entry.variantNameTokenSet),

    categoryTokens: Array.from(entry.categoryTokenSet),
    tipoTokens: Array.from(entry.tipoTokenSet),

    supportTokens: Array.from(entry.supportTokenSet),
    variants: Array.from(entry.variants.values()),
  }));

  if (!candidates.length) {
    console.log("[RESOLVE-SERVICE] candidatos sin tokens, devolviendo null");
    return { kind: "none", hit: null, candidates: [] };
  }

  const dfMap = buildTenantTokenDf(candidates);
  const totalCandidates = candidates.length;

  const observedQueryTokens = buildObservedQueryTokens(queryTokens, dfMap);
  const discriminativeQueryTokens = buildDiscriminativeQueryTokens(
    observedQueryTokens,
    dfMap,
    totalCandidates
  );

  if (!observedQueryTokens.length) {
    console.log("[RESOLVE-SERVICE] query sin tokens observados en catalogo, devolviendo null", {
      userText,
      queryTokens,
    });
    return { kind: "none", hit: null, candidates: [] };
  }

  const dominantQueryTokens = getDominantQueryTokens(
    discriminativeQueryTokens.length > 0
      ? discriminativeQueryTokens
      : observedQueryTokens,
    dfMap,
    totalCandidates
  );

  const scored: Scored[] = candidates.map((cand) => {
    const resolvableQueryTokens =
      discriminativeQueryTokens.length > 0
        ? discriminativeQueryTokens
        : observedQueryTokens;

    const nameScore = scoreTokensWeighted(
      resolvableQueryTokens,
      cand.serviceNameTokens,
      dfMap,
      totalCandidates
    );

    const variantScore = scoreTokensWeighted(
      resolvableQueryTokens,
      cand.variantNameTokens,
      dfMap,
      totalCandidates
    );

    const categoryScore = scoreTokensWeighted(
      observedQueryTokens,
      cand.categoryTokens,
      dfMap,
      totalCandidates
    );

    const tipoScore = scoreTokensWeighted(
      observedQueryTokens,
      cand.tipoTokens,
      dfMap,
      totalCandidates
    );

    const supportScore = scoreTokensWeighted(
      observedQueryTokens,
      cand.supportTokens,
      dfMap,
      totalCandidates
    );

    const exactNameHits = countExactHits(resolvableQueryTokens, cand.serviceNameTokens);
    const exactVariantHits = countExactHits(resolvableQueryTokens, cand.variantNameTokens);

    const overlapNameTokens = uniqueOverlapTokens(resolvableQueryTokens, cand.serviceNameTokens);
    const overlapVariantTokens = uniqueOverlapTokens(resolvableQueryTokens, cand.variantNameTokens);

    const overlapCategoryTokens = uniqueOverlapTokens(observedQueryTokens, cand.categoryTokens);
    const overlapTipoTokens = uniqueOverlapTokens(observedQueryTokens, cand.tipoTokens);
    const overlapSupportTokens = uniqueOverlapTokens(observedQueryTokens, cand.supportTokens);

    const resolvableOverlapTokens = uniqueUnion([
      overlapNameTokens,
      overlapVariantTokens,
    ]);

    const structuralOverlapTokens = uniqueUnion([
      overlapCategoryTokens,
      overlapTipoTokens,
    ]);

    const allOverlapTokens = uniqueUnion([
      resolvableOverlapTokens,
      structuralOverlapTokens,
      overlapSupportTokens,
    ]);

    const hasResolvableEntityEvidence =
      overlapNameTokens.length > 0 || overlapVariantTokens.length > 0;

    if (!allOverlapTokens.length) {
      return {
        cand,
        score: 0,
        exactNameHits,
        exactVariantHits,
        overlapNameTokens,
        overlapVariantTokens,
        overlapCategoryTokens,
        overlapTipoTokens,
        overlapSupportTokens,
        allOverlapTokens,
        dominantOverlapTokens: [],
        dominantOverlapCount: 0,
        hasResolvableEntityEvidence,
      };
    }

    const dominantOverlapTokens = dominantQueryTokens.filter((token) =>
      uniqueUnion([
        overlapNameTokens,
        overlapVariantTokens,
        overlapCategoryTokens,
        overlapTipoTokens,
      ]).includes(token)
    );

    const dominantOverlapCount = dominantOverlapTokens.length;

    const queryCoverage =
      resolvableQueryTokens.length > 0
        ? resolvableOverlapTokens.length / resolvableQueryTokens.length
        : 0;

    let score = 0;

    score += nameScore * 0.44;
    score += variantScore * 0.36;
    score += categoryScore * 0.08;
    score += tipoScore * 0.06;

    if (hasResolvableEntityEvidence) {
      score += supportScore * 0.06;
    }

    if (exactNameHits >= 2) score += 0.08;
    if (exactVariantHits >= 2) score += 0.08;

    score += queryCoverage * 0.1;

    if (dominantOverlapCount > 0) {
      score += Math.min(0.18, dominantOverlapCount * 0.12);
    }

    const categoryNorm = normalizeLabel(cand.category || "");
    const catalogRoleNorm = normalizeLabel(cand.catalogRole || "");
    const hasParent = !!cand.parentServiceId;

    const isAddOnCategory =
      categoryNorm === "add on" ||
      categoryNorm === "addon" ||
      categoryNorm === "add-on";

    const isExtraRole =
      catalogRoleNorm === "complemento / extra" ||
      catalogRoleNorm === "complemento extra" ||
      catalogRoleNorm === "extra" ||
      catalogRoleNorm === "addon" ||
      catalogRoleNorm === "add on" ||
      catalogRoleNorm === "add-on";

    const isPrimaryRole =
      catalogRoleNorm === "servicio principal" ||
      catalogRoleNorm === "primary service";

    const isAddOn = isAddOnCategory || isExtraRole;

    if (isAddOn) score -= 0.45;
    if (hasParent) score -= 0.12;
    if (isPrimaryRole) score += 0.18;
    if (isPrimaryRole || (!isAddOn && !hasParent)) score += 0.08;

    return {
      cand,
      score,
      exactNameHits,
      exactVariantHits,
      overlapNameTokens,
      overlapVariantTokens,
      overlapCategoryTokens,
      overlapTipoTokens,
      overlapSupportTokens,
      allOverlapTokens,
      dominantOverlapTokens,
      dominantOverlapCount,
      hasResolvableEntityEvidence,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  console.log("[RESOLVE-SERVICE][SUMMARY]", {
    userText,
    best: best
      ? {
          label: best.cand.label,
          score: best.score,
          serviceId: best.cand.serviceId,
        }
      : null,
    second: second
      ? {
          label: second.cand.label,
          score: second.score,
          serviceId: second.cand.serviceId,
        }
      : null,
  });

  const BASE_THRESHOLD = mode === "strict" ? 0.2 : 0.14;
  const SINGLE_TOKEN_THRESHOLD = mode === "strict" ? 0.52 : 0.3;
  const MARGIN = mode === "strict" ? 0.1 : 0.06;

  const ENTITY_STRONG_THRESHOLD = mode === "strict" ? 0.58 : 0.42;
  const ENTITY_CLEAR_MARGIN = mode === "strict" ? 0.14 : 0.08;
  const MIN_RESOLVABLE_OVERLAP =
    mode === "strict"
      ? (observedQueryTokens.length >= 2 ? 2 : 1)
      : 1;

  const topCandidates: ResolveServiceCandidate[] = scored
    .filter((s) => s.allOverlapTokens.length > 0)
    .slice(0, 3)
    .map((s) => ({
      id: s.cand.serviceId,
      name: s.cand.label,
      score: s.score,
      category: s.cand.category || null,
      tipo: s.cand.tipo || null,
      parentServiceId: s.cand.parentServiceId || null,
      catalogRole: s.cand.catalogRole || null,
      overlapNameTokens: s.overlapNameTokens,
      overlapTipoTokens: s.overlapTipoTokens,
      overlapSupportTokens: s.overlapSupportTokens,
      dominantOverlapTokens: s.dominantOverlapTokens,
    }));

  const ambiguousCandidates: ResolveServiceCandidate[] =
    best
      ? scored
          .filter(
            (s) =>
              s.score > 0 &&
              Math.abs(best.score - s.score) < MARGIN &&
              s.allOverlapTokens.length > 0
          )
          .slice(0, 5)
          .map((s) => ({
            id: s.cand.serviceId,
            name: s.cand.label,
            score: s.score,
            category: s.cand.category || null,
            tipo: s.cand.tipo || null,
            parentServiceId: s.cand.parentServiceId || null,
            catalogRole: s.cand.catalogRole || null,
            overlapNameTokens: s.overlapNameTokens,
            overlapTipoTokens: s.overlapTipoTokens,
            overlapSupportTokens: s.overlapSupportTokens,
            dominantOverlapTokens: s.dominantOverlapTokens,
          }))
      : [];

  if (observedQueryTokens.length === 1) {
    const token = observedQueryTokens[0];

    const withToken = scored.filter((s) => {
      const allTokens = [
        ...(s.cand.serviceNameTokens || []),
        ...(s.cand.variantNameTokens || []),
        ...(s.cand.categoryTokens || []),
        ...(s.cand.tipoTokens || []),
      ];
      return s.score > 0 && allTokens.includes(token);
    });

    if (mode === "strict") {
      if (withToken.length !== 1) {
        console.log(
          "[RESOLVE-SERVICE] (strict) 1 token observado pero",
          withToken.length,
          "candidatos → ambiguo, devolviendo null"
        );

        return {
          kind: withToken.length > 1 ? "ambiguous" : "none",
          hit: null,
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
        (only.exactNameHits >= 1 || only.exactVariantHits >= 1);

      if (enoughEvidence) {
        console.log("[RESOLVE-SERVICE] (strict) match único por token observado", {
          userText,
          token,
          label: only.cand.label,
          score: only.score,
        });

        return {
          kind: "resolved_single",
          hit: { id: only.cand.serviceId, name: only.cand.label },
          candidates: topCandidates,
        };
      }

      console.log(
        "[RESOLVE-SERVICE] (strict) evidencia insuficiente con 1 token observado, devolviendo null",
        {
          userText,
          token,
          label: only.cand.label,
          score: only.score,
        }
      );

      return {
        kind: "none",
        hit: null,
        candidates: topCandidates,
      };
    }

    console.log(
      "[RESOLVE-SERVICE] (loose) 1 token observado → no auto-resolver, devolviendo null",
      { userText, token, candidates: withToken.length }
    );

    return {
      kind: withToken.length > 1 ? "ambiguous" : "none",
      hit: null,
      candidates: withToken.slice(0, 3).map((s) => ({
        id: s.cand.serviceId,
        name: s.cand.label,
        score: s.score,
      })),
    };
  }

  const bestNameEvidenceCount = best?.exactNameHits || 0;
  const bestVariantEvidenceCount = best?.exactVariantHits || 0;
  const bestEvidenceCount = Math.max(
    bestNameEvidenceCount,
    bestVariantEvidenceCount
  );

  const secondScore = second?.score || 0;
  const marginVsSecond = best ? best.score - secondScore : 0;

  const resolvableEvidenceQueryTokens =
    discriminativeQueryTokens.length > 0
      ? discriminativeQueryTokens
      : observedQueryTokens;

  const bestResolvableOverlapTokens = best
    ? uniqueUnion([
        best.overlapNameTokens,
        best.overlapVariantTokens,
      ]).filter((token) => resolvableEvidenceQueryTokens.includes(token))
    : [];

  const bestResolvableOverlapCount = bestResolvableOverlapTokens.length;

  const exactEntityMatch =
    bestNameEvidenceCount >= 2 || bestVariantEvidenceCount >= 1;

  const strongSingleEntityCandidate =
    Boolean(best?.hasResolvableEntityEvidence) &&
    (best?.score || 0) >= ENTITY_STRONG_THRESHOLD &&
    marginVsSecond >= ENTITY_CLEAR_MARGIN &&
    bestResolvableOverlapCount >= MIN_RESOLVABLE_OVERLAP &&
    (
      bestNameEvidenceCount >= 1 ||
      bestVariantEvidenceCount >= 1 ||
      (best?.dominantOverlapCount || 0) >= 2
    );

  const enoughEvidence =
    Boolean(best?.hasResolvableEntityEvidence) &&
    bestResolvableOverlapCount >= MIN_RESOLVABLE_OVERLAP &&
    (exactEntityMatch || strongSingleEntityCandidate);

  if (!best || best.score < BASE_THRESHOLD || !enoughEvidence) {
    console.log("[RESOLVE-SERVICE] evidencia insuficiente, devolviendo null", {
      userText,
      bestScore: best?.score,
      threshold: BASE_THRESHOLD,
      bestEvidenceCount,
      secondScore,
      marginVsSecond,
    });

    const isAmbiguous =
      !!best &&
      !!second &&
      best.allOverlapTokens.length > 0 &&
      second.allOverlapTokens.length > 0 &&
      second.score > 0 &&
      Math.abs((best?.score || 0) - second.score) < MARGIN;

    return {
      kind: isAmbiguous ? "ambiguous" : "none",
      hit: null,
      candidates:
        isAmbiguous && ambiguousCandidates.length > 0
          ? ambiguousCandidates
          : topCandidates,
    };
  }

  if (
    second &&
    second.score > 0 &&
    best.allOverlapTokens.length > 0 &&
    second.allOverlapTokens.length > 0 &&
    Math.abs(best.score - second.score) < MARGIN
  ) {
    const bestHasDominant = best.dominantOverlapCount > 0;
    const secondHasDominant = second.dominantOverlapCount > 0;

    const bestCategoryNorm = normalizeLabel(best.cand.category || "");
    const secondCategoryNorm = normalizeLabel(second.cand.category || "");

    const bestTipoNorm = normalizeLabel(best.cand.tipo || "");
    const secondTipoNorm = normalizeLabel(second.cand.tipo || "");

    const sameFamily =
      (!!bestCategoryNorm &&
        !!secondCategoryNorm &&
        bestCategoryNorm === secondCategoryNorm) ||
      (!!bestTipoNorm &&
        !!secondTipoNorm &&
        bestTipoNorm === secondTipoNorm);

    const strongExplicitEvidence =
      best.exactNameHits >= 2 ||
      best.exactVariantHits >= 1 ||
      best.dominantOverlapCount >= 2 ||
      uniqueUnion([
        best.overlapNameTokens,
        best.overlapVariantTokens,
      ]).length >= 1;

    if (bestHasDominant && !secondHasDominant) {
      console.log("[RESOLVE-SERVICE] desempate por dominant query tokens, aceptando best", {
        userText,
        best: {
          label: best.cand.label,
          score: best.score,
          dominantOverlapTokens: best.dominantOverlapTokens,
        },
        second: {
          label: second.cand.label,
          score: second.score,
          dominantOverlapTokens: second.dominantOverlapTokens,
        },
        margin: Math.abs(best.score - second.score),
        requiredMargin: MARGIN,
      });

      return {
        kind: "resolved_single",
        hit: { id: best.cand.serviceId, name: best.cand.label },
        candidates: topCandidates,
      };
    }

    if (mode === "loose" && sameFamily && strongExplicitEvidence) {
      console.log(
        "[RESOLVE-SERVICE] empate dentro de la misma familia en modo loose, devolviendo ambiguous para evitar auto-pick incorrecto",
        {
          userText,
          best: {
            label: best.cand.label,
            score: best.score,
            category: best.cand.category,
            tipo: best.cand.tipo,
            exactNameHits: best.exactNameHits,
            exactVariantHits: best.exactVariantHits,
            dominantOverlapTokens: best.dominantOverlapTokens,
            allOverlapTokens: best.allOverlapTokens,
          },
          second: {
            label: second.cand.label,
            score: second.score,
            category: second.cand.category,
            tipo: second.cand.tipo,
            exactNameHits: second.exactNameHits,
            exactVariantHits: second.exactVariantHits,
            dominantOverlapTokens: second.dominantOverlapTokens,
            allOverlapTokens: second.allOverlapTokens,
          },
          sameFamily,
          strongExplicitEvidence,
          margin: Math.abs(best.score - second.score),
          requiredMargin: MARGIN,
        }
      );

      return {
        kind: "ambiguous",
        hit: null,
        candidates:
          ambiguousCandidates.length > 0 ? ambiguousCandidates : topCandidates,
      };
    }

    console.log(
      "[RESOLVE-SERVICE] empate entre best y second (margin pequeño), devolviendo null",
      {
        userText,
        best: {
          label: best.cand.label,
          score: best.score,
          category: best.cand.category,
          tipo: best.cand.tipo,
          dominantOverlapTokens: best.dominantOverlapTokens,
          allOverlapTokens: best.allOverlapTokens,
        },
        second: {
          label: second.cand.label,
          score: second.score,
          category: second.cand.category,
          tipo: second.cand.tipo,
          dominantOverlapTokens: second.dominantOverlapTokens,
          allOverlapTokens: second.allOverlapTokens,
        },
        sameFamily,
        strongExplicitEvidence,
        margin: Math.abs(best.score - second.score),
        requiredMargin: MARGIN,
      }
    );

    return {
      kind: "ambiguous",
      hit: null,
      candidates:
        ambiguousCandidates.length > 0 ? ambiguousCandidates : topCandidates,
    };
  }

  const bestVariants = Array.isArray(best?.cand.variants) ? best.cand.variants : [];
  const hasMultipleVariants = bestVariants.length > 1;
  const hasExplicitVariantEvidence =
    (best?.exactVariantHits || 0) > 0 ||
    (best?.overlapVariantTokens?.length || 0) > 0;

  if (best && hasMultipleVariants && !hasExplicitVariantEvidence) {
    const variantCandidates: ResolveServiceCandidate[] = bestVariants.map((variant) => ({
      id: best.cand.serviceId,
      name: variant.variantName,
      score: best.score,
      category: best.cand.category || null,
      tipo: best.cand.tipo || null,
      parentServiceId: best.cand.parentServiceId || null,
      catalogRole: best.cand.catalogRole || null,
      variantId: variant.variantId,
      variantName: variant.variantName,
      candidateKind: "variant",
      serviceName: best.cand.label,
      overlapNameTokens: best.overlapNameTokens,
      overlapTipoTokens: best.overlapTipoTokens,
      overlapSupportTokens: best.overlapSupportTokens,
      dominantOverlapTokens: best.dominantOverlapTokens,
    }));

    console.log("[RESOLVE-SERVICE] servicio resuelto pero variante ambigua, devolviendo ambiguous", {
      userText,
      serviceId: best.cand.serviceId,
      serviceName: best.cand.label,
      variantOptions: variantCandidates.map((v) => ({
        variantId: v.variantId,
        variantName: v.variantName,
      })),
    });

    return {
      kind: "ambiguous",
      hit: null,
      candidates: variantCandidates,
    };
  }

  console.log("[RESOLVE-SERVICE] match aceptado por evidencia resolutiva", {
    userText,
    label: best.cand.label,
    score: best.score,
  });

  return {
    kind: "resolved_single",
    hit: { id: best.cand.serviceId, name: best.cand.label },
    candidates: topCandidates,
  };
}

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string,
  opts?: ResolveServiceOptions
): Promise<Hit | null> {
  const result = await resolveServiceCandidatesFromText(
    pool,
    tenantId,
    userText,
    opts
  );

  return result.kind === "resolved_single" ? result.hit : null;
}