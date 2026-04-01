import type { Canal } from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";
import { getRecentHistoryForModel } from "../messages/getRecentHistoryForModel";
import { answerWithPromptBase } from "../../../answers/answerWithPromptBase";
import { stripMarkdownLinksForDm } from "../../format/stripMarkdownLinks";
import { buildDmWriterPrompt } from "./buildDmWriterPrompt";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

type CatalogChoiceOption =
  | {
      kind: "service";
      serviceId: string;
      label: string;
      serviceName?: string | null;
    }
  | {
      kind: "variant";
      serviceId: string;
      variantId: string;
      label: string;
      serviceName?: string | null;
      variantName?: string | null;
    };

type CatalogPayload =
  | {
      kind: "service_choice";
      originalIntent: string | null;
      options: CatalogChoiceOption[];
    }
  | {
      kind: "variant_choice";
      originalIntent: string | null;
      serviceId: string;
      serviceName: string | null;
      options: CatalogChoiceOption[];
    }
  | {
      kind: "resolved_catalog_answer";
      scope: "service" | "variant" | "family" | "overview";
      serviceId?: string | null;
      serviceName?: string | null;
      variantId?: string | null;
      variantName?: string | null;
      canonicalBlocks: {
        priceBlock?: string | null;
        includesBlock?: string | null;
        scheduleBlock?: string | null;
        locationBlock?: string | null;
        availabilityBlock?: string | null;
        servicesBlock?: string | null;
      };
    };

function shouldBypassWriterModel(input: {
  isCatalogChoiceReply: boolean;
  isGroundedCatalogReply: boolean;
  isPriceSummaryReply: boolean;
  canonicalBodyOwnsClosing: boolean;
  shouldUseGroundedFrameOnly: boolean;
}): boolean {
  if (input.isCatalogChoiceReply) {
    return false;
  }

  return (
    input.isGroundedCatalogReply ||
    input.isPriceSummaryReply ||
    input.canonicalBodyOwnsClosing ||
    input.shouldUseGroundedFrameOnly
  );
}

function buildCatalogChoiceCanonicalBody(input: {
  idiomaDestino: Lang;
  catalogPayload:
    | Extract<CatalogPayload, { kind: "service_choice" }>
    | Extract<CatalogPayload, { kind: "variant_choice" }>;
}): string {
  const { idiomaDestino, catalogPayload } = input;

  const options = Array.isArray(catalogPayload.options)
    ? catalogPayload.options
    : [];

  const optionLines = options
    .map((option, idx) => `${idx + 1}) ${String(option.label || "").trim()}`)
    .filter(Boolean);

  if (catalogPayload.kind === "service_choice") {
    return idiomaDestino === "en"
      ? `Please choose one option:\n\n${optionLines.join("\n")}`
      : `Por favor elige una opción:\n\n${optionLines.join("\n")}`;
  }

  const serviceLabel = normalizeText(catalogPayload.serviceName);

  return idiomaDestino === "en"
    ? `${serviceLabel || "This service"} has these options:\n\n${optionLines.join("\n")}`
    : `${serviceLabel || "Este servicio"} tiene estas opciones:\n\n${optionLines.join("\n")}`;
}

