import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";
import {
  formatMoneyAmount,
  formatMoneyRange,
  toNullableMoneyNumber,
} from "./helpers/catalogMoneyFormat";

export type HandleSingleServiceCatalogInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;
  routeIntent: string;
  catalogRoutingSignal: any;
  catalogReferenceClassification?: any;

  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;

  rows: any[];

  catalogRouteIntent?: string | null;
};

function toTrimmedString(value: any): string {
  return String(value ?? "").trim();
}

function normalizeDetailLine(value: string): string {
  return String(value || "").trim().replace(/^[-•*]\s*/, "");
}

function buildCanonicalDetailBlock(params: {
  idiomaDestino: string;
  serviceDescription: string;
}): string {
  void params.idiomaDestino;

  const rawLines = String(params.serviceDescription || "")
    .split(/\r?\n/)
    .map((line) => normalizeDetailLine(line))
    .filter(Boolean);

  if (!rawLines.length) {
    return "";
  }

  return rawLines.map((line) => `• ${line}`).join("\n");
}

export async function handleSingleServiceCatalog(
  input: HandleSingleServiceCatalogInput
): Promise<FastpathResult> {
  const structuredSignals = getCatalogStructuredSignals({
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
    catalogRouteIntent: input.catalogRouteIntent,
  });

  const referenceKind = toTrimmedString(
    structuredSignals.referenceKind ||
      input.catalogReferenceClassification?.kind ||
      input.catalogRoutingSignal?.referenceKind ||
      "none"
  ).toLowerCase();

  const structuredTargetServiceId = toTrimmedString(
    input.catalogRoutingSignal?.targetServiceId ||
      input.catalogReferenceClassification?.targetServiceId ||
      structuredSignals.targetServiceId ||
      ""
  );

  const structuredTargetServiceName = toTrimmedString(
    input.catalogRoutingSignal?.targetServiceName ||
      input.catalogReferenceClassification?.targetServiceName ||
      ""
  );

  const targetVariantId = toTrimmedString(
    input.catalogRoutingSignal?.targetVariantId ||
      input.catalogReferenceClassification?.targetVariantId ||
      structuredSignals.targetVariantId ||
      ""
  );

  const targetFamilyKey = toTrimmedString(
    input.catalogRoutingSignal?.targetFamilyKey ||
      input.catalogReferenceClassification?.targetFamilyKey ||
      structuredSignals.targetFamilyKey ||
      ""
  );

  const hasStructuredTarget =
    Boolean(structuredTargetServiceId) ||
    Boolean(targetVariantId) ||
    Boolean(targetFamilyKey) ||
    referenceKind === "entity_specific" ||
    referenceKind === "variant_specific" ||
    referenceKind === "catalog_family";

  const shouldSkipSinglePriceTargetResolution = false;

  const ellipticPriceFollowup =
    input.catalogRoutingSignal.shouldRouteCatalog &&
    (
      referenceKind === "referential_followup" ||
      input.catalogRoutingSignal.routeIntent === "catalog_alternatives" ||
      input.catalogRoutingSignal.routeIntent === "catalog_schedule" ||
      input.catalogRoutingSignal.routeIntent === "catalog_price" ||
      input.catalogReferenceClassification?.intent === "includes"
    );

  const ctxServiceId =
    toTrimmedString(input.convoCtx?.last_service_id) ||
    toTrimmedString(input.convoCtx?.selectedServiceId);

  const ctxServiceName =
    toTrimmedString(input.convoCtx?.last_service_name);

  const shouldResolveFromStructuredTarget =
    !shouldSkipSinglePriceTargetResolution &&
    (
      Boolean(structuredTargetServiceId) ||
      Boolean(targetVariantId) ||
      referenceKind === "entity_specific" ||
      referenceKind === "variant_specific"
    );

  const singleHit =
    shouldSkipSinglePriceTargetResolution
      ? null
      : shouldResolveFromStructuredTarget && structuredTargetServiceId
      ? {
          id: structuredTargetServiceId,
          name:
            structuredTargetServiceName ||
            toTrimmedString(input.catalogReferenceClassification?.targetServiceName) ||
            ctxServiceName ||
            "",
        }
      : ellipticPriceFollowup && ctxServiceId
      ? {
          id: ctxServiceId,
          name: ctxServiceName,
        }
      : null;

  if (shouldSkipSinglePriceTargetResolution) {
    console.log("[PRICE][single] skipped_by_catalog_reference_classification", {
      userInput: input.userInput,
      catalogReferenceKind: input.catalogReferenceClassification?.kind ?? "none",
    });
  }

  console.log("[PRICE][single] structured resolve output", {
    userInput: input.userInput,
    ellipticPriceFollowup,
    referenceKind,
    hasStructuredTarget,
    shouldResolveFromStructuredTarget,
    structuredTargetServiceId,
    structuredTargetServiceName,
    targetVariantId,
    targetFamilyKey,
    singleHit,
    ctxLastService: input.convoCtx?.last_service_id
      ? {
          id: input.convoCtx.last_service_id,
          name: input.convoCtx.last_service_name || null,
        }
      : null,
  });

  const asksSchedules = input.asksSchedules === true;
  const asksPrices = input.asksPrices === true;
  const asksLocation = input.asksLocation === true;
  const asksAvailability = input.asksAvailability === true;

  if (singleHit?.id) {
    const targetServiceId = toTrimmedString(singleHit.id);
    const targetServiceName = toTrimmedString(singleHit.name);

    const { rows: variants } = await input.pool.query<any>(
      `
      SELECT
        id,
        variant_name,
        description,
        variant_url,
        price,
        currency
      FROM service_variants
      WHERE service_id = $1
        AND active = true
      ORDER BY created_at ASC, id ASC
      `,
      [targetServiceId]
    );

    console.log("[PRICE][single] variants fetched", {
      targetServiceId,
      targetServiceName,
      variants: variants.map((v: any) => ({
        id: v.id,
        variant_name: v.variant_name,
        price: v.price,
        currency: v.currency,
      })),
    });

    const pricedVariants = variants.filter((v: any) => {
      const n = Number(v.price);
      return Number.isFinite(n) && n >= 0;
    });

    let chosenVariant: any = null;

    if (pricedVariants.length > 0) {
      const storedVariantOptions = Array.isArray(input.convoCtx?.last_variant_options)
        ? input.convoCtx.last_variant_options
        : [];

      const isAwaitingPriceVariantSelection =
        input.convoCtx?.expectedVariantIntent === "price_or_plan" &&
        Boolean(input.convoCtx?.expectingVariant) &&
        storedVariantOptions.length > 0;

      if (targetVariantId) {
        chosenVariant =
          pricedVariants.find(
            (v: any) => String(v.id) === String(targetVariantId)
          ) || null;

        console.log("[PRICE][single][STRUCTURED_VARIANT_SELECTION]", {
          userInput: input.userInput,
          targetVariantId,
          chosenVariant: chosenVariant
            ? {
                id: chosenVariant.id,
                variant_name: chosenVariant.variant_name,
                price: chosenVariant.price,
              }
            : null,
        });
      }

      if (!chosenVariant && isAwaitingPriceVariantSelection && targetVariantId) {
        const pickedFromContext =
          storedVariantOptions.find(
            (opt: any) => String(opt.id || "") === String(targetVariantId)
          ) || null;

        if (pickedFromContext?.id) {
          chosenVariant =
            pricedVariants.find(
              (v: any) => String(v.id) === String(pickedFromContext.id)
            ) || null;
        }

        console.log("[PRICE][single][STRUCTURED_VARIANT_SELECTION_FROM_CONTEXT]", {
          userInput: input.userInput,
          targetVariantId,
          pickedFromContext,
          chosenVariant: chosenVariant
            ? {
                id: chosenVariant.id,
                variant_name: chosenVariant.variant_name,
                price: chosenVariant.price,
              }
            : null,
        });
      }
    }

    console.log("[PRICE][single] final reply inputs", {
      targetServiceId,
      targetServiceName,
      variantsCount: variants.length,
      pricedVariantsCount: pricedVariants.length,
      chosenVariant: chosenVariant
        ? {
            id: chosenVariant.id,
            variant_name: chosenVariant.variant_name,
            price: chosenVariant.price,
            currency: chosenVariant.currency,
          }
        : null,
    });

    if (chosenVariant) {
      console.log("[PRICE][chosenVariant]", {
        userInput: input.userInput,
        targetServiceId,
        targetServiceName,
        chosenVariant: {
          id: chosenVariant?.id,
          variant_name: chosenVariant?.variant_name,
          price: chosenVariant?.price,
          variant_url: chosenVariant?.variant_url,
        },
        allVariants: pricedVariants.map((v: any) => ({
          id: v.id,
          variant_name: v.variant_name,
          price: v.price,
        })),
      });

      const priceNum = toNullableMoneyNumber(chosenVariant.price);
      const baseName = targetServiceName || "";
      const variantName = toTrimmedString(chosenVariant.variant_name);
      const resolvedCurrency = toTrimmedString(chosenVariant.currency || "USD");

      const {
        rows: [serviceBase],
      } = await input.pool.query<any>(
        `
        SELECT description
        FROM services
        WHERE id = $1
        LIMIT 1
        `,
        [targetServiceId]
      );

      const serviceDescription = toTrimmedString(
        chosenVariant.description || serviceBase?.description || ""
      );

      const priceText = formatMoneyAmount({
        amount: priceNum,
        currency: resolvedCurrency,
        locale: input.idiomaDestino,
      });

      const variantUrl = toTrimmedString(chosenVariant.variant_url);

      const detailBlock = buildCanonicalDetailBlock({
        idiomaDestino: input.idiomaDestino,
        serviceDescription,
      });

      const lastVariantId = toTrimmedString(input.convoCtx?.last_variant_id);
      const lastReplySource = toTrimmedString(input.convoCtx?.last_reply_source).toLowerCase();

      const isContinuationOnSameVariant =
        referenceKind === "referential_followup" &&
        Boolean(targetVariantId) &&
        targetVariantId === toTrimmedString(chosenVariant.id) &&
        lastVariantId === toTrimmedString(chosenVariant.id) &&
        (
          lastReplySource === "catalog_db" ||
          lastReplySource === "price_fastpath_db"
        );

      const presentationMode =
        isContinuationOnSameVariant && variantUrl
          ? "action_link"
          : "full_detail";

      const canonicalBody =
        presentationMode === "action_link"
          ? variantUrl
          : [
              `${baseName} — ${variantName}`,
              priceText || "",
              detailBlock || "",
              variantUrl || "",
            ]
              .filter(Boolean)
              .join("\n\n");

      return {
        handled: true,
        reply: canonicalBody,
        source: "price_fastpath_db",
        intent: "precio",
        catalogPayload: {
          kind: "resolved_catalog_answer",
          scope: "variant",
          presentationMode,
          closingMode:
            presentationMode === "action_link"
              ? "availability_statement"
              : "default",
          serviceId: targetServiceId,
          serviceName: baseName || null,
          variantId: toTrimmedString(chosenVariant.id),
          variantName: variantName || null,
          canonicalBlocks: {
            servicesBlock: `${baseName} — ${variantName}`,
            priceBlock: priceText || null,
            includesBlock: detailBlock || null,
            scheduleBlock: null,
            locationBlock: null,
            availabilityBlock: null,
            linkBlock: variantUrl || null,
          },
        },
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: baseName || null,
          last_service_at: Date.now(),

          last_variant_id: toTrimmedString(chosenVariant.id),
          last_variant_name: variantName || null,
          last_variant_url: variantUrl || null,
          last_variant_at: Date.now(),

          last_price_option_label: variantName || null,
          last_price_option_at: Date.now(),

          expectingVariant: false,
          expectedVariantIntent: null,
          lastResolvedIntent: "price_or_plan",
        } as any,
      };
    }

    if (pricedVariants.length > 1 && !chosenVariant && !asksSchedules) {
      const now = Date.now();

      console.log("[PRICE][single] multiple priced variants -> list for selection", {
        targetServiceId,
        targetServiceName,
        pricedVariants: pricedVariants.map((v: any, idx: number) => ({
          index: idx + 1,
          id: v.id,
          variant_name: v.variant_name,
          price: v.price,
          currency: v.currency,
          variant_url: v.variant_url,
        })),
      });

      const variantChoiceOptions = pricedVariants.reduce(
        (
          acc: Array<{
            kind: "variant";
            serviceId: string;
            variantId: string;
            label: string;
            serviceName: string | null;
            variantName: string;
            index: number;
            url: string | null;
            price: number | null;
            currency: string;
          }>,
          v: any,
          idx: number
        ) => {
          const variantId = toTrimmedString(v.id);
          const variantName = toTrimmedString(v.variant_name);
          const currency = toTrimmedString(v.currency || "USD") || "USD";
          const price = toNullableMoneyNumber(v.price);
          const url = v.variant_url ? toTrimmedString(v.variant_url) : null;

          if (!variantId || !variantName) {
            return acc;
          }

          const priceText = formatMoneyAmount({
            amount: price,
            currency,
            locale: input.idiomaDestino,
          });

          const label = priceText
            ? `${variantName} — ${priceText}`
            : variantName;

          acc.push({
            kind: "variant",
            serviceId: targetServiceId,
            variantId,
            label,
            serviceName: targetServiceName || null,
            variantName,
            index: idx + 1,
            url,
            price,
            currency,
          });

          return acc;
        },
        []
      );

      if (variantChoiceOptions.length < 2) {
        return {
          handled: false,
        };
      }

      const publicOptions = variantChoiceOptions.map((option) => ({
        kind: "variant" as const,
        serviceId: option.serviceId,
        variantId: option.variantId,
        label: option.label,
        serviceName: option.serviceName,
        variantName: option.variantName,
      }));

      return {
        handled: true,
        reply: "",
        source: "catalog_disambiguation_db",
        intent: "variant_choice",
        catalogPayload: {
          kind: "variant_choice",
          originalIntent: "precio",
          serviceId: targetServiceId,
          serviceName: targetServiceName || null,
          options: publicOptions,
        },
        ctxPatch: {
          selectedServiceId: targetServiceId,
          expectingVariant: true,
          expectedVariantIntent: "precio",
          expectingVariantForEntityId: targetServiceId,

          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: now,

          last_variant_id: null,
          last_variant_name: null,
          last_variant_url: null,
          last_variant_at: null,

          pendingCatalogChoice: {
            kind: "variant_choice",
            originalIntent: "precio",
            serviceId: targetServiceId,
            serviceName: targetServiceName || null,
            options: publicOptions,
            createdAt: now,
          },
          pendingCatalogChoiceAt: now,

          presentedVariantOptions: variantChoiceOptions.map((option) => ({
            variantId: option.variantId,
            label: option.label,
            index: option.index,
          })),

          last_variant_options: variantChoiceOptions.map((option) => ({
            index: option.index,
            id: option.variantId,
            variantId: option.variantId,
            variant_name: option.variantName,
            label: option.label,
            url: option.url,
            price: option.price,
            currency: option.currency,
          })),
          last_variant_options_at: now,

          last_price_option_label: null,
          last_price_option_at: null,

          last_bot_action: "catalog_variant_choice_pending",
          last_bot_action_at: now,
          lastResolvedIntent: "variant_choice",
        } as any,
      };
    }

    const matchedRow = input.rows.find(
      (r) => String(r.service_id || "") === targetServiceId
    );

    const isScheduleOnlyTurn =
      asksSchedules === true &&
      asksPrices !== true &&
      asksLocation !== true &&
      asksAvailability !== true;

    const hasServicePriceRow = !!matchedRow;

    if (singleHit?.id && isScheduleOnlyTurn) {
      return {
        handled: false,
      };
    }

    if (pricedVariants.length === 0 && !hasServicePriceRow && !isScheduleOnlyTurn) {
      return {
        handled: true,
        reply: "", // importante: NO inventar texto
        source: "price_fastpath_db_no_price",
        intent: "precio",
        catalogPayload: {
          kind: "resolved_catalog_answer",
          scope: "service",
          presentationMode: "full_detail",
          closingMode: "default",
          serviceId: targetServiceId,
          serviceName: targetServiceName || null,
          variantId: null,
          variantName: null,
          canonicalBlocks: {
            servicesBlock: targetServiceName || null,
            priceBlock: null,
            includesBlock: null,
            scheduleBlock: null,
            locationBlock: null,
            availabilityBlock: null,
            linkBlock: null,
          },
        },
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: Date.now(),
          expectingVariant: false,
          expectedVariantIntent: null,
          lastResolvedIntent: "price_or_plan",
        } as any,
      };
    }

    if (matchedRow && !isScheduleOnlyTurn && asksPrices) {
      const min = toNullableMoneyNumber(matchedRow.min_price);
      const max = toNullableMoneyNumber(matchedRow.max_price);

      const hasExplicitServicePrice =
        min !== null && max !== null;

      if (!hasExplicitServicePrice) {
        return {
          handled: true,
          reply: "", // NO inventar texto
          source: "price_fastpath_db_no_price",
          intent: "precio",
          catalogPayload: {
            kind: "resolved_catalog_answer",
            scope: "service",
            presentationMode: "full_detail",
            closingMode: "default",
            serviceId: targetServiceId,
            serviceName: targetServiceName || null,
            variantId: null,
            variantName: null,
            canonicalBlocks: {
              servicesBlock: targetServiceName || null,
              priceBlock: null, // clave
              includesBlock: null,
              scheduleBlock: null,
              locationBlock: null,
              availabilityBlock: null,
              linkBlock: null,
            },
          },
          ctxPatch: {
            last_service_id: targetServiceId,
            last_service_name: targetServiceName || null,
            last_service_at: Date.now(),
            expectingVariant: false,
            expectedVariantIntent: null,
            lastResolvedIntent: "price_or_plan",
          } as any,
        };
      }

      const priceText = formatMoneyRange({
        min,
        max,
        currency: matchedRow.currency || "USD",
        locale: input.idiomaDestino,
      });

      console.log("[PRICE][single][SERVICE_PRICE_RENDER]", {
        targetServiceId,
        targetServiceName,
        min,
        max,
      });

      const canonicalReply = `• ${targetServiceName}: ${priceText}`;

      return {
        handled: true,
        reply: canonicalReply,
        source: "price_fastpath_db",
        intent: "precio",
        catalogPayload: {
          kind: "resolved_catalog_answer",
          scope: "service",
          presentationMode: "full_detail",
          closingMode: "default",
          serviceId: targetServiceId,
          serviceName: targetServiceName || null,
          variantId: null,
          variantName: null,
          canonicalBlocks: {
            servicesBlock: targetServiceName || null,
            priceBlock: canonicalReply,
            includesBlock: null,
            scheduleBlock: null,
            locationBlock: null,
            availabilityBlock: null,
            linkBlock: null,
          },
        },
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: Date.now(),
          expectingVariant: false,
          expectedVariantIntent: null,
          lastResolvedIntent: "price_or_plan",
        } as any,
      };
    }
  }

  if (
    input.routeIntent === "catalog_price" &&
    input.catalogReferenceClassification?.kind === "catalog_overview"
  ) {
    const priceRows = input.rows.filter((row: any) => {
      const min = row?.min_price === null ? null : Number(row?.min_price);
      const max = row?.max_price === null ? null : Number(row?.max_price);
      return Number.isFinite(min) || Number.isFinite(max);
    });

    if (priceRows.length > 0) {
      const sortedPriceRows = [...priceRows].sort((a: any, b: any) => {
        const aMinRaw = a?.min_price === null ? null : Number(a?.min_price);
        const aMaxRaw = a?.max_price === null ? null : Number(a?.max_price);
        const bMinRaw = b?.min_price === null ? null : Number(b?.min_price);
        const bMaxRaw = b?.max_price === null ? null : Number(b?.max_price);

        const aMin = Number.isFinite(aMinRaw) ? Number(aMinRaw) : null;
        const aMax = Number.isFinite(aMaxRaw) ? Number(aMaxRaw) : null;
        const bMin = Number.isFinite(bMinRaw) ? Number(bMinRaw) : null;
        const bMax = Number.isFinite(bMaxRaw) ? Number(bMaxRaw) : null;

        const aEffective: number =
          aMin !== null
            ? aMin
            : aMax !== null
            ? aMax
            : Number.POSITIVE_INFINITY;

        const bEffective: number =
          bMin !== null
            ? bMin
            : bMax !== null
            ? bMax
            : Number.POSITIVE_INFINITY;

        if (aEffective !== bEffective) {
          return aEffective - bEffective;
        }

        const aName = String(a?.service_name || "").trim().toLowerCase();
        const bName = String(b?.service_name || "").trim().toLowerCase();

        return aName.localeCompare(bName);
      });

      const canonicalReply = sortedPriceRows
        .map((row: any) => {
          const serviceName = String(row?.service_name || "").trim();
          const min = row?.min_price === null ? null : Number(row?.min_price);
          const max = row?.max_price === null ? null : Number(row?.max_price);

          const priceText = formatMoneyRange({
            min: Number.isFinite(min) ? Number(min) : null,
            max: Number.isFinite(max) ? Number(max) : null,
            currency: row?.currency || "USD",
            locale: input.idiomaDestino,
          });

          return `• ${serviceName}${priceText ? ` — ${priceText}` : ""}`;
        })
        .join("\n");

      return {
        handled: true,
        reply: canonicalReply,
        source: "price_summary_db",
        intent: "precio",
        ctxPatch: {
          lastResolvedIntent: "price_or_plan",
          expectedVariantIntent: null,
        } as any,
      };
    }
  }

  return {
    handled: false,
  };
}