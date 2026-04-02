import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";

export type HandleVariantSecondTurnInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;
  detectedIntent?: string | null;
  intentOut?: string | null;
  catalogReferenceClassification?: any;
};

type PendingServiceChoice = {
  kind: "service_choice";
  originalIntent?: string | null;
  options: Array<{
    kind?: "service";
    serviceId?: string;
    variantId?: null;
    label?: string | null;
    serviceName?: string | null;
  }>;
  createdAt?: number | null;
};

type PendingVariantChoice = {
  kind: "variant_choice";
  originalIntent?: string | null;
  serviceId: string;
  serviceName?: string | null;
  options: Array<{
    kind?: "variant";
    serviceId?: string;
    variantId?: string | null;
    label?: string | null;
    serviceName?: string | null;
    variantName?: string | null;
  }>;
  createdAt?: number | null;
};

type PresentedVariantOption = {
  variantId: string;
  label: string;
  index: number;
};

function parseSingleDigitSelection(input: string): number | null {
  const value = String(input || "").trim();
  if (!value) return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 1 || parsed > 9) return null;
  if (String(parsed) !== value) return null;

  return parsed;
}

function isExplicitVariantSelectionTurn(input: string): boolean {
  const value = String(input || "").trim();
  if (!value) return false;

  if (parseSingleDigitSelection(value) !== null) {
    return true;
  }

  const normalized = normalizeChoiceText(value);

  if (!normalized) {
    return false;
  }

  // turno corto típico de selección, no pregunta nueva
  if (
    normalized === "autopago" ||
    normalized === "por mes" ||
    normalized === "auto pago" ||
    normalized === "monthly" ||
    normalized === "month" ||
    normalized === "autopay"
  ) {
    return true;
  }

  return false;
}

function splitLines(text: string): string[] {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);
}

