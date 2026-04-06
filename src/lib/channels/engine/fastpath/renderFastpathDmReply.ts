import type { Canal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
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

  if (input.shouldUseGroundedFrameOnly) {
    return false;
  }

  return (
    input.isGroundedCatalogReply ||
    input.isPriceSummaryReply ||
    input.canonicalBodyOwnsClosing
  );
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

function isBusinessInfoReply(input: {
  fpSource: string;
  fpIntent: string;
  replyPolicy: RenderFastpathDmReplyInput["replyPolicy"];
}): boolean {
  if (input.replyPolicy.isGroundedCatalogOverviewDm === true) {
    return true;
  }

  if (input.fpIntent === "info_general") {
    return true;
  }

  return input.fpSource.startsWith("business_info");
}

function buildCatalogChoiceCanonicalBody(input: {
  catalogPayload:
    | Extract<CatalogPayload, { kind: "service_choice" }>
    | Extract<CatalogPayload, { kind: "variant_choice" }>;
}): string {
  const { catalogPayload } = input;

  const options = Array.isArray(catalogPayload.options)
    ? catalogPayload.options
    : [];

  const optionLines = options
    .map((option, idx) => `${idx + 1}) ${String(option.label || "").trim()}`)
    .filter(Boolean);

  if (catalogPayload.kind === "service_choice") {
    return [
      "CANONICAL_CHOICE_KIND: service",
      "CANONICAL_CHOICE_INSTRUCTION: Ask the user to choose one option from the list. Do not add explanations outside this purpose.",
      "",
      optionLines.join("\n"),
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  const serviceLabel = normalizeText(catalogPayload.serviceName);

  return [
    "CANONICAL_CHOICE_KIND: variant",
    `CANONICAL_PARENT_LABEL: ${serviceLabel || ""}`,
    "CANONICAL_CHOICE_INSTRUCTION: Ask the user to choose one available variant for the selected option. Do not add explanations outside this purpose.",
    "",
    optionLines.join("\n"),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildTenantClosingPolicyInstruction(promptBaseMem: string): string | null {
  const text = String(promptBaseMem || "").trim();

  if (!text) return null;

  return [
    "If PROMPT_BASE contains a tenant-specific closing policy, follow that policy for the closing only.",
    "Treat the tenant closing policy in PROMPT_BASE as higher priority than generic closing style defaults only for the closing.",
    "Use the tenant's preferred closing style, wording pattern, and next-step format when present, but only in the closing.",
    "Do not let the tenant closing policy modify the intro.",
    "Do not let the tenant closing policy replace the canonical body with a vague question or generic opener.",
    "Never let the tenant closing policy alter, weaken, summarize, or rewrite the canonical body facts.",
  ].join(" ");
}

function buildCommercialClosingInstruction(input: {
  commercialPolicy: {
    purchaseIntent: "unknown" | "low" | "medium" | "high";
    wantsBooking: boolean;
    wantsQuote: boolean;
    wantsHuman: boolean;
    urgency: "unknown" | "low" | "medium" | "high";
    shouldUseSalesTone: boolean;
    shouldUseSoftClosing: boolean;
    shouldUseDirectClosing: boolean;
    shouldSuggestHumanHandoff: boolean;
  };
}): string | null {
  const { commercialPolicy } = input;

  if (commercialPolicy.shouldSuggestHumanHandoff) {
    return "Offer a direct next step with a person, without sounding pushy.";
  }

  if (commercialPolicy.shouldUseDirectClosing) {
    if (commercialPolicy.wantsBooking) {
      return "Close with one short and direct next-step question focused on booking or moving forward now.";
    }

    return "Close with one short and direct next-step question that helps the user move forward now.";
  }

  if (commercialPolicy.shouldUseSoftClosing) {
    return "Close with one short, guided, low-pressure question that helps the user continue naturally.";
  }

  if (commercialPolicy.shouldUseSalesTone) {
    return "Use a consultative sales tone and keep the close soft and natural.";
  }

  return null;
}

export type RenderFastpathDmReplyInput = {
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
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

    commercialPolicy: {
      purchaseIntent: "unknown" | "low" | "medium" | "high";
      wantsBooking: boolean;
      wantsQuote: boolean;
      wantsHuman: boolean;
      urgency: "unknown" | "low" | "medium" | "high";
      shouldUseSalesTone: boolean;
      shouldUseSoftClosing: boolean;
      shouldUseDirectClosing: boolean;
      shouldSuggestHumanHandoff: boolean;
    };
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

  const commercialPolicy = replyPolicy.commercialPolicy ?? {
    purchaseIntent: "low",
    wantsBooking: false,
    wantsQuote: false,
    wantsHuman: false,
    urgency: "low",
    shouldUseSalesTone: true,
    shouldUseSoftClosing: true,
    shouldUseDirectClosing: false,
    shouldSuggestHumanHandoff: false,
  };

  const fpSource = normalizeText(fp?.source).toLowerCase();
  const fpIntent = normalizeText(
    fp?.intent || input.detectedIntent || input.intentFallback || ""
  ).toLowerCase();

  const isInfoGeneralOverviewTurn = isBusinessInfoReply({
    fpSource,
    fpIntent,
    replyPolicy,
  });

  const catalogPayload = fp?.catalogPayload;

  const isServiceChoiceReply = catalogPayload?.kind === "service_choice";
  const isVariantChoiceReply = catalogPayload?.kind === "variant_choice";
  const isCatalogChoiceReply = isServiceChoiceReply || isVariantChoiceReply;
  const isResolvedCatalogAnswer =
    catalogPayload?.kind === "resolved_catalog_answer";

  const mustPreserveResolvedCanonicalBody = isResolvedCatalogAnswer;

  const unresolvedCatalogChoice = isCatalogChoiceReply;

  const commercialClosingInstruction = buildCommercialClosingInstruction({
    commercialPolicy,
  });

  const tenantClosingPolicyInstruction =
    buildTenantClosingPolicyInstruction(promptBaseMem);

  const canonicalReply = (() => {
    if (catalogPayload?.kind === "service_choice") {
      return buildCatalogChoiceCanonicalBody({
        catalogPayload,
      });
    }

    if (catalogPayload?.kind === "variant_choice") {
      return buildCatalogChoiceCanonicalBody({
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

  const shouldAllowIntro =
    !isResolvedCatalogAnswer &&
    !isInfoGeneralOverviewTurn &&
    !bypassWriterModel &&
    commercialPolicy.shouldUseSalesTone;

  const shouldAllowOutro =
    (!bypassWriterModel || isResolvedCatalogAnswer) &&
    !replyPolicy.canonicalBodyOwnsClosing &&
    (commercialPolicy.shouldUseSalesTone ||
      commercialPolicy.shouldUseSoftClosing ||
      commercialPolicy.shouldUseDirectClosing ||
      commercialPolicy.shouldSuggestHumanHandoff);

  const shouldEndWithSalesQuestion =
    !replyPolicy.canonicalBodyOwnsClosing &&
    !isCatalogChoiceReply &&
    (
      shouldForceSalesClosingQuestion ||
      commercialPolicy.shouldUseSoftClosing ||
      commercialPolicy.shouldUseDirectClosing ||
      commercialPolicy.shouldSuggestHumanHandoff
    );

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
    allowIntro: shouldAllowIntro,
    allowOutro: shouldAllowOutro,
    allowBodyRewrite: false,
    mustEndWithSalesQuestion: shouldEndWithSalesQuestion,
    reasoningNotes: isServiceChoiceReply
      ? "Catalog service choice turn. Do not add any intro, outro, summary, paraphrase, persuasion, or semantic framing. Return the canonical choice body exactly as provided so the user can select one service."
      : isVariantChoiceReply
      ? "Catalog variant choice turn. Do not add any intro, outro, summary, paraphrase, persuasion, or semantic framing. Return the canonical choice body exactly as provided so the user can select one variant."
      : isResolvedCatalogAnswer
      ? [
          "Resolved grounded catalog turn. The canonical body is the source of truth and must be preserved exactly.",
          "Do not rewrite, summarize, compress, paraphrase, or omit any fact, condition, number, schedule, bullet, or link from the canonical body.",
          "Do not add an intro before the canonical body.",
          "Do not restate, preview, summarize, or paraphrase facts already contained in the canonical body.",
          "Do not mention prices, numbers, includes, service details, schedules, locations, policies, or links outside the canonical body.",
          "After the canonical body, add exactly one short closing move that helps the user move forward.",
          "The closing must be consultative, natural, and sales-oriented.",
          "If PROMPT_BASE contains a tenant-specific closing policy, you must follow it for the closing.",
          "The tenant closing policy overrides generic closing style defaults, as long as the canonical body remains unchanged.",
          "The body itself must remain unchanged and in the same order.",
          tenantClosingPolicyInstruction,
          commercialClosingInstruction,
        ]
          .filter(Boolean)
          .join(" ")
      : isInfoGeneralOverviewTurn
      ? [
          "General business overview turn for DM. The canonical body is the source of truth and must be preserved.",
          "Do not replace it with a vague clarification question.",
          "Do not turn the intro into a broad generic question about what the user wants to know.",
          "Do not use the intro to weaken, delay, or redirect the overview.",
          "If an intro is used, it must be a very short acknowledgment only.",
          "The tenant-specific closing policy may apply only to the closing, never to the intro.",
          "Keep the canonical body in the same order and bullet structure.",
          tenantClosingPolicyInstruction,
          commercialClosingInstruction,
        ]
          .filter(Boolean)
          .join(" ")
      : isGroundedCatalogReply
      ? [
          "Grounded catalog turn. Preserve the canonical body exactly.",
          commercialClosingInstruction,
        ]
          .filter(Boolean)
          .join(" ")
      : isPriceSummaryReply
      ? [
          "Grounded price summary turn. Preserve the canonical body exactly.",
          commercialClosingInstruction,
        ]
          .filter(Boolean)
          .join(" ")
      : commercialClosingInstruction,
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

  function shouldAcceptPendingCta(input: {
    commercialPolicy: RenderFastpathDmReplyInput["replyPolicy"]["commercialPolicy"];
    detectedIntent: string | null;
    isResolvedCatalogAnswer: boolean;
    isInfoGeneralOverviewTurn: boolean;
  }): boolean {
    const intent = String(input.detectedIntent || "").trim().toLowerCase();
    const c = input.commercialPolicy;

    // ❌ nunca permitir en estos casos
    if (input.isInfoGeneralOverviewTurn) return false;
    if (intent === "info_general") return false;
    if (intent === "saludo") return false;
    if (intent === "duda") return false;

    // ✅ casos válidos fuertes
    if (c.purchaseIntent === "high" && (c.wantsBooking || c.wantsQuote)) {
      return true;
    }

    // ✅ casos medios controlados
    if (
      input.isResolvedCatalogAnswer &&
      c.purchaseIntent !== "low" &&
      (c.wantsBooking || c.wantsQuote)
    ) {
      return true;
    }

    return false;
  }

  if (composed.pendingCta) {
    const shouldAccept = shouldAcceptPendingCta({
      commercialPolicy,
      detectedIntent: fpIntent || null,
      isResolvedCatalogAnswer,
      isInfoGeneralOverviewTurn,
    });

    if (shouldAccept) {
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
    } else {
      console.log("[CTA][REJECTED_BY_POLICY]", {
        intent: fpIntent,
        commercialPolicy,
      });
    }
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