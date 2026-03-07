// src/lib/services/pricing/resolveServiceIdFromText.ts

import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirTexto } from "../../traducirTexto";

export type Hit = { id: string; name: string };

type Candidate = {
  serviceId: string;
  label: string;
  serviceTokens: string[];
  variantTokens: string[];
};

const STOPWORDS = new Set([
  // ES artículos / conectores
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
  "de",
  "del",
  "la",
  "el",
  "le",
  "los",
  "las",
  "lo",
  "al",
  // EN artículos / conectores
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
  // precio / genérico
  "precio",
  "precios",
  "cuanto",
  "cuanta",
  "cuestan",
  "cuesta",
  "vale",
  "costo",
  "price",
  "prices",
  "cost",
  "how",
  "much",
  // includes
  "include",
  "includes",
  "incluye",
  "incluyen",
  // términos genéricos de planes / servicios
  "plan",
  "planes",
  "membresia",
  "membresias",
  "mensual",
  "mensuales",
  "monthly",
  "membership",
  "memberships",
  // ⬇⬇ OJO: ya NO ponemos "clase"/"clases" como stopwords
  // porque son clave para "4 clases", "8 clases", etc.
  "service",
  "services",
  // ⬇⬇ NUEVO: que “paquete” no cuente como token fuerte
  "paquete",
  "paquetes",
  "pack",
  "package",
]);

