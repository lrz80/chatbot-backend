import type { Canal } from '../../lib/detectarIntencion';
import type { LangCode } from '../i18n/lang';
import { buildCanonicalTurnSnapshot } from '../channels/engine/continuation/buildCanonicalTurnSnapshot';

type LastServiceRef = {
  kind: "service" | "variant" | null;
  label: string | null;
  service_id: string | null;
  variant_id?: string | null;
  saved_at: string;
};

type FinalizeDeps = {
  safeSend: (
    tenantId: string,
    canal: Canal,
    messageId: string | null,
    fromNumber: string,
    reply: string
  ) => Promise<boolean>;

  setConversationState: (
    tenantId: string,
    canal: Canal,
    senderKey: string,
    state: { activeFlow: string; activeStep: string; context: any }
  ) => Promise<void>;

  saveAssistantMessageAndEmit: (args: {
    tenantId: string;
    canal: Canal;
    fromNumber: string;
    messageId: string | null;
    content: string;
  }) => Promise<void>;

  rememberAfterReply: (args: {
    tenantId: string;
    senderId: string;
    idiomaDestino: LangCode;
    userText: string;
    assistantText: string;
    lastIntent: string | null;
    replySource: string | null;
  }) => Promise<void>;

  captureLastServiceRef?: (args: {
    tenantId: string;
    userInput: string;
    assistantText: string;
    idiomaDestino: LangCode;
    convoCtx: any;
  }) => Promise<LastServiceRef | null>;
};

type FinalizeInput = {
  handled: boolean;
  reply: string | null;
  replySource: string | null;
  lastIntent: string | null;
  ctxPatch?: any;

  tenantId: string;
  canal: Canal;
  messageId: string | null;
  fromNumber: string;
  contactoNorm: string;
  userInput: string;

  idiomaDestino: LangCode;

  activeFlow: string;
  activeStep: string;
  convoCtx: any;

  intentFallback: string | null;

  onAfterOk?: (nextCtx: any) => void;
};

function getExplicitContinuationLastTurn(ctxPatch: any): any | null {
  const candidate = ctxPatch?.continuationContext?.lastTurn;

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const domain = String(candidate.domain || "").trim();

  if (
    domain !== "catalog" &&
    domain !== "business_info" &&
    domain !== "booking" &&
    domain !== "other"
  ) {
    return null;
  }

  return candidate;
}

function resolveContinuationDomain(args: {
  canonicalLastEntityId: string | null;
  canonicalLastResolvedIntent: string | null;
  baseCtx: any;
  replySource: string | null;
}): "catalog" | "business_info" | "booking" | "other" {
  const {
    canonicalLastEntityId,
    canonicalLastResolvedIntent,
    baseCtx,
    replySource,
  } = args;

  const bookingStep =
    baseCtx?.booking?.step && typeof baseCtx.booking.step === "string"
      ? baseCtx.booking.step.trim().toLowerCase()
      : "";

  const inBooking = Boolean(bookingStep && bookingStep !== "idle");

  if (inBooking) {
    return "booking";
  }

  const normalizedReplySource = String(replySource || "").trim().toLowerCase();
  const normalizedIntent = String(canonicalLastResolvedIntent || "").trim().toLowerCase();

  const isCatalogReplySource =
    normalizedReplySource === "catalog_db" ||
    normalizedReplySource === "catalog_route" ||
    normalizedReplySource.startsWith("catalog_");

  if (canonicalLastEntityId || isCatalogReplySource) {
    return "catalog";
  }

  if (
    normalizedIntent === "info_general" ||
    normalizedIntent === "horario" ||
    normalizedIntent === "ubicacion" ||
    normalizedIntent === "disponibilidad" ||
    normalizedIntent === "info_servicio"
  ) {
    return "business_info";
  }

  return "other";
}

