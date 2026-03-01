// src/lib/services/pricing/resolveServiceIdFromText.ts

import type { Pool } from "pg";
import { detectarIdioma } from "../../detectarIdioma";
import { traducirMensaje } from "../../traducirMensaje";

export type Hit = { id: string; name: string };

type Candidate = {
  serviceId: string;
  label: string;
  tokens: string[];
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
  "clase",
  "clases",
  "service",
  "services",
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
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * Score determinista simple:
 * score = (# tokens en común) / (# tokens del servicio)
 */
function scoreTokens(queryTokens: string[], serviceTokens: string[]): number {
  if (!queryTokens.length || !serviceTokens.length) return 0;

  const qSet = new Set(queryTokens);
  let common = 0;

  for (const t of serviceTokens) {
    if (qSet.has(t)) common += 1;
  }

  return common / serviceTokens.length; // 1.0 = todos los tokens del servicio aparecen en la query
}

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string
): Promise<Hit | null> {
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
      tAlt = normalize(await traducirMensaje(t, "en"));
    } else if (idioma === "en") {
      tAlt = normalize(await traducirMensaje(t, "es"));
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
  }>(
    `
    WITH base AS (
      SELECT
        s.id   AS service_id,
        s.name AS label
      FROM services s
      WHERE
        s.tenant_id = $1
        AND s.active = true
        AND s.name IS NOT NULL

      UNION ALL

      SELECT
        s.id           AS service_id,
        v.variant_name AS label
      FROM service_variants v
      JOIN services s ON s.id = v.service_id
      WHERE
        s.tenant_id = $1
        AND s.active = true
        AND v.active = true
        AND v.variant_name IS NOT NULL
    )
    SELECT service_id, label
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
    { serviceId: string; labels: string[]; tokenSet: Set<string> }
  >();

  for (const r of rows) {
    const label = String(r.label || "").trim();
    if (!label) continue;

    const tokens = tokenize(label);
    if (!tokens.length) continue;

    const serviceId = String(r.service_id);
    let entry = grouped.get(serviceId);
    if (!entry) {
      entry = { serviceId, labels: [label], tokenSet: new Set(tokens) };
      grouped.set(serviceId, entry);
    } else {
      entry.labels.push(label);
      for (const tk of tokens) entry.tokenSet.add(tk);
    }
  }

  const candidates: Candidate[] = Array.from(grouped.values()).map((g) => {
    // tomamos como label "principal" el más corto (suele ser el nombre del servicio)
    const mainLabel = g.labels.sort((a, b) => a.length - b.length)[0];
    return {
      serviceId: g.serviceId,
      label: mainLabel,
      tokens: Array.from(g.tokenSet),
    };
  });

  if (!candidates.length) {
    console.log("[RESOLVE-SERVICE] candidatos sin tokens, devolviendo null");
    return null;
  }

  // 3) Scoring determinista para todos los candidatos
  type Scored = { cand: Candidate; score: number };

  const scored: Scored[] = candidates.map((cand) => {
    const s1 = scoreTokens(qTokens1, cand.tokens);
    const s2 = qTokens2.length ? scoreTokens(qTokens2, cand.tokens) : 0;
    return { cand, score: Math.max(s1, s2) };
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

  // Parámetros de decisión
  const BASE_THRESHOLD = 0.6; // para frases más específicas (>= 2 tokens fuertes)
  const SINGLE_TOKEN_THRESHOLD = 0.7; // para queries de 1 token (ej. "bronze")
  const MARGIN = 0.2; // diferencia mínima con el segundo para confiar

    // 4) Caso especial: SOLO un token fuerte (ej. "gold", "bronce", "deluxe")
  if (strongTokens.length === 1) {
    const token = strongTokens[0];

    // buscamos candidatos cuyo token list contenga ese token
    const withToken = scored.filter((s) => s.cand.tokens.includes(token));

    if (withToken.length !== 1) {
      console.log(
        "[RESOLVE-SERVICE] 1 token fuerte pero",
        withToken.length,
        "candidatos → ambiguo, devolviendo null"
      );
      return null;
    }

    const only = withToken[0];

    console.log("[RESOLVE-SERVICE] match único por token fuerte (1-token)", {
      userText,
      token,
      label: only.cand.label,
      score: only.score,
    });

    // 💡 ya que solo hay UN servicio con ese token, lo aceptamos sin mirar umbral
    return { id: only.cand.serviceId, name: only.cand.label };
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