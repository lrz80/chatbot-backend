//src/lib/fastpath/handlers/catalog/runCatalogFastpath.ts
import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogIntentFlags } from "./getCatalogIntentFlags";
import { getCatalogTurnState } from "./getCatalogTurnState";
import { handleSingleServiceCatalog } from "./handleSingleServiceCatalog";
import {
  composeCatalogReplyBlocks,
  withSectionTitle,
} from "./helpers/catalogReplyBlocks";
import {
  buildAvailabilityBlockFromInfoClave,
  buildLocationBlockFromInfoClave,
} from "./helpers/catalogBusinessInfoBlocks";
import { buildPriceBlock } from "./helpers/catalogPriceBlock";
import { buildScheduleBlock } from "./helpers/catalogScheduleBlock";

type CatalogFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

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
  facets?: CatalogFacets | null;

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
    facets: input.facets || {},
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
    asksPrices,
    asksLocation,
    asksAvailability,
  } = getCatalogIntentFlags({
    routeIntent,
    facets: input.facets || {},
  });

  void isCombinationIntent;
  void isAskingOtherCatalogOptions;
  void asksAvailability;

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

  const intentOutNorm = String(input.intentOut || "").trim().toLowerCase();

  const hasExplicitCatalogRouting =
    catalogRoutingSignal.shouldRouteCatalog === true ||
    referenceKind === "catalog_overview" ||
    referenceKind === "catalog_family";

  const hasExplicitCatalogIntent =
    intentOutNorm === "precio" ||
    intentOutNorm === "planes_precios" ||
    intentOutNorm === "catalogo" ||
    intentOutNorm === "catalog" ||
    intentOutNorm === "other_plans" ||
    intentOutNorm === "catalog_alternatives" ||
    intentOutNorm === "combination_and_price" ||
    intentOutNorm === "catalog_combination";

  const isLocationOnlyTurn =
    asksLocation &&
    !asksPrices &&
    !asksSchedules &&
    !asksAvailability &&
    !asksIncludesOnly &&
    !isCombinationIntent &&
    !isAskingOtherCatalogOptions;

  const isAvailabilityOnlyTurn =
    asksAvailability &&
    !asksPrices &&
    !asksSchedules &&
    !asksLocation &&
    !asksIncludesOnly &&
    !isCombinationIntent &&
    !isAskingOtherCatalogOptions;

  if (isLocationOnlyTurn || isAvailabilityOnlyTurn) {
    const locationBody = asksLocation
      ? buildLocationBlockFromInfoClave(input.infoClave)
      : "";

    const availabilityBody = asksAvailability
      ? buildAvailabilityBlockFromInfoClave(input.infoClave)
      : "";

    const locationBlock = withSectionTitle(
      input.idiomaDestino,
      "Ubicación:",
      "Location:",
      locationBody
    );

    const availabilityBlock = withSectionTitle(
      input.idiomaDestino,
      "Disponibilidad:",
      "Availability:",
      availabilityBody
    );

    const finalReply = composeCatalogReplyBlocks({
      idiomaDestino: input.idiomaDestino,
      asksPrices,
      asksSchedules,
      asksLocation,
      asksAvailability,
      locationBlock,
      availabilityBlock,
      includeClosingLine: true,
    });

    if (finalReply.trim()) {
      return {
        handled: true,
        reply: finalReply,
        source: "catalog_db",
        intent: asksLocation ? "ubicacion" : "disponibilidad",
        ctxPatch: {
          last_catalog_at: Date.now(),
          lastResolvedIntent: asksLocation ? "location_only" : "availability_only",
        } as any,
      };
    }

    console.log("[CATALOG][SKIP_NON_PRICE_INFO_ONLY_EMPTY]", {
      userInput: input.userInput,
      intentOut: input.intentOut,
      facets: input.facets || {},
      routeIntent,
    });

    return {
      handled: false,
    };
  }

  const hasFacetDrivenCatalogIntent =
    asksPrices || asksSchedules;

  const allowGenericCatalogDbFallback =
    hasExplicitCatalogRouting ||
    hasExplicitCatalogIntent ||
    hasFacetDrivenCatalogIntent;

  if (isCatalogPriceLikeTurn) {
    console.log("🚫 BLOCK LLM PRICING — forcing DB path");
  }

  if (!isCatalogQuestion && !hasFacetDrivenCatalogIntent) {
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
  } else if (asksSchedules) {
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
      facets: input.facets || {},
    });
  }

  if (routeIntent === "catalog_family" && intentAllowsCatalogRouting) {
    console.log("[CATALOG_FAMILY][RUN_FASTPATH]", {
      userInput: input.userInput,
      questionType,
      detectedIntent: input.detectedIntent,
      catalogReferenceKind: input.catalogReferenceClassification?.kind ?? "none",
      routeIntent,
      facets: input.facets || {},
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
    `PREVIOUS_PLANS_MENTIONED: ${previousPlansStr}\n` +
    `ASKS_PRICES: ${asksPrices ? "yes" : "no"}\n` +
    `ASKS_SCHEDULES: ${asksSchedules ? "yes" : "no"}\n` +
    `ASKS_LOCATION: ${asksLocation ? "yes" : "no"}\n` +
    `ASKS_AVAILABILITY: ${asksAvailability ? "yes" : "no"}`;

  const shouldAttachBusinessInfo =
    Boolean(input.infoClave) &&
    (
      asksSchedules ||
      asksLocation ||
      asksAvailability ||
      routeIntent === "catalog_schedule" ||
      intentOutNorm === "info_general" ||
      intentOutNorm === "info_horarios_generales" ||
      intentOutNorm === "ubicacion" ||
      intentOutNorm === "disponibilidad"
    );

  const infoGeneralBlock = shouldAttachBusinessInfo
    ? input.idiomaDestino === "en"
      ? `\n\nBUSINESS_GENERAL_INFO (hours, address, availability, etc.):\n${input.infoClave}`
      : `\n\nINFO_GENERAL_DEL_NEGOCIO (horarios, dirección, disponibilidad, etc.):\n${input.infoClave}`
    : "";

  // PRICE OR PLAN
  if (!asksSchedules && !asksIncludesOnly && questionType === "price_or_plan") {
    if (!allowGenericCatalogDbFallback) {
      console.log("[CATALOG_DB][BLOCKED_GENERIC_FALLBACK]", {
        userInput: input.userInput,
        intentOut: input.intentOut,
        routeIntent,
        referenceKind,
        shouldRouteCatalog: catalogRoutingSignal.shouldRouteCatalog,
        hasStructuredTarget: input.hasStructuredTarget,
        facets: input.facets || {},
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

    const priceBlock = buildPriceBlock({
      idiomaDestino: input.idiomaDestino,
      rows: rowsLocalized,
      renderGenericPriceSummaryReply: input.renderGenericPriceSummaryReply,
    });

    const canonicalReply = priceBlock;
    const namesShown = input.extractPlanNamesFromReply(priceBlock);

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
      facets: input.facets || {},
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
        facets: input.facets || {},
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

    const priceBlock = buildPriceBlock({
      idiomaDestino: input.idiomaDestino,
      rows: rowsLocalized,
      renderGenericPriceSummaryReply: input.renderGenericPriceSummaryReply,
    });

    const scheduleBlock = buildScheduleBlock({
      idiomaDestino: input.idiomaDestino,
      infoClave: input.infoClave,
    });

    const canonicalReply = composeCatalogReplyBlocks({
      idiomaDestino: input.idiomaDestino,
      asksPrices,
      asksSchedules,
      asksLocation,
      asksAvailability,
      priceBlock,
      scheduleBlock,
      includeClosingLine: true,
    });

    const namesShown = input.extractPlanNamesFromReply(priceBlock);

    const finalReply = canonicalReply;

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
      facets: input.facets || {},
    });

    return {
      handled: true,
      reply: finalReply,
      source: "catalog_db",
      intent: "precio",
      ctxPatch,
    };
  }

  // OTHER PLANS
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
    facets: input.facets || {},
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
- ASKS_PRICES / ASKS_SCHEDULES / ASKS_LOCATION / ASKS_AVAILABILITY indicate which information blocks were requested.

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
- If there are NO explicit times, do not mention schedules or hours at all.
- If CATALOG mentions time restrictions, treat them ONLY as plan-specific restrictions.

HANDLING LOCATION:
- If ASKS_LOCATION is "yes" and BUSINESS_GENERAL_INFO contains an address/location, include it exactly as provided.
- Do not invent addresses or directions.

HANDLING AVAILABILITY:
- If ASKS_AVAILABILITY is "yes" and BUSINESS_GENERAL_INFO contains availability-related information, include it exactly as provided.
- Do not invent availability.

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
  - Plans or products with price 0 must be written as "free".

DETAIL MODE:
- Use DETAIL MODE only when the user asks about ONE specific plan.
- STILL use bullets:
  - one bullet with name + price,
  - 1–3 sub-bullets with key details.
- Keep it compact.

COMBINATIONS / BUNDLES:
- If QUESTION_TYPE is "combination_and_price" AND HAS_MULTI_ACCESS_PLAN is "yes":
  - You MUST recommend at least one plan that covers multiple services/categories or unlimited usage.
  - Mention name + price + URL if available.
- If HAS_MULTI_ACCESS_PLAN is "no":
  - You may list individual services separately.

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
- ASKS_PRICES / ASKS_SCHEDULES / ASKS_LOCATION / ASKS_AVAILABILITY indican qué bloques pidió el cliente.

REGLAS GENERALES:
- Responde SOLO con la información de CATALOGO e INFO_GENERAL_DEL_NEGOCIO.
- NO inventes precios, servicios ni condiciones.
- Líneas de introducción:
  - Solo puedes usar HASTA DOS líneas muy cortas al inicio (saludo + contexto) cuando PREVIOUS_PLANS_MENTIONED sea "none".
  - Si PREVIOUS_PLANS_MENTIONED NO es "none", está PROHIBIDO usar saludo o introducción. Debes empezar directamente con la lista o el detalle.
- Cada una de esas líneas, cuando estén permitidas, debe ser muy corta.
- PROHIBIDO escribir párrafos largos.

FORMATO DE PLANES OBLIGATORIO:
- Cada plan/pase/producto debe ir en UNA sola línea:
  • “• Nombre del plan: resumen de precio”.
- Después de ":" SOLO puede ir un resumen de precio:
  - números,
  - símbolo de moneda,
  - palabras muy cortas,
  - condiciones cortas.
- PROHIBIDO agregar descripciones.
- Si el nombre del plan viene con descripción, usa SOLO:
  - nombre,
  - precio.
- Los beneficios/inclusiones SOLO se pueden mencionar en MODO DETALLE.

REGLA DE CANTIDAD OBLIGATORIA:
- En MODO LISTA solo se pueden mostrar entre 3 y 7 opciones.
- Está TOTALMENTE PROHIBIDO listar TODO el catálogo.
- Si hay más de 7, elige solo las opciones más relevantes.
- JAMÁS muestres más de 7 ítems.
- Si un plan tiene varias variantes, SOLO muestra UNA en la lista inicial.

FRASES NEUTRAS PARA LISTAS:
- NO digas “Planes principales”, “Planes destacados”, “Todos los planes”, etc.
- Debes usar frases neutras que indiquen que solo muestras una parte.

CÓMO MANEJAR HORARIOS:
- Si INFO_GENERAL_DEL_NEGOCIO contiene horarios explícitos:
  - cópialos EXACTAMENTE como lista, uno por línea.
- Si NO contiene horarios:
  - NO menciones horarios ni hagas comentarios genéricos.
- Si el CATALOGO tiene restricciones horarias, aplícalas SOLO a ese plan.

CÓMO MANEJAR UBICACIÓN:
- Si ASKS_LOCATION = "yes" y INFO_GENERAL_DEL_NEGOCIO contiene dirección o ubicación, inclúyela exactamente como está.
- NO inventes dirección ni referencias.

CÓMO MANEJAR DISPONIBILIDAD:
- Si ASKS_AVAILABILITY = "yes" y INFO_GENERAL_DEL_NEGOCIO contiene disponibilidad, inclúyela exactamente como está.
- NO inventes disponibilidad.

MODO LISTA:
- Se usa cuando la pregunta es general.
- Debes:
  - mostrar 3–7 opciones,
  - usar exactamente “• Nombre del plan: precio”,
  - NO poner descripciones,
  - NO poner párrafos,
  - incluir SOLO UN enlace si aplica.
- MANEJO DE PREVIOUS_PLANS_MENTIONED:
  - Si PREVIOUS_PLANS_MENTIONED no es "none", debes entender que el cliente está pidiendo seguimiento u otras opciones.
  - En ese caso:
    - primero intenta listar SOLO planes nuevos,
    - si hay pocos, puedes completar con 1–2 ya mencionados.
- PRECIOS / SERVICIOS:
  - Siempre usa listas.
  - Cuando muestres varias opciones, ordénalas de menor a mayor precio total.
  - Si un plan o producto tiene precio 0, debes escribir "gratis".

MODO DETALLE:
- Se usa cuando el cliente pide info de un plan específico.
- Igual en viñetas:
  - una línea principal con nombre + precio,
  - 1–3 subviñetas con detalles concretos.

COMBINADOS / PAQUETES:
- Si QUESTION_TYPE = "combination_and_price" y HAS_MULTI_ACCESS_PLAN = "yes":
  - debes recomendar un plan que cubra varias categorías o acceso amplio.
- Si HAS_MULTI_ACCESS_PLAN = "no":
  - puedes listar servicios individuales.

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
    lastResolvedIntent: questionType,
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