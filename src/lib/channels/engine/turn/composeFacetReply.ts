//src/lib/channels/engine/turn/composeFacetReply.ts
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { resolveBusinessInfoFacetsCanonicalBody } from "../businessInfo/resolveBusinessInfoFacetsCanonicalBody";

type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type ComposeFacetReplyArgs = {
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
};

export async function composeFacetReply(
  args: ComposeFacetReplyArgs
): Promise<{ handled: boolean; reply?: string; source?: string; intent?: string | null }> {
  const {
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
  } = args;

  const blocks: string[] = [];

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

  // TODO: aquí conectas el bloque de catálogo/DB para asksPrices
  // Por ahora lo dejamos preparado sin hardcode por frase.
  // Ejemplo:
  // if (detectedFacets?.asksPrices) {
  //   const catalogPriceBlock = await resolveCatalogPriceCanonicalBody(...);
  //   if (catalogPriceBlock) blocks.push(catalogPriceBlock);
  // }

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
      source: "facet_composer",
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

      isCatalogDbReply: false,
      isPriceSummaryReply: false,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: false,
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
    source: "facet_composer",
    intent: finalIntent,
  };
}