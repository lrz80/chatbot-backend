import pool from "../../lib/db";

type ResolvedLink =
  | { ok: true; url: string; label: string; kind: "service" | "variant" }
  | { ok: false; reason: "no_match" | "ambiguous"; options?: { label: string; url?: string | null }[] };

function normalizeServiceQuery(q: string) {
  let s = String(q || "").toLowerCase();

  // ✅ Sinónimos ES/EN BÁSICOS (universales, NO por industria)
  // Mantén esto corto para no sesgar a un vertical.
  const map: Array<[RegExp, string]> = [
    // ES -> EN (muy comunes)
    [/\bbañ(o|os)\b/g, "bath"],
    [/\bcita(s)?\b/g, "appointment"],
    [/\breserva(s)?\b/g, "booking"],
    [/\bmembres(i|í)a(s)?\b/g, "membership"],
    [/\bpaquete(s)?\b/g, "package"],
        // Trial / free / complimentary (universal)
    [/\bclase\s+de\s+prueba\b/g, "trial"],
    [/\bprimera\s+clase\b/g, "trial"],
    [/\bclase\s+gratis\b/g, "trial"],
    [/\bgratis\b/g, "free"],
    [/\bprueba\b/g, "trial"],
    [/\bcomplimentary\b/g, "free"],
    [/\bcomp\b/g, "free"],
    [/\bintro(ductory)?\b/g, "trial"],
  ];
  for (const [re, repl] of map) s = s.replace(re, repl);

  // ✅ Quitar ruido típico al pedir links (ES/EN) — universal
  s = s.replace(
    /\b(mandame|mándame|pasame|pásame|env[ií]ame|enviame|dame|quiero|necesito|me\s+das|me\s+puedes|puedes|por\s+favor|pf|pls|please|send\s+me|send|link|enlace|url|reservar|reserva|agendar|agenda|book|booking|schedule)\b/g,
    " "
  );

  // ✅ Stopwords ES/EN (universales)
  s = s.replace(
    /\b(el|la|los|las|un|una|unos|unas|de|del|al|para|por|con|sin|y|o|que|es|en|the|a|an|of|for|to|and|or|is|in|on)\b/g,
    " "
  );

  // Limpieza final
  s = s.replace(/[^\p{L}\p{N}\s-]+/gu, " "); // quita puntuación
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

function isTrialLikeQuery(raw: string) {
  const s = String(raw || "").toLowerCase();
  return (
    /\b(trial|free\s*trial|free\s*class|first\s*class|intro|introductory|clase\s*de\s*prueba|clase\s*gratis|primera\s*clase|complimentary|comp)\b/i.test(
      s
    )
  );
}

export async function resolveServiceLink(args: {
  tenantId: string;
  query: string;
  limit?: number;
}): Promise<ResolvedLink> {
  const tenantId = args.tenantId;
  const qRaw = String(args.query || "").trim();
  const q = normalizeServiceQuery(qRaw);

  const limit = Math.min(args.limit ?? 5, 10);

  if (!tenantId || !q) return { ok: false, reason: "no_match" };

    // ✅ FAST PATH: si el usuario pide "clase de prueba / trial / complimentary",
  // resolvemos desde el catálogo usando el nombre (sin hardcode por negocio)
  if (isTrialLikeQuery(qRaw)) {
    // buscamos un servicio trial/free por nombre/desc (tenant-scoped)
    const { rows: trialServices } = await pool.query(
      `
      SELECT s.*,
             GREATEST(similarity(s.name, $2), similarity(s.description, $2)) AS score
      FROM services s
      WHERE s.tenant_id = $1
        AND s.active = TRUE
        AND (
          LOWER(s.name) LIKE '%trial%' OR
          LOWER(s.name) LIKE '%free%' OR
          LOWER(s.name) LIKE '%prueba%' OR
          LOWER(s.name) LIKE '%gratis%' OR
          LOWER(s.name) LIKE '%complimentary%' OR
          LOWER(s.name) LIKE '%intro%'
          OR s.name % $2 OR s.description % $2
        )
      ORDER BY
        (CASE
          WHEN LOWER(s.name) LIKE '%trial%' THEN 0
          WHEN LOWER(s.name) LIKE '%free%' THEN 1
          WHEN LOWER(s.name) LIKE '%prueba%' THEN 2
          ELSE 3
        END) ASC,
        score DESC,
        s.name ASC
      LIMIT $3
      `,
      [tenantId, q, limit]
    );

    if (!trialServices.length) return { ok: false, reason: "no_match" };

    // Usamos el top trial como "top", y dejamos que tu misma lógica de variantes
    // fuerce elección si hay 2+ (Functional/Cycling)
    const trialTop = trialServices[0];

    // Traer variantes activas del servicio trialTop
    const { rows: trialVariants } = await pool.query(
      `
      SELECT v.*
      FROM service_variants v
      WHERE v.service_id = $1
        AND v.active = TRUE
      ORDER BY v.variant_name ASC
      `,
      [trialTop.id]
    );

    // Si hay 2+ variantes y usuario no especificó, pedir elección (tu lógica)
    const hasMultiple = trialVariants.length >= 2;

    const userMentionsVariant =
      /\b(small|medium|large|xl|xxl)\b/i.test(qRaw) ||
      /\b(pequeñ[oa]s?|median[oa]s?|grand[ea]s?)\b/i.test(qRaw) ||
      /\b(\d+\s*(lb|lbs|pounds|kg))\b/i.test(qRaw) ||
      /\b(\d+\s*-\s*\d+)\b/.test(qRaw) ||
      /\b(\d+\+)\b/.test(qRaw) ||
      // ✅ adicional universal: cycling/functional si el negocio lo usa como variantes
      /\b(cycling|cycle|spin|spinning|functional|funcional)\b/i.test(qRaw);

    if (hasMultiple && !userMentionsVariant) {
      return {
        ok: false,
        reason: "ambiguous",
        options: trialVariants.slice(0, 5).map((v: any) => ({
          label: `${trialTop.name} - ${v.variant_name}`,
          url: v.variant_url || trialTop.service_url || null,
        })),
      };
    }

    // Si el usuario menciona una variante (o solo hay 1), intenta resolver variante por trigram
    if (trialVariants.length) {
      const { rows: variants } = await pool.query(
        `
        SELECT v.*,
               similarity(v.variant_name, $2) AS vscore
        FROM service_variants v
        WHERE v.service_id = $1
          AND v.active = TRUE
        ORDER BY vscore DESC, v.variant_name ASC
        LIMIT 3
        `,
        [trialTop.id, q]
      );

      if (variants.length) {
        const v = variants[0];
        const url = (v.variant_url || trialTop.service_url) as string | undefined;
        if (url) {
          return { ok: true, url, label: `${trialTop.name} - ${v.variant_name}`, kind: "variant" };
        }
      }

      // Si no matcheó variante pero hay solo 1 con link, úsala
      if (trialVariants.length === 1) {
        const v = trialVariants[0];
        const url = (v.variant_url || trialTop.service_url) as string | undefined;
        if (url) return { ok: true, url, label: `${trialTop.name} - ${v.variant_name}`, kind: "variant" };
      }
    }

    // Si no hay variantes con link, usa service_url
    if (trialTop.service_url) {
      return { ok: true, url: trialTop.service_url, label: trialTop.name, kind: "service" };
    }

    // Trial encontrado pero sin links configurados en service ni variantes
    return {
      ok: false,
      reason: "ambiguous",
      options: trialServices.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        url: s.service_url,
      })),
    };
  }

  // 1) Buscar el mejor servicio por similitud (mismo SQL del endpoint search)
  const { rows: services } = await pool.query(
    `
    SELECT s.*,
           GREATEST(similarity(s.name, $2), similarity(s.description, $2)) AS score
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND (s.name % $2 OR s.description % $2)
    ORDER BY score DESC, s.name ASC
    LIMIT $3
    `,
    [tenantId, q, limit]
  );
  console.log("🔎 [resolveServiceLink] qRaw/q =", { qRaw, q, tenantId });

  console.log(
    "🔎 [resolveServiceLink] candidates =",
    (services || []).map((s: any) => ({
      name: s.name,
      category: s.category,
      score: Number(s.score || 0),
      url: s.service_url,
    }))
  );

    if (!services.length) {
    // Fallback: búsqueda simple por ILIKE (por si pg_trgm no matchea)
    const tokens = q.split(" ").filter(Boolean);
    const patterns = tokens.length
    ? tokens.map((t) => `%${t}%`)
    : [`%${q}%`];

    const { rows: services2 } = await pool.query(
    `
    SELECT s.*, 0.0 AS score
    FROM services s
    WHERE s.tenant_id = $1
        AND s.active = TRUE
        AND (
        s.name ILIKE ANY($2) OR
        s.description ILIKE ANY($2)
        )
    ORDER BY s.category ASC, s.name ASC
    LIMIT $3
    `,
    [tenantId, patterns, limit]
    );

    if (!services2.length) return { ok: false, reason: "no_match" };

    // Si encontró algo, tratamos como ambiguo (para que el usuario elija 1-5)
    return {
      ok: false,
      reason: "ambiguous",
      options: services2.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        url: s.service_url,
      })),
    };
  }

    const top = services[0];
  const topScore = Number(top?.score || 0);
  const second = services[1];
  const secondScore = Number(second?.score || 0);

  // 2) Si score es bajo -> ambiguo
  if (topScore < 0.35) {
    return {
      ok: false,
      reason: "ambiguous",
      options: services.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        url: s.service_url,
      })),
    };
  }

  // ✅ 2B) Si hay 2+ candidatos con scores "fuertes", NO adivines -> deja elegir.
  // Regla: si el segundo es suficientemente bueno, pedimos elección.
  // (Esto fuerza el caso "bath" con Deluxe Bath + Basic Bath)
  if (services.length >= 2 && secondScore >= 0.35) {
    return {
      ok: false,
      reason: "ambiguous",
      options: services.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        url: s.service_url,
      })),
    };
  }

  // ✅ 3) Traer variantes activas del servicio TOP (SIEMPRE, no solo por trigram)
  // Esto permite forzar elección cuando el servicio tiene múltiples variantes.
  const { rows: allVariants } = await pool.query(
    `
    SELECT v.*
    FROM service_variants v
    WHERE v.service_id = $1
      AND v.active = TRUE
    ORDER BY v.variant_name ASC
    `,
    [top.id]
  );

  const hasMultipleVariants = allVariants.length >= 2;

  // heurística simple: detecta si el usuario ya especificó tamaño/peso
  const userMentionsVariant =
    /\b(small|medium|large|xl|xxl)\b/i.test(qRaw) ||
    /\b(pequeñ[oa]s?|median[oa]s?|grand[ea]s?)\b/i.test(qRaw) ||
    /\b(\d+\s*(lb|lbs|pounds|kg))\b/i.test(qRaw) ||
    /\b(\d+\s*-\s*\d+)\b/.test(qRaw) ||
    /\b(\d+\+)\b/.test(qRaw);

  // ✅ 3.5) Si el servicio top tiene 2+ variantes activas y el usuario NO especificó variante:
  // NO mandes link directo -> pide elección.
  if (hasMultipleVariants && !userMentionsVariant) {
    return {
      ok: false,
      reason: "ambiguous",
      options: allVariants.slice(0, 5).map((v: any) => ({
        label: `${top.name} - ${v.variant_name}`,
        url: v.variant_url || top.service_url || null,
      })),
    };
  }

  // 4) Si el usuario sí menciona variante, intenta resolver cuál variante exacta.
  // Solo en este caso hacemos trigram a variantes (porque ya hay señal).
  if (allVariants.length) {
    const { rows: variants } = await pool.query(
      `
      SELECT v.*,
             similarity(v.variant_name, $2) AS vscore
      FROM service_variants v
      WHERE v.service_id = $1
        AND v.active = TRUE
        AND v.variant_name % $2
      ORDER BY vscore DESC, v.variant_name ASC
      LIMIT 3
      `,
      [top.id, q]
    );

    if (variants.length) {
      const v = variants[0];
      const vScore = Number(v.vscore || 0);

      if (vScore >= 0.35 && (v.variant_url || top.service_url)) {
        const url = (v.variant_url || top.service_url) as string;
        return {
          ok: true,
          url,
          label: `${top.name} - ${v.variant_name}`,
          kind: "variant",
        };
      }
    }
  }

  // 4) Si hay link del servicio, lo devolvemos
  if (top.service_url) {
    return { ok: true, url: top.service_url, label: top.name, kind: "service" };
  }

  // 5) Sin link guardado -> ambiguo/no match
  return {
    ok: false,
    reason: "ambiguous",
    options: services.slice(0, 5).map((s: any) => ({
      label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
      url: s.service_url,
    })),
  };
}
