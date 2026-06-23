//src/lib/channels/engine/businessInfo/composeBusinessInfoAnswer.ts

import type { Pool } from "pg";
import type { Canal, CommercialSignal, IntentRoutingHints } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { resolveBusinessInfoFacetsCanonicalBody } from "./resolveBusinessInfoFacetsCanonicalBody";
import { buildCatalogOverviewPriceBlock } from "../../../fastpath/handlers/catalog/helpers/buildCatalogOverviewPriceBlock";
import { buildStaticFastpathReplyPolicy } from "../fastpath/buildFastpathReplyPolicy";

export type BusinessInfoIntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

export type BusinessInfoExternalAction = {
  type: "link";
  targetUrl: string;
};

export type ComposeBusinessInfoAnswerArgs = {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  infoClave: string;
  convoCtx?: any;

  detectedIntent: string | null;
  intentFallback: string | null;
  detectedFacets?: BusinessInfoIntentFacets | null;
  detectedCommercial?: CommercialSignal | null;
  routingHints?: IntentRoutingHints | null;

  externalAction?: BusinessInfoExternalAction | null;

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

  maxLines?: number;
};

export type ComposeBusinessInfoAnswerResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string | null;
  canonicalBody?: string;
  ctxPatch?: any;
};

function resolveBusinessInfoIntent(args: {
  detectedIntent: string | null;
  intentFallback: string | null;
  detectedFacets?: BusinessInfoIntentFacets | null;
}): string {
  const facets = args.detectedFacets;

  if (facets?.asksPrices && facets?.asksSchedules) {
    return "precio_y_horario";
  }

  if (facets?.asksPrices) return "precio";
  if (facets?.asksSchedules) return "horario";
  if (facets?.asksLocation) return "ubicacion";
  if (facets?.asksAvailability) return "disponibilidad";

  const detected = String(args.detectedIntent || "").trim();
  if (detected) return detected;

  const fallback = String(args.intentFallback || "").trim();
  if (fallback) return fallback;

  return "info_general";
}

function resolveBusinessInfoSource(args: {
  hasPriceBlock: boolean;
  hasBusinessInfoBlock: boolean;
  hasExternalAction: boolean;
}): string {
  if (args.hasPriceBlock && args.hasBusinessInfoBlock) {
    return "business_info_mixed";
  }

  if (args.hasPriceBlock) {
    return "business_info_prices";
  }

  if (args.hasBusinessInfoBlock) {
    return "business_info_facets";
  }

  if (args.hasExternalAction) {
    return "business_info_external_action";
  }

  return "business_info";
}

function hasAnyRequestedFacet(facets?: BusinessInfoIntentFacets | null): boolean {
  return Boolean(
    facets?.asksPrices ||
      facets?.asksSchedules ||
      facets?.asksLocation ||
      facets?.asksAvailability
  );
}

export async function composeBusinessInfoAnswer(
  args: ComposeBusinessInfoAnswerArgs
): Promise<ComposeBusinessInfoAnswerResult> {
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
    convoCtx,
    detectedIntent,
    intentFallback,
    detectedFacets,
    detectedCommercial,
    routingHints,
    externalAction,
    normalizeCatalogRole,
    traducirTexto,
    renderGenericPriceSummaryReply,
    maxLines = 9999,
  } = args;

  const requestedFacets = {
    asksPrices: detectedFacets?.asksPrices === true,
    asksSchedules: detectedFacets?.asksSchedules === true,
    asksLocation: detectedFacets?.asksLocation === true,
    asksAvailability: detectedFacets?.asksAvailability === true,
  };

  const blocks: string[] = [];

  let hasPriceBlock = false;
  let hasBusinessInfoBlock = false;

  if (requestedFacets.asksPrices) {
    const { priceBlock } = await buildCatalogOverviewPriceBlock({
      pool,
      tenantId,
      idiomaDestino,
      normalizeCatalogRole,
      traducirTexto,
      renderGenericPriceSummaryReply,
    });

    if (String(priceBlock || "").trim()) {
      blocks.push(String(priceBlock).trim());
      hasPriceBlock = true;
    }
  }

  if (
    requestedFacets.asksSchedules ||
    requestedFacets.asksLocation ||
    requestedFacets.asksAvailability
  ) {
    const businessInfoBlock = await resolveBusinessInfoFacetsCanonicalBody({
      pool,
      tenantId,
      canal,
      idiomaDestino,
      userInput,
      promptBaseMem,
      infoClave,
      convoCtx: convoCtx || {},
      facets: {
        asksSchedules: requestedFacets.asksSchedules,
        asksLocation: requestedFacets.asksLocation,
        asksAvailability: requestedFacets.asksAvailability,
      },
      routingHints: routingHints || null,
    });

    if (String(businessInfoBlock || "").trim()) {
      blocks.push(String(businessInfoBlock).trim());
      hasBusinessInfoBlock = true;
    }
  }

  const hasExternalAction =
    externalAction?.type === "link" &&
    String(externalAction?.targetUrl || "").trim().length > 0;

  const canonicalBody = blocks.filter(Boolean).join("\n\n").trim();

  if (!canonicalBody && !hasExternalAction) {
    return {
      handled: false,
      intent: resolveBusinessInfoIntent({
        detectedIntent,
        intentFallback,
        detectedFacets: requestedFacets,
      }),
      source: "business_info_empty",
    };
  }

  const finalIntent = resolveBusinessInfoIntent({
    detectedIntent,
    intentFallback,
    detectedFacets: requestedFacets,
  });

  const finalSource = resolveBusinessInfoSource({
    hasPriceBlock,
    hasBusinessInfoBlock,
    hasExternalAction,
  });

  const rendered = await renderFastpathDmReply({
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    fastpathText: canonicalBody || String(externalAction?.targetUrl || "").trim(),
    fp: {
      reply: canonicalBody || String(externalAction?.targetUrl || "").trim(),
      source: finalSource,
      intent: finalIntent,
      catalogPayload: undefined,
      externalAction: hasExternalAction
        ? {
            type: "link",
            targetUrl: String(externalAction?.targetUrl || "").trim(),
          }
        : undefined,
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
      answerType: hasAnyRequestedFacet(requestedFacets)
        ? "direct_answer"
        : "overview",
      replySourceKind: "business_info",
      responsePolicyMode: "grounded_frame_only",
      hasResolvedEntity: false,
      isCatalogDbReply: false,
      isPriceSummaryReply: hasPriceBlock,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: hasPriceBlock,
      isGroundedCatalogOverviewDm: !hasAnyRequestedFacet(requestedFacets),
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
        shouldSuggestHumanHandoff: detectedCommercial?.wantsHuman === true,
      },
    }),
    ctxPatch: {},
    maxLines,
  });

  const reply = String(rendered.reply || "").trim();

  if (!reply) {
    return {
      handled: false,
      source: finalSource,
      intent: finalIntent,
      canonicalBody,
    };
  }

  return {
    handled: true,
    reply,
    source: finalSource,
    intent: finalIntent,
    canonicalBody,
    ctxPatch: rendered.ctxPatch || {},
  };
}