function buildResolvedCatalogCanonicalBody(input: {
  catalogPayload: Extract<CatalogPayload, { kind: "resolved_catalog_answer" }>;
}): string {
  const blocks = input.catalogPayload.canonicalBlocks || {};

  return [
    normalizeText(blocks.servicesBlock),
    normalizeText(blocks.priceBlock),
    normalizeText(blocks.includesBlock),
    normalizeText(blocks.scheduleBlock),
    normalizeText(blocks.locationBlock),
    normalizeText(blocks.availabilityBlock),
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export type RenderFastpathDmReplyInput = {
  tenantId: string;
  canal: Canal;
  idiomaDestino: Lang;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  fastpathText: string;
  fp: {
    reply?: string | null;
    source?: string | null;
    intent?: string | null;
    awaitingEffect?: any;
    catalogPayload?: CatalogPayload;
  };
  detectedIntent?: string | null;
  intentFallback?: string | null;
  structuredService: {
    serviceId: string | null;
    serviceName: string | null;
    serviceLabel: string | null;
    hasResolution: boolean;
  };
  replyPolicy: {
    shouldUseGroundedFrameOnly: boolean;
    responsePolicyMode: "grounded_frame_only" | "grounded_only" | "clarify_only";
    hasResolvedEntity: boolean;

    isCatalogDbReply: boolean;
    isPriceSummaryReply: boolean;
    isPriceDisambiguationReply: boolean;
    isGroundedCatalogReply: boolean;
    isGroundedCatalogOverviewDm: boolean;
    shouldForceSalesClosingQuestion: boolean;

    canonicalBodyOwnsClosing: boolean;
  };
  ctxPatch: any;
  maxLines?: number;
};

export type RenderFastpathDmReplyResult = {
  reply: string;
  ctxPatch: any;
};

export async function renderFastpathDmReply(
  input: RenderFastpathDmReplyInput
): Promise<RenderFastpathDmReplyResult> {
  const {
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    fastpathText,
    fp,
    structuredService,
    replyPolicy,
    ctxPatch,
    maxLines = 9999,
  } = input;

  const history = await getRecentHistoryForModel({
    tenantId,
    canal,
    fromNumber: contactoNorm,
    excludeMessageId: messageId || undefined,
    limit: 12,
  });

  const {
    isCatalogDbReply,
    isPriceSummaryReply,
    isGroundedCatalogReply,
    shouldForceSalesClosingQuestion,
  } = replyPolicy;

  const catalogPayload = fp?.catalogPayload;

  const isServiceChoiceReply = catalogPayload?.kind === "service_choice";
  const isVariantChoiceReply = catalogPayload?.kind === "variant_choice";
  const isCatalogChoiceReply = isServiceChoiceReply || isVariantChoiceReply;
  const isResolvedCatalogAnswer =
    catalogPayload?.kind === "resolved_catalog_answer";

  const unresolvedCatalogChoice = isCatalogChoiceReply;

  const canonicalReply = (() => {
    if (catalogPayload?.kind === "service_choice") {
      return buildCatalogChoiceCanonicalBody({
        idiomaDestino,
        catalogPayload,
      });
    }

    if (catalogPayload?.kind === "variant_choice") {
      return buildCatalogChoiceCanonicalBody({
        idiomaDestino,
        catalogPayload,
      });
    }

    if (catalogPayload?.kind === "resolved_catalog_answer") {
      const resolvedBody = buildResolvedCatalogCanonicalBody({
        catalogPayload,
      });

      if (resolvedBody) {
        return resolvedBody;
      }
    }

    return normalizeText(fastpathText);
  })();

  const bypassWriterModel = shouldBypassWriterModel({
    isCatalogChoiceReply,
    isGroundedCatalogReply:
      isGroundedCatalogReply || isResolvedCatalogAnswer,
    isPriceSummaryReply,
    canonicalBodyOwnsClosing: replyPolicy.canonicalBodyOwnsClosing,
    shouldUseGroundedFrameOnly: replyPolicy.shouldUseGroundedFrameOnly,
  });

  const runtimeCapabilities = {
    bookingActive: false,
  };

  const resolvedEntityId =
    catalogPayload?.kind === "resolved_catalog_answer"
      ? normalizeText(catalogPayload.variantId || catalogPayload.serviceId) || null
      : replyPolicy.hasResolvedEntity
      ? structuredService?.serviceId ?? null
      : null;

  const resolvedEntityLabel =
    catalogPayload?.kind === "resolved_catalog_answer"
      ? normalizeText(
          catalogPayload.variantName || catalogPayload.serviceName
        ) || null
      : replyPolicy.hasResolvedEntity
      ? structuredService?.serviceLabel ?? null
      : null;

  const responsePolicy = {
    mode: isCatalogChoiceReply
      ? "clarify_only"
      : replyPolicy.responsePolicyMode,
    resolvedEntityType:
      isResolvedCatalogAnswer && resolvedEntityId ? "service" : null,
    resolvedEntityId,
    resolvedEntityLabel,
    canMentionSpecificPrice:
      isResolvedCatalogAnswer ||
      isGroundedCatalogReply ||
      replyPolicy.hasResolvedEntity,
    canSelectSpecificCatalogItem:
      isResolvedCatalogAnswer ||
      isGroundedCatalogReply ||
      replyPolicy.hasResolvedEntity,
    canOfferBookingTimes: false,
    canUseOfficialLinks: true,
    unresolvedEntity: unresolvedCatalogChoice,
    clarificationTarget: unresolvedCatalogChoice
      ? isServiceChoiceReply
        ? "service"
        : "variant"
      : null,
    singleResolvedEntityOnly:
      (isResolvedCatalogAnswer || replyPolicy.hasResolvedEntity) &&
      !isCatalogDbReply,
    allowAlternativeEntities: false,
    allowCrossSellEntities: false,
    allowAddOnSuggestions: false,
    preserveExactBody: bypassWriterModel || isCatalogChoiceReply,
    preserveExactOrder: bypassWriterModel || isCatalogChoiceReply,
    preserveExactBullets: bypassWriterModel || isCatalogChoiceReply,
    preserveExactNumbers: bypassWriterModel || isCatalogChoiceReply,
    preserveExactLinks: bypassWriterModel || isCatalogChoiceReply,
    allowIntro: !bypassWriterModel,
    allowOutro:
      !bypassWriterModel &&
      !replyPolicy.canonicalBodyOwnsClosing,
    allowBodyRewrite: false,
    mustEndWithSalesQuestion:
      !bypassWriterModel &&
      !isCatalogChoiceReply &&
      shouldForceSalesClosingQuestion &&
      !replyPolicy.canonicalBodyOwnsClosing,
    reasoningNotes: isServiceChoiceReply
      ? "Catalog service choice turn. Keep the canonical body exact, do not resolve for the user, and add a short conversational intro that helps the user choose one listed service."
      : isVariantChoiceReply
      ? "Catalog variant choice turn. Keep the canonical body exact, do not resolve for the user, and add a short conversational intro that helps the user choose one listed variant."
      : isResolvedCatalogAnswer
      ? "Resolved grounded catalog turn. Preserve the canonical body exactly."
      : isGroundedCatalogReply
      ? "Grounded catalog turn. Preserve the canonical body exactly."
      : isPriceSummaryReply
      ? "Grounded price summary turn. Preserve the canonical body exactly."
      : null,
  } as const;

  if (bypassWriterModel) {
    if (fp?.awaitingEffect?.type === "set_awaiting_yes_no") {
      const payload = fp.awaitingEffect.payload || null;
      if (payload?.kind) {
        ctxPatch.awaiting_yes_no_action = payload;
      }
    }

    return {
      reply: stripMarkdownLinksForDm(canonicalReply),
      ctxPatch,
    };
  }

  const promptConFastpath = buildDmWriterPrompt({
    idiomaDestino,
    promptBaseMem,
    fastpathText: canonicalReply,
  });

  const composed = await answerWithPromptBase({
    tenantId,
    promptBase: promptConFastpath,
    userInput,
    history,
    idiomaDestino,
    canal,
    maxLines,
    fallbackText: canonicalReply,
    runtimeCapabilities,
    responsePolicy,
  });

  if (composed.pendingCta) {
    const pendingCta = {
      ...composed.pendingCta,
      createdAt: new Date().toISOString(),
    };

    ctxPatch.pending_cta = pendingCta;

    ctxPatch.awaiting_yes_no_action = {
      kind: "pending_cta",
      ctaType: pendingCta.type ?? null,
      source: String(fp?.source || ""),
    };
  }

  if (fp?.awaitingEffect?.type === "set_awaiting_yes_no") {
    const payload = fp.awaitingEffect.payload || null;
    if (payload?.kind) {
      ctxPatch.awaiting_yes_no_action = payload;
    }
  }

  return {
    reply: stripMarkdownLinksForDm(composed.text),
    ctxPatch,
  };
}