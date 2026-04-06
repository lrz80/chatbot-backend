// src/lib/channels/engine/fallback/resolveUnhandledTurnFallback.ts
import type { Canal, CommercialSignal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { resolveBusinessInfoOverviewCanonicalBody } from "../businessInfo/resolveBusinessInfoOverviewCanonicalBody";

type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type ResolveUnhandledTurnFallbackArgs = {
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  infoClave: string;

  detectedIntent?: string | null;
  intentFallback?: string | null;
  detectedFacets?: IntentFacets | null;
  detectedCommercial?: CommercialSignal | null;
  ctxPatch?: Record<string, unknown> | null;
};

type ResolveUnhandledTurnFallbackResult = {
  handled: boolean;
  reply: string;
  source: "unhandled_turn_business_info_fallback" | "unhandled_turn_generic_fallback";
  intent: string | null;
  ctxPatch?: Record<string, unknown>;
};

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildLastResortFallbackText(idiomaDestino: LangCode): string {
  if (idiomaDestino === "en") {
    return "I can help you with information about services, schedules, pricing, location, or bookings. Tell me what you’d like to know and I’ll guide you.";
  }

  return "Puedo ayudarte con información sobre servicios, horarios, precios, ubicación o reservas. Dime qué te gustaría saber y te guío.";
}

export async function resolveUnhandledTurnFallback(
  args: ResolveUnhandledTurnFallbackArgs
): Promise<ResolveUnhandledTurnFallbackResult> {
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
    detectedCommercial,
    ctxPatch,
  } = args;

  const finalIntent =
    toTrimmedString(detectedIntent) ||
    toTrimmedString(intentFallback) ||
    "info_general";

  const canonicalBusinessInfoBody =
    await resolveBusinessInfoOverviewCanonicalBody({
      tenantId,
      canal,
      idiomaDestino,
      userInput,
      promptBaseMem,
      infoClave,
      overviewMode: "guided_entry",
    });

  if (canonicalBusinessInfoBody) {
    const rendered = await renderFastpathDmReply({
      tenantId,
      canal,
      idiomaDestino,
      userInput,
      contactoNorm,
      messageId,
      promptBaseMem,
      fastpathText: canonicalBusinessInfoBody,
      fp: {
        reply: canonicalBusinessInfoBody,
        source: "unhandled_turn_business_info_fallback",
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
      ctxPatch: ctxPatch || {},
      maxLines: 9999,
    });

    const reply = toTrimmedString(rendered.reply);

    if (reply) {
      return {
        handled: true,
        reply,
        source: "unhandled_turn_business_info_fallback",
        intent: finalIntent,
        ctxPatch: rendered.ctxPatch || {},
      };
    }
  }

  return {
    handled: true,
    reply: buildLastResortFallbackText(idiomaDestino),
    source: "unhandled_turn_generic_fallback",
    intent: finalIntent,
    ctxPatch: ctxPatch || {},
  };
}