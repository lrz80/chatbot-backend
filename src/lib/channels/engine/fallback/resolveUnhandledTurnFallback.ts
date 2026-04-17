// src/lib/channels/engine/fallback/resolveUnhandledTurnFallback.ts
import type { Canal, CommercialSignal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { resolveBusinessInfoOverviewCanonicalBody } from "../businessInfo/resolveBusinessInfoOverviewCanonicalBody";
import { buildStaticFastpathReplyPolicy } from "../fastpath/buildFastpathReplyPolicy";

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
  convoCtx?: any;

  detectedIntent?: string | null;
  intentFallback?: string | null;
  detectedFacets?: IntentFacets | null;
  detectedCommercial?: CommercialSignal | null;
  ctxPatch?: Record<string, unknown> | null;

  conversationState?: {
    activeFlow?: string | null;
    activeStep?: string | null;
  } | null;

  fallbackKind?: "default" | "post_completion_courtesy";
};

type ResolveUnhandledTurnFallbackResult = {
  handled: boolean;
  reply: string;
  source:
    | "explicit_exit_fallback"
    | "unhandled_turn_business_info_fallback"
    | "unhandled_turn_generic_fallback"
    | "unhandled_turn_post_completion_courtesy";
  intent: string | null;
  ctxPatch?: Record<string, unknown>;
};

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isExplicitExitIntent(intent: string | null): boolean {
  const normalized = toTrimmedString(intent).toLowerCase();

  return normalized === "no_interesado" || normalized === "despedida";
}

function buildLastResortFallbackText(): string {
  return "I can help you with information about services, schedules, pricing, location, or bookings. Tell me what you’d like to know and I’ll guide you.";
}

function buildCourtesyInstruction(
  conversationState?: {
    activeFlow?: string | null;
    activeStep?: string | null;
  } | null
): string {
  const activeFlow = toTrimmedString(conversationState?.activeFlow);
  const activeStep = toTrimmedString(conversationState?.activeStep);

  const stateContext =
    activeFlow && activeStep
      ? `Conversation state: flow=${activeFlow}, step=${activeStep}.`
      : "Conversation state indicates a completed flow.";

  return [
    "The user is sending a brief courtesy or acknowledgment after a completed process.",
    stateContext,
    "Reply with a short courtesy acknowledgment only.",
    "Do not introduce business overview, service list, pricing, location, schedules, or booking explanation.",
    "Do not restart discovery.",
    "Do not ask broad follow-up questions.",
    "A brief optional soft closing is allowed only if it does not reopen the sales flow.",
  ].join(" ");
}

async function resolvePostCompletionCourtesyFallback(
  args: ResolveUnhandledTurnFallbackArgs,
  finalIntent: string
): Promise<ResolveUnhandledTurnFallbackResult> {
  const rendered = await renderFastpathDmReply({
    tenantId: args.tenantId,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    contactoNorm: args.contactoNorm,
    messageId: args.messageId,
    promptBaseMem: args.promptBaseMem,
    fastpathText: "",
    fp: {
      reply: "",
      source: "unhandled_turn_post_completion_courtesy",
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
      canal: args.canal,
      answerType: "overview",
      replySourceKind: "business_info",
      responsePolicyMode: "grounded_frame_only",
      hasResolvedEntity: false,
      isCatalogDbReply: false,
      isPriceSummaryReply: false,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: false,
      isGroundedCatalogOverviewDm: true,
      shouldForceSalesClosingQuestion: false,
      shouldUseGroundedFrameOnly: true,
      canonicalBodyOwnsClosing: false,
      clarificationTarget: null,
      commercialPolicy: {
        purchaseIntent: args.detectedCommercial?.purchaseIntent ?? "low",
        wantsBooking: args.detectedCommercial?.wantsBooking === true,
        wantsQuote: args.detectedCommercial?.wantsQuote === true,
        wantsHuman: args.detectedCommercial?.wantsHuman === true,
        urgency: args.detectedCommercial?.urgency ?? "low",
        shouldUseSalesTone: true,
        shouldUseSoftClosing: true,
        shouldUseDirectClosing: false,
        shouldSuggestHumanHandoff: false,
      },
    }),
    ctxPatch: args.ctxPatch || {},
    maxLines: 9999,
  });

  const reply = toTrimmedString(rendered.reply);

  if (reply) {
    return {
      handled: true,
      reply,
      source: "unhandled_turn_post_completion_courtesy",
      intent: finalIntent,
      ctxPatch: rendered.ctxPatch || {},
    };
  }

  return {
    handled: true,
    reply: buildLastResortFallbackText(),
    source: "unhandled_turn_generic_fallback",
    intent: finalIntent,
    ctxPatch: args.ctxPatch || {},
  };
}