function normalize(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function buildTenantTokenDf(candidates: Candidate[]): Map<string, number> {
  const df = new Map<string, number>();

  for (const cand of candidates) {
    const seen = new Set([
      ...(cand.serviceTokens || []),
      ...(cand.variantTokens || []),
    ]);

    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  return df;
}

function tokenize(raw: string): string[] {
  return normalize(raw)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => {
      if (!w) return false;

      // 🔹 Dejamos pasar números como "4", "8", "12"
      if (/^\d+$/.test(w)) {
        return true;
      }

      // 🔹 Para palabras normales, misma lógica de antes:
      return w.length >= 2 && !STOPWORDS.has(w);
    });
}

function scoreTokensWeighted(
  queryTokens: string[],
  serviceTokens: string[],
  dfMap: Map<string, number>,
  totalCandidates: number
): number {
  if (!queryTokens.length || !serviceTokens.length || totalCandidates <= 0) return 0;

  const qSet = new Set(queryTokens);

  let matchedWeight = 0;
  let totalWeight = 0;

  for (const t of serviceTokens) {
    const df = dfMap.get(t) || 1;

    // cuanto más común es el token en el tenant, menos pesa
    const weight = Math.log(1 + totalCandidates / df);

    totalWeight += weight;
    if (qSet.has(t)) matchedWeight += weight;
  }

  return totalWeight > 0 ? matchedWeight / totalWeight : 0;
}

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string,
  opts?: { mode?: "strict" | "loose" }
): Promise<Hit | null> {
  const mode: "strict" | "loose" = opts?.mode || "strict";
  let t = String(userText || "").trim();
  if (!t) return null;

  // 1) Idioma + posible traducción cruzada ES <-> EN
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
      // 🔹 usamos traducirTexto en vez de traducirMensaje
      tAlt = normalize(await traducirTexto(t, "en"));
    } else if (idioma === "en") {
      tAlt = normalize(await traducirTexto(t, "es"));
    }
  } catch {
    tAlt = "";
  }

  const qTokens1 = tokenize(tNorm);
  const qTokens2 = tAlt ? tokenize(tAlt) : [];

  // tokens "fuertes" = unión de ambos sets
  const strongTokens = Array.from(new Set([...qTokens1, ...qTokens2]));

  if (!qTokens1.length && !qTokens2.length) {
    console.log("[RESOLVE-SERVICE] sin tokens fuertes, devolviendo null");
    return null;
  }

  // 2) Traer candidatos desde DB (services + service_variants)
  const { rows } = await pool.query<{
    service_id: string;
    label: string;
    label_type: "service" | "variant";
  }>(
    `
    WITH base AS (
      SELECT
        s.id   AS service_id,
        s.name AS label,
        'service'::text AS label_type
      FROM services s
      WHERE
        s.tenant_id = $1
        AND s.active = true
        AND s.name IS NOT NULL

      UNION ALL

      SELECT
        s.id           AS service_id,
        v.variant_name AS label,
        'variant'::text AS label_type
      FROM service_variants v
      JOIN services s ON s.id = v.service_id
      WHERE
        s.tenant_id = $1
        AND s.active = true
        AND v.active = true
        AND v.variant_name IS NOT NULL
    )
    SELECT service_id, label, label_type
    FROM base
    `,
    [tenantId]
  );

  if (!rows.length) {
    console.log("[RESOLVE-SERVICE] sin candidatos en DB, devolviendo null");
    return null;
  }

  // 🔹 Agrupamos por service_id para que Gold tenga UN solo candidato
  const grouped = new Map<
    string,
    {
      serviceId: string;
      serviceLabel: string | null;
      serviceTokenSet: Set<string>;
      variantTokenSet: Set<string>;
    }
  >();

  for (const r of rows) {
    const label = String(r.label || "").trim();
    if (!label) continue;

    const tokens = tokenize(label);
    if (!tokens.length) continue;

    const serviceId = String(r.service_id);
    let entry = grouped.get(serviceId);

    if (!entry) {
      entry = {
        serviceId,
        serviceLabel: null,
        serviceTokenSet: new Set<string>(),
        variantTokenSet: new Set<string>(),
      };
      grouped.set(serviceId, entry);
    }

    if (r.label_type === "service") {
      entry.serviceLabel = label;
      for (const tk of tokens) entry.serviceTokenSet.add(tk);
    } else {
      for (const tk of tokens) entry.variantTokenSet.add(tk);
    }
  }

  const candidates: Candidate[] = Array.from(grouped.values()).map((g) => ({
    serviceId: g.serviceId,
    label: g.serviceLabel || "Service",
    serviceTokens: Array.from(g.serviceTokenSet),
    variantTokens: Array.from(g.variantTokenSet),
  }));

  const dfMap = buildTenantTokenDf(candidates);
  const totalCandidates = candidates.length;

  if (!candidates.length) {
    console.log("[RESOLVE-SERVICE] candidatos sin tokens, devolviendo null");
    return null;
  }

  // 3) Scoring determinista para todos los candidatos
  type Scored = { cand: Candidate; score: number };

  const scored: Scored[] = candidates.map((cand) => {
    const serviceScore1 = scoreTokensWeighted(
      qTokens1,
      cand.serviceTokens.length ? cand.serviceTokens : cand.variantTokens,
      dfMap,
      totalCandidates
    );

    const serviceScore2 = qTokens2.length
      ? scoreTokensWeighted(
          qTokens2,
          cand.serviceTokens.length ? cand.serviceTokens : cand.variantTokens,
          dfMap,
          totalCandidates
        )
      : 0;

    const variantScore1 = cand.variantTokens.length
      ? scoreTokensWeighted(qTokens1, cand.variantTokens, dfMap, totalCandidates)
      : 0;

    const variantScore2 = qTokens2.length && cand.variantTokens.length
      ? scoreTokensWeighted(qTokens2, cand.variantTokens, dfMap, totalCandidates)
      : 0;

    const baseScore = Math.max(serviceScore1, serviceScore2);
    const variantScore = Math.max(variantScore1, variantScore2);

    const qSet = new Set([...qTokens1, ...qTokens2]);
    const exactServiceHits = cand.serviceTokens.filter((t) => qSet.has(t)).length;
    const exactVariantHits = cand.variantTokens.filter((t) => qSet.has(t)).length;

    let score = baseScore;

    // bono por match directo en nombre del servicio
    if (exactServiceHits > 0) {
      score += exactServiceHits * 0.25;
    }

    // las variantes ayudan, pero menos
    if (exactVariantHits > 0) {
      score += exactVariantHits * 0.08;
    }

    return { cand, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  console.log("[RESOLVE-SERVICE] debug", {
    userText,
    idioma,
    strongTokens,
    best: best
      ? { label: best.cand.label, score: best.score, serviceId: best.cand.serviceId }
      : null,
    second: second
      ? { label: second.cand.label, score: second.score, serviceId: second.cand.serviceId }
      : null,
  });

  // Parámetros de decisión (dependen del modo)
  const BASE_THRESHOLD = mode === "strict" ? 0.6 : 0.30;
  const SINGLE_TOKEN_THRESHOLD = mode === "strict" ? 0.7 : 0.3;
  const MARGIN = mode === "strict" ? 0.2 : 0.1;

  // 4) Caso especial: SOLO un token fuerte (ej. "bronze", "gold", "deluxe")
  if (strongTokens.length === 1) {
    const token = strongTokens[0];

    const withToken = scored.filter((s) => {
      const allTokens = [
        ...(s.cand.serviceTokens || []),
        ...(s.cand.variantTokens || []),
      ];
      return s.score > 0 && allTokens.includes(token);
    });

    if (mode === "strict") {
      // Comportamiento anterior: si no hay exactamente 1 candidato → ambiguo
      if (withToken.length !== 1) {
        console.log(
          "[RESOLVE-SERVICE] (strict) 1 token fuerte pero",
          withToken.length,
          "candidatos → ambiguo, devolviendo null"
        );
        return null;
      }

      const only = withToken[0];

      if (only.score >= SINGLE_TOKEN_THRESHOLD) {
        console.log("[RESOLVE-SERVICE] (strict) match único por token fuerte", {
          userText,
          token,
          label: only.cand.label,
          score: only.score,
        });
        return { id: only.cand.serviceId, name: only.cand.label };
      }

      console.log(
        "[RESOLVE-SERVICE] (strict) 1 token fuerte, 1 candidato pero score bajo, devolviendo null",
        {
          userText,
          token,
          label: only.cand.label,
          score: only.score,
        }
      );
      return null;
    }

    // ======== modo LOOSE (para "qué incluye el plan X") ========
    if (!withToken.length) {
      console.log(
        "[RESOLVE-SERVICE] (loose) 1 token fuerte pero 0 candidatos, devolviendo null",
        { userText, token }
      );
      return null;
    }

    // Agrupar por serviceId y quedarnos con el mejor de cada servicio
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

    console.log("[RESOLVE-SERVICE] (loose) match por token fuerte", {
      userText,
      token,
      label: bestLoose.cand.label,
      score: bestLoose.score,
      serviceId: bestLoose.cand.serviceId,
    });

    return { id: bestLoose.cand.serviceId, name: bestLoose.cand.label };
  }

  // 5) Caso general: 2+ tokens fuertes → usar mejor score con margen
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

  console.log("[RESOLVE-SERVICE] match aceptado (>=2 tokens fuertes)", {
    userText,
    label: best.cand.label,
    score: best.score,
  });

  return { id: best.cand.serviceId, name: best.cand.label };
}