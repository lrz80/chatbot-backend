//src/lib/fastpath/handlers/catalog/runCatalogFastpath.ts
import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogIntentFlags } from "./getCatalogIntentFlags";
import { getCatalogTurnState } from "./getCatalogTurnState";
import { handleSingleServiceCatalog } from "./handleSingleServiceCatalog";

export type RunCatalogFastpathInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;

  intentOut?: string | null;
  detectedIntent?: string | null;
  infoClave?: string | null;
  promptBase: string;
  canal: any;

  hasStructuredTarget: boolean;

  catalogReferenceClassification?: any;

  buildCatalogRoutingSignal: (input: {
    intentOut: string | null;
    catalogReferenceClassification?: any;
    convoCtx: any;
  }) => any;

  buildCatalogContext: (pool: Pool, tenantId: string) => Promise<string>;

  normalizeCatalogRole: (value: string | null | undefined) => string;
    traducirTexto: (
    texto: string,
    idiomaDestino: string,
    modo?: any
  ) => Promise<string>;

  renderGenericPriceSummaryReply: (input: {
    lang: any;
    rows: any[];
  }) => string;

  extractPlanNamesFromReply: (reply: string) => string[];
  sameBulletStructure: (canonicalReply: string, modelReply: string) => boolean;

  answerWithPromptBase: (input: any) => Promise<{ text: string }>;

  answerCatalogQuestionLLM: (input: {
    idiomaDestino: any;
    systemMsg: string;
    userMsg: string;
  }) => Promise<string>;

  postProcessCatalogReply: (input: {
    reply: string;
    questionType:
      | "combination_and_price"
      | "price_or_plan"
      | "schedule_and_price"
      | "other_plans";
    prevNames: string[];
  }) => {
    finalReply: string;
    namesShown: string[];
  };
};

