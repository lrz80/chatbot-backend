// src/lib/channels/engine/fallback/resolveUnhandledTurnFallback.ts
import type { Canal, CommercialSignal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
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

type ResolveUnhandledTurnFallbackSource =
  | "explicit_exit_fallback"
  | "payment_fallback"
  | "unhandled_turn_generic_fallback"
  | "unhandled_turn_post_completion_courtesy";

type ResolveUnhandledTurnFallbackResult = {
  handled: boolean;
  reply: string;
  source: ResolveUnhandledTurnFallbackSource;
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

function isPaymentIntent(intent: string | null): boolean {
  return toTrimmedString(intent).toLowerCase() === "pago";
}

function buildEmergencyGuardText(idiomaDestino: LangCode): string {
  return idiomaDestino === "es"
    ? "¿Me puedes decir un poco más para ayudarte mejor?"
    : "Could you share a bit more so I can help you better?";
}

async function renderFallbackReply(args: {
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  finalIntent: string;
  source: ResolveUnhandledTurnFallbackSource;
  answerType: "overview" | "guided_next_step";
  replySourceKind: "business_info" | "generic";
  detectedCommercial?: CommercialSignal | null;
  ctxPatch?: Record<string, unknown> | null;
}): Promise<{
  reply: string;
  ctxPatch: Record<string, unknown>;
}> {
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
      source: args.source,
      intent: args.finalIntent,
      catalogPayload: undefined,
    },
    detectedIntent: args.finalIntent,
    intentFallback: args.finalIntent,
    structuredService: {
      serviceId: null,
      serviceName: null,
      serviceLabel: null,
      hasResolution: false,
    },
    replyPolicy: buildStaticFastpathReplyPolicy({
      canal: args.canal,
      answerType: args.answerType,
      replySourceKind: args.replySourceKind,
      responsePolicyMode: "grounded_frame_only",
      hasResolvedEntity: false,
      isCatalogDbReply: false,
      isPriceSummaryReply: false,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: false,
      isGroundedCatalogOverviewDm: args.answerType === "overview",
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
        shouldUseSalesTone: args.source !== "explicit_exit_fallback",
        shouldUseSoftClosing: true,
        shouldUseDirectClosing: false,
        shouldSuggestHumanHandoff: false,
      },
    }),
    ctxPatch: args.ctxPatch || {},
    maxLines: 9999,
  });

  const reply = toTrimmedString(rendered.reply);

  return {
    reply: reply || buildEmergencyGuardText(args.idiomaDestino),
    ctxPatch: (rendered.ctxPatch || args.ctxPatch || {}) as Record<string, unknown>,
  };
}

async function resolvePostCompletionCourtesyFallback(
  args: ResolveUnhandledTurnFallbackArgs,
  finalIntent: string
): Promise<ResolveUnhandledTurnFallbackResult> {
  const rendered = await renderFallbackReply({
    tenantId: args.tenantId,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    contactoNorm: args.contactoNorm,
    messageId: args.messageId,
    promptBaseMem: args.promptBaseMem,
    finalIntent,
    source: "unhandled_turn_post_completion_courtesy",
    answerType: "overview",
    replySourceKind: "business_info",
    detectedCommercial: args.detectedCommercial,
    ctxPatch: args.ctxPatch || {},
  });

  return {
    handled: true,
    reply: rendered.reply,
    source: "unhandled_turn_post_completion_courtesy",
    intent: finalIntent,
    ctxPatch: rendered.ctxPatch,
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

  const rendered = await renderFallbackReply({
    tenantId: args.tenantId,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    contactoNorm: args.contactoNorm,
    messageId: args.messageId,
    promptBaseMem: args.promptBaseMem,
    finalIntent,
    source: "explicit_exit_fallback",
    answerType: "guided_next_step",
    replySourceKind: "generic",
    detectedCommercial: {
      purchaseIntent: "low",
      wantsBooking: false,
      wantsQuote: false,
      wantsHuman: false,
      urgency: "low",
    },
    ctxPatch: exitCtxPatch,
  });

  return {
    handled: true,
    reply: rendered.reply,
    source: "explicit_exit_fallback",
    intent: finalIntent,
    ctxPatch: rendered.ctxPatch,
  };
}

async function resolvePaymentFallback(
  args: ResolveUnhandledTurnFallbackArgs,
  finalIntent: string
): Promise<ResolveUnhandledTurnFallbackResult> {
  const paymentCtxPatch = {
    ...(args.ctxPatch || {}),
    actionContext: null,
  };

  const rendered = await renderFallbackReply({
    tenantId: args.tenantId,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    contactoNorm: args.contactoNorm,
    messageId: args.messageId,
    promptBaseMem: args.promptBaseMem,
    finalIntent,
    source: "payment_fallback",
    answerType: "guided_next_step",
    replySourceKind: "generic",
    detectedCommercial: args.detectedCommercial,
    ctxPatch: paymentCtxPatch,
  });

  return {
    handled: true,
    reply: rendered.reply,
    source: "payment_fallback",
    intent: finalIntent,
    ctxPatch: rendered.ctxPatch,
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
    detectedIntent,
    intentFallback,
    detectedCommercial,
    ctxPatch,
    fallbackKind,
  } = args;

  const finalIntent =
    toTrimmedString(detectedIntent) ||
    toTrimmedString(intentFallback) ||
    "other";

  if (fallbackKind === "post_completion_courtesy") {
    return await resolvePostCompletionCourtesyFallback(args, finalIntent);
  }

  if (isExplicitExitIntent(finalIntent)) {
    return await resolveExplicitExitFallback(args, finalIntent);
  }

  if (isPaymentIntent(finalIntent)) {
    return await resolvePaymentFallback(args, finalIntent);
  }

  const rendered = await renderFallbackReply({
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    finalIntent,
    source: "unhandled_turn_generic_fallback",
    answerType: "guided_next_step",
    replySourceKind: "generic",
    detectedCommercial,
    ctxPatch: ctxPatch || {},
  });

  return {
    handled: true,
    reply: rendered.reply,
    source: "unhandled_turn_generic_fallback",
    intent: finalIntent,
    ctxPatch: rendered.ctxPatch,
  };
}