//src/lib/channels/engine/state/applyStaleSelectionContextReset.ts

export type StaleSelectionIntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

export type ApplyStaleSelectionContextResetArgs = {
  convoCtx: any;
  userInput: string;
  intentNow: string | null;
  detectedFacets?: StaleSelectionIntentFacets | null;
};

export type ApplyStaleSelectionContextResetResult = {
  shouldReset: boolean;
  nextCtx: any;
  ctxPatch: any;
};

function hasArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function buildStaleSelectionClearPatch() {
  return {
    expectingVariant: false,
    selectedServiceId: null,

    last_plan_list: null,
    last_plan_list_at: null,

    last_package_list: null,
    last_package_list_at: null,

    last_list_kind: null,
    last_list_kind_at: null,

    pending_link_lookup: null,
    pending_link_at: null,
    pending_link_options: null,

    last_service_id: null,
    last_service_name: null,
    last_service_label: null,

    last_entity_kind: null,
    last_entity_at: null,

    structuredService: null,

    pendingCatalogChoice: null,
    pendingCatalogChoiceAt: null,

    lastPresentedEntityIds: null,
    lastPresentedFamilyKeys: null,

    expectingVariantForEntityId: null,
    expectedVariantIntent: null,

    presentedVariantOptions: null,
    last_variant_options: null,
    last_variant_options_at: null,

    continuationContext: null,
    last_assistant_turn: null,
  };
}

function hasStaleSelectionContext(ctx: any): boolean {
  return Boolean(
    ctx?.expectingVariant ||
      ctx?.selectedServiceId ||
      hasArrayItems(ctx?.last_plan_list) ||
      hasArrayItems(ctx?.last_package_list) ||
      ctx?.pending_link_lookup ||
      ctx?.pendingCatalogChoice ||
      ctx?.last_service_id ||
      ctx?.structuredService ||
      hasArrayItems(ctx?.presentedVariantOptions) ||
      hasArrayItems(ctx?.last_variant_options) ||
      ctx?.continuationContext?.lastTurn
  );
}

function hasPendingCatalogChoiceForSelection(ctx: any): boolean {
  return Boolean(
    ctx?.pendingCatalogChoice &&
      Array.isArray(ctx?.pendingCatalogChoice?.options) &&
      ctx.pendingCatalogChoice.options.length > 0
  );
}

function hasActiveSelectionContext(ctx: any): boolean {
  return Boolean(
    ctx?.pending_link_lookup ||
      ctx?.pending_price_lookup ||
      ctx?.expectingVariant ||
      hasPendingCatalogChoiceForSelection(ctx) ||
      hasArrayItems(ctx?.pending_link_options) ||
      hasArrayItems(ctx?.last_plan_list)
  );
}

function looksLikeSelectionReply(input: {
  userInput: string;
  convoCtx: any;
}): boolean {
  const rawInput = String(input.userInput || "").trim();

  if (!rawInput) {
    return false;
  }

  const inputTokens = rawInput
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);

  const numericInput = Number(rawInput);

  const isNumericSelection =
    Number.isInteger(numericInput) &&
    numericInput >= 1 &&
    numericInput <= 9 &&
    String(numericInput) === rawInput;

  const hasQuestionMark =
    rawInput.includes("?") || rawInput.includes("¿");

  const isShortFreeText =
    rawInput.length > 0 && rawInput.length <= 20;

  const isClearlyLongSentence =
    inputTokens.length >= 5;

  const isLowAutonomySelectionCandidate =
    isShortFreeText &&
    !hasQuestionMark &&
    !isClearlyLongSentence;

  return Boolean(
    isNumericSelection ||
      (
        hasActiveSelectionContext(input.convoCtx) &&
        isLowAutonomySelectionCandidate
      )
  );
}

function shouldResetForIntent(input: {
  intentNow: string | null;
  detectedFacets?: StaleSelectionIntentFacets | null;
}): boolean {
  const intentNow = String(input.intentNow || "").trim();

  if (!intentNow) {
    return false;
  }

  return Boolean(
    input.detectedFacets?.asksSchedules === true ||
      input.detectedFacets?.asksPrices === true ||
      input.detectedFacets?.asksLocation === true ||
      input.detectedFacets?.asksAvailability === true ||
      intentNow === "agendar" ||
      intentNow === "booking_start" ||
      intentNow === "info_servicio" ||
      intentNow === "precio" ||
      intentNow === "planes_precios" ||
      intentNow === "horario"
  );
}

export function applyStaleSelectionContextReset(
  args: ApplyStaleSelectionContextResetArgs
): ApplyStaleSelectionContextResetResult {
  const convoCtx =
    args.convoCtx && typeof args.convoCtx === "object"
      ? args.convoCtx
      : {};

  const shouldReset =
    shouldResetForIntent({
      intentNow: args.intentNow,
      detectedFacets: args.detectedFacets || null,
    }) &&
    hasStaleSelectionContext(convoCtx) &&
    !looksLikeSelectionReply({
      userInput: args.userInput,
      convoCtx,
    });

  if (!shouldReset) {
    return {
      shouldReset: false,
      nextCtx: convoCtx,
      ctxPatch: {},
    };
  }

  const ctxPatch = buildStaleSelectionClearPatch();

  return {
    shouldReset: true,
    nextCtx: {
      ...convoCtx,
      ...ctxPatch,
    },
    ctxPatch,
  };
}