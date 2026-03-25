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
import { renderCatalogReplyWithSalesFrame } from "../../helpers/catalogRendering";

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
    idiomaDestino: "es" | "en";
    canonicalReply: string;
    userInput: string;
    mode?: "grounded_frame_only" | "grounded_catalog_sales";
    maxIntroLines?: number;
    maxClosingLines?: number;
  }) => Promise<string | null>;

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

  const shouldTrySingleServiceCatalog =
    input.hasStructuredTarget ||
    Boolean(catalogRoutingSignal.targetServiceId) ||
    Boolean(catalogRoutingSignal.targetVariantId) ||
    referenceKind === "entity_specific" ||
    referenceKind === "variant_specific" ||
    referenceKind === "referential_followup" ||
    referenceKind === "catalog_family";

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

  const locationBody = asksLocation
  ? buildLocationBlockFromInfoClave(input.infoClave)
  : "";

  const availabilityBody = asksAvailability
    ? buildAvailabilityBlockFromInfoClave(input.infoClave)
    : "";

  const scheduleBlock =
    asksSchedules
      ? buildScheduleBlock({
          idiomaDestino: input.idiomaDestino,
          infoClave: input.infoClave,
        })
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

  const isBusinessInfoFacetTurn =
    !asksPrices &&
    (asksSchedules || asksLocation || asksAvailability) &&
    !asksIncludesOnly &&
    !isCombinationIntent &&
    !isAskingOtherCatalogOptions;

  if (isBusinessInfoFacetTurn) {
    const canonicalReply = composeCatalogReplyBlocks({
      idiomaDestino: input.idiomaDestino,
      asksPrices,
      asksSchedules,
      asksLocation,
      asksAvailability,
      scheduleBlock,
      locationBlock,
      availabilityBlock,
      includeClosingLine: true,
    });

    if (canonicalReply.trim()) {
      const finalReply = await renderCatalogReplyWithSalesFrame({
        lang: input.idiomaDestino === "en" ? "en" : "es",
        userInput: input.userInput,
        canonicalReply,
        answerCatalogQuestionLLM: input.answerCatalogQuestionLLM,
        mode: "grounded_frame_only",
        maxIntroLines: 1,
        maxClosingLines: 1,
      });

      return {
        handled: true,
        reply: finalReply,
        source: "catalog_db",
        intent: asksLocation
          ? "ubicacion"
          : asksSchedules
          ? "horario"
          : "disponibilidad",
        ctxPatch: {
          last_catalog_at: Date.now(),
          lastResolvedIntent: "business_info_facets",
        } as any,
      };
    }

    console.log("[CATALOG][SKIP_BUSINESS_INFO_FACETS_EMPTY]", {
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
    asksPrices || asksSchedules || asksLocation || asksAvailability;

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

    if (shouldTrySingleServiceCatalog) {
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
        answerCatalogQuestionLLM: input.answerCatalogQuestionLLM,
        renderCatalogReplyWithSalesFrame,
        catalogRouteIntent: routeIntent,
      });

      if (singleServiceCatalogResult.handled) {
        return singleServiceCatalogResult;
      }
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

    const finalReply = await renderCatalogReplyWithSalesFrame({
      lang: input.idiomaDestino === "en" ? "en" : "es",
      userInput: input.userInput,
      canonicalReply,
      answerCatalogQuestionLLM: input.answerCatalogQuestionLLM,
      mode: "grounded_catalog_sales",
      maxIntroLines: 1,
      maxClosingLines: 1,
    });

    console.log("[PRICE][catalog_db][SAFE_RENDER]", {
      rowsCount: rowsLocalized.length,
      namesShown,
      usedModelReply: finalReply !== canonicalReply,
      canonicalPreview: canonicalReply.slice(0, 220),
      modelPreview: finalReply.slice(0, 220),
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

    const canonicalReply = composeCatalogReplyBlocks({
      idiomaDestino: input.idiomaDestino,
      asksPrices,
      asksSchedules,
      asksLocation,
      asksAvailability,
      priceBlock,
      scheduleBlock,
      locationBlock,
      availabilityBlock,
      includeClosingLine: true,
    });

    const namesShown = input.extractPlanNamesFromReply(priceBlock);

    const finalReply = await renderCatalogReplyWithSalesFrame({
      lang: input.idiomaDestino === "en" ? "en" : "es",
      userInput: input.userInput,
      canonicalReply,
      answerCatalogQuestionLLM: input.answerCatalogQuestionLLM,
      mode: "grounded_catalog_sales",
      maxIntroLines: 1,
      maxClosingLines: 1,
    });

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
      const fallbackNames = (prevFresh ? prevNames : [])
        .map((name: string) => String(name || "").trim())
        .filter(Boolean)
        .slice(0, 5);

      const canonicalReply = fallbackNames.length
        ? fallbackNames.map((name: string) => `• ${name}`).join("\n")
        : "";

      const finalReply = canonicalReply
        ? await renderCatalogReplyWithSalesFrame({
            lang: input.idiomaDestino === "en" ? "en" : "es",
            userInput: input.userInput,
            canonicalReply,
            answerCatalogQuestionLLM: input.answerCatalogQuestionLLM,
            mode: "grounded_catalog_sales",
            maxIntroLines: 1,
            maxClosingLines: 1,
          })
        : "";

      return {
        handled: true,
        reply: finalReply || canonicalReply,
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

    const canonicalReply = rowsLocalized
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

    const reply = await renderCatalogReplyWithSalesFrame({
      lang: input.idiomaDestino === "en" ? "en" : "es",
      userInput: input.userInput,
      canonicalReply,
      answerCatalogQuestionLLM: input.answerCatalogQuestionLLM,
      mode: "grounded_catalog_sales",
      maxIntroLines: 1,
      maxClosingLines: 1,
    });

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

  return {
    handled: false,
  };
}