//src/lib/fastpath/handlers/catalog/handleVariantSecondTurn.ts
import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";
import {
  formatMoneyAmount,
  toNullableMoneyNumber,
} from "./helpers/catalogMoneyFormat";

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

type VariantChoiceOption = {
  kind: "variant";
  serviceId: string;
  variantId: string;
  label: string;
  serviceName: string | null;
  variantName: string;
  price: number | null;
  currency: string;
  displayPrice: string;
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

  return parseSingleDigitSelection(value) !== null;
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

function tokenizeChoiceText(value: unknown): string[] {
  return normalizeChoiceText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function getChoiceTokenOverlapScore(inputText: string, candidateText: string): number {
  const inputTokens = Array.from(new Set(tokenizeChoiceText(inputText)));
  const candidateTokens = new Set(tokenizeChoiceText(candidateText));

  if (!inputTokens.length || !candidateTokens.size) {
    return 0;
  }

  const overlap = inputTokens.filter((token) => candidateTokens.has(token)).length;

  return overlap / inputTokens.length;
}

function getChoiceTokenSet(value: unknown): Set<string> {
  return new Set(tokenizeChoiceText(value));
}

type VariantSelectionTextCandidate = {
  variantId: string;
  label: string;
  source: "presented" | "pending" | "db";
};

type VariantSelectionResolution = {
  variantId: string;
  reason:
    | "exact_presented"
    | "exact_pending"
    | "exact_db"
    | "high_text_overlap"
    | "bounded_unique_token";
  score: number;
  evidenceTokens: string[];
};

function buildVariantSelectionTextCandidates(params: {
  pendingVariantChoice: PendingVariantChoice | null;
  presentedVariantOptions: PresentedVariantOption[];
  dbVariants: Array<{ id: string; variant_name: string | null }>;
}): VariantSelectionTextCandidate[] {
  const candidates: VariantSelectionTextCandidate[] = [];

  for (const item of params.presentedVariantOptions) {
    const variantId = String(item.variantId || "").trim();
    const label = String(item.label || "").trim();

    if (variantId && label) {
      candidates.push({
        variantId,
        label,
        source: "presented",
      });
    }
  }

  for (const item of params.pendingVariantChoice?.options || []) {
    const variantId = String(item.variantId || "").trim();
    const label = String(item.label || "").trim();

    if (variantId && label) {
      candidates.push({
        variantId,
        label,
        source: "pending",
      });
    }

    const variantName = String(item.variantName || "").trim();

    if (variantId && variantName && normalizeChoiceText(variantName) !== normalizeChoiceText(label)) {
      candidates.push({
        variantId,
        label: variantName,
        source: "pending",
      });
    }
  }

  for (const item of params.dbVariants) {
    const variantId = String(item.id || "").trim();
    const label = String(item.variant_name || "").trim();

    if (variantId && label) {
      candidates.push({
        variantId,
        label,
        source: "db",
      });
    }
  }

  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${candidate.variantId}::${normalizeChoiceText(candidate.label)}::${candidate.source}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function resolveTextualVariantSelection(params: {
  userInput: string;
  pendingVariantChoice: PendingVariantChoice | null;
  presentedVariantOptions: PresentedVariantOption[];
  dbVariants: Array<{ id: string; variant_name: string | null }>;
}): VariantSelectionResolution | null {
  const userNorm = normalizeChoiceText(params.userInput);
  const userTokens = Array.from(getChoiceTokenSet(params.userInput));

  if (!userNorm || userTokens.length < 2) {
    return null;
  }

  const candidates = buildVariantSelectionTextCandidates({
    pendingVariantChoice: params.pendingVariantChoice,
    presentedVariantOptions: params.presentedVariantOptions,
    dbVariants: params.dbVariants,
  });

  if (!candidates.length) {
    return null;
  }

  for (const candidate of candidates) {
    if (normalizeChoiceText(candidate.label) !== userNorm) {
      continue;
    }

    const reason =
      candidate.source === "presented"
        ? "exact_presented"
        : candidate.source === "pending"
        ? "exact_pending"
        : "exact_db";

    return {
      variantId: candidate.variantId,
      reason,
      score: 1,
      evidenceTokens: userTokens,
    };
  }

  const variantIds = Array.from(
    new Set(candidates.map((candidate) => candidate.variantId).filter(Boolean))
  );

  if (variantIds.length < 2) {
    return null;
  }

  const tokensByVariant = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const current = tokensByVariant.get(candidate.variantId) || new Set<string>();

    for (const token of tokenizeChoiceText(candidate.label)) {
      current.add(token);
    }

    tokensByVariant.set(candidate.variantId, current);
  }

  const tokenVariantCount = new Map<string, number>();

  for (const tokenSet of tokensByVariant.values()) {
    for (const token of tokenSet) {
      tokenVariantCount.set(token, (tokenVariantCount.get(token) || 0) + 1);
    }
  }

  const groupedScores = variantIds
    .map((variantId) => {
      const tokenSet = tokensByVariant.get(variantId) || new Set<string>();
      const evidenceTokens = userTokens.filter((token) => tokenSet.has(token));
      const uniqueEvidenceTokens = evidenceTokens.filter(
        (token) => tokenVariantCount.get(token) === 1
      );

      const bestLabelScore = candidates
        .filter((candidate) => candidate.variantId === variantId)
        .reduce((best, candidate) => {
          const score = getChoiceTokenOverlapScore(params.userInput, candidate.label);
          return score > best ? score : best;
        }, 0);

      return {
        variantId,
        score: bestLabelScore,
        evidenceTokens,
        uniqueEvidenceTokens,
      };
    })
    .filter((item) => item.evidenceTokens.length > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.uniqueEvidenceTokens.length - a.uniqueEvidenceTokens.length;
    });

  const best = groupedScores[0] || null;
  const second = groupedScores[1] || null;

  if (!best) {
    return null;
  }

  const minHighOverlapScore = 2 / 3;

  if (
    best.score >= minHighOverlapScore &&
    (!second || best.score - second.score >= 0.2)
  ) {
    return {
      variantId: best.variantId,
      reason: "high_text_overlap",
      score: best.score,
      evidenceTokens: best.evidenceTokens,
    };
  }

  const variantsWithUniqueEvidence = groupedScores.filter(
    (item) => item.uniqueEvidenceTokens.length > 0
  );

  if (
    variantsWithUniqueEvidence.length === 1 &&
    variantsWithUniqueEvidence[0].variantId === best.variantId
  ) {
    return {
      variantId: best.variantId,
      reason: "bounded_unique_token",
      score: best.score,
      evidenceTokens: variantsWithUniqueEvidence[0].uniqueEvidenceTokens,
    };
  }

  return null;
}

function looksLikeTextualVariantSelection(input: {
  userInput: string;
  pendingVariantChoice: PendingVariantChoice | null;
  presentedVariantOptions: PresentedVariantOption[];
}): boolean {
  const userTokens = tokenizeChoiceText(input.userInput);

  if (userTokens.length < 2) {
    return false;
  }

  const candidateLabels = [
    ...(input.pendingVariantChoice?.options || []).map((option) => option.label),
    ...input.presentedVariantOptions.map((option) => option.label),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!candidateLabels.length) {
    return false;
  }

  const scored = candidateLabels
    .map((label) => ({
      label,
      score: getChoiceTokenOverlapScore(input.userInput, label),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return false;
  }

  const best = scored[0];
  const second = scored[1] || null;

  return best.score >= 0.67 && (!second || best.score - second.score >= 0.25);
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
    serviceName?: string | null;
    variantName?: string | null;
  }> = Array.isArray(pending.options) ? pending.options : [];

  const options = rawOptions
    .map((item) => {
      const variantId = String(item?.variantId || "").trim() || null;
      const label = String(item?.label || "").trim() || null;
      const variantName = String(item?.variantName || "").trim() || null;
      const serviceName = String(item?.serviceName || "").trim() || null;

      if (!variantId || !label) {
        return null;
      }

      return {
        kind: "variant" as const,
        serviceId,
        variantId,
        label,
        serviceName,
        variantName,
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
        serviceName: string | null;
        variantName: string | null;
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
  pendingVariantChoice: PendingVariantChoice | null;
  presentedVariantOptions: PresentedVariantOption[];
  dbVariants: Array<{ id: string; variant_name: string | null }>;
}): string | null {
  if (params.numericSelectionIndex !== null) {
    const fromPendingChoice =
      params.pendingVariantChoice?.options?.[params.numericSelectionIndex - 1];

    if (fromPendingChoice?.variantId) {
      return String(fromPendingChoice.variantId).trim();
    }

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
      (item) =>
        String(item.id || "").trim() ===
        String(params.targetVariantId || "").trim()
    );

    if (targetExistsInCurrentService) {
      return String(params.targetVariantId || "").trim();
    }
  }

  const textualResolution = resolveTextualVariantSelection({
    userInput: params.userInput,
    pendingVariantChoice: params.pendingVariantChoice,
    presentedVariantOptions: params.presentedVariantOptions,
    dbVariants: params.dbVariants,
  });

  if (textualResolution?.variantId) {
    console.log("[VARIANT_SECOND_TURN][TEXT_SELECTION_RESOLVED]", {
      userInput: params.userInput,
      variantId: textualResolution.variantId,
      reason: textualResolution.reason,
      score: textualResolution.score,
      evidenceTokens: textualResolution.evidenceTokens,
    });

    return textualResolution.variantId;
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
  const presentedVariantOptions = getPresentedVariantOptions(input.convoCtx);
  const numericSelectionIndex = parseSingleDigitSelection(input.userInput);

  const isSelectionTurn =
    isExplicitVariantSelectionTurn(input.userInput) ||
    looksLikeTextualVariantSelection({
      userInput: input.userInput,
      pendingVariantChoice,
      presentedVariantOptions,
    });

  const selectedServiceOptionFromChoice =
    pendingServiceChoice && numericSelectionIndex !== null
      ? pendingServiceChoice.options[numericSelectionIndex - 1] ?? null
      : null;

  const selectedServiceId =
    String(
      selectedServiceOptionFromChoice?.serviceId ||
        pendingVariantChoice?.serviceId ||
        structuredTargetServiceId ||
        input.convoCtx?.selectedServiceId ||
        input.convoCtx?.last_service_id ||
        ""
    ).trim() || null;

  const selectedServiceName =
    String(
      selectedServiceOptionFromChoice?.serviceName ||
        selectedServiceOptionFromChoice?.label ||
        pendingVariantChoice?.serviceName ||
        input.convoCtx?.last_service_name ||
        ""
    ).trim() || null;

  const hasVariantSelectionContext =
    Boolean(input.convoCtx?.expectingVariant) ||
    Boolean(pendingServiceChoice) ||
    Boolean(pendingVariantChoice) ||
    presentedVariantOptions.length > 0;

  const canAttemptVariantResolution =
    Boolean(selectedServiceId) &&
    hasVariantSelectionContext &&
    (
      isSelectionTurn ||
      Boolean(pendingVariantChoice) ||
      presentedVariantOptions.length > 0
    );

  console.log("[VARIANT_SECOND_TURN][GATE]", {
    userInput: input.userInput,
    numericSelectionIndex,
    isSelectionTurn,
    hasVariantSelectionContext,
    hasPendingServiceChoice: Boolean(pendingServiceChoice),
    hasPendingVariantChoice: Boolean(pendingVariantChoice),
    presentedVariantOptionsCount: presentedVariantOptions.length,
    selectedServiceId,
    canAttemptVariantResolution,
  });

  if (!canAttemptVariantResolution) {
    return {
      handled: false,
    };
  }

  console.log("[VARIANT_SECOND_TURN][ENTRY]", {
    userInput: input.userInput,
    expectingVariant: input.convoCtx?.expectingVariant,
    numericSelectionIndex,
    selectedServiceOptionFromChoice,
    selectedServiceId,
    selectedServiceName,
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

  if (pendingServiceChoice && !pendingVariantChoice && numericSelectionIndex !== null) {
    const originalIntent = String(
      pendingServiceChoice.originalIntent || "info_servicio"
    )
      .trim()
      .toLowerCase();

    const shouldIncludePricesInVariantChoice =
      originalIntent === "precio" ||
      originalIntent === "price_or_plan" ||
      originalIntent === "combination_and_price";

    const variantOptions: VariantChoiceOption[] = variants.reduce(
      (acc: VariantChoiceOption[], variant: any) => {
        const variantId = String(variant.id || "").trim();
        const variantName = String(variant.variant_name || "").trim();

        if (!variantId || !variantName) {
          return acc;
        }

        const priceNum = toNullableMoneyNumber(variant.price);
        const currency = String(variant.currency || "USD").trim() || "USD";

        const displayPrice = formatMoneyAmount({
          amount: priceNum,
          currency,
          locale: input.idiomaDestino,
        });

        const label =
          shouldIncludePricesInVariantChoice && displayPrice
            ? `${variantName} — ${displayPrice}`
            : variantName;

        acc.push({
          kind: "variant",
          serviceId,
          variantId,
          label,
          serviceName: selectedServiceName || null,
          variantName,
          price: priceNum,
          currency,
          displayPrice,
        });

        return acc;
      },
      []
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
            variant_name: option.variantName,
            label: option.label,
            displayPrice: option.displayPrice,
            price: option.price,
            currency: option.currency,
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
    pendingVariantChoice,
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
    console.log("[VARIANT_SECOND_TURN][UNRESOLVED_SELECTION]", {
      userInput: input.userInput,
      serviceId,
      numericSelectionIndex,
      targetVariantId,
      pendingVariantChoice:
        pendingVariantChoice?.options?.map((opt) => ({
          variantId: opt.variantId,
          label: opt.label,
        })) ?? [],
      presentedVariantOptions,
      dbVariants: variants.map((v: any) => ({
        id: String(v.id || "").trim(),
        variant_name: String(v.variant_name || "").trim(),
      })),
    });

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

  const priceText = formatMoneyAmount({
    amount: toNullableMoneyNumber(chosen.price),
    currency: String(chosen.currency || "USD").trim() || "USD",
    locale: input.idiomaDestino,
  });

  const title =
    baseName && variantName
      ? `${baseName} — ${variantName}`
      : baseName || variantName || "";

  const bulletLines = splitLines(descSource).map((line) => {
    const cleaned = String(line || "")
      .trim()
      .replace(/^[-•*]\s*/, "");
    return `• ${cleaned}`;
  });

  const bullets = bulletLines.join("\n");

  const canonicalParts: string[] = [];

  if (title) {
    canonicalParts.push(title);
  }

  if (priceText) {
    canonicalParts.push(priceText);
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
    catalogPayload: {
      kind: "resolved_catalog_answer",
      scope: "variant",
      presentationMode: "full_detail",
      closingMode: "availability_statement",
      serviceId,
      serviceName: baseName || null,
      variantId: String(chosen.id || ""),
      variantName: variantName || null,
      canonicalBlocks: {
        servicesBlock: title || null,
        priceBlock: priceText || null,
        includesBlock: bullets || null,
        scheduleBlock: null,
        locationBlock: null,
        availabilityBlock: null,
        linkBlock: link || null,
      },
    },
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