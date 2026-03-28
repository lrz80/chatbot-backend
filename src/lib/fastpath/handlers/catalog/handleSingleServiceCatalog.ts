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

export async function handleSingleServiceCatalog(
  input: HandleSingleServiceCatalogInput
): Promise<FastpathResult> {
  const {
    referenceKind,
    targetServiceId: structuredTargetServiceId,
    targetVariantId,
    targetFamilyKey,
    hasStructuredTarget,
    shouldResolveFromStructuredTarget,
  } = getCatalogStructuredSignals({
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
    catalogRouteIntent: input.catalogRouteIntent,
  });

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
      String(input.convoCtx?.last_service_id || "").trim() ||
      String(input.convoCtx?.selectedServiceId || "").trim();

    const ctxServiceName =
      String(input.convoCtx?.last_service_name || "").trim();

    const singleHit =
      shouldSkipSinglePriceTargetResolution
        ? null
        : shouldResolveFromStructuredTarget
        ? {
            id: String(structuredTargetServiceId || "").trim(),
            name: String(
              input.catalogReferenceClassification?.targetServiceName ||
              ctxServiceName ||
              ""
            ).trim(),
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
    const targetServiceId = String(singleHit.id || "").trim();
    const targetServiceName = String(singleHit.name || "").trim();

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
      const storedVariantOptions = Array.isArray((input.convoCtx as any)?.last_variant_options)
        ? (input.convoCtx as any).last_variant_options
        : [];

      const isAwaitingPriceVariantSelection =
        input.convoCtx.expectedVariantIntent === "price_or_plan" &&
        Boolean((input.convoCtx as any)?.expectingVariant) &&
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

    // ✅ Variante concreta resuelta desde DB -> construir canonicalReply y renderizar con frame comercial grounded
    // usando precio + includes reales desde DB, sin link automático
    // y con guardrail para no alterar la fuente de verdad.
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

      const priceNum =
        chosenVariant.price === null ||
        chosenVariant.price === undefined ||
        chosenVariant.price === ""
          ? null
          : Number(chosenVariant.price);

      const baseName = targetServiceName || "";
      const variantName = String(chosenVariant.variant_name || "").trim();
      const resolvedCurrency = String(chosenVariant.currency || "USD");

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

      const serviceDescription = String(
        chosenVariant.description || serviceBase?.description || ""
      ).trim();

      let priceText =
        input.idiomaDestino === "en" ? "price available" : "precio disponible";

      if (Number.isFinite(priceNum)) {
        priceText =
          resolvedCurrency === "USD"
            ? `$${priceNum!.toFixed(2)}`
            : `${priceNum!.toFixed(2)} ${resolvedCurrency}`;
      }

      const detailLines = serviceDescription
        ? serviceDescription
            .split(/\r?\n/)
            .map((l: string) => l.trim())
            .filter((l: string) => l.length > 0)
        : [];

      const bulletsText = detailLines.length
        ? detailLines.map((l: string) => `• ${l}`).join("\n")
        : "";

      const canonicalBody =
        input.idiomaDestino === "en"
          ? `${baseName} — ${variantName}\nPrice: ${priceText}${
              bulletsText ? `\n\nIncludes:\n${bulletsText}` : ""
            }`
          : `${baseName} — ${variantName}\nPrecio: ${priceText}${
              bulletsText ? `\n\nIncluye:\n${bulletsText}` : ""
            }`;

      const finalReply = canonicalBody;

      return {
        handled: true,
        reply: finalReply,
        source: "price_fastpath_db",
        intent: "precio",
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: baseName || null,
          last_service_at: Date.now(),

          last_variant_id: String(chosenVariant.id || ""),
          last_variant_name: variantName || null,
          last_variant_url: null,
          last_variant_at: Date.now(),

          last_price_option_label: variantName || null,
          last_price_option_at: Date.now(),

          expectedVariantIntent: null,
          lastResolvedIntent: "price_or_plan",
        } as any,
      };
    }

    // ✅ Si hay varias variantes con precio y el usuario NO eligió una,
    // listar variantes para que seleccione en vez de resumir por rango.
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
        const rawPrice =
          v.price === null || v.price === undefined || v.price === ""
            ? NaN
            : Number(v.price);

        const currency = String(v.currency || "USD").trim();
        const variantName = String(v.variant_name || "").trim();

        let priceText =
          input.idiomaDestino === "en" ? "price available" : "precio disponible";

        if (Number.isFinite(rawPrice)) {
          if (currency === "USD") {
            priceText = `$${rawPrice.toFixed(2)}`;
          } else {
            priceText = `${rawPrice.toFixed(2)} ${currency}`;
          }
        }

        return `• ${idx + 1}) ${variantName}: ${priceText}`;
      });

      const canonicalReply = lines.join("\n");

      const finalReply = canonicalReply;

      return {
        handled: true,
        reply: finalReply,
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
            id: String(v.id || ""),
            name: String(v.variant_name || "").trim(),
            url: v.variant_url ? String(v.variant_url).trim() : null,
            price:
              v.price === null || v.price === undefined || v.price === ""
                ? null
                : Number(v.price),
            currency: String(v.currency || "USD").trim(),
          })),
          last_variant_options_at: Date.now(),

          last_price_option_label: null,
          last_price_option_at: null,

          last_bot_action: "asked_price_variant",
          last_bot_action_at: Date.now(),
        } as any,
      };
    }

    // ✅ Si resolvió servicio, pero no variante exacta, responder natural usando DB
    const matchedRow = input.rows.find(
      (r) => String(r.service_id || "") === targetServiceId
    );

    const hasServicePriceRow = !!matchedRow;

    if (pricedVariants.length === 0 && !hasServicePriceRow) {
      const canonicalReply =
        input.idiomaDestino === "en"
          ? `• ${targetServiceName}\n• Price: not available in the catalog`
          : `• ${targetServiceName}\n• Precio: no disponible en el catálogo`;

      const finalReply = canonicalReply;

      return {
        handled: true,
        reply: finalReply,
        source: "price_fastpath_db_no_price",
        intent: "precio",
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: Date.now(),
          lastResolvedIntent: "price_or_plan",
          expectedVariantIntent: null,
        } as any,
      };
    }

    if (matchedRow) {
      const min = matchedRow.min_price === null ? null : Number(matchedRow.min_price);
      const max = matchedRow.max_price === null ? null : Number(matchedRow.max_price);

      const hasExplicitServicePrice =
        Number.isFinite(min) && Number.isFinite(max);

      if (!hasExplicitServicePrice) {
        const canonicalReply =
          input.idiomaDestino === "en"
            ? `• ${targetServiceName}\n• Price: not explicitly configured`
            : `• ${targetServiceName}\n• Precio: no configurado explícitamente`;

        const finalReply = canonicalReply;

        return {
          handled: true,
          reply: finalReply,
          source: "price_fastpath_db_no_price",
          intent: "precio",
          ctxPatch: {
            last_service_id: targetServiceId,
            last_service_name: targetServiceName || null,
            last_service_at: Date.now(),
            lastResolvedIntent: "price_or_plan",
            expectedVariantIntent: null,
          } as any,
        };
      }

      const priceText =
        min === max
          ? `$${min!.toFixed(2)}`
          : `${input.idiomaDestino === "en" ? "from" : "desde"} $${min!.toFixed(2)}`;

      console.log("[PRICE][single][LLM_RENDER] service_price", {
        targetServiceId,
        targetServiceName,
        min,
        max,
      });

      const canonicalReply = `• ${targetServiceName}: ${priceText}`;

      const finalReply = canonicalReply;

      return {
        handled: true,
        reply: finalReply,
        source: "price_fastpath_db",
        intent: "precio",
        ctxPatch: {
          last_service_id: targetServiceId,
          last_service_name: targetServiceName || null,
          last_service_at: Date.now(),
          lastResolvedIntent: "price_or_plan",
          expectedVariantIntent: null,
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

      const finalReply = canonicalReply;

      return {
        handled: true,
        reply: finalReply,
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