export async function finalizeReply(
  input: FinalizeInput,
  deps: FinalizeDeps
): Promise<void> {
  const {
    handled,
    reply,
    replySource,
    lastIntent,
    ctxPatch,
    tenantId,
    canal,
    messageId,
    fromNumber,
    contactoNorm,
    userInput,
    idiomaDestino,
    activeFlow,
    activeStep,
    convoCtx,
    intentFallback,
    onAfterOk,
  } = input;

  if (!handled || !reply) return;

  const senderKey = contactoNorm || fromNumber || "anónimo";

  let capturedRef: LastServiceRef | null = null;

  try {
    const hasSticky =
      Boolean(convoCtx?.service_info_pick?.options?.length) ||
      Boolean(convoCtx?.service_link_pick?.options?.length);

    const inBooking =
      Boolean(convoCtx?.booking?.step && convoCtx.booking.step !== "idle");

    if (
      deps.captureLastServiceRef &&
      !hasSticky &&
      !inBooking &&
      typeof userInput === "string" &&
      typeof reply === "string" &&
      userInput.trim().length >= 2 &&
      reply.trim().length >= 2
    ) {
      capturedRef = await deps.captureLastServiceRef({
        tenantId,
        userInput,
        assistantText: reply,
        idiomaDestino,
        convoCtx,
      });
    }
  } catch {
    // no romper el turno
  }

  const rawBaseCtx = convoCtx && typeof convoCtx === "object" ? convoCtx : {};
  const patchCtx = ctxPatch && typeof ctxPatch === "object" ? ctxPatch : {};

  const explicitContinuationLastTurn = getExplicitContinuationLastTurn(patchCtx);

  const baseCtx = {
    ...rawBaseCtx,
    ...patchCtx,
  };

  const canonicalLastEntityId =
    patchCtx.last_service_id ??
    patchCtx.selectedServiceId ??
    patchCtx.lastEntityId ??
    patchCtx.last_entity_id ??
    patchCtx.structuredService?.serviceId ??
    rawBaseCtx.last_service_id ??
    rawBaseCtx.selectedServiceId ??
    rawBaseCtx.lastEntityId ??
    rawBaseCtx.last_entity_id ??
    rawBaseCtx.structuredService?.serviceId ??
    rawBaseCtx.last_service_ref?.service_id ??
    capturedRef?.service_id ??
    null;

  const canonicalLastEntityName =
    patchCtx.last_service_name ??
    patchCtx.lastEntityName ??
    patchCtx.last_entity_name ??
    patchCtx.structuredService?.serviceName ??
    patchCtx.structuredService?.serviceLabel ??
    rawBaseCtx.last_service_name ??
    rawBaseCtx.lastEntityName ??
    rawBaseCtx.last_entity_name ??
    rawBaseCtx.structuredService?.serviceName ??
    rawBaseCtx.structuredService?.serviceLabel ??
    rawBaseCtx.last_service_ref?.label ??
    capturedRef?.label ??
    null;

  const canonicalLastFamilyKey =
    patchCtx.lastFamilyKey ??
    patchCtx.last_family_key ??
    rawBaseCtx.lastFamilyKey ??
    rawBaseCtx.last_family_key ??
    null;

  const canonicalLastFamilyName =
    patchCtx.lastFamilyName ??
    patchCtx.last_family_name ??
    rawBaseCtx.lastFamilyName ??
    rawBaseCtx.last_family_name ??
    null;

  const canonicalLastPresentedEntityIds = Array.isArray(baseCtx.lastPresentedEntityIds)
    ? baseCtx.lastPresentedEntityIds
    : Array.isArray(baseCtx.last_presented_entity_ids)
    ? baseCtx.last_presented_entity_ids
    : Array.isArray(baseCtx.last_plan_list)
    ? baseCtx.last_plan_list
        .map((item: any) => item?.id ?? item?.service_id ?? null)
        .filter(Boolean)
    : Array.isArray(baseCtx.last_package_list)
    ? baseCtx.last_package_list
        .map((item: any) => item?.id ?? item?.service_id ?? null)
        .filter(Boolean)
    : [];

  const canonicalLastPresentedFamilyKeys = Array.isArray(baseCtx.lastPresentedFamilyKeys)
    ? baseCtx.lastPresentedFamilyKeys
    : Array.isArray(baseCtx.last_presented_family_keys)
    ? baseCtx.last_presented_family_keys
    : [];

  const hasOwn = (obj: any, key: string) =>
    Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

  const canonicalExpectingVariantForEntityId = hasOwn(baseCtx, "expectingVariantForEntityId")
    ? baseCtx.expectingVariantForEntityId
    : hasOwn(baseCtx, "expecting_variant_for_entity_id")
    ? baseCtx.expecting_variant_for_entity_id
    : hasOwn(baseCtx, "expectingVariant")
    ? (baseCtx.expectingVariant ? canonicalLastEntityId : null)
    : null;

  const canonicalExpectedVariantIntent = hasOwn(baseCtx, "expectedVariantIntent")
    ? baseCtx.expectedVariantIntent
    : hasOwn(baseCtx, "expected_variant_intent")
    ? baseCtx.expected_variant_intent
    : null;

  const canonicalPresentedVariantOptions = hasOwn(baseCtx, "presentedVariantOptions")
    ? (Array.isArray(baseCtx.presentedVariantOptions)
        ? baseCtx.presentedVariantOptions
        : null)
    : hasOwn(baseCtx, "presented_variant_options")
    ? (Array.isArray(baseCtx.presented_variant_options)
        ? baseCtx.presented_variant_options
        : null)
    : [];

  const canonicalLastResolvedIntent =
    lastIntent ??
    intentFallback ??
    patchCtx.lastResolvedIntent ??
    patchCtx.last_resolved_intent ??
    patchCtx.last_intent ??
    rawBaseCtx.lastResolvedIntent ??
    rawBaseCtx.last_resolved_intent ??
    rawBaseCtx.last_intent ??
    null;

  const canonicalLastVariantId =
    patchCtx.last_variant_id ??
    patchCtx.lastVariantId ??
    rawBaseCtx.last_variant_id ??
    rawBaseCtx.lastVariantId ??
    capturedRef?.variant_id ??
    null;

  const canonicalLastVariantName =
    patchCtx.last_variant_name ??
    patchCtx.lastVariantName ??
    rawBaseCtx.last_variant_name ??
    rawBaseCtx.lastVariantName ??
    null;

  const continuationDomain =
    explicitContinuationLastTurn?.domain ||
    resolveContinuationDomain({
      canonicalLastEntityId,
      canonicalLastResolvedIntent,
      baseCtx,
      replySource,
    });

  const conversationAnchor =
    explicitContinuationLastTurn?.domain === "other"
      ? null
      : continuationDomain === "catalog" || continuationDomain === "business_info"
      ? {
          domain: continuationDomain,
          entityId: canonicalLastEntityId,
          entityName: canonicalLastEntityName,
          variantId: canonicalLastVariantId,
          variantName: canonicalLastVariantName,
          intent: canonicalLastResolvedIntent,
          createdAt: new Date().toISOString(),
        }
      : null;

  const continuationLastTurn =
    explicitContinuationLastTurn ||
    buildCanonicalTurnSnapshot({
      domain: continuationDomain,
      intent: canonicalLastResolvedIntent,
      userText: userInput,
      assistantText: reply,
      canonicalSource: continuationDomain,
      references: {
        serviceId: canonicalLastEntityId,
        familyId: canonicalLastFamilyKey,
        variantId: canonicalLastVariantId,
      },
    });

  const nextActionContext = hasOwn(patchCtx, "actionContext")
    ? patchCtx.actionContext ?? null
    : rawBaseCtx.actionContext ?? null;

  const nextCtx = {
    ...baseCtx,
    ...(capturedRef?.service_id ? { last_service_ref: capturedRef } : {}),
    conversationAnchor,

    continuationContext: {
      ...(baseCtx?.continuationContext ?? {}),
      lastTurn: continuationLastTurn,
    },

    actionContext: nextActionContext,

    lastEntityId:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalLastEntityId,
    lastEntityName:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalLastEntityName,
    lastFamilyKey:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalLastFamilyKey,
    lastFamilyName:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalLastFamilyName,
    lastPresentedEntityIds:
      explicitContinuationLastTurn?.domain === "other" ? [] : canonicalLastPresentedEntityIds,
    lastPresentedFamilyKeys:
      explicitContinuationLastTurn?.domain === "other" ? [] : canonicalLastPresentedFamilyKeys,
    expectingVariantForEntityId:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalExpectingVariantForEntityId,
    expectedVariantIntent:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalExpectedVariantIntent,
    lastResolvedIntent: canonicalLastResolvedIntent,
    presentedVariantOptions:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalPresentedVariantOptions,

    last_intent: canonicalLastResolvedIntent,
    last_reply_source: replySource || null,
    last_assistant_text: reply,
    last_user_text: userInput,
    last_turn_at: new Date().toISOString(),

    last_entity_id:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalLastEntityId,
    last_entity_name:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalLastEntityName,
    last_family_key:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalLastFamilyKey,
    last_family_name:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalLastFamilyName,
    last_presented_entity_ids:
      explicitContinuationLastTurn?.domain === "other" ? [] : canonicalLastPresentedEntityIds,
    last_presented_family_keys:
      explicitContinuationLastTurn?.domain === "other" ? [] : canonicalLastPresentedFamilyKeys,
    expecting_variant_for_entity_id:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalExpectingVariantForEntityId,
    expected_variant_intent:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalExpectedVariantIntent,
    presented_variant_options:
      explicitContinuationLastTurn?.domain === "other" ? null : canonicalPresentedVariantOptions,
    last_resolved_intent: canonicalLastResolvedIntent,
  };

  console.log("[FINALIZE_REPLY][OUTBOUND_REPLY_DEBUG]", {
    tenantId,
    canal,
    replyPreview: String(reply || "").slice(0, 300),
    continuationDomain,
    continuationLastTurn,
    actionContext: nextActionContext,
  });

  const ok = await deps.safeSend(tenantId, canal, messageId, fromNumber, reply);

  if (!ok) {
    console.warn("⚠️ finalizeReply: safeSend falló; no guardo assistant/memoria/estado.", {
      replySource,
    });
    return;
  }

  await deps.setConversationState(tenantId, canal, senderKey, {
    activeFlow: activeFlow || "generic_sales",
    activeStep: activeStep || "start",
    context: nextCtx,
  });

  await deps.saveAssistantMessageAndEmit({
    tenantId,
    canal,
    fromNumber: senderKey,
    messageId,
    content: reply,
  });

  await deps.rememberAfterReply({
    tenantId,
    senderId: senderKey,
    idiomaDestino,
    userText: userInput,
    assistantText: reply,
    lastIntent: lastIntent || intentFallback || null,
    replySource: replySource || null,
  });

  if (onAfterOk) onAfterOk(nextCtx);
}