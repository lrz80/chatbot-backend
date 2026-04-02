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
  isResolvedCatalogAnswer: boolean;
  isGroundedCatalogReply: boolean;
  isPriceSummaryReply: boolean;
  canonicalBodyOwnsClosing: boolean;
  shouldUseGroundedFrameOnly: boolean;
}): boolean {
  if (input.isCatalogChoiceReply) {
    return true;
  }

  if (input.isResolvedCatalogAnswer) {
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
      ? `I can help you with that. To give you the right details, which option are you interested in?\n\n${optionLines.join("\n")}`
      : `Claro. Para darte la información correcta, dime cuál de estas opciones te interesa:\n\n${optionLines.join("\n")}`;
  }

  const serviceLabel = normalizeText(catalogPayload.serviceName);

  return idiomaDestino === "en"
    ? `${serviceLabel || "This option"} has these available formats. Which one would you like?\n\n${optionLines.join("\n")}`
    : `${serviceLabel || "Esta opción"} tiene estas modalidades disponibles. ¿Cuál te interesa?\n\n${optionLines.join("\n")}`;
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

function isInfoGeneralOverviewSource(value: unknown): boolean {
  const normalized = normalizeText(value).toLowerCase();
  return (
    normalized === "info_general_overview" ||
    normalized === "info_general_prompt_base" ||
    normalized === "info_general_overview_db"
  );
}

function isInfoGeneralOverviewIntent(value: unknown): boolean {
  const normalized = normalizeText(value).toLowerCase();
  return (
    normalized === "info_general" ||
    normalized === "info_general_overview"
  );
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

  const fpSource = normalizeText(fp?.source).toLowerCase();
  const fpIntent = normalizeText(
    fp?.intent || input.detectedIntent || input.intentFallback || ""
  ).toLowerCase();

  const isInfoGeneralOverviewTurn =
    isInfoGeneralOverviewSource(fpSource) ||
    isInfoGeneralOverviewIntent(fpIntent) ||
    replyPolicy.isGroundedCatalogOverviewDm === true;

  const catalogPayload = fp?.catalogPayload;

  const isServiceChoiceReply = catalogPayload?.kind === "service_choice";
  const isVariantChoiceReply = catalogPayload?.kind === "variant_choice";
  const isCatalogChoiceReply = isServiceChoiceReply || isVariantChoiceReply;
  const isResolvedCatalogAnswer =
    catalogPayload?.kind === "resolved_catalog_answer";

  const mustPreserveResolvedCanonicalBody = isResolvedCatalogAnswer;

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
    isResolvedCatalogAnswer,
    isGroundedCatalogReply,
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
      : isResolvedCatalogAnswer || isInfoGeneralOverviewTurn
      ? "grounded_frame_only"
      : replyPolicy.responsePolicyMode,
    resolvedEntityType:
      isResolvedCatalogAnswer && resolvedEntityId ? "service" : null,
    resolvedEntityId,
    resolvedEntityLabel,
    canMentionSpecificPrice:
      isResolvedCatalogAnswer ||
      isGroundedCatalogReply ||
      isInfoGeneralOverviewTurn ||
      replyPolicy.hasResolvedEntity,
    canSelectSpecificCatalogItem:
      isResolvedCatalogAnswer ||
      isGroundedCatalogReply ||
      isInfoGeneralOverviewTurn ||
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
    preserveExactBody:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    preserveExactOrder:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    preserveExactBullets:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    preserveExactNumbers:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    preserveExactLinks:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    allowIntro: !bypassWriterModel || isResolvedCatalogAnswer,
    allowOutro:
      (!bypassWriterModel || isResolvedCatalogAnswer) &&
      !replyPolicy.canonicalBodyOwnsClosing,
    allowBodyRewrite: false,
    mustEndWithSalesQuestion:
      (
        (!bypassWriterModel && !isCatalogChoiceReply && shouldForceSalesClosingQuestion) ||
        isResolvedCatalogAnswer
      ) &&
      !replyPolicy.canonicalBodyOwnsClosing,
    reasoningNotes: isServiceChoiceReply
      ? "Catalog service choice turn. Do not add any intro, outro, summary, paraphrase, persuasion, or semantic framing. Return the canonical choice body exactly as provided so the user can select one service."
      : isVariantChoiceReply
      ? "Catalog variant choice turn. Do not add any intro, outro, summary, paraphrase, persuasion, or semantic framing. Return the canonical choice body exactly as provided so the user can select one variant."
      : isResolvedCatalogAnswer
      ? "Resolved grounded catalog turn. The canonical body is the source of truth and must be preserved exactly. Do not rewrite, summarize, compress, paraphrase, or omit any fact, condition, number, schedule, bullet, or link from the canonical body. You may add only one short intro before the canonical body and one short sales-oriented closing question after it. The body itself must remain unchanged and in the same order."
      : isInfoGeneralOverviewTurn
      ? "General business overview turn for DM. The canonical body is the source of truth and must be preserved. Do not replace it with a vague clarification question. Start with a short, warm, sales-oriented intro. Then keep the canonical body in the same order and bullet structure. After that, end with a guided closing question that helps the user advance naturally, offering concrete options such as prices, schedules, or which service fits them best. Do not ask an open generic question like asking what information they want."
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