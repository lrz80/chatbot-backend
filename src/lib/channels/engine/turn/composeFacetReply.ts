// src/lib/channels/engine/turn/composeFacetReply.ts
import type { Pool } from "pg";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { resolveBusinessInfoFacetsCanonicalBody } from "../businessInfo/resolveBusinessInfoFacetsCanonicalBody";
import { buildCatalogOverviewPriceBlock } from "../../../fastpath/handlers/catalog/helpers/buildCatalogOverviewPriceBlock";
import { buildStaticFastpathReplyPolicy } from "../fastpath/buildFastpathReplyPolicy";

type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type ComposeFacetReplyArgs = {
  pool: Pool;
  tenantId: string;
  canal: any;
  idiomaDestino: string;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  infoClave: string;

  detectedIntent: string | null;
  intentFallback: string | null;
  detectedFacets?: IntentFacets | null;
  detectedCommercial?: any;

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
};

function resolveFacetIntent(args: {
  detectedIntent: string | null;
  intentFallback: string | null;
  detectedFacets?: IntentFacets | null;
}): string {
  const detected = String(args.detectedIntent || "").trim();
  if (detected) return detected;

  const fallback = String(args.intentFallback || "").trim();
  if (fallback) return fallback;

  const facets = args.detectedFacets;

  if (facets?.asksPrices) return "precio";
  if (facets?.asksSchedules) return "horario";
  if (facets?.asksLocation) return "ubicacion";
  if (facets?.asksAvailability) return "disponibilidad";

  return "info_general";
}

function resolveFacetSource(args: {
  hasPriceBlock: boolean;
  hasBusinessInfoBlock: boolean;
}): string {
  if (args.hasPriceBlock && args.hasBusinessInfoBlock) {
    return "facet_composer_mixed";
  }

  if (args.hasPriceBlock) {
    return "catalog_db";
  }

  if (args.hasBusinessInfoBlock) {
    return "info_clave_db";
  }

  return "facet_composer";
}

export async function composeFacetReply(
  args: ComposeFacetReplyArgs
): Promise<{ handled: boolean; reply?: string; source?: string; intent?: string | null }> {
  const {
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    infoClave,
    detectedIntent,
    intentFallback,
    detectedFacets,
    detectedCommercial,
    normalizeCatalogRole,
    traducirTexto,
    renderGenericPriceSummaryReply,
  } = args;

  const blocks: string[] = [];
  let hasPriceBlock = false;
  let hasBusinessInfoBlock = false;

  if (detectedFacets?.asksPrices === true) {
    const { priceBlock } = await buildCatalogOverviewPriceBlock({
      pool,
      tenantId,
      idiomaDestino,
      normalizeCatalogRole,
      traducirTexto,
      renderGenericPriceSummaryReply,
    });

    if (String(priceBlock || "").trim()) {
      blocks.push(priceBlock.trim());
      hasPriceBlock = true;
    }
  }

  const businessInfoBlock = await resolveBusinessInfoFacetsCanonicalBody({
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    promptBaseMem,
    infoClave,
    facets: {
      asksSchedules: detectedFacets?.asksSchedules === true,
      asksLocation: detectedFacets?.asksLocation === true,
      asksAvailability: detectedFacets?.asksAvailability === true,
    },
  });

  if (String(businessInfoBlock || "").trim()) {
    blocks.push(String(businessInfoBlock).trim());
    hasBusinessInfoBlock = true;
  }

  const canonicalBody = blocks.filter(Boolean).join("\n\n").trim();

  if (!canonicalBody) {
    return { handled: false };
  }

  const finalIntent = resolveFacetIntent({
    detectedIntent,
    intentFallback,
    detectedFacets,
  });

  const finalSource = resolveFacetSource({
    hasPriceBlock,
    hasBusinessInfoBlock,
  });

  const rendered = await renderFastpathDmReply({
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    fastpathText: canonicalBody,
    fp: {
      reply: canonicalBody,
      source: finalSource,
      intent: finalIntent,
      catalogPayload: undefined,
    },
    detectedIntent: finalIntent,
    intentFallback: finalIntent,
    structuredService: {
      serviceId: null,
      serviceName: null,
      serviceLabel: null,
      hasResolution: false,
    },
    replyPolicy: buildStaticFastpathReplyPolicy({
      canal,
      answerType: "overview",
      replySourceKind: "business_info",
      responsePolicyMode: "grounded_frame_only",
      hasResolvedEntity: false,
      isCatalogDbReply: false,
      isPriceSummaryReply: hasPriceBlock,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: hasPriceBlock,
      isGroundedCatalogOverviewDm: true,
      shouldForceSalesClosingQuestion: false,
      shouldUseGroundedFrameOnly: true,
      canonicalBodyOwnsClosing: false,
      clarificationTarget: null,
      commercialPolicy: {
        purchaseIntent: detectedCommercial?.purchaseIntent ?? "low",
        wantsBooking: detectedCommercial?.wantsBooking === true,
        wantsQuote: detectedCommercial?.wantsQuote === true,
        wantsHuman: detectedCommercial?.wantsHuman === true,
        urgency: detectedCommercial?.urgency ?? "low",
        shouldUseSalesTone: true,
        shouldUseSoftClosing: true,
        shouldUseDirectClosing: false,
        shouldSuggestHumanHandoff: false,
      },
    }),
    ctxPatch: {},
    maxLines: 9999,
  });

  return {
    handled: true,
    reply: String(rendered.reply || "").trim(),
    source: finalSource,
    intent: finalIntent,
  };
}