async function resolveExplicitExitFallback(
  args: ResolveUnhandledTurnFallbackArgs,
  finalIntent: string
): Promise<ResolveUnhandledTurnFallbackResult> {
  const exitCtxPatch = {
    ...(args.ctxPatch || {}),
    actionContext: null,
    pending_cta: null,
    awaiting_yes_no_action: null,
    awaiting_yesno: false,
    yesno_resolution: null,
  };

  const rendered = await renderFastpathDmReply({
    tenantId: args.tenantId,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    contactoNorm: args.contactoNorm,
    messageId: args.messageId,
    promptBaseMem: args.promptBaseMem,
    fastpathText: "",
    fp: {
      reply: "",
      source: "explicit_exit_fallback",
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
      canal: args.canal,
      answerType: "guided_next_step",
      replySourceKind: "generic",
      responsePolicyMode: "grounded_frame_only",
      hasResolvedEntity: false,
      isCatalogDbReply: false,
      isPriceSummaryReply: false,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: false,
      isGroundedCatalogOverviewDm: false,
      shouldForceSalesClosingQuestion: false,
      shouldUseGroundedFrameOnly: true,
      canonicalBodyOwnsClosing: false,
      clarificationTarget: null,
      commercialPolicy: {
        purchaseIntent: "low",
        wantsBooking: false,
        wantsQuote: false,
        wantsHuman: false,
        urgency: "low",
        shouldUseSalesTone: false,
        shouldUseSoftClosing: true,
        shouldUseDirectClosing: false,
        shouldSuggestHumanHandoff: false,
      },
    }),
    ctxPatch: exitCtxPatch,
    maxLines: 9999,
  });

  const reply = toTrimmedString(rendered.reply);

  if (reply) {
    return {
      handled: true,
      reply,
      source: "explicit_exit_fallback",
      intent: finalIntent,
      ctxPatch: rendered.ctxPatch || exitCtxPatch,
    };
  }

  return {
    handled: true,
    reply: "No problem.",
    source: "explicit_exit_fallback",
    intent: finalIntent,
    ctxPatch: exitCtxPatch,
  };
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
    convoCtx,
    detectedIntent,
    intentFallback,
    detectedCommercial,
    ctxPatch,
    fallbackKind,
  } = args;

  const finalIntent =
    toTrimmedString(detectedIntent) ||
    toTrimmedString(intentFallback) ||
    "info_general";

  if (fallbackKind === "post_completion_courtesy") {
    return await resolvePostCompletionCourtesyFallback(args, finalIntent);
  }

  if (isExplicitExitIntent(finalIntent)) {
    return await resolveExplicitExitFallback(args, finalIntent);
  }

  const canonicalBusinessInfoBody =
    await resolveBusinessInfoOverviewCanonicalBody({
      tenantId,
      canal,
      idiomaDestino,
      userInput,
      promptBaseMem,
      infoClave,
      convoCtx,
      overviewMode: "general_overview",
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
      replyPolicy: buildStaticFastpathReplyPolicy({
        canal: args.canal,
        answerType: "guided_next_step",
        replySourceKind: "generic",
        responsePolicyMode: "grounded_frame_only",
        hasResolvedEntity: false,
        isCatalogDbReply: false,
        isPriceSummaryReply: false,
        isPriceDisambiguationReply: false,
        isGroundedCatalogReply: false,
        isGroundedCatalogOverviewDm: false,
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
    reply: buildLastResortFallbackText(),
    source: "unhandled_turn_generic_fallback",
    intent: finalIntent,
    ctxPatch: ctxPatch || {},
  };
}