import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";

export type HandleSingleServiceCatalogInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;
  routeIntent: string;
  catalogRoutingSignal: any;
  catalogReferenceClassification?: any;

  rows: any[];

  catalogRouteIntent?: string | null;
};

function toTrimmedString(value: any): string {
  return String(value ?? "").trim();
}

function toNullableNumber(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDetailLine(value: string): string {
  return String(value || "").trim().replace(/^[-•*]\s*/, "");
}

function buildCanonicalDetailBlock(params: {
  idiomaDestino: string;
  serviceDescription: string;
}): string {
  const rawLines = String(params.serviceDescription || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!rawLines.length) {
    return "";
  }

  const normalizedLines = rawLines.map(normalizeDetailLine);

  const headingIndex = normalizedLines.findIndex((line) => {
    const lowered = line.toLowerCase();
    return lowered === "incluye:" || lowered === "includes:";
  });

  if (headingIndex >= 0) {
    const heading = params.idiomaDestino === "en" ? "Includes:" : "Incluye:";
    const detailItems = normalizedLines
      .slice(headingIndex + 1)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!detailItems.length) {
      return heading;
    }

    return [
      heading,
      ...detailItems.map((line) => `• ${line}`),
    ].join("\n");
  }

  return normalizedLines.map((line) => `• ${line}`).join("\n");
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
      return Number.isFinite(n) && n > 0;
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

      const priceNum = toNullableNumber(chosenVariant.price);
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

      let priceText =
        input.idiomaDestino === "es" ? "precio disponible" : "price available";

      if (priceNum !== null) {
        priceText =
          resolvedCurrency === "USD"
            ? `$${priceNum.toFixed(2)}`
            : `${priceNum.toFixed(2)} ${resolvedCurrency}`;
      }

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
              input.idiomaDestino === "es"
                ? `Precio: ${priceText}`
                : `Price: ${priceText}`,
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
          serviceId: targetServiceId,
          serviceName: baseName || null,
          variantId: toTrimmedString(chosenVariant.id),
          variantName: variantName || null,
          canonicalBlocks: {
            servicesBlock: `${baseName} — ${variantName}`,
            priceBlock:
              input.idiomaDestino === "es"
                ? `Precio: ${priceText}`
                : `Price: ${priceText}`,
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

    if (pricedVariants.length > 1 && !chosenVariant) {
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

      const lines = pricedVariants.map((v: any, idx: number) => {
        const rawPrice = toNullableNumber(v.price);
        const currency = toTrimmedString(v.currency || "USD");
        const variantName = toTrimmedString(v.variant_name);

        let priceText =
          input.idiomaDestino === "en" ? "price available" : "precio disponible";

        if (rawPrice !== null) {
          priceText =
            currency === "USD"
              ? `$${rawPrice.toFixed(2)}`
              : `${rawPrice.toFixed(2)} ${currency}`;
        }

        return `• ${idx + 1}) ${variantName}: ${priceText}`;
      });

      return {
        handled: true,
        reply: lines.join("\n"),
        source: "price_disambiguation_db",
        intent: "precio",
        ctxPatch: {
          selectedServiceId: targetServiceId,
          expectingVariant: true,
          expectedVariantIntent: "price_or_plan",

          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: Date.now(),

          last_variant_id: null,
          last_variant_name: null,
          last_variant_url: null,
          last_variant_at: null,

          last_variant_options: pricedVariants.map((v: any, idx: number) => ({
            index: idx + 1,
            id: toTrimmedString(v.id),
            name: toTrimmedString(v.variant_name),
            url: v.variant_url ? toTrimmedString(v.variant_url) : null,
            price: toNullableNumber(v.price),
            currency: toTrimmedString(v.currency || "USD"),
          })),
          last_variant_options_at: Date.now(),

          last_price_option_label: null,
          last_price_option_at: null,

          last_bot_action: "asked_price_variant",
          last_bot_action_at: Date.now(),
        } as any,
      };
    }

    const matchedRow = input.rows.find(
      (r) => String(r.service_id || "") === targetServiceId
    );

    const hasServicePriceRow = !!matchedRow;

    if (pricedVariants.length === 0 && !hasServicePriceRow) {
      const canonicalReply =
        input.idiomaDestino === "en"
          ? `• ${targetServiceName}\n• Price: not available in the catalog`
          : `• ${targetServiceName}\n• Precio: no disponible en el catálogo`;

      return {
        handled: true,
        reply: canonicalReply,
        source: "price_fastpath_db_no_price",
        intent: "precio",
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

    if (matchedRow) {
      const min = toNullableNumber(matchedRow.min_price);
      const max = toNullableNumber(matchedRow.max_price);

      const hasExplicitServicePrice =
        min !== null && max !== null;

      if (!hasExplicitServicePrice) {
        const canonicalReply =
          input.idiomaDestino === "en"
            ? `• ${targetServiceName}\n• Price: not explicitly configured`
            : `• ${targetServiceName}\n• Precio: no configurado explícitamente`;

        return {
          handled: true,
          reply: canonicalReply,
          source: "price_fastpath_db_no_price",
          intent: "precio",
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

      const priceText =
        min === max
          ? `$${min.toFixed(2)}`
          : `${input.idiomaDestino === "en" ? "from" : "desde"} $${min.toFixed(2)}`;

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

          let priceText =
            input.idiomaDestino === "en"
              ? "price not available"
              : "precio no disponible";

          if (Number.isFinite(min) && Number.isFinite(max)) {
            if (min === max) {
              priceText = `$${min!.toFixed(2)}`;
            } else {
              priceText =
                input.idiomaDestino === "en"
                  ? `from $${min!.toFixed(2)}`
                  : `desde $${min!.toFixed(2)}`;
            }
          } else if (Number.isFinite(min)) {
            priceText =
              input.idiomaDestino === "en"
                ? `from $${min!.toFixed(2)}`
                : `desde $${min!.toFixed(2)}`;
          } else if (Number.isFinite(max)) {
            priceText = `$${max!.toFixed(2)}`;
          }

          return `• ${serviceName}: ${priceText}`;
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