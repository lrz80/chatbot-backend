// backend/src/lib/conversation/finalizeReply.ts
import type { Canal } from '../../lib/detectarIntencion'; 

type LastServiceRef = {
  kind: "service" | "variant" | null;
  label: string | null;
  service_id: string | null;
  variant_id?: string | null;
  saved_at: string;
};

type FinalizeDeps = {
  // Sender/transport
  safeSend: (
    tenantId: string,
    canal: Canal,
    messageId: string | null,
    fromNumber: string,
    reply: string
  ) => Promise<boolean>;

  // Persistencia
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
    idiomaDestino: "es" | "en";
    userText: string;
    assistantText: string;
    lastIntent: string | null;
  }) => Promise<void>;

  // ✅ opcional: permitir que el LLM deje ancla de servicio para turnos siguientes
  captureLastServiceRef?: (args: {
    tenantId: string;
    userInput: string;
    assistantText: string;
    idiomaDestino: "es" | "en";
    convoCtx: any;
  }) => Promise<LastServiceRef | null>;
};

type FinalizeInput = {
  handled: boolean;
  reply: string | null;
  replySource: string | null;
  lastIntent: string | null;

  tenantId: string;
  canal: Canal;
  messageId: string | null;
  fromNumber: string; // número real del cliente (sin whatsapp:)
  contactoNorm: string; // llave normalizada
  userInput: string;

  idiomaDestino: "es" | "en";

  // snapshot estado conversacional (lo que tengas en memoria al final del turno)
  activeFlow: string;
  activeStep: string;
  convoCtx: any;

  // si manejas un fallback separado, pasa aquí el valor final
  intentFallback: string | null;

  // callback para mantener sync en el webhook si quieres
  onAfterOk?: (nextCtx: any) => void;
};

export async function finalizeReply(
  input: FinalizeInput,
  deps: FinalizeDeps
): Promise<void> {
  const {
    handled,
    reply,
    replySource,
    lastIntent,
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

  // ✅ Sender único para estado/memoria
  const senderKey = contactoNorm || fromNumber || "anónimo";

  // ✅ Intentar capturar last_service_ref (para casos donde el LLM respondió un servicio)
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

  const baseCtx = convoCtx && typeof convoCtx === "object" ? convoCtx : {};

  const canonicalLastEntityId =
    baseCtx.lastEntityId ??
    baseCtx.last_entity_id ??
    baseCtx.last_service_id ??
    baseCtx.selectedServiceId ??
    baseCtx.structuredService?.serviceId ??
    baseCtx.last_service_ref?.service_id ??
    capturedRef?.service_id ??
    null;

  const canonicalLastEntityName =
    baseCtx.lastEntityName ??
    baseCtx.last_entity_name ??
    baseCtx.last_service_name ??
    baseCtx.structuredService?.serviceName ??
    baseCtx.structuredService?.serviceLabel ??
    baseCtx.last_service_ref?.label ??
    capturedRef?.label ??
    null;

  const canonicalLastFamilyKey =
    baseCtx.lastFamilyKey ??
    baseCtx.last_family_key ??
    null;

  const canonicalLastFamilyName =
    baseCtx.lastFamilyName ??
    baseCtx.last_family_name ??
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
    baseCtx.lastResolvedIntent ??
    baseCtx.last_resolved_intent ??
    baseCtx.last_intent ??
    null;

  const nextCtx = {
    ...baseCtx,
    ...(capturedRef?.service_id ? { last_service_ref: capturedRef } : {}),

    // ancla canónica para clasificación/routing
    lastEntityId: canonicalLastEntityId,
    lastEntityName: canonicalLastEntityName,
    lastFamilyKey: canonicalLastFamilyKey,
    lastFamilyName: canonicalLastFamilyName,
    lastPresentedEntityIds: canonicalLastPresentedEntityIds,
    lastPresentedFamilyKeys: canonicalLastPresentedFamilyKeys,
    expectingVariantForEntityId: canonicalExpectingVariantForEntityId,
    expectedVariantIntent: canonicalExpectedVariantIntent,
    lastResolvedIntent: canonicalLastResolvedIntent,
    presentedVariantOptions: canonicalPresentedVariantOptions,

    // compat legacy
    last_intent: canonicalLastResolvedIntent,
    last_reply_source: replySource || null,
    last_assistant_text: reply,
    last_user_text: userInput,
    last_turn_at: new Date().toISOString(),

    // mantener consistencia y no revivir valores legacy viejos
    last_entity_id: canonicalLastEntityId,
    last_entity_name: canonicalLastEntityName,
    last_family_key: canonicalLastFamilyKey,
    last_family_name: canonicalLastFamilyName,
    last_presented_entity_ids: canonicalLastPresentedEntityIds,
    last_presented_family_keys: canonicalLastPresentedFamilyKeys,
    expecting_variant_for_entity_id: canonicalExpectingVariantForEntityId,
    expected_variant_intent: canonicalExpectedVariantIntent,
    presented_variant_options: canonicalPresentedVariantOptions,
    last_resolved_intent: canonicalLastResolvedIntent,
  };

  const ok = await deps.safeSend(tenantId, canal, messageId, fromNumber, reply);

  if (!ok) {
    console.warn("⚠️ finalizeReply: safeSend falló; no guardo assistant/memoria/estado.", {
      replySource,
    });
    return;
  }

  // 1) state (una sola vez)
  await deps.setConversationState(tenantId, canal, senderKey, {
    activeFlow: activeFlow || "generic_sales",
    activeStep: activeStep || "start",
    context: nextCtx,
  });

  // 2) mensaje assistant + emit
  await deps.saveAssistantMessageAndEmit({
    tenantId,
    canal,
    fromNumber: senderKey,
    messageId,
    content: reply,
  });

  // 3) memoria
  await deps.rememberAfterReply({
    tenantId,
    senderId: senderKey,
    idiomaDestino,
    userText: userInput,
    assistantText: reply,
    lastIntent: lastIntent || intentFallback || null,
  });

  if (onAfterOk) onAfterOk(nextCtx);
}