function normalizeChoiceText(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function resolveVariantTurnIntent(params: {
  detectedIntent?: string | null;
  intentOut?: string | null;
  originalIntent?: string | null;
  askedPriceVariant: boolean;
}): string {
  if (params.askedPriceVariant) {
    return "precio";
  }

  const originalIntent = String(params.originalIntent || "")
    .trim()
    .toLowerCase();

  if (originalIntent && originalIntent !== "duda") {
    return originalIntent;
  }

  const normalizedIntentOut = String(params.intentOut || "")
    .trim()
    .toLowerCase();

  if (normalizedIntentOut && normalizedIntentOut !== "duda") {
    return normalizedIntentOut;
  }

  const normalizedDetectedIntent = String(params.detectedIntent || "")
    .trim()
    .toLowerCase();

  if (normalizedDetectedIntent && normalizedDetectedIntent !== "duda") {
    return normalizedDetectedIntent;
  }

  return "info_servicio";
}

function getPendingVariantChoice(convoCtx: any): PendingVariantChoice | null {
  const pending = convoCtx?.pendingCatalogChoice;

  if (!pending || pending.kind !== "variant_choice") {
    return null;
  }

  const serviceId = String(pending.serviceId || "").trim();
  if (!serviceId) {
    return null;
  }

  const rawOptions: Array<{
    kind?: "variant";
    serviceId?: string;
    variantId?: string | null;
    label?: string | null;
  }> = Array.isArray(pending.options) ? pending.options : [];

  const options = rawOptions
    .map((item) => {
      const variantId = String(item?.variantId || "").trim() || null;
      const label = String(item?.label || "").trim() || null;

      if (!variantId || !label) {
        return null;
      }

      return {
        kind: "variant" as const,
        serviceId,
        variantId,
        label,
      };
    })
    .filter(
      (
        item
      ): item is {
        kind: "variant";
        serviceId: string;
        variantId: string;
        label: string;
      } => item !== null
    );

  if (options.length < 2) {
    return null;
  }

  return {
    kind: "variant_choice",
    originalIntent:
      typeof pending.originalIntent === "string"
        ? pending.originalIntent
        : null,
    serviceId,
    serviceName:
      typeof pending.serviceName === "string"
        ? pending.serviceName
        : null,
    options,
    createdAt:
      typeof pending.createdAt === "number" ? pending.createdAt : null,
  };
}

function getPendingServiceChoice(convoCtx: any): PendingServiceChoice | null {
  const pending = convoCtx?.pendingCatalogChoice;

  if (!pending || pending.kind !== "service_choice") {
    return null;
  }

  const rawOptions = Array.isArray(pending.options) ? pending.options : [];

  const options = rawOptions
    .map((item: any) => {
      const serviceId = String(item?.serviceId || item?.id || "").trim();
      const label = String(item?.label || item?.name || "").trim();

      if (!serviceId || !label) {
        return null;
      }

      return {
        kind: "service" as const,
        serviceId,
        variantId: null,
        label,
        serviceName: String(item?.serviceName || item?.name || "").trim() || null,
      };
    })
    .filter(Boolean) as Array<{
      kind: "service";
      serviceId: string;
      variantId: null;
      label: string;
      serviceName?: string | null;
    }>;

  if (options.length < 2) {
    return null;
  }

  return {
    kind: "service_choice",
    originalIntent:
      typeof pending.originalIntent === "string"
        ? pending.originalIntent
        : null,
    options,
    createdAt:
      typeof pending.createdAt === "number" ? pending.createdAt : null,
  };
}

function getPresentedVariantOptions(convoCtx: any): PresentedVariantOption[] {
  const fromPresented = Array.isArray(convoCtx?.presentedVariantOptions)
    ? convoCtx.presentedVariantOptions
    : [];

  const normalizedPresented = fromPresented
    .map((item: any, idx: number) => {
      const variantId = String(item?.variantId || item?.id || "").trim();
      const label = String(item?.label || item?.variant_name || "").trim();

      if (!variantId || !label) {
        return null;
      }

      return {
        variantId,
        label,
        index: idx + 1,
      };
    })
    .filter(Boolean) as PresentedVariantOption[];

  if (normalizedPresented.length > 0) {
    return normalizedPresented;
  }

  const fromLastVariantOptions = Array.isArray(convoCtx?.last_variant_options)
    ? convoCtx.last_variant_options
    : [];

  return fromLastVariantOptions
    .map((item: any, idx: number) => {
      const variantId = String(item?.id || item?.variantId || "").trim();
      const label = String(item?.variant_name || item?.label || "").trim();

      if (!variantId || !label) {
        return null;
      }

      return {
        variantId,
        label,
        index:
          typeof item?.index === "number" && Number.isInteger(item.index)
            ? item.index
            : idx + 1,
      };
    })
    .filter(Boolean) as PresentedVariantOption[];
}

function resolveVariantIdFromUserInput(params: {
  userInput: string;
  numericSelectionIndex: number | null;
  targetVariantId: string | null;
  presentedVariantOptions: PresentedVariantOption[];
  dbVariants: Array<{ id: string; variant_name: string | null }>;
}): string | null {
  if (params.numericSelectionIndex !== null) {
    const fromPresented = params.presentedVariantOptions.find(
      (item) => item.index === params.numericSelectionIndex
    );

    if (fromPresented?.variantId) {
      return fromPresented.variantId;
    }

    const idx = params.numericSelectionIndex - 1;
    if (idx >= 0 && idx < params.dbVariants.length) {
      return String(params.dbVariants[idx]?.id || "").trim() || null;
    }
  }

  if (params.targetVariantId) {
    const targetExistsInCurrentService = params.dbVariants.some(
      (item) => String(item.id || "").trim() === String(params.targetVariantId || "").trim()
    );

    if (targetExistsInCurrentService) {
      return String(params.targetVariantId || "").trim();
    }
  }

  const userNorm = normalizeChoiceText(params.userInput);
  if (!userNorm) {
    return null;
  }

  const fromPresentedByLabel = params.presentedVariantOptions.find(
    (item) => normalizeChoiceText(item.label) === userNorm
  );

  if (fromPresentedByLabel?.variantId) {
    return fromPresentedByLabel.variantId;
  }

  const fromDbByLabel = params.dbVariants.find(
    (item) => normalizeChoiceText(item.variant_name) === userNorm
  );

  if (fromDbByLabel?.id) {
    return String(fromDbByLabel.id).trim();
  }

  return null;
}

export async function handleVariantSecondTurn(
  input: HandleVariantSecondTurnInput
): Promise<FastpathResult> {
  const {
    targetServiceId: structuredTargetServiceId,
    targetVariantId,
  } = getCatalogStructuredSignals({
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
  });

  const pendingServiceChoice = getPendingServiceChoice(input.convoCtx);
  const pendingVariantChoice = getPendingVariantChoice(input.convoCtx);
  const numericSelectionIndex = parseSingleDigitSelection(input.userInput);
  const isSelectionTurn = isExplicitVariantSelectionTurn(input.userInput);

  const selectedServiceIdFromServiceChoice =
    pendingServiceChoice && numericSelectionIndex !== null
      ? String(
          pendingServiceChoice.options[numericSelectionIndex - 1]?.serviceId || ""
        ).trim() || null
      : null;

  const selectedServiceLabelFromServiceChoice =
    pendingServiceChoice && numericSelectionIndex !== null
      ? String(
          pendingServiceChoice.options[numericSelectionIndex - 1]?.serviceName ||
            pendingServiceChoice.options[numericSelectionIndex - 1]?.label ||
            ""
        ).trim() || null
      : null;

  const selectedServiceId =
    String(
      selectedServiceIdFromServiceChoice ||
        pendingVariantChoice?.serviceId ||
        structuredTargetServiceId ||
        input.convoCtx?.selectedServiceId ||
        input.convoCtx?.last_service_id ||
        ""
    ).trim() || null;

  const selectedServiceName =
    String(
      selectedServiceLabelFromServiceChoice ||
        pendingVariantChoice?.serviceName ||
        input.convoCtx?.last_service_name ||
        ""
    ).trim() || null;

  const presentedVariantOptions = getPresentedVariantOptions(input.convoCtx);

  const hasVariantSelectionContext =
    Boolean(input.convoCtx?.expectingVariant) ||
    Boolean(pendingServiceChoice) ||
    Boolean(pendingVariantChoice) ||
    presentedVariantOptions.length > 0;

  const canAttemptVariantResolution =
    Boolean(selectedServiceId) &&
    hasVariantSelectionContext &&
    isSelectionTurn;

  if (!isSelectionTurn) {
    return {
      handled: false,
    };
  }

  if (!canAttemptVariantResolution) {
    return {
      handled: false,
    };
  }

  console.log("[VARIANT_SECOND_TURN][ENTRY]", {
    userInput: input.userInput,
    expectingVariant: input.convoCtx?.expectingVariant,
    selectedServiceId,
    selectedServiceName,
    numericSelectionIndex,
    targetVariantId,
    presentedVariantOptionsCount: presentedVariantOptions.length,
    pendingVariantChoiceKind: pendingVariantChoice?.kind || null,
  });

  const serviceId = String(selectedServiceId);

  const askedPriceVariant =
    String(input.convoCtx?.last_bot_action || "") === "asked_price_variant";

  const resolvedVariantTurnIntent = resolveVariantTurnIntent({
    detectedIntent: input.detectedIntent,
    intentOut: input.intentOut,
    originalIntent: pendingVariantChoice?.originalIntent || null,
    askedPriceVariant,
  });

  const { rows: variants } = await input.pool.query<any>(
    `
    SELECT
      id,
      variant_name,
      description,
      variant_url,
      price,
      currency
    FROM service_variants
    WHERE service_id = $1
      AND active = true
    ORDER BY created_at ASC, id ASC
    `,
    [serviceId]
  );

  if (!variants.length) {
    return {
      handled: false,
      ctxPatch: {
        expectingVariant: false,
        selectedServiceId: null,
        pendingCatalogChoice: null,
        pendingCatalogChoiceAt: null,
        expectedVariantIntent: null,
        expectingVariantForEntityId: null,
        presentedVariantOptions: null,
      } as any,
    };
  }

  if (pendingServiceChoice) {
    const variantOptions = variants
    .map((variant: any) => {
      const variantId = String(variant.id || "").trim();
      const label = String(variant.variant_name || "").trim();

      if (!variantId || !label) {
        return null;
      }

      return {
        kind: "variant" as const,
        serviceId,
        variantId,
        label,
        serviceName: selectedServiceName || null,
        variantName: label,
      };
    })
    .filter(
      (
        option
      ): option is {
        kind: "variant";
        serviceId: string;
        variantId: string;
        label: string;
        serviceName: string | null;
        variantName: string;
      } => option !== null
    );

    if (variantOptions.length > 1) {
      return {
        handled: true,
        reply: "",
        source: "catalog_disambiguation_db",
        intent: "variant_choice",
        catalogPayload: {
          kind: "variant_choice",
          originalIntent: pendingServiceChoice.originalIntent || "info_servicio",
          serviceId,
          serviceName: selectedServiceName || null,
          options: variantOptions,
        },
        ctxPatch: {
          expectingVariant: true,
          expectedVariantIntent:
            pendingServiceChoice.originalIntent || "info_servicio",
          expectingVariantForEntityId: serviceId,

          selectedServiceId: serviceId,

          last_service_id: serviceId,
          last_service_name: selectedServiceName || null,
          last_service_at: Date.now(),

          pendingCatalogChoice: {
            kind: "variant_choice",
            originalIntent: pendingServiceChoice.originalIntent || "info_servicio",
            serviceId,
            serviceName: selectedServiceName || null,
            options: variantOptions,
            createdAt: Date.now(),
          },
          pendingCatalogChoiceAt: Date.now(),

          presentedVariantOptions: variantOptions.map((option, idx) => ({
            variantId: option.variantId,
            label: option.label,
            index: idx + 1,
          })),

          last_variant_options: variantOptions.map((option, idx) => ({
            index: idx + 1,
            id: option.variantId,
            variantId: option.variantId,
            variant_name: option.label,
            label: option.label,
          })),
          last_variant_options_at: Date.now(),

          last_bot_action: "catalog_variant_choice_pending",
          last_bot_action_at: Date.now(),
          lastResolvedIntent: "variant_choice",
        } as any,
      };
    }
  }

  const resolvedVariantId = resolveVariantIdFromUserInput({
    userInput: input.userInput,
    numericSelectionIndex,
    targetVariantId: String(targetVariantId || "").trim() || null,
    presentedVariantOptions,
    dbVariants: variants.map((v: any) => ({
      id: String(v.id || "").trim(),
      variant_name:
        v.variant_name === null || v.variant_name === undefined
          ? null
          : String(v.variant_name),
    })),
  });

  if (!resolvedVariantId) {
    return {
      handled: false,
    };
  }

  const chosen =
    variants.find((v: any) => String(v.id || "") === resolvedVariantId) || null;

  if (!chosen) {
    return {
      handled: false,
    };
  }

  const {
    rows: [service],
  } = await input.pool.query<any>(
    `
    SELECT
      name,
      description,
      service_url
    FROM services
    WHERE id = $1
    LIMIT 1
    `,
    [serviceId]
  );

  const descSource = String(
    chosen.description || service?.description || ""
  ).trim();

  const link: string | null = chosen.variant_url
    ? String(chosen.variant_url).trim()
    : service?.service_url
    ? String(service.service_url).trim()
    : null;

  const baseName =
    String(service?.name || selectedServiceName || "").trim();

  const variantName = String(chosen.variant_name || "").trim();

  if (askedPriceVariant) {
    const priceNum =
      chosen.price === null || chosen.price === undefined || chosen.price === ""
        ? null
        : Number(chosen.price);

    const currency = String(chosen.currency || "USD").trim();

    let priceText =
      input.idiomaDestino === "en"
        ? "price available"
        : "precio disponible";

    if (Number.isFinite(priceNum)) {
      priceText =
        currency === "USD"
          ? `$${priceNum!.toFixed(2)}`
          : `${priceNum!.toFixed(2)} ${currency}`;
    }

    const reply =
      `${baseName} — ${variantName}\n• ${priceText}${link ? `\n${link}` : ""}`.trim();

    return {
      handled: true,
      reply,
      source: "price_fastpath_db",
      intent: resolvedVariantTurnIntent,
      ctxPatch: {
        expectingVariant: false,
        expectedVariantIntent: null,
        expectingVariantForEntityId: null,
        presentedVariantOptions: null,
        pendingCatalogChoice: null,
        pendingCatalogChoiceAt: null,

        lastResolvedIntent: resolvedVariantTurnIntent,

        selectedServiceId: serviceId,

        last_service_id: serviceId,
        last_service_name: baseName || null,
        last_service_at: Date.now(),

        last_variant_id: String(chosen.id || ""),
        last_variant_name: variantName || null,
        last_variant_url: link || null,
        last_variant_at: Date.now(),

        last_price_option_label: variantName || null,
        last_price_option_at: Date.now(),

        last_bot_action: "answered_price_variant",
        last_bot_action_at: Date.now(),
      } as any,
    };
  }

  const title =
    baseName && variantName
      ? `${baseName} — ${variantName}`
      : baseName || variantName || "";

  const bulletLines = splitLines(descSource).map((line) => `• ${line}`);
  const bullets = bulletLines.join("\n");

  const canonicalParts: string[] = [];

  if (title) {
    canonicalParts.push(title);
  }

  if (bullets) {
    canonicalParts.push(bullets);
  }

  if (link) {
    canonicalParts.push(link);
  }

  const finalReply = canonicalParts.join("\n\n").trim();

  console.log("[VARIANT_SECOND_TURN][CHOSEN]", {
    userInput: input.userInput,
    serviceId,
    chosenVariantId: chosen?.id,
    chosenVariantName: chosen?.variant_name,
    resolvedVariantTurnIntent,
  });

  return {
    handled: true,
    reply: finalReply,
    source: "catalog_db",
    intent: resolvedVariantTurnIntent,
    ctxPatch: {
      expectingVariant: false,
      expectedVariantIntent: null,
      expectingVariantForEntityId: null,
      presentedVariantOptions: null,
      pendingCatalogChoice: null,
      pendingCatalogChoiceAt: null,

      lastResolvedIntent: resolvedVariantTurnIntent,

      selectedServiceId: serviceId,

      last_service_id: serviceId,
      last_service_name: baseName || null,
      last_service_at: Date.now(),

      last_variant_id: String(chosen.id || ""),
      last_variant_name: variantName || null,
      last_variant_url: link || null,
      last_variant_at: Date.now(),

      last_price_option_label: variantName || null,
      last_price_option_at: Date.now(),
    } as any,
  };
}