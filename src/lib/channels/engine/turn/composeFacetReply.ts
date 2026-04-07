//src/lib/channels/engine/turn/composeFacetReply.ts
import type { Pool } from "pg";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { resolveBusinessInfoFacetsCanonicalBody } from "../businessInfo/resolveBusinessInfoFacetsCanonicalBody";
import { buildCatalogOverviewPriceBlock } from "../../../fastpath/handlers/catalog/helpers/buildCatalogOverviewPriceBlock";

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

  if (businessInfoBlock) {
    blocks.push(businessInfoBlock);
  }

  const canonicalBody = blocks.filter(Boolean).join("\n\n").trim();

  if (!canonicalBody) {
    return { handled: false };
  }

  const finalIntent = detectedIntent || intentFallback || "info_general";

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
      source: hasPriceBlock ? "facet_composer_mixed" : "facet_composer",
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
    replyPolicy: {
      shouldUseGroundedFrameOnly: true,
      responsePolicyMode: "grounded_frame_only",
      hasResolvedEntity: false,

      isCatalogDbReply: hasPriceBlock,
      isPriceSummaryReply: hasPriceBlock,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: hasPriceBlock,
      isGroundedCatalogOverviewDm: true,
      shouldForceSalesClosingQuestion: false,
      canonicalBodyOwnsClosing: true,

      commercialPolicy: {
        purchaseIntent: detectedCommercial?.purchaseIntent ?? "low",
        wantsBooking: detectedCommercial?.wantsBooking === true,
        wantsQuote: detectedCommercial?.wantsQuote === true,
        wantsHuman: detectedCommercial?.wantsHuman === true,
        urgency: detectedCommercial?.urgency ?? "low",
        shouldUseSalesTone: true,
        shouldUseSoftClosing: true,
        shouldUseDirectClosing: false,
        shouldSuggestHumanHandoff: detectedCommercial?.wantsHuman === true,
      },
    },
    ctxPatch: {},
    maxLines: 9999,
  });

  return {
    handled: true,
    reply: String(rendered.reply || "").trim(),
    source: hasPriceBlock ? "facet_composer_mixed" : "facet_composer",
    intent: finalIntent,
  };
}