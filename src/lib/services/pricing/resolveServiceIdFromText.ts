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
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas",
  "para", "por", "en", "y", "o", "u", "a",
  "que", "q", "este", "esta", "ese", "esa", "esto", "eso",
  // EN artículos / conectores
  "the", "a", "an", "and", "or", "to", "for", "in", "of", "what", "does",
  // precio / genérico
  "precio", "precios", "cuanto", "cuanta", "cuestan", "cuesta", "vale", "costo",
  "price", "prices", "cost", "how", "much",
  "include", "includes", "incluye", "incluyen",
  // términos genéricos de planes
  "plan", "planes", "membresia", "membresias",
  "mensual", "mensuales", "monthly", "membership", "memberships",
  "clase", "clases", "service", "services"
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
 * Score determinista: solapamiento de tokens.
 * score = (# tokens en común) / (# tokens del servicio)
 */
function scoreTokens(queryTokens: string[], serviceTokens: string[]): number {
  if (!queryTokens.length || !serviceTokens.length) return 0;

  const qSet = new Set(queryTokens);
  let common = 0;

  for (const t of serviceTokens) {
    if (qSet.has(t)) common += 1;
  }

  return common / serviceTokens.length; // 1.0 = todos los tokens coinciden
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

  if (!qTokens1.length && !qTokens2.length) return null;

  // 2) Traer candidatos desde DB (services + service_variants)
  const { rows } = await pool.query<{
    service_id: string;
    label: string;
  }>(
    `
    WITH base AS (
      SELECT
        s.id AS service_id,
        s.name AS label
      FROM services s
      WHERE
        s.tenant_id = $1
        AND s.active = true
        AND s.name IS NOT NULL

      UNION ALL

      SELECT
        s.id AS service_id,
        v.label AS label
      FROM service_variants v
      JOIN services s ON s.id = v.service_id
      WHERE
        s.tenant_id = $1
        AND s.active = true
        AND v.label IS NOT NULL
    )
    SELECT service_id, label
    FROM base
    `,
    [tenantId]
  );

  if (!rows.length) return null;

  const candidates: Candidate[] = rows
    .map((r) => {
      const label = String(r.label || "").trim();
      const tokens = tokenize(label);
      if (!label || !tokens.length) return null;
      return {
        serviceId: String(r.service_id),
        label,
        tokens
      };
    })
    .filter(Boolean) as Candidate[];

  if (!candidates.length) return null;

  // 3) Scoring determinista
  type Scored = { cand: Candidate; score: number };

  const scored: Scored[] = candidates.map((cand) => {
    const s1 = scoreTokens(qTokens1, cand.tokens);
    const s2 = qTokens2.length ? scoreTokens(qTokens2, cand.tokens) : 0;
    return { cand, score: Math.max(s1, s2) };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  // Umbral mínimo: al menos un token fuerte debe coincidir
  const THRESHOLD = 0.34; // p.ej. 1 de 3 tokens
  const MARGIN = 0.15;    // diferencia mínima con el segundo

  if (!best || best.score < THRESHOLD) {
    return null;
  }

  // Si hay otro casi igual de bueno, lo marcamos como ambiguo (upstream decidirá)
  if (second && second.score > 0 && Math.abs(best.score - second.score) < MARGIN) {
    return null;
  }

  return { id: best.cand.serviceId, name: best.cand.label };
}