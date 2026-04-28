//src/lib/fastpath/handlers/catalog/runCatalogFastpath.ts
import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogIntentFlags } from "./getCatalogIntentFlags";
import { getCatalogTurnState } from "./getCatalogTurnState";
import { handleSingleServiceCatalog } from "./handleSingleServiceCatalog";
import { handleCatalogComparison } from "./handleCatalogComparison";
import { resolveServiceCandidatesFromText } from "../../../services/pricing/resolveServiceIdFromText";
import { handleResolvedServiceDetail } from "./handleResolvedServiceDetail";
import { buildCatalogOverviewPriceBlock } from "./helpers/buildCatalogOverviewPriceBlock";
import {
  formatMoneyAmount,
  toNullableMoneyNumber,
} from "./helpers/catalogMoneyFormat";
import { handleFreeOffer } from "./handleFreeOffer";
import { handleInterestToLink } from "./handleInterestToLink";
import { resolveBestLinkForService } from "../../../links/resolveBestLinkForService";
import { getServiceDetailsText } from "../../../services/resolveServiceInfo";
import { getServiceAndVariantUrl } from "../../../services/getServiceAndVariantUrl";

type CatalogFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type CatalogServiceDisambiguationOption = {
  kind: "service";
  serviceId: string;
  variantId?: null;
  label: string;
  serviceName?: string | null;
};

type CatalogVariantDisambiguationOption = {
  kind: "variant";
  serviceId: string;
  variantId: string;
  label: string;
  serviceName?: string | null;
  variantName?: string | null;
  price?: number | null;
  currency?: string | null;
};

type CatalogDisambiguationOption =
  | CatalogServiceDisambiguationOption
  | CatalogVariantDisambiguationOption;

type PendingCatalogChoice =
  | {
      kind: "service_choice";
      originalIntent?: string | null;
      options: CatalogDisambiguationOption[];
      createdAt?: number | null;
    }
  | {
      kind: "variant_choice";
      originalIntent?: string | null;
      serviceId: string;
      serviceName?: string | null;
      options: CatalogDisambiguationOption[];
      createdAt?: number | null;
    };

