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

function normLite(s: string) {
  return String(s || "").toLowerCase();
}

function isTrialLike(qRaw: string) {
  // complimentary = gratis (correcto)
  // complementary = adicional (común typo), lo soportamos igual
  return /\b(prueba|trial|free\s*trial|intro|introductory|first\s*class|clase\s+de\s+prueba|clase\s+gratis|gratuita|complimentary|complementary)\b/i.test(qRaw);
}

function wantsClassLike(qRaw: string) {
  return /\b(clase|classes|class|session|sesion|sesión)\b/i.test(qRaw);
}

function wantsPlanLike(qRaw: string) {
  return /\b(plan|planes|membresia|membresía|membership|autopay|subscription|suscripcion|suscripción|paquete|packages)\b/i.test(qRaw);
}

function extractKeyTokens(qRaw: string) {
  // tokens "de intención" que sí discriminan: cycling, functional, sauna, etc.
  const raw = normalizeServiceQuery(qRaw);
  const parts = raw.split(" ").map(t => t.trim()).filter(Boolean);

  const stop = new Set([
    "service","servicio","plan","paquete","package","membership","membresia",
    "class","clase","classes","sesion","session","booking","book","reservar","reserva","agendar","agenda",
    "link","enlace","url",
    // trial markers los tratamos aparte con isTrialLike
    "trial","prueba","gratis","gratuita","free","intro","first"
  ]);

  const tokens = parts
    .filter(t => t.length >= 3)
    .filter(t => !stop.has(t));

  // unique
  return Array.from(new Set(tokens));
}

function containsAnyToken(text: string, tokens: string[]) {
  const t = normLite(text);
  return tokens.some(tok => t.includes(tok));
}

function isTrialLikeQuery(raw: string) {
  const s = String(raw || "").toLowerCase();
  return /\b(prueba|de\s*prueba|trial|free\s*trial|free\s*class|first\s*class|primera\s*clase|intro|introductory|clase\s*de\s*prueba|clase\s*gratis|gratis|gratuita|complimentary|complementary|comp)\b/i.test(
    s
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
  // ====== FLAGS DEL MENSAJE (antes de filtrar) ======
  const trialReq = isTrialLike(qRaw);
  const keyTokens = extractKeyTokens(qRaw);
  const classReq = wantsClassLike(qRaw);
  const planReq = wantsPlanLike(qRaw);

  // ====== FILTROS SOBRE SERVICES (NO hardcode por negocio) ======
  let filtered = (services || []) as any[];

  // 1) Si pidió "clase" y NO pidió plan/membresía, filtra fuera tipo=plan
  if (classReq && !planReq) {
    filtered = filtered.filter(s => String(s.tipo || "").toLowerCase() !== "plan");
  }

  // 2) Si es trial/prueba, intenta quedarte solo con servicios que parezcan trial
  if (trialReq) {
    const trialFiltered = filtered.filter(s => {
      const hay = `${s.name || ""} ${s.category || ""} ${s.description || ""}`.toLowerCase();
      return /\b(trial|free|intro|prueba|gratis|complimentary|complementary)\b/i.test(hay);
    });
    if (trialFiltered.length) filtered = trialFiltered;
  }

  // 3) Tokens discriminantes (ej: cycling/functional/sauna/laser/etc) sobre servicio
  if (keyTokens.length) {
    const tokenFiltered = filtered.filter(s =>
      containsAnyToken(`${s.name || ""} ${s.category || ""} ${s.description || ""}`, keyTokens)
    );
    if (tokenFiltered.length) filtered = tokenFiltered;
  }

  // ✅ Resultado final inicial
  let servicesFinal = filtered;

  // 4) Si tokens NO aparecen en el servicio pero SÍ en variantes, mantener ese servicio
  if (keyTokens.length && servicesFinal.length) {
    const keep: any[] = [];

    for (const s of servicesFinal) {
      const hayService = `${s.name || ""} ${s.category || ""} ${s.description || ""}`;
      if (containsAnyToken(hayService, keyTokens)) {
        keep.push(s);
        continue;
      }

      const { rows: vrows } = await pool.query(
        `
        SELECT v.variant_name, v.description
        FROM service_variants v
        WHERE v.service_id = $1
          AND v.active = TRUE
        `,
        [s.id]
      );

      const hayVariants = (vrows || [])
        .map((v: any) => `${v.variant_name || ""} ${v.description || ""}`)
        .join(" | ");

      if (containsAnyToken(hayVariants, keyTokens)) {
        keep.push(s);
      }
    }

    if (keep.length) servicesFinal = keep;
  }

  console.log("🔎 [resolveServiceLink] qRaw/q =", { qRaw, q, tenantId });

  console.log(
    "🔎 [resolveServiceLink] candidates =",
    (servicesFinal || []).map((s: any) => ({
      name: s.name,
      category: s.category,
      tipo: s.tipo,
      score: Number(s.score || 0),
      url: s.service_url,
    }))
  );

  if (!servicesFinal.length) {
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

    let services2Final = (services2 || []) as any[];

    if (classReq && !planReq) {
      services2Final = services2Final.filter(s => String(s.tipo || "").toLowerCase() !== "plan");
    }

    if (trialReq) {
      const trialFiltered2 = services2Final.filter(s => {
        const hay = `${s.name || ""} ${s.category || ""} ${s.description || ""}`.toLowerCase();
        return /\b(trial|free|intro|prueba|gratis|complimentary|complementary)\b/i.test(hay);
    });
    if (trialFiltered2.length) services2Final = trialFiltered2;
    }

    if (keyTokens.length) {
      const tokenFiltered2 = services2Final.filter(s =>
        containsAnyToken(`${s.name || ""} ${s.category || ""} ${s.description || ""}`, keyTokens)
    );
    if (tokenFiltered2.length) services2Final = tokenFiltered2;
    }

    if (!services2Final.length) return { ok: false, reason: "no_match" };

    return {
      ok: false,
      reason: "ambiguous",
      options: services2Final.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        url: s.service_url,
      })),
    };
  }

  const top = servicesFinal[0];
  const topScore = Number(top?.score || 0);
  const second = servicesFinal[1];
  const secondScore = Number(second?.score || 0);

  // 2) Si score es bajo -> ambiguo
  if (topScore < 0.35) {
    return {
      ok: false,
      reason: "ambiguous",
      options: servicesFinal.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        url: s.service_url,
      })),
    };
  }

  // ✅ 2B) Si hay 2+ candidatos con scores "fuertes", NO adivines -> deja elegir.
  // Regla: si el segundo es suficientemente bueno, pedimos elección.
  // (Esto fuerza el caso "bath" con Deluxe Bath + Basic Bath)
  if (servicesFinal.length >= 2 && secondScore >= 0.35) {
    return {
      ok: false,
      reason: "ambiguous",
      options: servicesFinal.slice(0, 5).map((s: any) => ({
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
    options: servicesFinal.slice(0, 5).map((s: any) => ({
      label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
      url: s.service_url,
    })),
  };
}
