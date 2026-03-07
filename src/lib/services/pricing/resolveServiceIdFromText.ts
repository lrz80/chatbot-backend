import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirTexto } from "../../traducirTexto";

export type Hit = { id: string; name: string };

type Candidate = {
  serviceId: string;
  label: string;
  serviceNameTokens: string[];
  catalogTokens: string[];
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
      if (/^\d+$/.test(w)) return true;
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

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string,
  opts?: { mode?: "strict" | "loose" }
): Promise<Hit | null> {
  const mode: "strict" | "loose" = opts?.mode || "strict";
  const t = String(userText || "").trim();
  if (!t) return null;

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
    return null;
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
    console.log("[RESOLVE-SERVICE] sin candidatos en DB, devolviendo null");
    return null;
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
    label: g.serviceLabel || "Service",
    serviceNameTokens: Array.from(g.serviceNameTokenSet),
    catalogTokens: Array.from(g.catalogTokenSet),
  }));

  if (!candidates.length) {
    console.log("[RESOLVE-SERVICE] candidatos sin tokens, devolviendo null");
    return null;
  }

  const dfMap = buildTenantTokenDf(candidates);
  const totalCandidates = candidates.length;

  type Scored = { cand: Candidate; score: number };

  const scored: Scored[] = candidates.map((cand) => {
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

    let score = 0;

    // Peso principal: el nombre del servicio
    score += nameScore * 0.65;

    // Peso secundario: descripción + variantes del catálogo
    score += catalogScore * 0.35;

    // Premios por cobertura exacta real del catálogo
    score += exactNameHits * 0.22;
    score += exactCatalogHits * 0.06;

    return { cand, score };
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

  const BASE_THRESHOLD = mode === "strict" ? 0.6 : 0.3;
  const SINGLE_TOKEN_THRESHOLD = mode === "strict" ? 0.7 : 0.3;
  const MARGIN = mode === "strict" ? 0.2 : 0.1;

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
        return null;
      }

      const only = withToken[0];

      if (only.score >= SINGLE_TOKEN_THRESHOLD) {
        console.log("[RESOLVE-SERVICE] (strict) match único por token útil", {
          userText,
          token,
          label: only.cand.label,
          score: only.score,
        });
        return { id: only.cand.serviceId, name: only.cand.label };
      }

      console.log(
        "[RESOLVE-SERVICE] (strict) 1 token útil, 1 candidato pero score bajo, devolviendo null",
        {
          userText,
          token,
          label: only.cand.label,
          score: only.score,
        }
      );
      return null;
    }

    if (!withToken.length) {
      console.log(
        "[RESOLVE-SERVICE] (loose) 1 token útil pero 0 candidatos, devolviendo null",
        { userText, token }
      );
      return null;
    }

    const byService = new Map<string, { cand: Candidate; score: number }>();
    for (const s of withToken) {
      const key = s.cand.serviceId;
      const prev = byService.get(key);
      if (!prev || s.score > prev.score) {
        byService.set(key, s);
      }
    }

    const bestList = Array.from(byService.values()).sort((a, b) => b.score - a.score);
    const bestLoose = bestList[0];

    if (!bestLoose || bestLoose.score < SINGLE_TOKEN_THRESHOLD) {
      console.log(
        "[RESOLVE-SERVICE] (loose) mejor candidato por debajo de threshold, devolviendo null",
        {
          userText,
          token,
          label: bestLoose?.cand.label,
          score: bestLoose?.score,
        }
      );
      return null;
    }

    console.log("[RESOLVE-SERVICE] (loose) match por token útil", {
      userText,
      token,
      label: bestLoose.cand.label,
      score: bestLoose.score,
      serviceId: bestLoose.cand.serviceId,
    });

    return { id: bestLoose.cand.serviceId, name: bestLoose.cand.label };
  }

  if (!best || best.score < BASE_THRESHOLD) {
    console.log("[RESOLVE-SERVICE] best.score por debajo del umbral, devolviendo null", {
      userText,
      bestScore: best?.score,
      threshold: BASE_THRESHOLD,
    });
    return null;
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
    return null;
  }

  console.log("[RESOLVE-SERVICE] match aceptado (>=2 tokens útiles)", {
    userText,
    label: best.cand.label,
    score: best.score,
  });

  return { id: best.cand.serviceId, name: best.cand.label };
}