export async function runCatalogFastpath(
  input: RunCatalogFastpathInput
): Promise<FastpathResult> {
  const catalogRoutingSignal = input.buildCatalogRoutingSignal({
    intentOut: input.intentOut || null,
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
  });

  console.log("[CATALOG][ROUTING_SIGNAL]", {
    userInput: input.userInput,
    intentOut: input.intentOut,
    signal: {
      shouldRouteCatalog: catalogRoutingSignal.shouldRouteCatalog,
      routeIntent: catalogRoutingSignal.routeIntent,
      referenceKind: catalogRoutingSignal.referenceKind,
      source: catalogRoutingSignal.source,
      allowsDbCatalogPath: catalogRoutingSignal.allowsDbCatalogPath,
      hasFreshCatalogContext: catalogRoutingSignal.hasFreshCatalogContext,
      previousCatalogPlans: catalogRoutingSignal.previousCatalogPlans,
      targetServiceId: catalogRoutingSignal.targetServiceId,
      targetServiceName: catalogRoutingSignal.targetServiceName,
      targetVariantId: catalogRoutingSignal.targetVariantId,
      targetVariantName: catalogRoutingSignal.targetVariantName,
      targetFamilyKey: catalogRoutingSignal.targetFamilyKey,
      targetFamilyName: catalogRoutingSignal.targetFamilyName,
      targetLevel: catalogRoutingSignal.targetLevel,
      disambiguationType: catalogRoutingSignal.disambiguationType,
      anchorShift: catalogRoutingSignal.anchorShift,
    },
  });

  const routeIntent = String(catalogRoutingSignal.routeIntent || "").trim();

  const {
    isCombinationIntent,
    asksIncludesOnly,
    isAskingOtherCatalogOptions,
    asksSchedules,
  } = getCatalogIntentFlags({
    routeIntent,
  });

  void isCombinationIntent;
  void isAskingOtherCatalogOptions;

  const {
    hasRecentCatalogContext,
    intentAllowsCatalogRouting,
    isCatalogPriceLikeTurn,
    hasStructuredCatalogState,
    isCatalogQuestion,
  } = getCatalogTurnState({
    catalogRoutingSignal,
    convoCtx: input.convoCtx,
    hasStructuredTarget: input.hasStructuredTarget,
  });

  void hasRecentCatalogContext;
  void hasStructuredCatalogState;

  const referenceKind = String(
    input.catalogReferenceClassification?.kind || "none"
  )
    .trim()
    .toLowerCase();

  const hasExplicitCatalogRouting =
    catalogRoutingSignal.shouldRouteCatalog === true ||
    referenceKind === "catalog_overview" ||
    referenceKind === "catalog_family";

  const hasExplicitCatalogIntent =
    String(input.intentOut || "").trim().toLowerCase() === "precio" ||
    String(input.intentOut || "").trim().toLowerCase() === "planes_precios" ||
    String(input.intentOut || "").trim().toLowerCase() === "catalogo" ||
    String(input.intentOut || "").trim().toLowerCase() === "catalog" ||
    String(input.intentOut || "").trim().toLowerCase() === "other_plans" ||
    String(input.intentOut || "").trim().toLowerCase() === "catalog_alternatives" ||
    String(input.intentOut || "").trim().toLowerCase() === "combination_and_price" ||
    String(input.intentOut || "").trim().toLowerCase() === "catalog_combination";

  const allowGenericCatalogDbFallback =
    hasExplicitCatalogRouting || hasExplicitCatalogIntent;

  if (isCatalogPriceLikeTurn) {
    console.log("🚫 BLOCK LLM PRICING — forcing DB path");
  }

  if (!isCatalogQuestion) {
    return {
      handled: false,
    };
  }

  type QuestionType =
    | "combination_and_price"
    | "price_or_plan"
    | "schedule_and_price"
    | "other_plans";

  let questionType: QuestionType;

  if (routeIntent === "catalog_combination") {
    questionType = "combination_and_price";
  } else if (routeIntent === "catalog_alternatives") {
    questionType = "other_plans";
  } else if (routeIntent === "catalog_schedule" || asksSchedules) {
    questionType = "schedule_and_price";
  } else {
    questionType = "price_or_plan";
  }

  if (routeIntent === "catalog_overview" && intentAllowsCatalogRouting) {
    console.log("[CATALOG_OVERVIEW][RUN_FASTPATH]", {
      userInput: input.userInput,
      questionType,
      detectedIntent: input.detectedIntent,
      catalogReferenceKind: input.catalogReferenceClassification?.kind ?? "none",
      routeIntent,
    });
  }

  if (routeIntent === "catalog_family" && intentAllowsCatalogRouting) {
    console.log("[CATALOG_FAMILY][RUN_FASTPATH]", {
      userInput: input.userInput,
      questionType,
      detectedIntent: input.detectedIntent,
      catalogReferenceKind: input.catalogReferenceClassification?.kind ?? "none",
      routeIntent,
    });
  }

  const catalogText = await input.buildCatalogContext(
    input.pool,
    input.tenantId
  );

  const hasMultiAccessPlan = false;

  const nowForMeta = Date.now();
  let previousPlansStr = "none";
  const prevNames = Array.isArray(input.convoCtx?.last_catalog_plans)
    ? input.convoCtx.last_catalog_plans
    : [];
  const prevAtRaw = input.convoCtx?.last_catalog_at;
  const prevAt = Number(prevAtRaw);
  const prevFresh =
    prevNames.length > 0 &&
    Number.isFinite(prevAt) &&
    prevAt > 0 &&
    nowForMeta - prevAt <= 30 * 60 * 1000;

  if (prevFresh) {
    previousPlansStr = prevNames.join(" | ");
  }

  const metaBlock =
    `QUESTION_TYPE: ${questionType}\n` +
    `HAS_MULTI_ACCESS_PLAN: ${hasMultiAccessPlan ? "yes" : "no"}\n` +
    `PREVIOUS_PLANS_MENTIONED: ${previousPlansStr}`;

  const shouldAttachInfoGeneral =
    !!input.infoClave &&
    (
      asksSchedules ||
      routeIntent === "catalog_schedule" ||
      input.intentOut === "info_general" ||
      input.intentOut === "info_horarios_generales"
    );

  const infoGeneralBlock = shouldAttachInfoGeneral
    ? input.idiomaDestino === "en"
      ? `\n\nBUSINESS_GENERAL_INFO (hours, address, etc.):\n${input.infoClave}`
      : `\n\nINFO_GENERAL_DEL_NEGOCIO (horarios, dirección, etc.):\n${input.infoClave}`
    : "";

  //PRICE OR PLAN
  if (!asksSchedules && !asksIncludesOnly && questionType === "price_or_plan") {
    if (!allowGenericCatalogDbFallback) {
      console.log("[CATALOG_DB][BLOCKED_GENERIC_FALLBACK]", {
        userInput: input.userInput,
        intentOut: input.intentOut,
        routeIntent,
        referenceKind,
        shouldRouteCatalog: catalogRoutingSignal.shouldRouteCatalog,
        hasStructuredTarget: input.hasStructuredTarget,
      });

      return {
        handled: false,
      };
    }
    
    const { rows } = await input.pool.query<{
      service_id: string;
      service_name: string;
      min_price: number | string | null;
      max_price: number | string | null;
      parent_service_id: string | null;
      category: string | null;
      catalog_role: string | null;
    }>(
      `
      WITH variant_prices AS (
        SELECT
          s.id AS service_id,
          s.name AS service_name,
          s.parent_service_id,
          s.category,
          s.catalog_role,
          MIN(v.price)::numeric AS min_price,
          MAX(v.price)::numeric AS max_price
        FROM services s
        JOIN service_variants v
          ON v.service_id = s.id
        AND v.active = true
        WHERE s.tenant_id = $1
          AND s.active = true
          AND v.price IS NOT NULL
        GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
      ),
      base_prices AS (
        SELECT
          s.id AS service_id,
          s.name AS service_name,
          s.parent_service_id,
          s.category,
          s.catalog_role,
          MIN(s.price_base)::numeric AS min_price,
          MAX(s.price_base)::numeric AS max_price
        FROM services s
        WHERE s.tenant_id = $1
          AND s.active = true
          AND s.price_base IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM service_variants v
            WHERE v.service_id = s.id
              AND v.active = true
              AND v.price IS NOT NULL
          )
        GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
      )
      SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role
      FROM (
        SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM variant_prices
        UNION ALL
        SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM base_prices
      ) x;
      `,
      [input.tenantId]
    );

    const singleServiceCatalogResult = await handleSingleServiceCatalog({
      pool: input.pool,
      tenantId: input.tenantId,
      userInput: input.userInput,
      idiomaDestino: input.idiomaDestino,
      convoCtx: input.convoCtx,
      routeIntent,
      catalogRoutingSignal,
      catalogReferenceClassification: input.catalogReferenceClassification,
      rows,
      answerWithPromptBase: input.answerWithPromptBase,
      promptBase: input.promptBase,
      canal: input.canal,
    });

    if (singleServiceCatalogResult.handled) {
      return singleServiceCatalogResult;
    }

    const rowsPrioritized = [...rows].sort((a, b) => {
      const aRole = input.normalizeCatalogRole(a.catalog_role);
      const bRole = input.normalizeCatalogRole(b.catalog_role);

      const aPrimary = aRole === "primary";
      const bPrimary = bRole === "primary";

      if (aPrimary !== bPrimary) {
        return aPrimary ? -1 : 1;
      }

      const aSortPrice =
        a.min_price === null ? Number.NEGATIVE_INFINITY : Number(a.min_price);
      const bSortPrice =
        b.min_price === null ? Number.NEGATIVE_INFINITY : Number(b.min_price);

      if (aSortPrice !== bSortPrice) {
        return bSortPrice - aSortPrice;
      }

      return String(a.service_name || "").localeCompare(
        String(b.service_name || "")
      );
    });

    let rowsLocalized = rowsPrioritized;

    if (input.idiomaDestino === "en") {
      rowsLocalized = await Promise.all(
        rowsPrioritized.map(async (r) => {
          const nameEs = String(r.service_name || "").trim();
          if (!nameEs) return r;

          try {
            const nameEn = await input.traducirTexto(
              nameEs,
              "en",
              "catalog_label"
            );
            return { ...r, service_name: nameEn };
          } catch {
            return r;
          }
        })
      );
    }

    const dbReply = input.renderGenericPriceSummaryReply({
      lang: input.idiomaDestino,
      rows: rowsLocalized,
    });

    const cleanedReply = dbReply;
    const canonicalReply = cleanedReply;
    const namesShown = input.extractPlanNamesFromReply(cleanedReply);

    const extraContext = [
      "CATALOGO_DB_CANONICO:",
      canonicalReply,
      "",
      "REGLAS_CRITICAS_DEL_TURNO:",
      "- Debes usar EXCLUSIVAMENTE los servicios y precios del CATALOGO_DB_CANONICO.",
      "- Debes conservar EXACTAMENTE el mismo orden de los bullets.",
      "- Debes conservar EXACTAMENTE los mismos nombres de servicios.",
      "- Debes conservar EXACTAMENTE los mismos precios.",
      "- NO puedes agregar servicios.",
      "- NO puedes quitar servicios.",
      "- NO puedes reordenar bullets.",
      "- NO puedes resumir varios bullets en uno solo.",
      "- SOLO puedes suavizar el encabezado o la línea final.",
      "- Si no puedes mejorar sin alterar el contenido, devuelve el CATALOGO_DB_CANONICO tal cual.",
      "- Si el usuario ya está en una conversación activa, NO empieces con saludo como 'Hola'. Ve directo al punto.",
      "",
      "CONTINUIDAD_CONVERSACIONAL:",
      "- La respuesta DEBE terminar con una pregunta o invitación a continuar la conversación.",
      "- Debes guiar al usuario hacia el siguiente paso (más información, reserva, o aclaración).",
      "- Evita respuestas que solo informen el precio sin invitar a continuar.",
    ].join("\n");

    const aiCatalogReply = await input.answerWithPromptBase({
      tenantId: input.tenantId,
      promptBase: input.promptBase,
      userInput: input.userInput,
      history: [],
      idiomaDestino: input.idiomaDestino,
      canal: input.canal,
      maxLines: 8,
      fallbackText: canonicalReply,
      extraContext,
    });

    const modelReply = String(aiCatalogReply?.text || "").trim();
    const finalReply =
      modelReply && input.sameBulletStructure(canonicalReply, modelReply)
        ? modelReply
        : canonicalReply;

    console.log("[PRICE][catalog_db][SAFE_RENDER]", {
      rowsCount: rowsLocalized.length,
      namesShown,
      usedModelReply: finalReply === modelReply,
      canonicalPreview: canonicalReply.slice(0, 220),
      modelPreview: modelReply.slice(0, 220),
    });

    const ctxPatch: any = {
      last_catalog_at: Date.now(),
      lastResolvedIntent: "price_or_plan",
    };

    if (namesShown.length) {
      ctxPatch.last_catalog_plans = namesShown;
    }

    console.log("[PRICE][catalog_db][FINAL_REPLY_BEFORE_RETURN]", {
      replyPreview: finalReply,
    });

    return {
      handled: true,
      reply: finalReply,
      source: "catalog_db",
      intent: "precio",
      ctxPatch,
    };
  }

  // SCHEDULE + PRICE
  if (questionType === "schedule_and_price") {
    if (!allowGenericCatalogDbFallback) {
      console.log("[CATALOG_DB][BLOCKED_SCHEDULE_PRICE_FALLBACK]", {
        userInput: input.userInput,
        intentOut: input.intentOut,
        routeIntent,
        referenceKind,
        shouldRouteCatalog: catalogRoutingSignal.shouldRouteCatalog,
        hasStructuredTarget: input.hasStructuredTarget,
      });

      return {
        handled: false,
      };
    }

    const { rows } = await input.pool.query<{
      service_id: string;
      service_name: string;
      min_price: number | string | null;
      max_price: number | string | null;
      parent_service_id: string | null;
      category: string | null;
      catalog_role: string | null;
    }>(
      `
      WITH variant_prices AS (
        SELECT
          s.id AS service_id,
          s.name AS service_name,
          s.parent_service_id,
          s.category,
          s.catalog_role,
          MIN(v.price)::numeric AS min_price,
          MAX(v.price)::numeric AS max_price
        FROM services s
        JOIN service_variants v
          ON v.service_id = s.id
         AND v.active = true
        WHERE s.tenant_id = $1
          AND s.active = true
          AND v.price IS NOT NULL
        GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
      ),
      base_prices AS (
        SELECT
          s.id AS service_id,
          s.name AS service_name,
          s.parent_service_id,
          s.category,
          s.catalog_role,
          MIN(s.price_base)::numeric AS min_price,
          MAX(s.price_base)::numeric AS max_price
        FROM services s
        WHERE s.tenant_id = $1
          AND s.active = true
          AND s.price_base IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM service_variants v
            WHERE v.service_id = s.id
              AND v.active = true
              AND v.price IS NOT NULL
          )
        GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
      )
      SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role
      FROM (
        SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM variant_prices
        UNION ALL
        SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM base_prices
      ) x;
      `,
      [input.tenantId]
    );

    const rowsPrioritized = [...rows].sort((a, b) => {
      const aRole = input.normalizeCatalogRole(a.catalog_role);
      const bRole = input.normalizeCatalogRole(b.catalog_role);

      const aPrimary = aRole === "primary";
      const bPrimary = bRole === "primary";

      if (aPrimary !== bPrimary) {
        return aPrimary ? -1 : 1;
      }

      const aSortPrice =
        a.min_price === null ? Number.NEGATIVE_INFINITY : Number(a.min_price);
      const bSortPrice =
        b.min_price === null ? Number.NEGATIVE_INFINITY : Number(b.min_price);

      if (aSortPrice !== bSortPrice) {
        return bSortPrice - aSortPrice;
      }

      return String(a.service_name || "").localeCompare(
        String(b.service_name || "")
      );
    });

    let rowsLocalized = rowsPrioritized;

    if (input.idiomaDestino === "en") {
      rowsLocalized = await Promise.all(
        rowsPrioritized.map(async (r) => {
          const nameEs = String(r.service_name || "").trim();
          if (!nameEs) return r;

          try {
            const nameEn = await input.traducirTexto(
              nameEs,
              "en",
              "catalog_label"
            );
            return { ...r, service_name: nameEn };
          } catch {
            return r;
          }
        })
      );
    }

    const canonicalPriceReply = input.renderGenericPriceSummaryReply({
      lang: input.idiomaDestino,
      rows: rowsLocalized,
    }).trim();

    const canonicalReply = input.infoClave?.trim()
      ? `${canonicalPriceReply}\n\n${
          input.idiomaDestino === "en" ? "Schedules:" : "Horarios:"
        }\n${input.infoClave.trim()}`
      : canonicalPriceReply;

    const namesShown = input.extractPlanNamesFromReply(canonicalPriceReply);

    const extraContext = [
      "CATALOGO_DB_CANONICO:",
      canonicalPriceReply,
      "",
      input.idiomaDestino === "en"
        ? "SCHEDULES_CANONICOS:"
        : "HORARIOS_CANONICOS:",
      input.infoClave?.trim() || "",
      "",
      "REGLAS_CRITICAS_DEL_TURNO:",
      "- Debes usar EXCLUSIVAMENTE los precios del CATALOGO_DB_CANONICO.",
      "- Debes conservar EXACTAMENTE los mismos nombres y precios.",
      "- NO puedes agregar servicios.",
      "- NO puedes quitar servicios.",
      "- NO puedes inventar horarios.",
      "- Si hay horarios canónicos, cópialos tal cual.",
      "- SOLO puedes suavizar el encabezado o la línea final.",
    ].join("\n");

    const aiCatalogReply = await input.answerWithPromptBase({
      tenantId: input.tenantId,
      promptBase: input.promptBase,
      userInput: input.userInput,
      history: [],
      idiomaDestino: input.idiomaDestino,
      canal: input.canal,
      maxLines: 14,
      fallbackText: canonicalReply,
      extraContext,
    });

    const modelReply = String(aiCatalogReply?.text || "").trim();
    const finalReply = modelReply || canonicalReply;

    const ctxPatch: any = {
      last_catalog_at: Date.now(),
      lastResolvedIntent: "schedule_and_price",
    };

    if (namesShown.length) {
      ctxPatch.last_catalog_plans = namesShown;
    }

    console.log("[SCHEDULE_AND_PRICE][FINAL_REPLY]", {
      canonicalReply,
      finalReply,
    });

    return {
      handled: true,
      reply: finalReply,
      source: "catalog_db",
      intent: "precio",
      ctxPatch,
    };
  }

  //OTHER PLANS
  if (!asksSchedules && questionType === "other_plans") {
    const { rows } = await input.pool.query<any>(
      `
      SELECT
        CASE
          WHEN v.variant_name IS NOT NULL AND length(trim(v.variant_name)) > 0
            THEN s.name || ' — ' || v.variant_name
          ELSE s.name
        END AS option_name,
        s.name AS service_name,
        v.variant_name,
        v.price::numeric AS price_value
      FROM services s
      JOIN service_variants v
        ON v.service_id = s.id
       AND v.active = true
      WHERE s.tenant_id = $1
        AND s.active = true
        AND v.price IS NOT NULL

      UNION ALL

      SELECT
        s.name AS option_name,
        s.name AS service_name,
        NULL::text AS variant_name,
        s.price_base::numeric AS price_value
      FROM services s
      WHERE s.tenant_id = $1
        AND s.active = true
        AND s.price_base IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM service_variants v
          WHERE v.service_id = s.id
            AND v.active = true
            AND v.price IS NOT NULL
        )
      ORDER BY price_value ASC NULLS LAST, option_name ASC
      `,
      [input.tenantId]
    );

    const norm = (s: string) =>
      String(s || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const prevSet = new Set((prevFresh ? prevNames : []).map(norm));

    const freshRows = rows.filter((r: any) => {
      const optionNorm = norm(r.option_name);
      const serviceNorm = norm(r.service_name);

      return !prevSet.has(optionNorm) && !prevSet.has(serviceNorm);
    });

    const rowsToRender = freshRows.slice(0, 5);

    if (!rowsToRender.length) {
      const reply =
        input.idiomaDestino === "en"
          ? "I already showed you the main options. You can ask me about any of the options I mentioned and I’ll gladly give you more details 😊"
          : "Ya te mostré las opciones principales. Puedes preguntarme por alguna de las opciones que te mencioné y con gusto te doy más detalles 😊";

      return {
        handled: true,
        reply,
        source: "catalog_db",
        intent: "precio",
        ctxPatch: {
          last_catalog_at: Date.now(),
          lastResolvedIntent: "other_plans",
        } as any,
      };
    }

    let rowsLocalized = rowsToRender.map((r: any) => ({ ...r }));

    if (input.idiomaDestino === "en") {
      rowsLocalized = await Promise.all(
        rowsToRender.map(async (r: any) => {
          try {
            const optionEn = await input.traducirTexto(
              String(r.option_name || ""),
              "en",
              "catalog_label"
            );
            return { ...r, option_name: optionEn };
          } catch {
            return r;
          }
        })
      );
    }

    const reply = rowsLocalized
      .map((r: any) => {
        const price = Number(r.price_value);
        const priceText =
          price === 0
            ? input.idiomaDestino === "en"
              ? "free"
              : "gratis"
            : Number.isFinite(price)
            ? `$${price.toFixed(2)}`
            : "";

        return `• ${String(r.option_name || "").trim()}: ${priceText}`;
      })
      .join("\n");

    const namesShown = rowsToRender
      .map((r: any) => String(r.option_name || "").trim())
      .filter(Boolean)
      .slice(0, 7);

    const ctxPatch: any = {
      last_catalog_at: Date.now(),
      lastResolvedIntent: "other_plans",
    };

    if (namesShown.length) {
      ctxPatch.last_catalog_plans = namesShown;
    }

    return {
      handled: true,
      reply,
      source: "catalog_db",
      intent: "precio",
      ctxPatch,
    };
  }

  console.log("[PRICE][pre-llm-catalog-check]", {
    userInput: input.userInput,
    detectedIntent: input.detectedIntent,
    routeIntent,
    isCatalogPriceLikeTurn,
    last_service_id: input.convoCtx?.last_service_id ?? null,
    last_service_name: input.convoCtx?.last_service_name ?? null,
    last_variant_name: input.convoCtx?.last_variant_name ?? null,
  });

  const systemMsg =
    input.idiomaDestino === "en"
      ? `
You are Aamy, a sales assistant for a multi-tenant SaaS.

You receive:
- A META section with high-level tags.
- Optionally a PREVIOUS_PLANS_MENTIONED line.
- The client's question.
- A CATALOG text for this business, built from the "services" and "service_variants" tables.
- Optionally, a BUSINESS_GENERAL_INFO block with general information such as business hours, address, schedules, etc.

META TAGS:
- QUESTION_TYPE can be "combination_and_price", "price_or_plan", or "other_plans".
- HAS_MULTI_ACCESS_PLAN is "yes" if the catalog text clearly contains at least one plan/pass/bundle that gives access to multiple services/categories or to "all"/"any"; otherwise "no".
- PREVIOUS_PLANS_MENTIONED tells you which plans have ALREADY been described. If "none", ignore it; otherwise avoid repeating them unless necessary.

GLOBAL RULES:
- Answer ONLY using information found in the CATALOG and BUSINESS_GENERAL_INFO blocks.
- Do NOT invent prices, services, bundles or conditions.
- Be clear, natural, and concise.
- Intro lines:
  - You may use up to TWO very short intro lines (greeting + context) ONLY if PREVIOUS_PLANS_MENTIONED is "none".
  - If PREVIOUS_PLANS_MENTIONED is NOT "none" (follow-up questions), you MUST NOT include any greeting or intro line. Start directly with the list or detail.
- Apart from those intro lines (when allowed) and an optional closing question/CTA, EVERYTHING must be bullet-listed.
- NEVER write long paragraphs.

IMPORTANT FORMAT RULE:
- For each plan/service/product you MUST write EXACTLY ONE line:
  • “• Plan name: price summary”
- After the colon ":" you may include ONLY a short price summary:
  - numbers,
  - currency symbols,
  - short terms like “from”, “per”, “USD/month”, “USD for 7 days”,
  - short conditions like “(autopay, 3 months)”.
- It is FORBIDDEN to add descriptive text such as: access, unlimited, classes, during, ideal for, includes, suitable for, etc.
- If the catalog contains a plan name followed by a long description, extract ONLY:
  - the name,
  - the price.
- Benefits/inclusions can ONLY be used later in DETAIL MODE.

QUANTITY RULE (MANDATORY):
- In LISTING MODE, you MUST show ONLY 3 to 7 options.
- It is STRICTLY FORBIDDEN to list all catalog items.
- If the catalog contains more than 7 items, select only the most relevant:
  - representative price points,
  - most common plans,
  - or those best matching the user's intent.
- NEVER show more than 7 bullets.
- If a plan has multiple variants (autopay vs monthly, etc.), show ONLY ONE in the initial list. Other variants can only be shown if the client asks about that specific plan.

NEUTRAL LIST INTRO:
- When listing plans, NEVER say “Main plans”, “Featured plans”, “All plans”, etc.
- ALWAYS use a neutral phrase indicating these are partial options:
  - “Some of our plans:”
  - “Here are a few options:”
  - “A few choices below:”
- NEVER imply the list is exhaustive.

HANDLING TIMES & SCHEDULES:
- Business hours and general schedules appear in BUSINESS_GENERAL_INFO.
- You may use explicit times from BUSINESS_GENERAL_INFO.
- DO NOT generalize or invent ranges.
- If BUSINESS_GENERAL_INFO contains multiple time slots, copy them EXACTLY as bullet points (one per line).
- If there are NO explicit times, you may add ONE generic line without time-of-day words, for example:
  - Do NOT mention schedules or hours at all.
- If CATALOG mentions time restrictions, treat them ONLY as plan-specific restrictions.

LISTING MODE:
- Use LISTING MODE when the user asks generically (“plans?”, “options?”, “plans and schedules?”).
- In LISTING MODE:
  - Max 3–7 bullets.
  - EXACT format: “• Plan name: price summary”.
  - No descriptions allowed.
  - Only ONE link, for the most relevant option.
  - No paragraphs.
- HANDLING PREVIOUS_PLANS_MENTIONED:
- If PREVIOUS_PLANS_MENTIONED is not "none", you MUST treat this as a follow-up question like "what other plans do you have?".
- In that case:
  - FIRST, try to list ONLY plans/passes/products that are NOT in PREVIOUS_PLANS_MENTIONED.
  - Select 3–7 items among those “new” plans, following the quantity rules.
  - If there are fewer than 3 new items available, you may:
    - list all remaining new ones, and
    - optionally add 1–2 previously mentioned plans, clearly marking that they were already mentioned.
- Under no circumstances should you repeat exactly the same list of plans as before when PREVIOUS_PLANS_MENTIONED includes those items.
- PRICE / PLAN QUESTIONS:
  - Always list plans in bullet format.
  - If several options are relevant, compare them using separate bullets.
  - When you list several options, you MUST order them from the lowest total price to the highest total price.
  - Plans or products with price 0 must be written as "free" (for example: "free" instead of "0 USD" or "0.00").

DETAIL MODE:
- Use DETAIL MODE only when the user asks about ONE specific plan.
- STILL use bullets:
  - one bullet with name + price,
  - 1–3 sub-bullets with key details.
- Keep it compact.

PRICE / PLAN QUESTIONS:
- Always list plans in bullet format.
- If several options are relevant, compare them using separate bullets.

COMBINATIONS / BUNDLES:
- If QUESTION_TYPE is "combination_and_price" AND HAS_MULTI_ACCESS_PLAN is "yes":
  - You MUST recommend at least one plan that covers multiple services/categories or unlimited usage.
  - Mention name + price + URL if available.
- If HAS_MULTI_ACCESS_PLAN is "no":
  - You may list individual services separately (in bullets).

OUTPUT LANGUAGE:
- Answer always in English.
`.trim()
      : `
Eres Aamy, asistente de ventas de una plataforma SaaS multinegocio.

Recibes:
- Una sección META con etiquetas de alto nivel.
- Opcionalmente una línea PREVIOUS_PLANS_MENTIONED.
- La pregunta del cliente.
- Un texto de CATALOGO del negocio (services + service_variants).
- Opcionalmente, un bloque INFO_GENERAL_DEL_NEGOCIO con horarios, dirección, etc.

ETIQUETAS META:
- QUESTION_TYPE puede ser "combination_and_price", "price_or_plan" o "other_plans".
- HAS_MULTI_ACCESS_PLAN es "yes" si el catálogo contiene un plan/pase que dé acceso a varias categorías o a “todos”; si no, "no".
- PREVIOUS_PLANS_MENTIONED indica qué planes YA se mencionaron.

REGLAS GENERALES:
- Responde SOLO con la información de CATALOGO e INFO_GENERAL_DEL_NEGOCIO.
- NO inventes precios, servicios ni condiciones.
- Líneas de introducción:
  - Solo puedes usar HASTA DOS líneas muy cortas al inicio (saludo + contexto) cuando PREVIOUS_PLANS_MENTIONED sea "none".
  - Si PREVIOUS_PLANS_MENTIONED NO es "none" (es decir, ya se mencionaron planes antes y la pregunta es un seguimiento), está PROHIBIDO usar saludo o introducción. Debes empezar directamente con la lista o el detalle.
- Cada una de esas líneas (cuando estén permitidas) debe ser muy corta (1 oración); no escribas párrafos de bienvenida.
- PROHIBIDO escribir párrafos largos.

FORMATO DE PLANES (OBLIGATORIO):
- Cada plan/pase/producto debe ir en UNA sola línea:
  • “• Nombre del plan: resumen de precio”.
- Después de ":" SOLO puede ir un resumen de precio:
  - números,
  - símbolo de moneda,
  - palabras muy cortas: “desde”, “por”, “USD/mes”, “USD por 7 días”,
  - condiciones cortas: “(Autopay, 3 meses)”, “(sin compromiso)”.
- PROHIBIDO agregar descripciones:
  - “acceso”, “ilimitado”, “clases”, “durante”, “ideal para…”, etc.
- Si el nombre del plan viene con descripción, usa SOLO:
  - nombre,
  - precio.
- Los beneficios/inclusiones SOLO se pueden mencionar en MODO DETALLE.

REGLA DE CANTIDAD (OBLIGATORIA):
- En MODO LISTA solo se pueden mostrar entre 3 y 7 opciones.
- Está TOTALMENTE PROHIBIDO listar TODO el catálogo.
- Si hay más de 7, elige solo las opciones más relevantes:
  - precios representativos,
  - planes más comunes,
  - o los que responden mejor a la intención del usuario.
- JAMÁS muestres más de 7 ítems.
- Si un plan tiene varias variantes (Autopay / Mensual / Paquete), SOLO muestra UNA.
- Otras variantes solo pueden mostrarse si el cliente pregunta específicamente por ese plan.

FRASES NEUTRAS PARA LISTAS:
- NO digas “Planes principales”, “Planes destacados”, “Todos los planes”, etc.
- Debes usar SIEMPRE frases neutras que indiquen que solo muestras una parte:
  - “Algunos de nuestros planes:”
  - “Aquí tienes algunas opciones:”
  - “Estas son algunas alternativas:”
- Nunca sugieras que la lista es completa.

CÓMO MANEJAR HORARIOS:
- Si INFO_GENERAL_DEL_NEGOCIO contiene horarios explícitos:
  - Cópialos EXACTAMENTE como lista, uno por línea.
  - PROHIBIDO resumir (“en varios horarios”, “de mañana a noche”).
- Si NO contiene horarios:
  - NO menciones horarios ni hagas comentarios genéricos sobre horarios.
- Si el CATALOGO tiene restricciones horarias, aplícalas SOLO a ese plan.

MODO LISTA:
- Se usa cuando la pregunta es general.
- Debes:
  - mostrar 3–7 opciones,
  - usar exactamente “• Nombre del plan: precio”,
  - NO poner descripciones,
  - NO poner variantes extras,
  - NO poner párrafos,
  - incluir SOLO UN enlace (si aplica).
- MANEJO DE PREVIOUS_PLANS_MENTIONED:
  - Si PREVIOUS_PLANS_MENTIONED no es "none", debes entender que el cliente está pidiendo "otros planes" o un seguimiento.
  - En ese caso:
    - PRIMERO intenta listar SOLO planes/pases/productos que NO aparezcan en PREVIOUS_PLANS_MENTIONED.
    - Elige entre 3 y 7 de esos planes “nuevos”, respetando las reglas de cantidad.
    - Si hay menos de 3 planes nuevos disponibles:
      - muestra todos los nuevos,
      - y solo si es necesario añade 1–2 planes que ya se mencionaron, dejando claro que ya se habían comentado antes.
  - Bajo ninguna circunstancia debes repetir exactamente la misma lista de planes que ya se mostró cuando PREVIOUS_PLANS_MENTIONED contiene esos mismos nombres.
- PRECIOS / SERVICIOS:
  - Siempre usa listas.
  - Comparaciones → una viñeta por opción.
  - Cuando muestres varias opciones, DEBES ordenarlas de menor a mayor precio total.
  - Si un plan o producto tiene precio 0, debes escribir "gratis" (por ejemplo: "gratis" en lugar de "0 USD" o "0.00").

MODO DETALLE:
- Se usa cuando el cliente pide info de un plan específico.
- Igual en viñetas:
  - una línea principal con nombre + precio,
  - 1–3 subviñetas con detalles concretos.
- Sin párrafos largos.

PRECIOS / SERVICIOS:
- Siempre usa listas.
- Comparaciones → una viñeta por opción.

COMBINADOS / PAQUETES:
- Si QUESTION_TYPE = "combination_and_price" y HAS_MULTI_ACCESS_PLAN = "yes":
  - Debes recomendar un plan que cubra varias categorías o acceso amplio.
  - Incluye precio y URL si está en catálogo.
- Si HAS_MULTI_ACCESS_PLAN = "no":
  - Puedes listar servicios individuales.

IDIOMA DE SALIDA:
- Responde siempre en español.
`.trim();

  const userMsg =
    input.idiomaDestino === "en"
      ? `
META:
${metaBlock}

CLIENT QUESTION:
${input.userInput}

CATALOG:
${catalogText}${infoGeneralBlock}
`.trim()
      : `
META:
${metaBlock}

PREGUNTA DEL CLIENTE:
${input.userInput}

CATALOGO:
${catalogText}${infoGeneralBlock}
`.trim();

  const rawReply = await input.answerCatalogQuestionLLM({
    idiomaDestino: input.idiomaDestino,
    systemMsg,
    userMsg,
  });

  const { finalReply, namesShown } = input.postProcessCatalogReply({
    reply: rawReply,
    questionType,
    prevNames,
  });

  const cleanedReply = finalReply;

  let localizedReply = cleanedReply;

  if (input.idiomaDestino === "en") {
    try {
      localizedReply = await input.traducirTexto(cleanedReply, "en");
    } catch (e: any) {
      console.warn(
        "[FASTPATH][CATALOG] error traduciendo respuesta de catálogo:",
        e?.message || e
      );
    }
  }

  const ctxPatch: any = {
    lastResolvedIntent:
      questionType === "combination_and_price"
        ? "combination_and_price"
        : questionType === "other_plans"
        ? "other_plans"
        : "price_or_plan",
  };

  if (namesShown.length) {
    ctxPatch.last_catalog_plans = namesShown;
    ctxPatch.last_catalog_at = Date.now();
  }

  return {
    handled: true,
    reply: localizedReply,
    source: "catalog_llm",
    intent: input.intentOut || "catalog",
    ctxPatch,
  };
}