function getPendingCatalogChoice(convoCtx: any): PendingCatalogChoice | null {
  const pending = convoCtx?.pendingCatalogChoice;

  if (!pending || (pending.kind !== "service_choice" && pending.kind !== "variant_choice")) {
    return null;
  }

  const options = normalizeCatalogDisambiguationOptions(pending.options);

  if (options.length < 2) {
    return null;
  }

  if (pending.kind === "variant_choice") {
    const serviceId = String(pending.serviceId || "").trim();

    if (!serviceId) {
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

function clearPendingCatalogChoiceCtxPatch() {
  return {
    pendingCatalogChoice: null,
    pendingCatalogChoiceAt: null,
  };
}

type PendingCatalogSelectionResolution =
  | { status: "none" }
  | { status: "unresolved" }
  | {
      status: "resolved";
      option: CatalogDisambiguationOption;
    };

function normalizePendingChoiceText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function resolvePendingCatalogChoiceSelection(input: {
  userInput: string;
  pendingCatalogChoice: PendingCatalogChoice | null;
}): PendingCatalogSelectionResolution {
  const pending = input.pendingCatalogChoice;

  if (!pending || !Array.isArray(pending.options) || pending.options.length === 0) {
    return { status: "none" };
  }

  const text = normalizePendingChoiceText(input.userInput);

  if (!text) {
    return { status: "unresolved" };
  }

  const numeric = Number(text);

  if (
    Number.isInteger(numeric) &&
    numeric >= 1 &&
    numeric <= pending.options.length
  ) {
    return {
      status: "resolved",
      option: pending.options[numeric - 1],
    };
  }

const tokenizedInput = normalizePendingChoiceText(input.userInput)
  .split(/\s+/)
  .map((part) => part.trim())
  .filter(Boolean);

const semanticMatches = pending.options.filter((option) => {
  const optionLabel = normalizePendingChoiceText(option.label);
  const optionVariantName =
    option.kind === "variant"
      ? normalizePendingChoiceText(option.variantName || "")
      : "";
  const optionServiceName = normalizePendingChoiceText(option.serviceName || "");

  const candidateTexts = [optionLabel, optionVariantName, optionServiceName]
    .map((value) => value.trim())
    .filter(Boolean);

  if (!candidateTexts.length) return false;

  if (candidateTexts.some((value) => value === text)) {
    return true;
  }

  if (candidateTexts.some((value) => text.includes(value))) {
    return true;
  }

  const inputTokensMatchAnyCandidate = candidateTexts.some((value) => {
    const candidateTokens = value
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (!candidateTokens.length) return false;

    return tokenizedInput.every((token) => candidateTokens.includes(token));
  });

  return inputTokensMatchAnyCandidate;
});

if (semanticMatches.length === 1) {
  return {
    status: "resolved",
    option: semanticMatches[0],
  };
}

  return { status: "unresolved" };
}

function shouldReusePendingCatalogChoice(params: {
  userInput: string;
  pendingCatalogChoice: PendingCatalogChoice | null;
  pendingCatalogSelection: PendingCatalogSelectionResolution;
  routeIntent: string;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
}): boolean {
  const {
    userInput,
    pendingCatalogChoice,
    pendingCatalogSelection,
    routeIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
  } = params;

  if (!pendingCatalogChoice) {
    return false;
  }

  if (pendingCatalogSelection.status === "resolved") {
    return true;
  }

  const normalized = String(userInput || "").trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  // Si el usuario hace una pregunta general nueva de catálogo,
  // no debemos reciclar una desambiguación vieja.
  const isFreshGenericCatalogTurn =
    pendingCatalogSelection.status === "unresolved" &&
    pendingCatalogChoice.kind === "service_choice" &&
    (
      routeIntent === "catalog_price" ||
      asksPrices === true ||
      asksIncludesOnly === true ||
      asksSchedules === true
    );

  if (isFreshGenericCatalogTurn) {
    return false;
  }

  return true;
}

function shouldScopeCanonicalResolutionToPendingChoice(params: {
  pendingCatalogChoice: PendingCatalogChoice | null;
  pendingCatalogSelection: PendingCatalogSelectionResolution;
  routeIntent: string;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
}): boolean {
  const {
    pendingCatalogChoice,
    pendingCatalogSelection,
    routeIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
  } = params;

  if (!pendingCatalogChoice) {
    return false;
  }

  // Solo permitimos scope por pending choice si el turno actual
  // realmente está resolviendo esa selección pendiente.
  if (pendingCatalogSelection.status === "resolved") {
    return true;
  }

  // Un turno nuevo de catálogo/precio/horario no debe quedar
  // limitado por una lista pendiente vieja.
  const isFreshCatalogQuestion =
    pendingCatalogSelection.status === "unresolved" &&
    (
      routeIntent === "catalog_price" ||
      routeIntent === "catalog_includes" ||
      asksPrices === true ||
      asksIncludesOnly === true ||
      asksSchedules === true
    );

  if (isFreshCatalogQuestion) {
    return false;
  }

  return false;
}

function normalizeCatalogDisambiguationOptions(
  raw: any
): CatalogDisambiguationOption[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const result: CatalogDisambiguationOption[] = [];

  for (const item of raw) {
    const rawKind = String(
      item?.kind || item?.candidateKind || ""
    ).trim().toLowerCase();

    const kind: "service" | "variant" =
      rawKind === "variant" ? "variant" : "service";

    if (kind === "variant") {
      const serviceId = String(item?.serviceId || item?.id || "").trim();
      const variantId = String(item?.variantId || "").trim();

      const serviceName = String(
        item?.serviceName ||
        item?.service_name ||
        ""
      ).trim();

      const rawLabel = String(
        item?.label ||
        item?.variantName ||
        item?.variant_name ||
        item?.name ||
        ""
      ).trim();

      const variantName = String(
        item?.variantName ||
        item?.variant_name ||
        item?.name ||
        rawLabel ||
        ""
      ).trim();

      if (!serviceId || !variantId || !variantName) {
        continue;
      }

      const dedupeKey = `${serviceId}::${variantId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      result.push({
        kind: "variant",
        serviceId,
        variantId,
        label: rawLabel || variantName,
        serviceName: serviceName || null,
        variantName,
      });

      continue;
    }

    const serviceId = String(
      item?.id ||
      item?.serviceId ||
      ""
    ).trim();

    const serviceName = String(
      item?.name ||
      item?.serviceName ||
      item?.service_name ||
      item?.label ||
      ""
    ).trim();

    if (!serviceId || !serviceName) {
      continue;
    }

    const dedupeKey = serviceId;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    result.push({
      kind: "service",
      serviceId,
      variantId: null,
      label: serviceName,
      serviceName,
    });
  }

  return result;
}

type CanonicalCatalogResolution =
  | {
      status: "resolved_single";
      serviceId: string;
      serviceName: string;
    }
  | {
      status: "ambiguous";
      options: CatalogDisambiguationOption[];
    }
  | {
      status: "not_found";
    };

function isExplicitCatalogQuestion(params: {
  routeIntent: string;
  intentOut: string;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
}): boolean {
  return (
    params.routeIntent === "catalog_price" ||
    params.routeIntent === "entity_detail" ||
    params.routeIntent === "variant_detail" ||
    params.routeIntent === "catalog_includes" ||
    params.routeIntent === "catalog_combination" ||
    params.routeIntent === "referential_followup" ||
    params.intentOut === "precio" ||
    params.intentOut === "planes_precios" ||
    (
      params.intentOut === "info_servicio" &&
      (
        params.routeIntent === "entity_detail" ||
        params.routeIntent === "variant_detail" ||
        params.asksIncludesOnly === true ||
        (
          params.asksSchedules === true &&
          params.routeIntent === "catalog_includes"
        )
      )
    ) ||
    params.intentOut === "combination_and_price" ||
    params.asksPrices === true ||
    params.asksIncludesOnly === true ||
    (
      params.asksSchedules === true &&
      (
        params.routeIntent === "catalog_price" ||
        params.intentOut === "planes_precios"
      )
    )
  );
}

function shouldTreatAsGenericServiceInterest(params: {
  intentOutNorm: string;
  routeIntent: string;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
  asksAvailability: boolean;
  hasPendingCatalogChoice: boolean;
  hasPendingSelectedVariant: boolean;
  hasTargetVariantId: boolean;
  hasIncomingCanonicalVariantAmbiguous: boolean;
}): boolean {
  const {
    intentOutNorm,
    routeIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
    asksAvailability,
    hasPendingCatalogChoice,
    hasPendingSelectedVariant,
    hasTargetVariantId,
    hasIncomingCanonicalVariantAmbiguous,
  } = params;

  if (intentOutNorm !== "info_servicio") {
    return false;
  }

  if (asksPrices || asksIncludesOnly || asksSchedules || asksAvailability) {
    return false;
  }

  if (
    routeIntent === "catalog_price" ||
    routeIntent === "variant_detail" ||
    routeIntent === "catalog_combination" ||
    routeIntent === "catalog_compare" ||
    routeIntent === "catalog_alternatives"
  ) {
    return false;
  }

  if (
    hasPendingCatalogChoice ||
    hasPendingSelectedVariant ||
    hasTargetVariantId ||
    hasIncomingCanonicalVariantAmbiguous
  ) {
    return false;
  }

  return true;
}

function shouldOpenVariantChoiceForTurn(params: {
  routeIntent: string;
  intentOutNorm: string;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
  asksAvailability: boolean;
  hasPendingCatalogChoice: boolean;
  hasPendingSelectedVariant: boolean;
  hasTargetVariantId: boolean;
  hasIncomingCanonicalVariantAmbiguous: boolean;
}): boolean {
  if (
    shouldTreatAsGenericServiceInterest({
      intentOutNorm: params.intentOutNorm,
      routeIntent: params.routeIntent,
      asksPrices: params.asksPrices,
      asksIncludesOnly: params.asksIncludesOnly,
      asksSchedules: params.asksSchedules,
      asksAvailability: params.asksAvailability,
      hasPendingCatalogChoice: params.hasPendingCatalogChoice,
      hasPendingSelectedVariant: params.hasPendingSelectedVariant,
      hasTargetVariantId: params.hasTargetVariantId,
      hasIncomingCanonicalVariantAmbiguous:
        params.hasIncomingCanonicalVariantAmbiguous,
    })
  ) {
    return false;
  }

  return shouldRequireVariantChoice({
    routeIntent: params.routeIntent,
    intentOutNorm: params.intentOutNorm,
    asksPrices: params.asksPrices,
    asksIncludesOnly: params.asksIncludesOnly,
    asksSchedules: params.asksSchedules,
    asksAvailability: params.asksAvailability,
    hasPendingCatalogChoice: params.hasPendingCatalogChoice,
    hasPendingSelectedVariant: params.hasPendingSelectedVariant,
    hasTargetVariantId: params.hasTargetVariantId,
    hasIncomingCanonicalVariantAmbiguous:
      params.hasIncomingCanonicalVariantAmbiguous,
  });
}

async function resolveCanonicalCatalogTarget(input: {
  pool: Pool;
  tenantId: string;
  userInput: string;
  allowedServiceIds?: string[] | null;
}): Promise<CanonicalCatalogResolution> {
  const scopedAllowedServiceIds = Array.isArray(input.allowedServiceIds)
    ? input.allowedServiceIds
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];

  const resolution = await resolveServiceCandidatesFromText(
    input.pool,
    input.tenantId,
    input.userInput,
    scopedAllowedServiceIds.length > 0
      ? {
          mode: "loose",
          allowedServiceIds: scopedAllowedServiceIds,
        }
      : {
          mode: "loose",
        }
  );

  if (resolution.kind === "resolved_single" && resolution.hit) {
    return {
      status: "resolved_single",
      serviceId: String(resolution.hit.id || "").trim(),
      serviceName: String(resolution.hit.name || "").trim(),
    };
  }

  if (resolution.kind === "ambiguous") {
    const options = normalizeCatalogDisambiguationOptions(
      resolution.candidates
    );

    if (options.length > 1) {
      return {
        status: "ambiguous",
        options,
      };
    }
  }

  return {
    status: "not_found",
  };
}

function shouldRequireVariantChoice(params: {
  routeIntent: string;
  intentOutNorm: string;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
  asksAvailability: boolean;
  hasPendingCatalogChoice: boolean;
  hasPendingSelectedVariant: boolean;
  hasTargetVariantId: boolean;
  hasIncomingCanonicalVariantAmbiguous: boolean;
}): boolean {
  if (
    shouldTreatAsGenericServiceInterest({
      intentOutNorm: params.intentOutNorm,
      routeIntent: params.routeIntent,
      asksPrices: params.asksPrices,
      asksIncludesOnly: params.asksIncludesOnly,
      asksSchedules: params.asksSchedules,
      asksAvailability: params.asksAvailability,
      hasPendingCatalogChoice: params.hasPendingCatalogChoice,
      hasPendingSelectedVariant: params.hasPendingSelectedVariant,
      hasTargetVariantId: params.hasTargetVariantId,
      hasIncomingCanonicalVariantAmbiguous:
        params.hasIncomingCanonicalVariantAmbiguous,
    })
  ) {
    return false;
  }

  // Una pregunta de horario NO debe abrir variant_choice por sí sola.
  // Solo abrimos variantes cuando el turno realmente exige selección de variante.
  return (
    params.routeIntent === "catalog_price" ||
    params.routeIntent === "catalog_includes" ||
    params.routeIntent === "variant_detail" ||
    params.asksPrices === true ||
    params.asksIncludesOnly === true ||
    params.hasPendingCatalogChoice === true ||
    params.hasPendingSelectedVariant === true ||
    params.hasTargetVariantId === true ||
    params.hasIncomingCanonicalVariantAmbiguous === true
  );
}

function shouldSkipVariantDisambiguation(params: {
  catalogRoutingSignal: any;
  pendingSelectedVariant:
    | {
        serviceId: string;
        serviceName: string | null;
        variantId: string;
        variantName: string | null;
      }
    | null;
}): boolean {
  const targetVariantId = String(
    params.catalogRoutingSignal?.targetVariantId || ""
  ).trim();

  if (targetVariantId) {
    return true;
  }

  if (params.pendingSelectedVariant?.variantId) {
    return true;
  }

  return false;
}

function resolveDisambiguationOriginalIntent(input: {
  intentOutNorm: string;
  routeIntent: string;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
}): "precio" | "info_servicio" {
  if (
    input.intentOutNorm === "precio" ||
    input.intentOutNorm === "planes_precios" ||
    input.routeIntent === "catalog_price" ||
    input.routeIntent === "catalog_alternatives" ||
    input.asksPrices === true
  ) {
    return "precio";
  }

  if (
    input.intentOutNorm === "info_servicio" ||
    input.routeIntent === "catalog_includes" ||
    input.routeIntent === "entity_detail" ||
    input.routeIntent === "variant_detail" ||
    input.asksIncludesOnly === true ||
    input.asksSchedules === true
  ) {
    return "info_servicio";
  }

  return "info_servicio";
}

async function getActiveVariantOptionsForService(input: {
  pool: Pool;
  serviceId: string;
  includePriceInLabel: boolean;
  idiomaDestino: string;
}): Promise<CatalogVariantDisambiguationOption[]> {
  const { rows } = await input.pool.query<{
    id: string;
    variant_name: string | null;
    service_name: string | null;
    price: number | string | null;
    currency: string | null;
  }>(
    `
    SELECT
      v.id,
      v.variant_name,
      s.name AS service_name,
      v.price,
      v.currency
    FROM service_variants v
    JOIN services s
      ON s.id = v.service_id
    WHERE v.service_id = $1
      AND v.active = true
      AND v.variant_name IS NOT NULL
      AND length(trim(v.variant_name)) > 0
    ORDER BY v.variant_name ASC, v.id ASC
    `,
    [input.serviceId]
  );

  const options: CatalogVariantDisambiguationOption[] = [];

  for (const row of rows) {
    const variantId = String(row.id || "").trim();
    const variantName = String(row.variant_name || "").trim();
    const serviceName = String(row.service_name || "").trim();
    const rawPrice = toNullableMoneyNumber(row.price);
    const currency = String(row.currency || "USD").trim() || "USD";

    if (!variantId || !variantName) {
      continue;
    }

    let label = variantName;

    if (input.includePriceInLabel) {
      const priceText = formatMoneyAmount({
        amount: rawPrice,
        currency,
        locale: input.idiomaDestino,
      });

      label = priceText ? `${variantName} — ${priceText}` : variantName;
    }

    options.push({
      kind: "variant",
      serviceId: input.serviceId,
      variantId,
      label,
      serviceName: serviceName || null,
      variantName: variantName || null,
      price: rawPrice,
      currency: currency || null,
    });
  }

  return options;
}

async function maybeBuildVariantDisambiguationResult(input: {
  pool: Pool;
  serviceId: string;
  serviceName: string;
  routeIntent: string;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
  asksAvailability: boolean;
  hasPendingCatalogChoice: boolean;
  hasPendingSelectedVariant: boolean;
  hasTargetVariantId: boolean;
  hasIncomingCanonicalVariantAmbiguous: boolean;
  originalIntent: "precio" | "info_servicio";
  idiomaDestino: string;
  forceSkip?: boolean;
}): Promise<FastpathResult | null> {
  if (
    !shouldRequireVariantChoice({
      routeIntent: input.routeIntent,
      intentOutNorm: input.originalIntent === "precio" ? "precio" : "info_servicio",
      asksPrices: input.asksPrices,
      asksIncludesOnly: input.asksIncludesOnly,
      asksSchedules: input.asksSchedules,
      asksAvailability: input.asksAvailability,
      hasPendingCatalogChoice: input.hasPendingCatalogChoice,
      hasPendingSelectedVariant: input.hasPendingSelectedVariant,
      hasTargetVariantId: input.hasTargetVariantId,
      hasIncomingCanonicalVariantAmbiguous:
        input.hasIncomingCanonicalVariantAmbiguous,
    })
  ) {
    return null;
  }

  if (input.forceSkip === true) {
    return null;
  }

  const variantOptions = await getActiveVariantOptionsForService({
    pool: input.pool,
    serviceId: input.serviceId,
    includePriceInLabel: input.originalIntent === "precio",
    idiomaDestino: input.idiomaDestino,
  });

  if (variantOptions.length <= 1) {
    return null;
  }

  return buildCatalogDisambiguationResult({
    routeIntent: input.routeIntent,
    kind: "variant_choice",
    options: variantOptions,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    originalIntent: input.originalIntent,
  });
}

function buildCatalogFamilyGuidedResult(input: {
  routeIntent: string;
  options: CatalogServiceDisambiguationOption[];
  originalIntent?: "precio" | "info_servicio" | null;
}): FastpathResult {
  const originalIntent =
    input.originalIntent ||
    (
      input.routeIntent === "catalog_price" ||
      input.routeIntent === "catalog_alternatives"
        ? "precio"
        : "info_servicio"
    );

  const now = Date.now();

  return {
    handled: true,
    reply: "",
    source: "catalog_disambiguation_db",
    intent: "catalog_family_guided",
    catalogPayload: {
      kind: "catalog_family_guided",
      originalIntent,
      options: input.options.map((option) => ({
        kind: "service" as const,
        serviceId: option.serviceId,
        label: option.label,
        serviceName: option.serviceName || option.label || null,
      })),
    },
    ctxPatch: {
      last_catalog_at: now,
      lastResolvedIntent: "catalog_family_guided",
      pendingCatalogChoiceAt: now,
      pendingCatalogChoice: {
        kind: "service_choice",
        originalIntent,
        options: input.options,
        createdAt: now,
      },
      lastPresentedEntityIds: input.options.map((option) => option.serviceId),
      catalogFamilyGuided: {
        kind: "catalog_family_guided",
        originalIntent,
        options: input.options,
        createdAt: now,
      },
    } as any,
  };
}

function buildCatalogDisambiguationResult(input: {
  routeIntent: string;
  kind: "service_choice" | "variant_choice";
  options: CatalogDisambiguationOption[];
  serviceId?: string | null;
  serviceName?: string | null;
  originalIntent?: "precio" | "info_servicio" | null;
}): FastpathResult {
  const originalIntent =
    input.originalIntent ||
    (
      input.routeIntent === "catalog_price" ||
      input.routeIntent === "catalog_alternatives"
        ? "precio"
        : "info_servicio"
    );

  const now = Date.now();

  const baseCtxPatch: any = {
    last_catalog_at: now,
    lastResolvedIntent: input.kind,
    pendingCatalogChoiceAt: now,
  };

  if (input.kind === "service_choice") {
    baseCtxPatch.lastPresentedEntityIds = input.options.map(
      (option) => option.serviceId
    );

    baseCtxPatch.pendingCatalogChoice = {
      kind: "service_choice",
      originalIntent,
      options: input.options,
      createdAt: now,
    };

    return {
      handled: true,
      reply: "",
      source: "catalog_disambiguation_db",
      intent: "service_choice",
      catalogPayload: {
        kind: "service_choice",
        originalIntent,
        options: input.options.map((option) => ({
          kind: "service",
          serviceId: option.serviceId,
          label: option.label,
          serviceName: option.serviceName || option.label || null,
        })),
      },
      ctxPatch: baseCtxPatch,
    };
  }

  const selectedServiceId = String(input.serviceId || "").trim();
  const selectedServiceName = String(input.serviceName || "").trim() || null;

  baseCtxPatch.pendingCatalogChoice = {
    kind: "variant_choice",
    originalIntent,
    serviceId: selectedServiceId,
    serviceName: selectedServiceName,
    options: input.options,
    createdAt: now,
  };

  baseCtxPatch.selectedServiceId = selectedServiceId || null;
  baseCtxPatch.last_service_id = selectedServiceId || null;
  baseCtxPatch.last_service_name = selectedServiceName;
  baseCtxPatch.last_service_at = now;
  baseCtxPatch.expectingVariant = true;
  baseCtxPatch.expectingVariantForEntityId = selectedServiceId || null;
  baseCtxPatch.expectedVariantIntent = originalIntent;

  baseCtxPatch.presentedVariantOptions = input.options
    .filter((option) => option.kind === "variant")
    .map((option, idx) => ({
      variantId: option.variantId,
      label: option.label,
      index: idx + 1,
    }));

  baseCtxPatch.last_variant_options = input.options
    .filter((option) => option.kind === "variant")
    .map((option, idx) => ({
      index: idx + 1,
      id: option.variantId,
      variantId: option.variantId,
      variant_name: option.variantName || option.label,
      label: option.label,
    }));

  baseCtxPatch.last_variant_options_at = now;

  return {
    handled: true,
    reply: "",
    source: "catalog_disambiguation_db",
    intent: "variant_choice",
    catalogPayload: {
      kind: "variant_choice",
      originalIntent,
      serviceId: selectedServiceId,
      serviceName: selectedServiceName,
      options: input.options
        .filter((option) => option.kind === "variant")
        .map((option) => ({
          kind: "variant" as const,
          serviceId: option.serviceId,
          variantId: option.variantId,
          label: option.label,
          serviceName: option.serviceName || selectedServiceName,
          variantName: option.variantName || option.label,
        })),
    },
    ctxPatch: baseCtxPatch,
  };
}

function countCatalogSignalsForTurn(input: {
  userInput: string;
  canonicalResolutionStatus?: string | null;
  canonicalOptionCount?: number;
  hasBookingSignal: boolean;
  hasFamilySignal: boolean;
  hasServiceSignal: boolean;
  hasVariantSignal: boolean;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
  asksAvailability: boolean;
}): number {
  const signals = new Set<string>();

  if (input.hasBookingSignal) {
    signals.add("booking");
  }

  if (input.hasFamilySignal) {
    signals.add("catalog_family");
  }

  if (input.hasServiceSignal) {
    signals.add("service");
  }

  if (input.hasVariantSignal) {
    signals.add("variant");
  }

  if (input.asksPrices) {
    signals.add("prices");
  }

  if (input.asksIncludesOnly) {
    signals.add("includes");
  }

  if (input.asksSchedules) {
    signals.add("schedules");
  }

  if (input.asksAvailability) {
    signals.add("availability");
  }

  if (
    input.canonicalResolutionStatus === "ambiguous" &&
    Number(input.canonicalOptionCount || 0) > 1
  ) {
    signals.add("multiple_catalog_candidates");
  }

  return signals.size;
}

function shouldTreatAsMultiCatalogQuestion(input: {
  userInput: string;
  intentOutNorm: string;
  routeIntent: string;
  canonicalResolutionStatus?: string | null;
  canonicalOptionCount?: number;
  hasFamilyStructuredCatalogTarget: boolean;
  hasServiceStructuredCatalogTarget: boolean;
  hasVariantStructuredCatalogTarget: boolean;
  asksPrices: boolean;
  asksIncludesOnly: boolean;
  asksSchedules: boolean;
  asksAvailability: boolean;
  wantsBooking: boolean;
}): boolean {
  const signalCount = countCatalogSignalsForTurn({
    userInput: input.userInput,
    canonicalResolutionStatus: input.canonicalResolutionStatus,
    canonicalOptionCount: input.canonicalOptionCount,
    hasBookingSignal:
      input.wantsBooking ||
      input.intentOutNorm === "reserva" ||
      input.intentOutNorm === "clase_prueba",
    hasFamilySignal: input.hasFamilyStructuredCatalogTarget,
    hasServiceSignal: input.hasServiceStructuredCatalogTarget,
    hasVariantSignal: input.hasVariantStructuredCatalogTarget,
    asksPrices: input.asksPrices,
    asksIncludesOnly: input.asksIncludesOnly,
    asksSchedules: input.asksSchedules,
    asksAvailability: input.asksAvailability,
  });

  return signalCount >= 2;
}

export type RunCatalogFastpathInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;

  intentOut?: string | null;
  detectedIntent?: string | null;
  infoClave?: string | null;

  commercial?: {
    wantsBooking?: boolean;
    wantsQuote?: boolean;
    purchaseIntent?: string | null;
    urgency?: string | null;
  } | null;

  hasStructuredTarget: boolean;

  catalogRoutingSignal: any;
  catalogReferenceClassification?: any;
  facets?: CatalogFacets | null;

  buildCatalogRoutingSignal: (input: {
    intentOut: string | null;
    catalogReferenceClassification?: any;
    convoCtx: any;
  }) => any;

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

  extractPlanNamesFromReply: (reply: string) => string[];

  canonicalCatalogResolution?: {
    resolutionKind: string;
    resolvedServiceId?: string | null;
    resolvedServiceName?: string | null;
    variantOptions?: Array<{
      variantId: string;
      variantName: string;
    }>;
  } | null;
};

function normalizeIncomingCanonicalResolution(input: {
  resolutionKind?: string | null;
  resolvedServiceId?: string | null;
  resolvedServiceName?: string | null;
  variantOptions?: Array<{
    variantId: string;
    variantName: string;
  }> | null;
} | null | undefined): {
  resolutionKind: "resolved_single" | "resolved_service_variant_ambiguous" | "ambiguous" | "none";
  resolvedServiceId: string | null;
  resolvedServiceName: string | null;
  variantOptions: Array<{
    variantId: string;
    variantName: string;
  }>;
} {
  const resolutionKindRaw = String(input?.resolutionKind || "").trim();

  const resolutionKind =
    resolutionKindRaw === "resolved_single" ||
    resolutionKindRaw === "resolved_service_variant_ambiguous" ||
    resolutionKindRaw === "ambiguous"
      ? resolutionKindRaw
      : "none";

  const resolvedServiceId =
    typeof input?.resolvedServiceId === "string" && input.resolvedServiceId.trim()
      ? input.resolvedServiceId.trim()
      : null;

  const resolvedServiceName =
    typeof input?.resolvedServiceName === "string" && input.resolvedServiceName.trim()
      ? input.resolvedServiceName.trim()
      : null;

  const variantOptions = Array.isArray(input?.variantOptions)
    ? input.variantOptions
        .map((item) => {
          const variantId =
            typeof item?.variantId === "string" && item.variantId.trim()
              ? item.variantId.trim()
              : null;

          const variantName =
            typeof item?.variantName === "string" && item.variantName.trim()
              ? item.variantName.trim()
              : null;

          if (!variantId || !variantName) return null;

          return {
            variantId,
            variantName,
          };
        })
        .filter(
          (
            item
          ): item is {
            variantId: string;
            variantName: string;
          } => Boolean(item)
        )
    : [];

  return {
    resolutionKind,
    resolvedServiceId,
    resolvedServiceName,
    variantOptions,
  };
}

export async function runCatalogFastpath(
  input: RunCatalogFastpathInput
): Promise<FastpathResult> {
  console.log("[RUN_CATALOG_FASTPATH_ENTRY]", {
    userInput: input.userInput,
  });

  const catalogRoutingSignal = input.catalogRoutingSignal;

  const incomingCanonicalResolution = normalizeIncomingCanonicalResolution(
    input.canonicalCatalogResolution || null
  );

  const hasIncomingCanonicalResolvedSingle =
    incomingCanonicalResolution.resolutionKind === "resolved_single" &&
    Boolean(incomingCanonicalResolution.resolvedServiceId);

  const hasIncomingCanonicalAmbiguous =
    incomingCanonicalResolution.resolutionKind === "ambiguous";

  const hasIncomingCanonicalVariantAmbiguous =
    incomingCanonicalResolution.resolutionKind === "resolved_service_variant_ambiguous" &&
    Boolean(incomingCanonicalResolution.resolvedServiceId);

  const pendingCatalogChoice = getPendingCatalogChoice(input.convoCtx);

  const pendingCatalogSelection = resolvePendingCatalogChoiceSelection({
    userInput: input.userInput,
    pendingCatalogChoice,
  });

  let pendingSelectedService:
    | {
        serviceId: string;
        serviceName: string | null;
      }
    | null = null;

  let pendingSelectedVariant:
    | {
        serviceId: string;
        serviceName: string | null;
        variantId: string;
        variantName: string | null;
      }
    | null = null;

  const pendingOriginalIntent = String(
    pendingCatalogChoice?.originalIntent || ""
  )
    .trim()
    .toLowerCase();

  const pendingRouteIntentOverride =
    pendingOriginalIntent === "precio"
      ? "catalog_price"
      : pendingOriginalIntent === "info_servicio"
      ? "catalog_includes"
      : "";

  if (pendingCatalogSelection.status === "resolved") {
    const selected = pendingCatalogSelection.option;

    if (selected.kind === "service") {
      pendingSelectedService = {
        serviceId: selected.serviceId,
        serviceName: selected.serviceName || selected.label || null,
      };
    } else {
      pendingSelectedVariant = {
        serviceId: selected.serviceId,
        serviceName: selected.serviceName || null,
        variantId: selected.variantId,
        variantName: selected.variantName || selected.label || null,
      };

      pendingSelectedService = {
        serviceId: selected.serviceId,
        serviceName: selected.serviceName || null,
      };
    }
  }

  if (
    pendingCatalogSelection.status === "resolved" &&
    pendingSelectedService &&
    !pendingSelectedVariant
  ) {
    const now = Date.now();

    console.log("[CATALOG][PENDING_SERVICE_CHOICE_RESOLVED]", {
      userInput: input.userInput,
      serviceId: pendingSelectedService.serviceId,
      serviceName: pendingSelectedService.serviceName,
      originalIntent: pendingOriginalIntent || null,
    });

    const resolvedServiceResult = await handleResolvedServiceDetail({
      pool: input.pool,
      userInput: input.userInput,
      idiomaDestino: input.idiomaDestino as any,
      intentOut:
        pendingOriginalIntent === "precio"
          ? "precio"
          : "info_servicio",
      hit: {
        id: pendingSelectedService.serviceId,
        name: pendingSelectedService.serviceName || "",
      },
      traducirMensaje: input.traducirTexto as any,
      convoCtx: {
        ...(input.convoCtx || {}),
        selectedServiceId: pendingSelectedService.serviceId,
        last_service_id: pendingSelectedService.serviceId,
        last_service_name: pendingSelectedService.serviceName || null,
      },
    });

    if (resolvedServiceResult.handled) {
      return {
        ...resolvedServiceResult,
        ctxPatch: {
          ...((resolvedServiceResult as any).ctxPatch || {}),
          ...clearPendingCatalogChoiceCtxPatch(),

          selectedServiceId: pendingSelectedService.serviceId,
          last_service_id: pendingSelectedService.serviceId,
          last_service_name: pendingSelectedService.serviceName || null,
          last_service_at: now,

          expectingVariant: false,
          expectingVariantForEntityId: null,
          expectedVariantIntent: null,
          presentedVariantOptions: null,
          last_variant_options: null,
          last_variant_options_at: null,

          lastResolvedIntent:
            pendingOriginalIntent === "precio"
              ? "price_or_plan"
              : "includes",
        },
      };
    }

    return {
      handled: false,
      ctxPatch: {
        ...clearPendingCatalogChoiceCtxPatch(),
        selectedServiceId: pendingSelectedService.serviceId,
        last_service_id: pendingSelectedService.serviceId,
        last_service_name: pendingSelectedService.serviceName || null,
        last_service_at: now,
      },
    };
  }

  const shouldForceResolvedVariant =
    shouldSkipVariantDisambiguation({
      catalogRoutingSignal,
      pendingSelectedVariant,
    });

  const rawRouteIntent = String(catalogRoutingSignal.routeIntent || "").trim();

  const shouldUsePendingRouteIntentOverride =
    Boolean(pendingCatalogChoice) &&
    Boolean(pendingRouteIntentOverride) &&
    (
      rawRouteIntent === "" ||
      rawRouteIntent === "referential_followup" ||
      rawRouteIntent === "entity_detail" ||
      rawRouteIntent === "variant_detail"
    );

  const routeIntent = shouldUsePendingRouteIntentOverride
    ? pendingRouteIntentOverride
    : rawRouteIntent;

  const routingReferenceKind = String(
    input.catalogReferenceClassification?.kind || "none"
  )
    .trim()
    .toLowerCase();

  const routingTargetServiceId = String(
    catalogRoutingSignal.targetServiceId || ""
  ).trim();

  const routingTargetServiceName = String(
    catalogRoutingSignal.targetServiceName || ""
  ).trim();

  const routingTargetVariantId = String(
    catalogRoutingSignal.targetVariantId || ""
  ).trim();

  const routingTargetVariantName = String(
    catalogRoutingSignal.targetVariantName || ""
  ).trim();

  const routingTargetFamilyKey = String(
    catalogRoutingSignal.targetFamilyKey || ""
  ).trim();

  const effectiveAuthority = pendingSelectedVariant
    ? {
        source: "pending_variant" as const,
        status: "resolved_single" as const,
        serviceId: pendingSelectedVariant.serviceId,
        serviceName: pendingSelectedVariant.serviceName || "",
        variantId: pendingSelectedVariant.variantId,
        variantName: pendingSelectedVariant.variantName || "",
        familyKey: "",
        referenceKind: "variant_specific",
      }
    : pendingSelectedService
    ? {
        source: "pending_service" as const,
        status: "resolved_single" as const,
        serviceId: pendingSelectedService.serviceId,
        serviceName: pendingSelectedService.serviceName || "",
        variantId: "",
        variantName: "",
        familyKey: "",
        referenceKind: "entity_specific",
      }
    : hasIncomingCanonicalVariantAmbiguous
    ? {
        source: "canonical_variant_ambiguous" as const,
        status: "resolved_service_variant_ambiguous" as const,
        serviceId: String(incomingCanonicalResolution.resolvedServiceId || "").trim(),
        serviceName: String(incomingCanonicalResolution.resolvedServiceName || "").trim(),
        variantId: "",
        variantName: "",
        familyKey: "",
        referenceKind: "entity_specific",
      }
    : hasIncomingCanonicalResolvedSingle
    ? {
        source: "canonical_single" as const,
        status: "resolved_single" as const,
        serviceId: String(incomingCanonicalResolution.resolvedServiceId || "").trim(),
        serviceName: String(incomingCanonicalResolution.resolvedServiceName || "").trim(),
        variantId: "",
        variantName: "",
        familyKey: "",
        referenceKind: "entity_specific",
      }
    : hasIncomingCanonicalAmbiguous
    ? {
        source: "canonical_ambiguous" as const,
        status: "ambiguous" as const,
        serviceId: "",
        serviceName: "",
        variantId: "",
        variantName: "",
        familyKey: "canonical_ambiguous_family",
        referenceKind: "catalog_family",
      }
    : routingTargetVariantId && routingTargetServiceId
    ? {
        source: "routing_variant" as const,
        status: "resolved_single" as const,
        serviceId: routingTargetServiceId,
        serviceName: routingTargetServiceName,
        variantId: routingTargetVariantId,
        variantName: routingTargetVariantName,
        familyKey: "",
        referenceKind: "variant_specific",
      }
    : routingTargetServiceId
    ? {
        source: "routing_service" as const,
        status: "resolved_single" as const,
        serviceId: routingTargetServiceId,
        serviceName: routingTargetServiceName,
        variantId: "",
        variantName: "",
        familyKey: "",
        referenceKind: "entity_specific",
      }
    : routingTargetFamilyKey || routingReferenceKind === "catalog_family"
    ? {
        source: "routing_family" as const,
        status: "ambiguous" as const,
        serviceId: "",
        serviceName: "",
        variantId: "",
        variantName: "",
        familyKey: routingTargetFamilyKey || "canonical_ambiguous_family",
        referenceKind: "catalog_family",
      }
    : {
        source: "none" as const,
        status: "not_found" as const,
        serviceId: "",
        serviceName: "",
        variantId: "",
        variantName: "",
        familyKey: "",
        referenceKind: routingReferenceKind || "none",
      };

  const structuredTargetServiceId = effectiveAuthority.serviceId;
  const structuredTargetServiceName = effectiveAuthority.serviceName;
  const structuredTargetVariantId = effectiveAuthority.variantId;
  const structuredTargetFamilyKey = effectiveAuthority.familyKey;
  const referenceKind = effectiveAuthority.referenceKind;

  const executionRouteIntent =
    routeIntent === "referential_followup" && structuredTargetServiceId
      ? "entity_detail"
      : routeIntent;

  console.log("[CATALOG][ROUTING_SIGNAL]", {
    userInput: input.userInput,
    intentOut: input.intentOut,
    facets: input.facets || {},
    signal: {
      shouldRouteCatalog: catalogRoutingSignal.shouldRouteCatalog,
      rawRouteIntent: String(catalogRoutingSignal.routeIntent || "").trim(),
      effectiveRouteIntent: routeIntent,
      routeIntent: catalogRoutingSignal.routeIntent,
      referenceKind: catalogRoutingSignal.referenceKind,
      source: catalogRoutingSignal.source,
      allowsDbCatalogPath: catalogRoutingSignal.allowsDbCatalogPath,
      hasFreshCatalogContext: catalogRoutingSignal.hasFreshCatalogContext,
      previousCatalogPlans: catalogRoutingSignal.previousCatalogPlans,
      targetServiceId: catalogRoutingSignal.targetServiceId,
      targetServiceName: catalogRoutingSignal.targetServiceName,
      targetVariantId: catalogRoutingSignal.targetVariantId,
      targetVariantName: catalogRoutingSignal.targetVariantName,
      targetFamilyKey: catalogRoutingSignal.targetFamilyKey,
      targetFamilyName: catalogRoutingSignal.targetFamilyName,
      targetLevel: catalogRoutingSignal.targetLevel,
      disambiguationType: catalogRoutingSignal.disambiguationType,
      anchorShift: catalogRoutingSignal.anchorShift,
    },
  });

  const {
    isCombinationIntent,
    asksIncludesOnly,
    isAskingOtherCatalogOptions,
    asksSchedules,
    asksPrices,
  } = getCatalogIntentFlags({
    routeIntent: executionRouteIntent,
    facets: input.facets || {},
  });

  void isCombinationIntent;
  void isAskingOtherCatalogOptions;

  const {
    hasRecentCatalogContext,
    intentAllowsCatalogRouting,
    isCatalogPriceLikeTurn,
    hasStructuredCatalogState,
    isCatalogQuestion,
  } = getCatalogTurnState({
    catalogRoutingSignal,
    convoCtx: input.convoCtx,
    hasStructuredTarget: input.hasStructuredTarget,
  });

  void hasRecentCatalogContext;
  void hasStructuredCatalogState;

  const targetServiceId = structuredTargetServiceId;
  const targetVariantId = structuredTargetVariantId;
  const targetFamilyKey = structuredTargetFamilyKey;

  const isStructuredComparisonTurn =
    routeIntent === "catalog_compare";

  const hasServiceStructuredCatalogTarget =
    !isStructuredComparisonTurn &&
    Boolean(targetServiceId);

  const hasVariantStructuredCatalogTarget =
    !isStructuredComparisonTurn &&
    Boolean(targetVariantId);

  const hasFamilyStructuredCatalogTarget =
    !isStructuredComparisonTurn &&
    Boolean(targetFamilyKey);

  const hasAnyStructuredCatalogTarget =
    hasServiceStructuredCatalogTarget ||
    hasVariantStructuredCatalogTarget ||
    hasFamilyStructuredCatalogTarget;

  const intentOutNorm = String(input.intentOut || "").trim().toLowerCase();

  console.log("[CATALOG][INTENT_NORM_DEBUG]", {
    userInput: input.userInput,
    inputIntentOut: input.intentOut ?? null,
    inputDetectedIntent: input.detectedIntent ?? null,
    intentOutNorm,
  });

  const isGenericCatalogOverviewByIntent =
    !hasAnyStructuredCatalogTarget &&
    (
      effectiveAuthority.referenceKind === "none" ||
      effectiveAuthority.referenceKind === "catalog_overview"
    ) &&
    (
      intentOutNorm === "precio" ||
      intentOutNorm === "planes_precios" ||
      asksPrices === true
    ) &&
    asksIncludesOnly !== true &&
    asksSchedules !== true;

  const hasExplicitCatalogRouting =
    catalogRoutingSignal.shouldRouteCatalog === true ||
    referenceKind === "catalog_overview" ||
    referenceKind === "catalog_family";

  const hasExplicitCatalogIntent =
    intentOutNorm === "catalogo" ||
    intentOutNorm === "catalog";

  const disambiguationOriginalIntent = resolveDisambiguationOriginalIntent({
    intentOutNorm,
    routeIntent: executionRouteIntent || routeIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
  });

  const isGenericServiceInterestTurn = shouldTreatAsGenericServiceInterest({
    intentOutNorm,
    routeIntent: executionRouteIntent || routeIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
    asksAvailability: Boolean(input.facets?.asksAvailability),
    hasPendingCatalogChoice: Boolean(pendingCatalogChoice),
    hasPendingSelectedVariant: Boolean(pendingSelectedVariant),
    hasTargetVariantId: Boolean(targetVariantId),
    hasIncomingCanonicalVariantAmbiguous,
  });

  const shouldOpenVariantChoice = shouldOpenVariantChoiceForTurn({
    intentOutNorm,
    routeIntent: executionRouteIntent || routeIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
    asksAvailability: Boolean(input.facets?.asksAvailability),
    hasPendingCatalogChoice: Boolean(pendingCatalogChoice),
    hasPendingSelectedVariant: Boolean(pendingSelectedVariant),
    hasTargetVariantId: Boolean(targetVariantId),
    hasIncomingCanonicalVariantAmbiguous,
  });

  console.log("[CATALOG][VARIANT_CHOICE_GATE_DEBUG]", {
    userInput: input.userInput,
    intentOutNorm,
    routeIntent: executionRouteIntent || routeIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
    asksAvailability: Boolean(input.facets?.asksAvailability),
    hasPendingCatalogChoice: Boolean(pendingCatalogChoice),
    hasPendingSelectedVariant: Boolean(pendingSelectedVariant),
    hasTargetVariantId: Boolean(targetVariantId),
    hasIncomingCanonicalVariantAmbiguous,
    isGenericServiceInterestTurn,
    shouldOpenVariantChoice,
  });

  console.log("[CATALOG][GENERIC_SERVICE_INTEREST_GUARD]", {
    userInput: input.userInput,
    intentOutNorm,
    routeIntent,
    executionRouteIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
    asksAvailability: Boolean(input.facets?.asksAvailability),
    hasPendingCatalogChoice: Boolean(pendingCatalogChoice),
    hasPendingSelectedVariant: Boolean(pendingSelectedVariant),
    hasTargetVariantId: Boolean(targetVariantId),
    hasIncomingCanonicalVariantAmbiguous,
    isGenericServiceInterestTurn,
  });

  type QuestionType =
    | "multi_catalog_question"
    | "combination_and_price"
    | "price_or_plan"
    | "schedule_and_price"
    | "other_plans";

  const shouldForceServiceChoiceFromFamilyAmbiguity =
    referenceKind === "catalog_family" &&
    targetFamilyKey === "canonical_ambiguous_family" &&
    (
      executionRouteIntent === "catalog_includes" ||
      executionRouteIntent === "catalog_price" ||
      executionRouteIntent === "entity_detail" ||
      intentOutNorm === "info_general" ||
      intentOutNorm === "info_servicio" ||
      intentOutNorm === "precio"
    );

  const isGenericCatalogOverviewTurn =
    referenceKind === "catalog_overview" &&
    !targetServiceId &&
    !targetVariantId &&
    !targetFamilyKey;

  if (shouldForceServiceChoiceFromFamilyAmbiguity && !isGenericCatalogOverviewTurn) {
    const familyResolution = await resolveServiceCandidatesFromText(
      input.pool,
      input.tenantId,
      input.userInput,
      { mode: "loose" }
    );

    if (familyResolution.kind === "ambiguous") {
      const normalizedOptions = normalizeCatalogDisambiguationOptions(
        familyResolution.candidates
      );

      const serviceOptions = normalizedOptions.filter(
        (option): option is CatalogServiceDisambiguationOption =>
          option.kind === "service"
      );

      if (serviceOptions.length > 1) {
        const shouldUseGuidedFamilyMode =
          intentOutNorm === "info_general" ||
          intentOutNorm === "info_servicio" ||
          executionRouteIntent === "catalog_includes" ||
          executionRouteIntent === "entity_detail";

        if (shouldUseGuidedFamilyMode) {
          return buildCatalogFamilyGuidedResult({
            routeIntent: executionRouteIntent || routeIntent,
            options: serviceOptions,
            originalIntent: disambiguationOriginalIntent,
          });
        }

        return buildCatalogDisambiguationResult({
          routeIntent: executionRouteIntent || routeIntent,
          kind: "service_choice",
          options: serviceOptions,
          originalIntent: disambiguationOriginalIntent,
        });
      }
    }
  }

  const hasActivePendingChoiceForThisTurn =
    shouldReusePendingCatalogChoice({
      userInput: input.userInput,
      pendingCatalogChoice,
      pendingCatalogSelection,
      routeIntent,
      asksPrices,
      asksIncludesOnly,
      asksSchedules,
    });

  const hasCatalogEntitySignal =
    hasActivePendingChoiceForThisTurn ||
    hasServiceStructuredCatalogTarget ||
    hasVariantStructuredCatalogTarget ||
    hasFamilyStructuredCatalogTarget;

  const hasFacetDrivenCatalogIntent =
    asksPrices === true;

  const allowGenericCatalogDbFallback =
    !hasAnyStructuredCatalogTarget &&
    (
      referenceKind === "catalog_overview" ||
      executionRouteIntent === "catalog_overview" ||
      isGenericCatalogOverviewByIntent
    );

  const shouldResolveExplicitCatalogTarget =
    !isGenericCatalogOverviewByIntent &&
    isExplicitCatalogQuestion({
      routeIntent: executionRouteIntent,
      intentOut: intentOutNorm,
      asksPrices,
      asksIncludesOnly,
      asksSchedules,
    });

  const shouldResolveCanonicalTargetEarly =
    shouldResolveExplicitCatalogTarget &&
    !isGenericCatalogOverviewByIntent &&
    !hasFamilyStructuredCatalogTarget &&
    !isStructuredComparisonTurn;

  const isGenericCatalogPriceOverviewTurn =
    executionRouteIntent === "catalog_price" &&
    referenceKind === "catalog_overview" &&
    !hasAnyStructuredCatalogTarget;

  const shouldNeverSilenceCatalogTurn =
    catalogRoutingSignal.shouldRouteCatalog === true &&
    (
      hasAnyStructuredCatalogTarget ||
      referenceKind === "catalog_overview" ||
      executionRouteIntent === "catalog_overview"
    );

  let canonicalCatalogResolution: CanonicalCatalogResolution | null =
    effectiveAuthority.status === "resolved_single" &&
    effectiveAuthority.serviceId
      ? {
          status: "resolved_single",
          serviceId: effectiveAuthority.serviceId,
          serviceName: effectiveAuthority.serviceName || "",
        }
      : effectiveAuthority.status === "ambiguous"
      ? {
          status: "ambiguous",
          options: [],
        }
      : null;

  const shouldScopeCanonicalResolution =
    shouldScopeCanonicalResolutionToPendingChoice({
      pendingCatalogChoice,
      pendingCatalogSelection,
      routeIntent,
      asksPrices,
      asksIncludesOnly,
      asksSchedules,
    });

  const canonicalResolutionAllowedServiceIds =
    shouldScopeCanonicalResolution && pendingCatalogChoice
      ? pendingCatalogChoice.options.map((option) => option.serviceId)
      : null;

  if (
    effectiveAuthority.source === "none" &&
    shouldResolveCanonicalTargetEarly
  ) {
    canonicalCatalogResolution = await resolveCanonicalCatalogTarget({
      pool: input.pool,
      tenantId: input.tenantId,
      userInput: input.userInput,
      allowedServiceIds: canonicalResolutionAllowedServiceIds,
    });

    if (canonicalCatalogResolution.status === "ambiguous") {
      // No retornamos todavía.
      // Primero dejamos que questionType decida si es multi_catalog_question,
      // service_choice normal o variant_choice.
    }
  }

  // ===============================
  // ✅ INTEREST → LINK — dentro del dominio catálogo
  // ===============================
  // Solo corre si no es pregunta múltiple ni ambigüedad de catálogo.
  {
    const shouldAllowInterestToLink =
      canonicalCatalogResolution?.status !== "ambiguous" &&
      referenceKind !== "catalog_family";

    if (shouldAllowInterestToLink) {
      const interestToLinkResult = await handleInterestToLink({
        pool: input.pool,
        tenantId: input.tenantId,
        userInput: input.userInput,
        idiomaDestino: input.idiomaDestino as any,
        detectedIntent: input.detectedIntent,
        intentOut: input.intentOut || null,
        catalogReferenceClassification: input.catalogReferenceClassification,
        convoCtx: input.convoCtx,
        buildCatalogRoutingSignal: input.buildCatalogRoutingSignal,
        resolveBestLinkForService,
        getServiceDetailsText,
        getServiceAndVariantUrl,
      });

      if (interestToLinkResult.handled) {
        return interestToLinkResult;
      }
    }
  }

  let questionType: QuestionType;

  const canonicalOptionCount =
    canonicalCatalogResolution?.status === "ambiguous"
      ? canonicalCatalogResolution.options.length
      : 0;

  const isMultiCatalogQuestion = shouldTreatAsMultiCatalogQuestion({
    userInput: input.userInput,
    intentOutNorm,
    routeIntent: executionRouteIntent || routeIntent,
    canonicalResolutionStatus: canonicalCatalogResolution?.status || null,
    canonicalOptionCount,
    hasFamilyStructuredCatalogTarget,
    hasServiceStructuredCatalogTarget,
    hasVariantStructuredCatalogTarget,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
    asksAvailability: Boolean(input.facets?.asksAvailability),
    wantsBooking: Boolean(input.commercial?.wantsBooking),
  });

  if (isMultiCatalogQuestion) {
    questionType = "multi_catalog_question";
  } else if (executionRouteIntent === "catalog_combination") {
    questionType = "combination_and_price";
  } else if (executionRouteIntent === "catalog_alternatives") {
    questionType = "other_plans";
  } else if (asksSchedules && asksPrices) {
    questionType = "schedule_and_price";
  } else {
    questionType = "price_or_plan";
  }

  if (isCatalogPriceLikeTurn) {
    console.log("🚫 BLOCK LLM PRICING — forcing DB path");
  }

  const shouldReusePendingChoice = shouldReusePendingCatalogChoice({
    userInput: input.userInput,
    pendingCatalogChoice,
    pendingCatalogSelection,
    routeIntent,
    asksPrices,
    asksIncludesOnly,
    asksSchedules,
  });

  if (
    pendingCatalogChoice &&
    pendingCatalogSelection.status === "unresolved" &&
    shouldReusePendingChoice
  ) {
    return buildCatalogDisambiguationResult({
      routeIntent:
        pendingCatalogChoice.originalIntent === "precio"
          ? "catalog_price"
          : "catalog_includes",
      kind: pendingCatalogChoice.kind,
      options: pendingCatalogChoice.options,
      serviceId:
        pendingCatalogChoice.kind === "variant_choice"
          ? pendingCatalogChoice.serviceId
          : null,
      serviceName:
        pendingCatalogChoice.kind === "variant_choice"
          ? pendingCatalogChoice.serviceName || null
          : null,
      originalIntent:
        pendingCatalogChoice.originalIntent === "precio"
          ? "precio"
          : "info_servicio",
    });
  }

  if (
    pendingCatalogChoice &&
    pendingCatalogSelection.status === "unresolved" &&
    !shouldReusePendingChoice
  ) {
    // El usuario hizo una nueva pregunta general.
    // No reciclamos la desambiguación anterior.
  }

  if (!isCatalogQuestion && !hasFacetDrivenCatalogIntent) {
    return {
      handled: false,
    };
  }

  if (executionRouteIntent === "catalog_overview" && intentAllowsCatalogRouting) {
    console.log("[CATALOG_OVERVIEW][RUN_FASTPATH]", {
      userInput: input.userInput,
      questionType,
      detectedIntent: input.detectedIntent,
      catalogReferenceKind: input.catalogReferenceClassification?.kind ?? "none",
      routeIntent,
      facets: input.facets || {},
    });
  }

  if (executionRouteIntent === "catalog_family" && intentAllowsCatalogRouting) {
    console.log("[CATALOG_FAMILY][RUN_FASTPATH]", {
      userInput: input.userInput,
      questionType,
      detectedIntent: input.detectedIntent,
      catalogReferenceKind: input.catalogReferenceClassification?.kind ?? "none",
      routeIntent,
      facets: input.facets || {},
    });
  }

  const now = Date.now();
  const prevNames = Array.isArray(input.convoCtx?.last_catalog_plans)
    ? input.convoCtx.last_catalog_plans
    : [];
  const prevAtRaw = input.convoCtx?.last_catalog_at;
  const prevAt = Number(prevAtRaw);

  const prevFresh =
    prevNames.length > 0 &&
    Number.isFinite(prevAt) &&
    prevAt > 0 &&
    now - prevAt <= 30 * 60 * 1000;

  if (questionType === "multi_catalog_question") {
    if (canonicalCatalogResolution?.status === "ambiguous") {
      const normalizedOptions = normalizeCatalogDisambiguationOptions(
        canonicalCatalogResolution.options
      );

      const serviceOptions = normalizedOptions.filter(
        (option): option is CatalogServiceDisambiguationOption =>
          option.kind === "service"
      );

      if (serviceOptions.length > 1) {
        return buildCatalogFamilyGuidedResult({
          routeIntent: executionRouteIntent || routeIntent,
          options: serviceOptions,
          originalIntent: disambiguationOriginalIntent,
        });
      }

      const variantOptions = normalizedOptions.filter(
        (option): option is CatalogVariantDisambiguationOption =>
          option.kind === "variant"
      );

      const variantServiceIds = Array.from(
        new Set(variantOptions.map((option) => option.serviceId))
      );

      if (variantOptions.length > 1 && variantServiceIds.length === 1) {
        const serviceId = variantServiceIds[0];
        const serviceName =
          variantOptions.find((option) => option.serviceId === serviceId)
            ?.serviceName || null;

        return buildCatalogDisambiguationResult({
          routeIntent: executionRouteIntent || routeIntent,
          kind: "variant_choice",
          options: variantOptions,
          serviceId,
          serviceName,
          originalIntent: disambiguationOriginalIntent,
        });
      }
    }

    if (hasFamilyStructuredCatalogTarget) {
      const familyResolution = await resolveServiceCandidatesFromText(
        input.pool,
        input.tenantId,
        input.userInput,
        { mode: "loose" }
      );

      if (familyResolution.kind === "ambiguous") {
        const normalizedOptions = normalizeCatalogDisambiguationOptions(
          familyResolution.candidates
        );

        const serviceOptions = normalizedOptions.filter(
          (option): option is CatalogServiceDisambiguationOption =>
            option.kind === "service"
        );

        if (serviceOptions.length > 1) {
          return buildCatalogFamilyGuidedResult({
            routeIntent: executionRouteIntent || routeIntent,
            options: serviceOptions,
            originalIntent: disambiguationOriginalIntent,
          });
        }
      }
    }

    console.log("[CATALOG][MULTI_QUESTION_UNRESOLVED_FALLBACK]", {
      userInput: input.userInput,
      canonicalStatus: canonicalCatalogResolution?.status || null,
      routeIntent: executionRouteIntent || routeIntent,
    });
  }

  if (executionRouteIntent === "catalog_includes" || executionRouteIntent === "entity_detail") {
    if (canonicalCatalogResolution?.status === "resolved_single") {
            if (isGenericServiceInterestTurn) {
        const { rows } = await input.pool.query<{
          service_id: string;
          service_name: string;
          min_price: number | string | null;
          max_price: number | string | null;
          parent_service_id: string | null;
          category: string | null;
          catalog_role: string | null;
        }>(
          `
          WITH variant_prices AS (
            SELECT
              s.id AS service_id,
              s.name AS service_name,
              s.parent_service_id,
              s.category,
              s.catalog_role,
              MIN(v.price)::numeric AS min_price,
              MAX(v.price)::numeric AS max_price
            FROM services s
            JOIN service_variants v
              ON v.service_id = s.id
             AND v.active = true
            WHERE s.tenant_id = $1
              AND s.active = true
              AND v.price IS NOT NULL
            GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
          ),
          base_prices AS (
            SELECT
              s.id AS service_id,
              s.name AS service_name,
              s.parent_service_id,
              s.category,
              s.catalog_role,
              MIN(s.price_base)::numeric AS min_price,
              MAX(s.price_base)::numeric AS max_price
            FROM services s
            WHERE s.tenant_id = $1
              AND s.active = true
              AND s.price_base IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM service_variants v
                WHERE v.service_id = s.id
                  AND v.active = true
                  AND v.price IS NOT NULL
              )
            GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
          )
          SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role
          FROM (
            SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM variant_prices
            UNION ALL
            SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM base_prices
          ) x;
          `,
          [input.tenantId]
        );

        const resolvedRoutingSignal = {
          ...catalogRoutingSignal,
          targetServiceId:
            pendingSelectedVariant?.serviceId || canonicalCatalogResolution.serviceId,
          targetServiceName:
            pendingSelectedVariant?.serviceName || canonicalCatalogResolution.serviceName,
          targetVariantId: null,
          targetVariantName: null,
          targetFamilyKey: null,
          targetFamilyName: null,
          targetLevel: "service",
          disambiguationType: "none",
        };

        const singleServiceCatalogResult = await handleSingleServiceCatalog({
          pool: input.pool,
          tenantId: input.tenantId,
          userInput: input.userInput,
          idiomaDestino: input.idiomaDestino,
          convoCtx: input.convoCtx,
          routeIntent: executionRouteIntent,
          catalogRoutingSignal: resolvedRoutingSignal,
          catalogReferenceClassification: input.catalogReferenceClassification,
          asksPrices,
          asksSchedules,
          asksLocation: Boolean(input.facets?.asksLocation),
          asksAvailability: Boolean(input.facets?.asksAvailability),
          rows,
          catalogRouteIntent: executionRouteIntent,
        });

        if (singleServiceCatalogResult.handled) {
          return {
            ...singleServiceCatalogResult,
            ctxPatch: {
              ...(singleServiceCatalogResult.ctxPatch || {}),
              ...clearPendingCatalogChoiceCtxPatch(),
            },
          };
        }

        const resolvedServiceDetailResult = await handleResolvedServiceDetail({
          pool: input.pool,
          userInput: input.userInput,
          idiomaDestino: input.idiomaDestino,
          intentOut: input.intentOut || "info_servicio",
          hit: {
            serviceId:
              pendingSelectedVariant?.serviceId ||
              canonicalCatalogResolution.serviceId,
            id:
              pendingSelectedVariant?.serviceId ||
              canonicalCatalogResolution.serviceId,
          },
          traducirMensaje: async (texto: string) => texto,
          convoCtx: input.convoCtx,
          asksPrices,
          asksSchedules,
          asksLocation: Boolean(input.facets?.asksLocation),
          asksAvailability: Boolean(input.facets?.asksAvailability),
        });

        if (resolvedServiceDetailResult.handled) {
          return {
            ...resolvedServiceDetailResult,
            ctxPatch: {
              ...(resolvedServiceDetailResult.ctxPatch || {}),
              ...clearPendingCatalogChoiceCtxPatch(),
            },
          };
        }

        return {
          handled: false,
        };
      }

      const canonicalVariantOptions = Array.isArray(
        input.canonicalCatalogResolution?.variantOptions
      )
        ? input.canonicalCatalogResolution!.variantOptions
            .map((item) => ({
              kind: "variant" as const,
              serviceId: canonicalCatalogResolution.serviceId,
              variantId: String(item.variantId || "").trim(),
              label: String(item.variantName || "").trim(),
              serviceName: canonicalCatalogResolution.serviceName || null,
              variantName: String(item.variantName || "").trim(),
            }))
            .filter((item) => item.variantId && item.label)
        : [];

      const shouldForceCanonicalVariantChoice =
        shouldOpenVariantChoice &&
        String(input.canonicalCatalogResolution?.resolutionKind || "") ===
          "resolved_service_variant_ambiguous" &&
        canonicalVariantOptions.length > 1;

      if (shouldForceCanonicalVariantChoice) {
        return buildCatalogDisambiguationResult({
          routeIntent: executionRouteIntent || routeIntent,
          kind: "variant_choice",
          options: canonicalVariantOptions,
          serviceId: canonicalCatalogResolution.serviceId,
          serviceName: canonicalCatalogResolution.serviceName,
          originalIntent: disambiguationOriginalIntent,
        });
      }

      if (!shouldForceResolvedVariant && shouldOpenVariantChoice) {
        const variantDisambiguationResult =
          await maybeBuildVariantDisambiguationResult({
            pool: input.pool,
            serviceId: canonicalCatalogResolution.serviceId,
            serviceName: canonicalCatalogResolution.serviceName,
            routeIntent,
            asksPrices,
            asksIncludesOnly,
            asksSchedules,
            asksAvailability: Boolean(input.facets?.asksAvailability),
            hasPendingCatalogChoice: Boolean(pendingCatalogChoice),
            hasPendingSelectedVariant: Boolean(pendingSelectedVariant),
            hasTargetVariantId: Boolean(targetVariantId),
            hasIncomingCanonicalVariantAmbiguous,
            originalIntent: disambiguationOriginalIntent,
            idiomaDestino: input.idiomaDestino,
            forceSkip: !shouldOpenVariantChoice,
          });

        if (variantDisambiguationResult) {
          return variantDisambiguationResult;
        }
      }

      const { rows } = await input.pool.query<{
        service_id: string;
        service_name: string;
        min_price: number | string | null;
        max_price: number | string | null;
        parent_service_id: string | null;
        category: string | null;
        catalog_role: string | null;
      }>(
        `
        WITH variant_prices AS (
          SELECT
            s.id AS service_id,
            s.name AS service_name,
            s.parent_service_id,
            s.category,
            s.catalog_role,
            MIN(v.price)::numeric AS min_price,
            MAX(v.price)::numeric AS max_price
          FROM services s
          JOIN service_variants v
            ON v.service_id = s.id
          AND v.active = true
          WHERE s.tenant_id = $1
            AND s.active = true
            AND v.price IS NOT NULL
          GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
        ),
        base_prices AS (
          SELECT
            s.id AS service_id,
            s.name AS service_name,
            s.parent_service_id,
            s.category,
            s.catalog_role,
            MIN(s.price_base)::numeric AS min_price,
            MAX(s.price_base)::numeric AS max_price
          FROM services s
          WHERE s.tenant_id = $1
            AND s.active = true
            AND s.price_base IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM service_variants v
              WHERE v.service_id = s.id
                AND v.active = true
                AND v.price IS NOT NULL
            )
          GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
        )
        SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role
        FROM (
          SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM variant_prices
          UNION ALL
          SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM base_prices
        ) x;
        `,
        [input.tenantId]
      );

      const resolvedRoutingSignal = {
        ...catalogRoutingSignal,
        targetServiceId:
          pendingSelectedVariant?.serviceId || canonicalCatalogResolution.serviceId,
        targetServiceName:
          pendingSelectedVariant?.serviceName || canonicalCatalogResolution.serviceName,
        targetVariantId: pendingSelectedVariant?.variantId || null,
        targetVariantName: pendingSelectedVariant?.variantName || null,
        targetFamilyKey: null,
        targetFamilyName: null,
        targetLevel: pendingSelectedVariant ? "variant" : "service",
        disambiguationType: "none",
      };

      const singleServiceCatalogResult = await handleSingleServiceCatalog({
        pool: input.pool,
        tenantId: input.tenantId,
        userInput: input.userInput,
        idiomaDestino: input.idiomaDestino,
        convoCtx: input.convoCtx,
        routeIntent: executionRouteIntent,
        catalogRoutingSignal: resolvedRoutingSignal,
        catalogReferenceClassification: input.catalogReferenceClassification,
        asksPrices,
        asksSchedules,
        asksLocation: Boolean(input.facets?.asksLocation),
        asksAvailability: Boolean(input.facets?.asksAvailability),
        rows,
        catalogRouteIntent: executionRouteIntent,
      });

      if (singleServiceCatalogResult.handled) {
        return {
          ...singleServiceCatalogResult,
          ctxPatch: {
            ...(singleServiceCatalogResult.ctxPatch || {}),
            ...clearPendingCatalogChoiceCtxPatch(),
          },
        };
      }

      const resolvedServiceDetailResult = await handleResolvedServiceDetail({
        pool: input.pool,
        userInput: input.userInput,
        idiomaDestino: input.idiomaDestino,
        intentOut: input.intentOut || "info_servicio",
        hit: {
          serviceId:
            pendingSelectedVariant?.serviceId ||
            canonicalCatalogResolution.serviceId,
          id:
            pendingSelectedVariant?.serviceId ||
            canonicalCatalogResolution.serviceId,
        },
        traducirMensaje: async (texto: string) => texto,
        convoCtx: input.convoCtx,
        asksPrices,
        asksSchedules,
        asksLocation: Boolean(input.facets?.asksLocation),
        asksAvailability: Boolean(input.facets?.asksAvailability),
      });

      if (resolvedServiceDetailResult.handled) {
        return {
          ...resolvedServiceDetailResult,
          ctxPatch: {
            ...(resolvedServiceDetailResult.ctxPatch || {}),
            ...clearPendingCatalogChoiceCtxPatch(),
          },
        };
      }
    }

    return {
      handled: false,
    };
  }

  // ===============================
  // ✅ FREE OFFER — subordinado al plan de catálogo
  // ===============================
  // No puede correr antes de multi_catalog_question.
  // Solo aplica cuando NO hay múltiples candidatos de catálogo.
  {
    const shouldAllowGenericFreeOfferHandler =
      !hasAnyStructuredCatalogTarget &&
      canonicalCatalogResolution?.status !== "ambiguous" &&
      intentOutNorm === "clase_prueba";

    if (shouldAllowGenericFreeOfferHandler) {
      const freeOfferResult = await handleFreeOffer({
        pool: input.pool,
        tenantId: input.tenantId,
        idiomaDestino: input.idiomaDestino as any,
        detectedIntent: input.detectedIntent,
        catalogReferenceClassification: input.catalogReferenceClassification,
        convoCtx: input.convoCtx,
      });

      if (freeOfferResult.handled) {
        return freeOfferResult;
      }
    }
  }

  // PRICE OR PLAN
  if (!asksSchedules && !asksIncludesOnly && questionType === "price_or_plan") {
    const { rows, priceBlock } = await buildCatalogOverviewPriceBlock({
      pool: input.pool,
      tenantId: input.tenantId,
      idiomaDestino: input.idiomaDestino,
      normalizeCatalogRole: input.normalizeCatalogRole,
      traducirTexto: input.traducirTexto,
      renderGenericPriceSummaryReply: input.renderGenericPriceSummaryReply,
    });

    if (isStructuredComparisonTurn) {
      const comparisonResult = await handleCatalogComparison({
        pool: input.pool,
        tenantId: input.tenantId,
        userInput: input.userInput,
        idiomaDestino: input.idiomaDestino,
        catalogReferenceClassification: input.catalogReferenceClassification,
      });

      if (comparisonResult.handled) {
        return {
          ...comparisonResult,
          ctxPatch: {
            ...(comparisonResult.ctxPatch || {}),
            ...clearPendingCatalogChoiceCtxPatch(),
          },
        };
      }

      return {
        handled: false,
      };
    }

    if (canonicalCatalogResolution?.status === "resolved_single") {
      const canonicalVariantOptions = await getActiveVariantOptionsForService({
        pool: input.pool,
        serviceId: canonicalCatalogResolution.serviceId,
        includePriceInLabel: disambiguationOriginalIntent === "precio",
        idiomaDestino: input.idiomaDestino,
      });

      const shouldForceCanonicalVariantChoice =
        shouldOpenVariantChoice &&
        String(input.canonicalCatalogResolution?.resolutionKind || "") ===
          "resolved_service_variant_ambiguous" &&
        canonicalVariantOptions.length > 1;

      if (shouldForceCanonicalVariantChoice) {
        return buildCatalogDisambiguationResult({
          routeIntent: executionRouteIntent || routeIntent,
          kind: "variant_choice",
          options: canonicalVariantOptions,
          serviceId: canonicalCatalogResolution.serviceId,
          serviceName: canonicalCatalogResolution.serviceName,
          originalIntent: disambiguationOriginalIntent,
        });
      }

      if (!shouldForceResolvedVariant && shouldOpenVariantChoice) {
        const variantDisambiguationResult =
          await maybeBuildVariantDisambiguationResult({
            pool: input.pool,
            serviceId: canonicalCatalogResolution.serviceId,
            serviceName: canonicalCatalogResolution.serviceName,
            routeIntent,
            asksPrices,
            asksIncludesOnly,
            asksSchedules,
            asksAvailability: Boolean(input.facets?.asksAvailability),
            hasPendingCatalogChoice: Boolean(pendingCatalogChoice),
            hasPendingSelectedVariant: Boolean(pendingSelectedVariant),
            hasTargetVariantId: Boolean(targetVariantId),
            hasIncomingCanonicalVariantAmbiguous,
            originalIntent: disambiguationOriginalIntent,
            idiomaDestino: input.idiomaDestino,
            forceSkip: !shouldOpenVariantChoice,
          });

        if (variantDisambiguationResult) {
          return variantDisambiguationResult;
        }
      }

      const resolvedRoutingSignal = {
        ...catalogRoutingSignal,
        targetServiceId:
          pendingSelectedVariant?.serviceId || canonicalCatalogResolution.serviceId,
        targetServiceName:
          pendingSelectedVariant?.serviceName || canonicalCatalogResolution.serviceName,
        targetVariantId: pendingSelectedVariant?.variantId || null,
        targetVariantName: pendingSelectedVariant?.variantName || null,
        targetFamilyKey: null,
        targetFamilyName: null,
        targetLevel: pendingSelectedVariant ? "variant" : "service",
        disambiguationType: "none",
      };

      const singleServiceCatalogResult = await handleSingleServiceCatalog({
        pool: input.pool,
        tenantId: input.tenantId,
        userInput: input.userInput,
        idiomaDestino: input.idiomaDestino,
        convoCtx: input.convoCtx,
        routeIntent: executionRouteIntent,
        catalogRoutingSignal: resolvedRoutingSignal,
        catalogReferenceClassification: input.catalogReferenceClassification,
        asksPrices,
        asksSchedules,
        asksLocation: Boolean(input.facets?.asksLocation),
        asksAvailability: Boolean(input.facets?.asksAvailability),
        rows,
        catalogRouteIntent: executionRouteIntent,
      });

      if (singleServiceCatalogResult.handled) {
        return {
          ...singleServiceCatalogResult,
          ctxPatch: {
            ...(singleServiceCatalogResult.ctxPatch || {}),
            ...clearPendingCatalogChoiceCtxPatch(),
          },
        };
      }

      const resolvedServiceDetailResult = await handleResolvedServiceDetail({
        pool: input.pool,
        userInput: input.userInput,
        idiomaDestino: input.idiomaDestino,
        intentOut: input.intentOut || "precio",
        hit: {
          serviceId:
            pendingSelectedVariant?.serviceId ||
            canonicalCatalogResolution.serviceId,
          id:
            pendingSelectedVariant?.serviceId ||
            canonicalCatalogResolution.serviceId,
        },
        traducirMensaje: async (texto: string) => texto,
        convoCtx: input.convoCtx,
        asksPrices,
        asksSchedules,
        asksLocation: Boolean(input.facets?.asksLocation),
        asksAvailability: Boolean(input.facets?.asksAvailability),
      });

      if (resolvedServiceDetailResult.handled) {
        return {
          ...resolvedServiceDetailResult,
          ctxPatch: {
            ...(resolvedServiceDetailResult.ctxPatch || {}),
            ...clearPendingCatalogChoiceCtxPatch(),
          },
        };
      }

      return {
        handled: false,
      };
    }

    if (
      shouldResolveExplicitCatalogTarget &&
      canonicalCatalogResolution?.status === "not_found" &&
      !isGenericCatalogPriceOverviewTurn
    ) {
      return {
        handled: false,
      };
    }

    if (!allowGenericCatalogDbFallback) {
      return {
        handled: false,
      };
    }

    const canonicalReply = priceBlock;
    const namesShown = input.extractPlanNamesFromReply(priceBlock);
    const finalReply = canonicalReply;

    const ctxPatch: any = {
      last_catalog_at: Date.now(),
      lastResolvedIntent: "price_or_plan",
      pendingCatalogChoice: null,
      pendingCatalogChoiceAt: null,
    };

    if (namesShown.length) {
      ctxPatch.last_catalog_plans = namesShown;
    }

    return {
      handled: true,
      reply: finalReply,
      source: "catalog_db",
      intent: "precio",
      catalogPayload: {
        kind: "resolved_catalog_answer",
        scope: "overview",
        canonicalBlocks: {
          priceBlock: priceBlock || null,
        },
      },
      ctxPatch,
    };
  }

  // SCHEDULE + PRICE
  // Este archivo ya no responde business info general desde info_clave.
  // Si el turno mezcla horario + precio, solo seguimos por catálogo
  // cuando hay target concreto resuelto desde DB.
  if (questionType === "schedule_and_price") {
    const { rows } = await buildCatalogOverviewPriceBlock({
      pool: input.pool,
      tenantId: input.tenantId,
      idiomaDestino: input.idiomaDestino,
      normalizeCatalogRole: input.normalizeCatalogRole,
      traducirTexto: input.traducirTexto,
      renderGenericPriceSummaryReply: input.renderGenericPriceSummaryReply,
    });

    if (canonicalCatalogResolution?.status === "resolved_single") {
      const canonicalVariantOptions = await getActiveVariantOptionsForService({
        pool: input.pool,
        serviceId: canonicalCatalogResolution.serviceId,
        includePriceInLabel: disambiguationOriginalIntent === "precio",
        idiomaDestino: input.idiomaDestino,
      });

      const shouldForceCanonicalVariantChoice =
        shouldOpenVariantChoice &&
        String(input.canonicalCatalogResolution?.resolutionKind || "") ===
          "resolved_service_variant_ambiguous" &&
        canonicalVariantOptions.length > 1;

      if (shouldForceCanonicalVariantChoice) {
        return buildCatalogDisambiguationResult({
          routeIntent: executionRouteIntent || routeIntent,
          kind: "variant_choice",
          options: canonicalVariantOptions,
          serviceId: canonicalCatalogResolution.serviceId,
          serviceName: canonicalCatalogResolution.serviceName,
          originalIntent: disambiguationOriginalIntent,
        });
      }

      if (!shouldForceResolvedVariant && shouldOpenVariantChoice) {
        const variantDisambiguationResult =
          await maybeBuildVariantDisambiguationResult({
            pool: input.pool,
            serviceId: canonicalCatalogResolution.serviceId,
            serviceName: canonicalCatalogResolution.serviceName,
            routeIntent,
            asksPrices,
            asksIncludesOnly,
            asksSchedules,
            asksAvailability: Boolean(input.facets?.asksAvailability),
            hasPendingCatalogChoice: Boolean(pendingCatalogChoice),
            hasPendingSelectedVariant: Boolean(pendingSelectedVariant),
            hasTargetVariantId: Boolean(targetVariantId),
            hasIncomingCanonicalVariantAmbiguous,
            originalIntent: disambiguationOriginalIntent,
            idiomaDestino: input.idiomaDestino,
            forceSkip: !shouldOpenVariantChoice,
          });

        if (variantDisambiguationResult) {
          return variantDisambiguationResult;
        }
      }

      const resolvedRoutingSignal = {
        ...catalogRoutingSignal,
        targetServiceId:
          pendingSelectedVariant?.serviceId || canonicalCatalogResolution.serviceId,
        targetServiceName:
          pendingSelectedVariant?.serviceName || canonicalCatalogResolution.serviceName,
        targetVariantId: pendingSelectedVariant?.variantId || null,
        targetVariantName: pendingSelectedVariant?.variantName || null,
        targetFamilyKey: null,
        targetFamilyName: null,
        targetLevel: pendingSelectedVariant ? "variant" : "service",
        disambiguationType: "none",
      };

      const singleServiceCatalogResult = await handleSingleServiceCatalog({
        pool: input.pool,
        tenantId: input.tenantId,
        userInput: input.userInput,
        idiomaDestino: input.idiomaDestino,
        convoCtx: input.convoCtx,
        routeIntent: executionRouteIntent,
        catalogRoutingSignal: resolvedRoutingSignal,
        catalogReferenceClassification: input.catalogReferenceClassification,
        asksPrices,
        asksSchedules,
        asksLocation: Boolean(input.facets?.asksLocation),
        asksAvailability: Boolean(input.facets?.asksAvailability),
        rows,
        catalogRouteIntent: executionRouteIntent,
      });

      if (singleServiceCatalogResult.handled) {
        return {
          ...singleServiceCatalogResult,
          ctxPatch: {
            ...(singleServiceCatalogResult.ctxPatch || {}),
            ...clearPendingCatalogChoiceCtxPatch(),
          },
        };
      }
    }

    return {
      handled: false,
    };
  }

  // OTHER PLANS
  if (!asksSchedules && questionType === "other_plans") {
    const { rows } = await input.pool.query<any>(
      `
      SELECT
        CASE
          WHEN v.variant_name IS NOT NULL AND length(trim(v.variant_name)) > 0
            THEN s.name || ' — ' || v.variant_name
          ELSE s.name
        END AS option_name,
        s.name AS service_name,
        v.variant_name,
        v.price::numeric AS price_value
      FROM services s
      JOIN service_variants v
        ON v.service_id = s.id
       AND v.active = true
      WHERE s.tenant_id = $1
        AND s.active = true
        AND v.price IS NOT NULL

      UNION ALL

      SELECT
        s.name AS option_name,
        s.name AS service_name,
        NULL::text AS variant_name,
        s.price_base::numeric AS price_value
      FROM services s
      WHERE s.tenant_id = $1
        AND s.active = true
        AND s.price_base IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM service_variants v
          WHERE v.service_id = s.id
            AND v.active = true
            AND v.price IS NOT NULL
        )
      ORDER BY price_value ASC NULLS LAST, option_name ASC
      `,
      [input.tenantId]
    );

    const norm = (s: string) =>
      String(s || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const prevSet = new Set((prevFresh ? prevNames : []).map(norm));

    const freshRows = rows.filter((r: any) => {
      const optionNorm = norm(r.option_name);
      const serviceNorm = norm(r.service_name);

      return !prevSet.has(optionNorm) && !prevSet.has(serviceNorm);
    });

    const rowsToRender = freshRows.slice(0, 5);

    if (!rowsToRender.length) {
      const fallbackNames = (prevFresh ? prevNames : [])
        .map((name: string) => String(name || "").trim())
        .filter(Boolean)
        .slice(0, 5);

      const canonicalReply = fallbackNames.length
        ? fallbackNames.map((name: string) => `• ${name}`).join("\n")
        : "";

      const finalReply = canonicalReply || "";

      return {
        handled: true,
        reply: finalReply || canonicalReply,
        source: "catalog_db",
        intent: "precio",
        catalogPayload: {
          kind: "resolved_catalog_answer",
          scope: "overview",
          canonicalBlocks: {
            priceBlock: (finalReply || canonicalReply) || null,
          },
        },
        ctxPatch: {
          last_catalog_at: Date.now(),
          lastResolvedIntent: "other_plans",
          pendingCatalogChoice: null,
          pendingCatalogChoiceAt: null,
        } as any,
      };
    }

    let rowsLocalized = rowsToRender.map((r: any) => ({ ...r }));

    if (input.idiomaDestino === "en") {
      rowsLocalized = await Promise.all(
        rowsToRender.map(async (r: any) => {
          try {
            const optionEn = await input.traducirTexto(
              String(r.option_name || ""),
              "en",
              "catalog_label"
            );
            return { ...r, option_name: optionEn };
          } catch {
            return r;
          }
        })
      );
    }

    const canonicalReply = rowsLocalized
      .map((r: any) => {
        const price = Number(r.price_value);
        const priceText =
          price === 0
            ? input.idiomaDestino === "en"
              ? "free"
              : "gratis"
            : Number.isFinite(price)
            ? `$${price.toFixed(2)}`
            : "";

        return `• ${String(r.option_name || "").trim()}: ${priceText}`;
      })
      .join("\n");

    const reply = canonicalReply;

    const namesShown = rowsToRender
      .map((r: any) => String(r.option_name || "").trim())
      .filter(Boolean)
      .slice(0, 7);

    const ctxPatch: any = {
      last_catalog_at: Date.now(),
      lastResolvedIntent: "other_plans",
      pendingCatalogChoice: null,
      pendingCatalogChoiceAt: null,
    };

    if (namesShown.length) {
      ctxPatch.last_catalog_plans = namesShown;
    }

    return {
      handled: true,
      reply,
      source: "catalog_db",
      intent: "precio",
      catalogPayload: {
        kind: "resolved_catalog_answer",
        scope: "overview",
        canonicalBlocks: {
          priceBlock: canonicalReply || null,
        },
      },
      ctxPatch,
    };
  }

  if (shouldNeverSilenceCatalogTurn) {
    return {
      handled: false,
    };
  }

  return {
    handled: false,
  };
}