import type { Canal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { getRecentHistoryForModel } from "../messages/getRecentHistoryForModel";
import { answerWithPromptBase } from "../../../answers/answerWithPromptBase";
import { stripMarkdownLinksForDm } from "../../format/stripMarkdownLinks";
import { buildDmWriterPrompt } from "./buildDmWriterPrompt";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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
  isInfoGeneralOverviewTurn: boolean;
}): boolean {
  if (input.isCatalogChoiceReply) {
    return true;
  }

  if (input.isResolvedCatalogAnswer) {
    return true;
  }

  if (
    input.shouldUseGroundedFrameOnly &&
    (
      input.canonicalBodyOwnsClosing ||
      input.isGroundedCatalogReply ||
      input.isPriceSummaryReply ||
      input.isInfoGeneralOverviewTurn
    )
  ) {
    return true;
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

async function renderCatalogChoiceBody(input: {
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  promptBaseMem: string;
  history: ChatCompletionMessageParam[];
  catalogPayload:
    | Extract<CatalogPayload, { kind: "service_choice" }>
    | Extract<CatalogPayload, { kind: "variant_choice" }>;
}): Promise<string> {
  const options = Array.isArray(input.catalogPayload.options)
    ? input.catalogPayload.options
        .map((option, idx) => {
          const label = String(option.label || "").trim();
          if (!label) return null;

          return {
            index: idx + 1,
            label,
            kind: option.kind,
            serviceId: option.serviceId,
            variantId: option.kind === "variant" ? option.variantId : null,
            serviceName:
              "serviceName" in option && option.serviceName
                ? String(option.serviceName).trim()
                : null,
            variantName:
              option.kind === "variant" && option.variantName
                ? String(option.variantName).trim()
                : null,
          };
        })
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
    : [];

  const structuredChoice = {
    kind: input.catalogPayload.kind,
    originalIntent: input.catalogPayload.originalIntent ?? null,
    serviceId:
      input.catalogPayload.kind === "variant_choice"
        ? input.catalogPayload.serviceId
        : null,
    serviceName:
      input.catalogPayload.kind === "variant_choice"
        ? normalizeText(input.catalogPayload.serviceName) || null
        : null,
    options,
  };

  const deterministicChoiceBody = options
    .map((option) => `${option.index}) ${option.label}`)
    .join("\n")
    .trim();

  const prompt = [
    "SYSTEM_ROLE:",
    "You write the final customer-facing DM message for a catalog clarification turn.",
    "",
    "TASK:",
    "- Return STRICT JSON only.",
    '- Use exactly this shape: {"text":"..."}',
    "- Write a short natural DM message in the user's language.",
    "- Use only STRUCTURED_CHOICE_JSON as source of truth.",
    "- Preserve each option label exactly as provided.",
    "- Present the options as a numbered list.",
    "- Do not invent prices, includes, schedules, links, benefits, or extra facts.",
    "- Do not convert the turn into a generic vague question.",
    "- If kind is variant_choice, keep the response tied to the selected service.",
    "",
    "PROMPT_BASE:",
    input.promptBaseMem || "",
    "",
    "MENSAJE_USUARIO:",
    input.userInput || "",
    "",
    "STRUCTURED_CHOICE_JSON:",
    JSON.stringify(structuredChoice),
  ].join("\n");

  const composed = await answerWithPromptBase({
    tenantId: input.tenantId,
    promptBase: prompt,
    userInput: input.userInput,
    history: input.history,
    idiomaDestino: input.idiomaDestino,
    canal: input.canal,
    maxLines: 8,
    runtimeCapabilities: {
      bookingActive: false,
    },
    responsePolicy: {
      mode: "normal",
      resolvedEntityType: null,
      resolvedEntityId:
        input.catalogPayload.kind === "variant_choice"
          ? input.catalogPayload.serviceId
          : null,
      resolvedEntityLabel:
        input.catalogPayload.kind === "variant_choice"
          ? normalizeText(input.catalogPayload.serviceName) || null
          : null,
      canMentionSpecificPrice: false,
      canSelectSpecificCatalogItem: true,
      canOfferBookingTimes: false,
      canUseOfficialLinks: false,
      unresolvedEntity: true,
      clarificationTarget:
        input.catalogPayload.kind === "service_choice" ? "service" : "variant",
      singleResolvedEntityOnly: false,
      allowAlternativeEntities: false,
      allowCrossSellEntities: false,
      allowAddOnSuggestions: false,
      preserveExactBody: false,
      preserveExactOrder: true,
      preserveExactBullets: true,
      preserveExactNumbers: true,
      preserveExactLinks: false,
      allowIntro: false,
      allowOutro: false,
      allowBodyRewrite: true,
      mustEndWithSalesQuestion: false,
      reasoningNotes:
        "Render a customer-facing clarification reply from structured choice data only. Preserve option labels exactly.",
    },
  });

  const finalText = String(composed.text || "").trim();

  if (finalText) {
    return finalText;
  }

  return deterministicChoiceBody;
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

async function buildGroundedFrameOnly(input: {
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  promptBaseMem: string;
  history: ChatCompletionMessageParam[];
  canonicalReply: string;
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
  fpIntent: string;
  isInfoGeneralOverviewTurn: boolean;
  isResolvedCatalogAnswer: boolean;
  isCatalogChoiceReply: boolean;
}): Promise<{ intro: string | null; closing: string | null }> {
  if (input.isCatalogChoiceReply) {
    return { intro: null, closing: null };
  }

  if (input.fpIntent === "precio") {
    return { intro: null, closing: null };
  }

  const framePrompt = [
    "SYSTEM_ROLE:",
    "You only generate a conversational frame around a canonical grounded body.",
    "",
    "TASK:",
    "- Return STRICT JSON only.",
    '- Use exactly this shape: {"intro":string|null,"closing":string|null}.',
    "- Do not rewrite, summarize, compress, paraphrase, reorder, or replace the canonical body.",
    "- Do not generate the body.",
    "- The body will be inserted by the system exactly as-is after your output.",
    "- intro must be optional and very short.",
    "- closing must be optional and very short.",
    "- intro and closing must sound natural, consultative, and sales-oriented when appropriate.",
    "- Do not mention any facts, prices, schedules, links, service names, or details that are not already in the canonical body.",
    "- Do not duplicate facts already stated in the canonical body.",
    "- Do not produce lists, bullets, or long paragraphs.",
    "- Do not ask broad vague questions like '¿Qué información deseas?' or similar.",
    "",
    "GROUNDING_RULES:",
    "- If the turn is grounded business info or grounded catalog, preserve the body exactly.",
    "- You may only add framing around it.",
    "- If the user intent is price-like, closing should help the user move toward choosing the best option.",
    "- If the user intent is schedule/location/info-like, closing should help the user continue naturally.",
    "- If human handoff is appropriate, closing may suggest continuing with a person.",
    "",
    "TURN_METADATA_JSON:",
    JSON.stringify({
      fpIntent: input.fpIntent || null,
      isInfoGeneralOverviewTurn: input.isInfoGeneralOverviewTurn,
      isResolvedCatalogAnswer: input.isResolvedCatalogAnswer,
      purchaseIntent: input.commercialPolicy.purchaseIntent,
      wantsBooking: input.commercialPolicy.wantsBooking,
      wantsQuote: input.commercialPolicy.wantsQuote,
      wantsHuman: input.commercialPolicy.wantsHuman,
      urgency: input.commercialPolicy.urgency,
      shouldUseSalesTone: input.commercialPolicy.shouldUseSalesTone,
      shouldUseSoftClosing: input.commercialPolicy.shouldUseSoftClosing,
      shouldUseDirectClosing: input.commercialPolicy.shouldUseDirectClosing,
      shouldSuggestHumanHandoff: input.commercialPolicy.shouldSuggestHumanHandoff,
    }),
    "",
    "PROMPT_BASE:",
    input.promptBaseMem || "",
    "",
    "MENSAJE_USUARIO:",
    input.userInput || "",
    "",
    "CUERPO_CANONICO_REFERENCIA:",
    input.canonicalReply || "",
  ].join("\n");

  return { intro: null, closing: null };
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

  const isCatalogListReply =
    fpSource === "service_list_db" ||
    fpSource === "catalog_list_db" ||
    fpSource === "catalog_overview_db";

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
    catalogPayload?.kind === "resolved_catalog_answer" ||
    fpSource === "catalog_db";

  const isOverviewCatalogDbReply =
    fpSource === "catalog_db" &&
    !isCatalogChoiceReply &&
    !isInfoGeneralOverviewTurn;

  const mustPreserveResolvedCanonicalBody = isResolvedCatalogAnswer;

  const unresolvedCatalogChoice = isCatalogChoiceReply;

  const commercialClosingInstruction = buildCommercialClosingInstruction({
    commercialPolicy,
  });

  const tenantClosingPolicyInstruction =
    buildTenantClosingPolicyInstruction(promptBaseMem);

  const canonicalReply = await (async () => {
    if (catalogPayload?.kind === "service_choice") {
      return await renderCatalogChoiceBody({
        tenantId,
        canal,
        idiomaDestino,
        userInput,
        promptBaseMem,
        history,
        catalogPayload,
      });
    }

    if (catalogPayload?.kind === "variant_choice") {
      return await renderCatalogChoiceBody({
        tenantId,
        canal,
        idiomaDestino,
        userInput,
        promptBaseMem,
        history,
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

    if (fpSource === "catalog_db") {
      return normalizeText(fastpathText);
    }

    return normalizeText(fastpathText);
  })();

    const shouldReturnCanonicalDirectly =
    (isCatalogListReply || isOverviewCatalogDbReply) &&
    Boolean(canonicalReply);
    
    const bypassWriterModel = shouldBypassWriterModel({
      isCatalogChoiceReply,
      isResolvedCatalogAnswer: isResolvedCatalogAnswer || isCatalogListReply,
      isGroundedCatalogReply: isGroundedCatalogReply || isCatalogListReply,
      isPriceSummaryReply: isPriceSummaryReply || isCatalogListReply,
      canonicalBodyOwnsClosing: replyPolicy.canonicalBodyOwnsClosing,
      shouldUseGroundedFrameOnly:
        replyPolicy.shouldUseGroundedFrameOnly || isCatalogListReply,
      isInfoGeneralOverviewTurn,
    });

    if (shouldReturnCanonicalDirectly) {
      console.log("[DM_RENDER][EARLY_RETURN_CANONICAL]", {
        fpSource,
        catalogPayloadKind: catalogPayload?.kind ?? null,
        catalogPayloadScope:
          catalogPayload?.kind === "resolved_catalog_answer"
            ? catalogPayload.scope
            : null,
        isCatalogListReply,
        isOverviewCatalogDbReply,
        canonicalReplyPreview: String(canonicalReply).slice(0, 200),
      });

      if (fp?.awaitingEffect?.type === "set_awaiting_yes_no") {
        const payload = fp.awaitingEffect.payload || null;
        if (payload?.kind) {
          ctxPatch.awaiting_yes_no_action = payload;
        }
      }

      return {
        reply: stripMarkdownLinksForDm(String(canonicalReply).trim()),
        ctxPatch,
      };
    }

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
    !isCatalogListReply &&
    !isInfoGeneralOverviewTurn &&
    !bypassWriterModel &&
    commercialPolicy.shouldUseSalesTone;

  const shouldAllowOutro =
    (!bypassWriterModel ||
      isResolvedCatalogAnswer ||
      isCatalogListReply ||
      isInfoGeneralOverviewTurn) &&
    !replyPolicy.canonicalBodyOwnsClosing &&
    (
      isResolvedCatalogAnswer ||
      isCatalogListReply ||
      isInfoGeneralOverviewTurn ||
      commercialPolicy.shouldUseSalesTone ||
      commercialPolicy.shouldUseSoftClosing ||
      commercialPolicy.shouldUseDirectClosing ||
      commercialPolicy.shouldSuggestHumanHandoff
    );

  const shouldEndWithSalesQuestion =
    !replyPolicy.canonicalBodyOwnsClosing &&
    !isCatalogChoiceReply &&
    (
      isResolvedCatalogAnswer ||
      isCatalogListReply ||
      isInfoGeneralOverviewTurn ||
      shouldForceSalesClosingQuestion ||
      commercialPolicy.shouldUseSoftClosing ||
      commercialPolicy.shouldUseDirectClosing ||
      commercialPolicy.shouldSuggestHumanHandoff
    );

  const responsePolicy = {
    mode: isCatalogChoiceReply
      ? "clarify_only"
      : isResolvedCatalogAnswer || isCatalogListReply || isInfoGeneralOverviewTurn
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
      isCatalogListReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    preserveExactOrder:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      isCatalogListReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    preserveExactBullets:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      isCatalogListReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    preserveExactNumbers:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      isCatalogListReply ||
      mustPreserveResolvedCanonicalBody ||
      isInfoGeneralOverviewTurn,
    preserveExactLinks:
      bypassWriterModel ||
      isCatalogChoiceReply ||
      isCatalogListReply ||
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
      : isCatalogListReply
      ? [
          "Grounded catalog list turn. The canonical body is the source of truth and must be preserved exactly.",
          "Do not rewrite, summarize, decorate, or enrich the catalog list.",
          "Do not invent descriptions, includes, prices, schedule details, labels, or benefits not already present in the canonical body.",
          "After the canonical body, add exactly one short closing move only if allowed by policy.",
          tenantClosingPolicyInstruction,
          commercialClosingInstruction,
        ]
          .filter(Boolean)
          .join(" ")
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
          "Do not omit the closing.",
          "After the canonical body, add exactly one short closing move that helps the user continue.",
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
    console.log("[DM_RENDER][BYPASS_WRITER_MODEL]", {
      fpSource,
      fpIntent,
      isCatalogListReply,
      isOverviewCatalogDbReply,
      isResolvedCatalogAnswer,
      isCatalogChoiceReply,
      bypassWriterModel,
    });

    if (fp?.awaitingEffect?.type === "set_awaiting_yes_no") {
      const payload = fp.awaitingEffect.payload || null;
      if (payload?.kind) {
        ctxPatch.awaiting_yes_no_action = payload;
      }
    }

    const frame = await buildGroundedFrameOnly({
      tenantId,
      canal,
      idiomaDestino,
      userInput,
      promptBaseMem,
      history,
      canonicalReply,
      commercialPolicy,
      fpIntent,
      isInfoGeneralOverviewTurn,
      isResolvedCatalogAnswer,
      isCatalogChoiceReply,
    });

    const finalGroundedReply = [
      String(frame.intro || "").trim(),
      canonicalReply,
      String(frame.closing || "").trim(),
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    return {
      reply: stripMarkdownLinksForDm(finalGroundedReply),
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