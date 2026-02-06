import type { Pool } from "pg";
import { traducirMensaje } from "../../traducirMensaje";

type Need = "price" | "duration" | "includes" | string;

const STOP_ES = new Set([
  "cuanto", "cuánto", "cuesta", "valen", "vale", "precio", "precios", "tarifa", "tarifas",
  "el", "la", "los", "las", "un", "una", "unos", "unas",
  "de", "del", "al", "a", "por", "para", "en", "y", "o", "que", "qué",
  "me", "mi", "tu", "sus", "su",
]);

const STOP_EN = new Set([
  "how", "much", "is", "are", "price", "prices", "cost", "rate", "rates", "fee", "fees",
  "the", "a", "an", "to", "for", "of", "in", "on", "and", "or", "what",
  "me", "my", "your",
]);

function tokenize(raw: string) {
  return String(raw || "")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñ]+/i)
    .filter(Boolean)
    .slice(0, 16);
}

function stripStopwords(tokens: string[]) {
  return tokens.filter((t) => !STOP_ES.has(t) && !STOP_EN.has(t));
}

// Expansiones “universales” (NO por industria):
// - “haircut” → también busca “cut”
// - “corte” → también busca “cut” (por traducción o por token directo)
function expandTokens(tokens: string[]) {
  const out = new Set(tokens);
  for (const t of tokens) {
    if (t === "haircut") out.add("cut");
    if (t === "corte") out.add("cut");
    if (t === "pelo" || t === "cabello") out.add("hair");
  }
  return Array.from(out);
}

function buildPattern(tokens: string[]) {
  const cleaned = stripStopwords(tokens);
  const expanded = expandTokens(cleaned);

  // Prioridad genérica (no vertical)
  const priority = ["haircut", "cut", "hair", "plan", "package", "class", "membership"];
  expanded.sort((a, b) => (priority.includes(b) ? 1 : 0) - (priority.includes(a) ? 1 : 0));

  const top = expanded.slice(0, 4).join(" ").trim();
  return top ? `%${top}%` : "";
}

export async function resolveServiceInfoByDb(args: {
  pool: Pool;
  tenantId: string;
  query: string;
  need?: Need;
  limit?: number;
}) {
  const { pool, tenantId, query } = args;
  const q = String(query || "").trim();
  if (!q) return { ok: false as const, reason: "no_match" as const };

  // 1) patrón en el idioma original
  const patternA = buildPattern(tokenize(q));

  // 2) patrón traducido a EN para matchear catálogos guardados en inglés
  let qEn = "";
  try {
    qEn = String(await traducirMensaje(q, "en") || "").trim();
  } catch {
    qEn = "";
  }
  const patternB = qEn ? buildPattern(tokenize(qEn)) : "";

  const patterns = [patternA, patternB].filter(Boolean);
  if (!patterns.length) return { ok: false as const, reason: "no_match" as const };

  // arma WHERE (like p1 OR like p2 ...)
  const likeClause = patterns
    .map((_, i) => `lower(v.variant_name) LIKE lower($${i + 2}) OR lower(s.name) LIKE lower($${i + 2})`)
    .join(" OR ");

  const params = [tenantId, ...patterns];

  // 1) VARIANTS primero
  const vr = await pool.query(
    `
    SELECT
      s.id AS service_id,
      s.name AS service_name,
      s.description AS service_desc,
      s.duration_min AS service_duration,
      s.price_base AS service_price_base,
      s.service_url AS service_url,

      v.id AS variant_id,
      v.variant_name,
      v.description AS variant_desc,
      v.duration_min AS variant_duration,
      v.price AS variant_price,
      COALESCE(v.currency, 'USD') AS variant_currency,
      v.variant_url AS variant_url
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND v.active = TRUE
      AND v.price IS NOT NULL
      AND ( ${likeClause} )
    ORDER BY v.updated_at DESC NULLS LAST
    LIMIT 5
    `,
    params
  );

  if (vr.rows?.length === 1) {
    const row = vr.rows[0];
    const price =
      row.variant_price != null ? Number(row.variant_price)
      : row.service_price_base != null ? Number(row.service_price_base)
      : null;

    return {
      ok: true as const,
      kind: "variant" as const,
      label: `${row.service_name} - ${row.variant_name}`,
      url: row.variant_url || row.service_url || null,
      price,
      currency: row.variant_currency ? String(row.variant_currency) : "USD",
      duration_min:
        row.variant_duration != null ? Number(row.variant_duration)
        : row.service_duration != null ? Number(row.service_duration)
        : null,
      description:
        row.variant_desc && String(row.variant_desc).trim()
          ? String(row.variant_desc)
          : row.service_desc ? String(row.service_desc) : null,
      service_id: String(row.service_id),
      variant_id: String(row.variant_id),
    };
  }

  if (vr.rows?.length > 1) {
    return {
      ok: false as const,
      reason: "ambiguous" as const,
      options: vr.rows.map((r: any) => ({
        label: `${r.service_name} - ${r.variant_name}`,
        kind: "variant",
        service_id: String(r.service_id),
        variant_id: String(r.variant_id),
      })),
    };
  }

  // 2) SERVICES si no hay variantes
  const likeClauseS = patterns
    .map((_, i) => `lower(s.name) LIKE lower($${i + 2})`)
    .join(" OR ");

  const sr = await pool.query(
    `
    SELECT
      s.id AS service_id,
      s.name AS service_name,
      s.description AS service_desc,
      s.duration_min AS service_duration,
      s.price_base AS service_price_base,
      s.service_url AS service_url
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND ( ${likeClauseS} )
    ORDER BY s.updated_at DESC NULLS LAST
    LIMIT 5
    `,
    params
  );

  if (sr.rows?.length === 1) {
    const row = sr.rows[0];
    return {
      ok: true as const,
      kind: "service" as const,
      label: String(row.service_name),
      url: row.service_url || null,
      price: row.service_price_base != null ? Number(row.service_price_base) : null,
      currency: "USD",
      duration_min: row.service_duration != null ? Number(row.service_duration) : null,
      description: row.service_desc ? String(row.service_desc) : null,
      service_id: String(row.service_id),
      variant_id: undefined,
    };
  }

  if (sr.rows?.length > 1) {
    return {
      ok: false as const,
      reason: "ambiguous" as const,
      options: sr.rows.map((r: any) => ({
        label: String(r.service_name),
        kind: "service",
        service_id: String(r.service_id),
        variant_id: null,
      })),
    };
  }

  return { ok: false as const, reason: "no_match" as const };
}
