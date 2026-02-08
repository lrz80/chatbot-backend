// backend/src/lib/services/fastpath/resolveServiceInfoByDb.ts
import type { Pool } from "pg";

type Need = "price" | "duration" | "includes" | "any" | string;

type Resolved =
  | {
      ok: true;
      kind: "service" | "variant";
      label: string;
      url: string | null;
      price: number | null;
      currency: string | null;
      duration_min: number | null;
      description: string | null;
      service_id: string;
      variant_id?: string;
    }
  | {
      ok: false;
      reason: "no_match" | "ambiguous";
      options?: Array<{
        label: string;
        kind: "service" | "variant";
        service_id: string;
        variant_id?: string | null;
      }>;
    };

function stripAccents(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function norm(s: string) {
  return stripAccents(String(s || "").toLowerCase())
    .replace(/[^a-z0-9ñ\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string) {
  const t = norm(s);
  if (!t) return [];
  return t.split(" ").filter(Boolean);
}

const STOP = new Set([
  // ES
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "un",
  "una",
  "unos",
  "unas",
  "para",
  "por",
  "que",
  "quiero",
  "necesito",
  "dame",
  "mas",
  "info",
  "informacion",
  "detalles",
  "precio",
  "precios",
  "cuanto",
  "cuesta",
  "vale",
  "tarifa",
  "tarifas",
  // EN
  "the",
  "a",
  "an",
  "to",
  "for",
  "and",
  "or",
  "of",
  "in",
  "on",
  "is",
  "are",
  "price",
  "prices",
  "cost",
  "costs",
  "how",
  "much",
  "rate",
  "rates",
  "fee",
  "fees",
  "pricing",
]);

function contentTokens(text: string) {
  return tokenize(text).filter((w) => w.length >= 2 && !STOP.has(w));
}

function diceCoefficient(a: string, b: string) {
  // bigrams dice, barato y suficiente
  if (!a || !b) return 0;
  if (a === b) return 1;

  const bigrams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };

  const A = bigrams(a);
  const B = bigrams(b);

  const map = new Map<string, number>();
  for (const x of A) map.set(x, (map.get(x) || 0) + 1);

  let inter = 0;
  for (const x of B) {
    const n = map.get(x) || 0;
    if (n > 0) {
      inter++;
      map.set(x, n - 1);
    }
  }

  return (2 * inter) / (A.length + B.length);
}

function scoreCandidate(query: string, label: string) {
  const qn = norm(query);
  const ln = norm(label);

  const qTokens = contentTokens(query);
  if (!qTokens.length) return 0;

  const lTokens = new Set(contentTokens(label));

  // overlap fuerte
  let overlap = 0;
  for (const tok of qTokens) if (lTokens.has(tok)) overlap++;

  // substring bonus
  const substr = ln.includes(qn) || qn.includes(ln) ? 2 : 0;

  // fuzzy bonus (bigrams)
  const fuzzy = diceCoefficient(qn, ln) * 3; // 0..3

  // token prefix bonus (ej: "hair" vs "haircut")
  let prefix = 0;
  for (const tok of qTokens) {
    if (tok.length >= 3) {
      for (const lt of lTokens) {
        if (lt.startsWith(tok) || tok.startsWith(lt)) {
          prefix += 0.3;
          break;
        }
      }
    }
  }

  return overlap * 3 + substr + fuzzy + prefix;
}

/**
 * Resolver DB-first por scoring:
 * - trae candidatos (variants + services con precio o descripción)
 * - rankea por similitud contra query
 * - si top es claro => ok
 * - si hay empate cercano => ambiguous con menú
 *
 * Nota: NO hardcode de "grooming". Solo matching semántico y fuzzy.
 */
export async function resolveServiceInfoByDb(args: {
  pool: Pool;
  tenantId: string;
  query: string;
  need?: Need;
  limit?: number;
}): Promise<Resolved> {
  const { pool, tenantId } = args;
  const userQuery = String(args.query || "").trim();
  if (!userQuery) return { ok: false, reason: "no_match" };

  const limit = Math.min(Math.max(Number(args.limit || 5), 3), 8);

  const need = String(args.need || "");

  const wantsPrice = need === "price" || need === "any";
  const wantsDuration = need === "duration" || need === "any";
  const wantsIncludes = need === "includes" || need === "any";

  // Si no vino need, asume "any" pero SIN mezclar señales:
  // deja que el scoring elija por label, no por “includes”.
  // (o sea: no lo uses para filtrar candidates)
  const isNeedUnknown = !need;

  // Importante: "uñas" (con ñ) sí; "unas" (sin ñ) NO.
  // Como luego normalizamos y se pierde la ñ, detectamos antes.
  const hasEnye = /uñas|uña/i.test(userQuery);

  // Expand tokens mínimamente (universal, no por industria)
  // - "corte de pelo" ≈ "haircut"
  // - "uñas" (con ñ) ≈ "nails"
  // - no tocamos "unas" sin ñ
  let qExpanded = userQuery;
  if (/\bcorte\b/i.test(userQuery) && /\bpelo\b/i.test(userQuery)) qExpanded += " haircut hair cut";
  if (hasEnye) qExpanded += " nails nail";

  // 1) Variants candidates
  const vRes = await pool.query(
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
      AND (
        ($2::boolean = TRUE AND v.price IS NOT NULL)
        OR ($3::boolean = TRUE AND v.duration_min IS NOT NULL)
        OR ($4::boolean = TRUE AND v.description IS NOT NULL AND length(trim(v.description)) > 0)
        OR ($5::boolean = TRUE) -- fallback para need desconocido
      )
    ORDER BY v.updated_at DESC NULLS LAST, v.created_at DESC NULLS LAST
    LIMIT 250
    `,
    [tenantId, wantsPrice, wantsDuration, wantsIncludes, isNeedUnknown || need === "any"]
  );

  // 2) Services candidates (solo si tienen price_base o description)
  const sRes = await pool.query(
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
      AND (
        s.price_base IS NOT NULL
        OR (s.description IS NOT NULL AND length(trim(s.description)) > 0)
      )
    ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC NULLS LAST
    LIMIT 250
    `,
    [tenantId]
  );

  type Cand = {
    kind: "variant" | "service";
    label: string;
    service_id: string;
    variant_id?: string;
    url: string | null;
    price: number | null;
    currency: string | null;
    duration_min: number | null;
    description: string | null;
    _score: number;
  };

  const cands: Cand[] = [];

  for (const r of vRes.rows || []) {
    const label = `${r.service_name} - ${r.variant_name}`;
    const price =
      r.variant_price != null ? Number(r.variant_price)
      : r.service_price_base != null ? Number(r.service_price_base)
      : null;

    cands.push({
      kind: "variant",
      label,
      service_id: String(r.service_id),
      variant_id: String(r.variant_id),
      url: (r.variant_url || r.service_url || null) as string | null,
      price: price != null && Number.isFinite(price) ? price : null,
      currency: r.variant_currency ? String(r.variant_currency) : "USD",
      duration_min:
        r.variant_duration != null ? Number(r.variant_duration)
        : r.service_duration != null ? Number(r.service_duration)
        : null,
      description:
        r.variant_desc && String(r.variant_desc).trim()
          ? String(r.variant_desc)
          : r.service_desc ? String(r.service_desc) : null,
      _score: 0,
    });
  }

  for (const r of sRes.rows || []) {
    // si el service tiene variants con precio, igual lo dejamos;
    // el scoring decidirá si el user quiso “service” o una variante.
    const label = String(r.service_name);
    const price = r.service_price_base != null ? Number(r.service_price_base) : null;

    cands.push({
      kind: "service",
      label,
      service_id: String(r.service_id),
      url: (r.service_url || null) as string | null,
      price: price != null && Number.isFinite(price) ? price : null,
      currency: "USD",
      duration_min: r.service_duration != null ? Number(r.service_duration) : null,
      description: r.service_desc ? String(r.service_desc) : null,
      _score: 0,
    });
  }

  if (!cands.length) return { ok: false, reason: "no_match" };

  // Score
  for (const c of cands) c._score = scoreCandidate(qExpanded, c.label);

  // Ordena por score desc
  cands.sort((a, b) => b._score - a._score);

  const best = cands[0];
  const second = cands[1];

  // Umbral mínimo: si es muy bajo, no inventamos.
  if (!best || best._score < 3) return { ok: false, reason: "no_match" };

  // Ambiguo si el segundo está muy cerca del primero
  if (second && second._score >= best._score * 0.92) {
    const top = cands.slice(0, limit);

    return {
      ok: false,
      reason: "ambiguous",
      options: top.map((x) => ({
        label: x.label,
        kind: x.kind,
        service_id: x.service_id,
        variant_id: x.variant_id || null,
      })),
    };
  }

  // ✅ Regla universal:
  // Si ganó un SERVICE pero le falta la info pedida, y existen VARIANTS con esa info,
  // entonces NO respondas "no tengo": muestra opciones (o responde la única).
  const missingPrice =
    wantsPrice && (best.price == null || !Number.isFinite(best.price as any));

  const missingDuration =
    wantsDuration && (best.duration_min == null || !Number.isFinite(best.duration_min as any));

  const missingIncludes =
    wantsIncludes && (!best.description || !String(best.description).trim());

  if (best.kind === "service" && (missingPrice || missingDuration || missingIncludes)) {
    const vPick = await pool.query(
    `
    SELECT
      s.id AS service_id,
      s.name AS service_name,
      s.description AS service_desc,
      s.duration_min AS service_duration,

      v.id AS variant_id,
      v.variant_name,
      v.price,
      COALESCE(v.currency, 'USD') AS currency,
      v.duration_min AS variant_duration,
      v.description AS variant_desc,
      COALESCE(v.variant_url, s.service_url) AS url
    FROM services s
    JOIN service_variants v ON v.service_id = s.id
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND v.active = TRUE
      AND s.id = $2
      AND (
        ($4::boolean = TRUE AND v.price IS NOT NULL)
        OR ($5::boolean = TRUE AND v.duration_min IS NOT NULL)
        OR ($6::boolean = TRUE AND v.description IS NOT NULL AND length(trim(v.description)) > 0)
      )
    ORDER BY v.updated_at DESC NULLS LAST, v.created_at DESC NULLS LAST
    LIMIT $3
    `,
    [tenantId, best.service_id, limit, wantsPrice, wantsDuration, wantsIncludes]
    );

    const rows = vPick.rows || [];

    if (rows.length === 1) {
      const r = rows[0];

      const price = r.price != null ? Number(r.price) : null;
      const duration_min =
        r.variant_duration != null
          ? Number(r.variant_duration)
          : r.service_duration != null
            ? Number(r.service_duration)
            : null;

      const description =
        r.variant_desc && String(r.variant_desc).trim()
          ? String(r.variant_desc)
          : r.service_desc
            ? String(r.service_desc)
            : null;

      return {
        ok: true,
        kind: "variant",
        label: `${r.service_name} - ${r.variant_name}`,
        url: r.url || null,
        price,
        currency: r.currency ? String(r.currency) : "USD",
        duration_min,
        description,
        service_id: String(r.service_id),
        variant_id: String(r.variant_id),
      };
    }

    if (rows.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        options: rows.slice(0, limit).map((r: any) => ({
          label: `${r.service_name} - ${r.variant_name}`,
          kind: "variant" as const,
          service_id: String(r.service_id),
          variant_id: String(r.variant_id),
        })),
      };
    }
  }

  // ✅ Si ganó un VARIANT pero no tiene la info pedida,
// intenta otras variantes del mismo service que sí la tengan.
if (best.kind === "variant" && (missingPrice || missingDuration || missingIncludes)) {
  const vPick2 = await pool.query(
    `
    SELECT
      s.id AS service_id,
      s.name AS service_name,
      s.description AS service_desc,
      s.duration_min AS service_duration,

      v.id AS variant_id,
      v.variant_name,
      v.price,
      COALESCE(v.currency, 'USD') AS currency,
      v.duration_min AS variant_duration,
      v.description AS variant_desc,
      COALESCE(v.variant_url, s.service_url) AS url
    FROM services s
    JOIN service_variants v ON v.service_id = s.id
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND v.active = TRUE
      AND s.id = $2
      AND (
        ($4::boolean = TRUE AND v.price IS NOT NULL)
        OR ($5::boolean = TRUE AND v.duration_min IS NOT NULL)
        OR ($6::boolean = TRUE AND v.description IS NOT NULL AND length(trim(v.description)) > 0)
      )
    ORDER BY v.updated_at DESC NULLS LAST, v.created_at DESC NULLS LAST
    LIMIT $3
    `,
    [tenantId, best.service_id, limit, wantsPrice, wantsDuration, wantsIncludes]
  );

  const rows = vPick2.rows || [];

  if (rows.length === 1) {
    const r = rows[0];
    return {
      ok: true,
      kind: "variant",
      label: `${r.service_name} - ${r.variant_name}`,
      url: r.url || null,
      price: r.price != null ? Number(r.price) : null,
      currency: r.currency ? String(r.currency) : "USD",
      duration_min:
        r.variant_duration != null ? Number(r.variant_duration)
        : r.service_duration != null ? Number(r.service_duration)
        : null,
      description:
        r.variant_desc && String(r.variant_desc).trim()
          ? String(r.variant_desc)
          : r.service_desc ? String(r.service_desc) : null,
      service_id: String(r.service_id),
      variant_id: String(r.variant_id),
    };
  }

  if (rows.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      options: rows.slice(0, limit).map((r: any) => ({
        label: `${r.service_name} - ${r.variant_name}`,
        kind: "variant" as const,
        service_id: String(r.service_id),
        variant_id: String(r.variant_id),
      })),
    };
  }
}

  // OK
  return {
    ok: true,
    kind: best.kind,
    label: best.label,
    url: best.url,
    price: best.price,
    currency: best.currency,
    duration_min: best.duration_min,
    description: best.description,
    service_id: best.service_id,
    variant_id: best.variant_id,
  };
}
