//src/lib/channels/engine/fastpath/renderFastpathDmReply.ts
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

function normalizeComparableText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFirstNonEmptyLine(text: string): string {
  return (
    String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || ""
  );
}

function getTokenSet(text: string): Set<string> {
  return new Set(
    normalizeComparableText(text)
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function getTokenOverlapRatio(a: string, b: string): number {
  const aSet = getTokenSet(a);
  const bSet = getTokenSet(b);

  if (!aSet.size || !bSet.size) return 0;

  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) overlap += 1;
  }

  return overlap / Math.min(aSet.size, bSet.size);
}

function isSemanticallyDuplicatedAgainstCanonicalLead(args: {
  frameText?: string | null;
  canonicalBody: string;
}): boolean {
  const frameText = String(args.frameText || "").trim();
  const canonicalBody = String(args.canonicalBody || "").trim();

  if (!frameText || !canonicalBody) return false;

  const firstCanonicalLine = getFirstNonEmptyLine(canonicalBody);
  if (!firstCanonicalLine) return false;

  const normalizedFrameText = normalizeComparableText(frameText);
  const normalizedFirstLine = normalizeComparableText(firstCanonicalLine);

  if (!normalizedFrameText || !normalizedFirstLine) return false;

  if (
    normalizedFrameText === normalizedFirstLine ||
    normalizedFrameText.includes(normalizedFirstLine) ||
    normalizedFirstLine.includes(normalizedFrameText)
  ) {
    return true;
  }

  const overlapRatio = getTokenOverlapRatio(frameText, firstCanonicalLine);
  return overlapRatio >= 0.9;
}

function stripFirstCanonicalLineIfDuplicated(args: {
  frameText?: string | null;
  canonicalBody: string;
}): string {
  const canonicalBody = String(args.canonicalBody || "").trim();
  if (!canonicalBody) return "";

  if (
    !isSemanticallyDuplicatedAgainstCanonicalLead({
      frameText: args.frameText,
      canonicalBody,
    })
  ) {
    return canonicalBody;
  }

  const lines = canonicalBody.split("\n");
  let removed = false;
  const nextLines: string[] = [];

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();

    if (!removed && line) {
      removed = true;
      continue;
    }

    nextLines.push(rawLine);
  }

  return nextLines.join("\n").trim();
}

function nullifyFrameTextIfDuplicated(args: {
  frameText?: string | null;
  canonicalBody: string;
}): string | null {
  const frameText = String(args.frameText || "").trim();
  if (!frameText) return null;

  return isSemanticallyDuplicatedAgainstCanonicalLead({
    frameText,
    canonicalBody: args.canonicalBody,
  })
    ? null
    : frameText;
}

function looksLikeResolvedHeading(line: string): boolean {
  const value = String(line || "").trim();
  if (!value) return false;

  if (value.startsWith("•")) return false;
  if (value.startsWith("-")) return false;
  if (value.startsWith("http")) return false;
  if (value.length > 90) return false;

  return true;
}

function stripFirstResolvedHeadingFromCanonicalBody(input: {
  canonicalBody: string;
  resolvedEntityLabel?: string | null;
  resolvedServiceName?: string | null;
}): string {
  const canonicalBody = String(input.canonicalBody || "").trim();
  if (!canonicalBody) return "";

  const lines = String(canonicalBody).split("\n");
  const firstNonEmpty = lines.find((line) => String(line || "").trim()) || "";
  const firstLine = String(firstNonEmpty || "").trim();

  if (!firstLine) return canonicalBody;

  const firstLineNorm = normalizeComparableText(firstLine);
  const resolvedEntityLabelNorm = normalizeComparableText(
    String(input.resolvedEntityLabel || "")
  );
  const resolvedServiceNameNorm = normalizeComparableText(
    String(input.resolvedServiceName || "")
  );

  const matchesResolvedLabel =
    !!resolvedEntityLabelNorm &&
    (
      firstLineNorm === resolvedEntityLabelNorm ||
      firstLineNorm.includes(resolvedEntityLabelNorm) ||
      resolvedEntityLabelNorm.includes(firstLineNorm)
    );

  const matchesResolvedService =
    !!resolvedServiceNameNorm &&
    (
      firstLineNorm === resolvedServiceNameNorm ||
      firstLineNorm.includes(resolvedServiceNameNorm) ||
      resolvedServiceNameNorm.includes(firstLineNorm)
    );

  const shouldStrip =
    matchesResolvedLabel ||
    matchesResolvedService ||
    looksLikeResolvedHeading(firstLine);

  if (!shouldStrip) {
    return canonicalBody;
  }

  let removed = false;
  const nextLines: string[] = [];

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();

    if (!removed && line) {
      removed = true;
      continue;
    }

    nextLines.push(rawLine);
  }

  return nextLines.join("\n").trim();
}

function stripJsonCodeFences(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return raw;

  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

type FrameClosingType = "availability_statement" | "question" | "none";

function parseFrameJson(value: string): {
  intro: string | null;
  closing: string | null;
  closingType: FrameClosingType;
} {
  const raw = stripJsonCodeFences(value);

  if (!raw) {
    return { intro: null, closing: null, closingType: "none" };
  }

  try {
    const parsed = JSON.parse(raw) as {
      intro?: unknown;
      closing?: unknown;
      closingType?: unknown;
    };

    const intro =
      typeof parsed?.intro === "string" && parsed.intro.trim()
        ? parsed.intro.trim()
        : null;

    const closing =
      typeof parsed?.closing === "string" && parsed.closing.trim()
        ? parsed.closing.trim()
        : null;

    const closingTypeRaw =
      typeof parsed?.closingType === "string"
        ? parsed.closingType.trim().toLowerCase()
        : "none";

    const closingType: FrameClosingType =
      closingTypeRaw === "availability_statement" ||
      closingTypeRaw === "question"
        ? closingTypeRaw
        : "none";

    return { intro, closing, closingType };
  } catch {
    return { intro: null, closing: null, closingType: "none" };
  }
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
      presentationMode?: "full_detail" | "action_link";
      closingMode?: "default" | "availability_statement" | "none";
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
        linkBlock?: string | null;
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
  const presentationMode = String(
    input.catalogPayload.presentationMode || "full_detail"
  ).trim().toLowerCase();

  if (presentationMode === "action_link") {
    return [
      normalizeText(blocks.linkBlock),
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  return [
    normalizeText(blocks.servicesBlock),
    normalizeText(blocks.priceBlock),
    normalizeText(blocks.includesBlock),
    normalizeText(blocks.scheduleBlock),
    normalizeText(blocks.locationBlock),
    normalizeText(blocks.availabilityBlock),
    normalizeText(blocks.linkBlock),
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

function renderCatalogChoiceBody(input: {
  catalogPayload:
    | Extract<CatalogPayload, { kind: "service_choice" }>
    | Extract<CatalogPayload, { kind: "variant_choice" }>;
}): string {
  const options = Array.isArray(input.catalogPayload.options)
    ? input.catalogPayload.options
        .map((option, idx) => {
          const label = String(option.label || "").trim();
          if (!label) return null;

          return `${idx + 1}) ${label}`;
        })
        .filter((value): value is string => Boolean(value))
    : [];

  return options.join("\n").trim();
}

function buildTenantClosingPolicyInstruction(promptBaseMem: string): string | null {
  const text = String(promptBaseMem || "").trim();

  if (!text) return null;

  return [
    "If PROMPT_BASE contains a tenant-specific CTA or preferred closing instruction, it must be treated as the authoritative closing policy.",
    "When a closing is allowed for the turn, prefer the tenant CTA from PROMPT_BASE over generic closing rewrites.",
    "If PROMPT_BASE includes an explicit next-step sentence or an exact phrase the user should send, preserve that CTA wording in the closing.",
    "Do not paraphrase, soften, translate away, or replace the tenant CTA unless required by the target output language.",
    "Keep the tenant CTA in the closing only.",
    "Do not let the tenant CTA modify the intro.",
    "Do not let the tenant CTA replace the canonical body with a vague question or generic opener.",
    "Never let the tenant CTA alter, weaken, summarize, or rewrite the canonical body facts.",
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
  isActionLinkResolvedCatalogReply: boolean;
  resolvedCatalogClosingMode: "default" | "availability_statement" | "none";
}): Promise<{
  intro: string | null;
  closing: string | null;
  closingType: FrameClosingType;
}> {
  const frameTaskRules = input.isCatalogChoiceReply
    ? [
        "This is a catalog choice turn.",
        "Return exactly one short intro line before the canonical options body.",
        "For catalog choice turns, intro is required and must never be null.",
        "The intro must state that the selected plan or service has these options.",
        "The intro must be simple, neutral, and direct.",
        "The intro must not sound promotional or vague.",
        "The intro must not say 'here is information about the plan' or similar.",
        "The intro must not ask whether the user wants more information.",
        "The intro must not mention includes, benefits, features, prices, schedules, policies, or links.",
        "The intro must not repeat the numbered options.",
        "Return exactly one short closing line after the canonical options body.",
        "The closing must be a direct selection CTA.",
        "The closing should tell the user to select the option they want.",
        "The closing must not be phrased as a broad question.",
        "Prefer imperative CTA style over question style.",
        "Do not rewrite or summarize the options body.",
        "Do not mention any facts not already implied by the canonical body.",
        "Do not return intro as null for catalog choice turns.",
        "If you are unsure, still return a short direct intro instead of null.",
      ]
    : input.isResolvedCatalogAnswer
    ? [
        "This is a resolved grounded catalog answer.",
        "Return exactly one short intro before the canonical body.",
        input.resolvedCatalogClosingMode === "none"
          ? "Closing must be null."
          : "Return exactly one short closing after the canonical body.",
        "You are only framing the canonical body. The body itself is already resolved and grounded by the system.",
        "The intro must be brief, neutral-to-consultative, and natural.",
        "The closing must be brief and must respect the tenant CTA from PROMPT_BASE when one exists.",
        "Do not rewrite, summarize, paraphrase, compress, expand, or replace the canonical body.",
        "Do not mention any fact, benefit, positioning, suitability claim, audience claim, recommendation, promise, or interpretation that is not explicitly present in the canonical body.",
        "Do not infer who this plan is ideal for.",
        "Do not infer lifestyle, preferences, goals, schedule fit, or customer profile.",
        "Do not restate prices, includes, schedules, policies, conditions, or links outside the canonical body.",
        "Do not repeat the exact title or heading if the canonical body already starts with it.",
        "The intro must work only as a light conversational bridge into the body.",
        "The closing must work only as a light conversational bridge to the next step.",
        "If PROMPT_BASE contains an explicit tenant CTA, use that CTA in the closing instead of inventing a different next-step wording.",
        "Do not replace an explicit tenant CTA with a generic variant.",
        "The closing must never ask for more information, more details, or more explanation about the same plan, service, or variant already explained.",
        "The closing must never imply that the system still owes the user basic information about the same item.",
        input.resolvedCatalogClosingMode === "availability_statement"
          ? "The closing should only communicate continued availability to help the user further."
          : "The closing should only help the user do one of these: proceed, compare another option, book, or talk to a person.",
        input.resolvedCatalogClosingMode === "none"
          ? "Always return null for closing."
        : input.resolvedCatalogClosingMode === "availability_statement"
          ? "Return one short declarative closing that leaves the conversation open for further help. closingType must be availability_statement. The closing must not be a question. The closing must not invite booking, proceeding, reserving, clicking, confirming, or continuing a process."
          : "If there is no strong next step, return null for closing.",
        input.resolvedCatalogClosingMode === "availability_statement"
          ? "For availability_statement turns, never use closingType question."
          : null,
        input.resolvedCatalogClosingMode === "availability_statement"
          ? "If you cannot produce a valid availability-style closing, return closing as null and closingType as none."
          : null,
        input.resolvedCatalogClosingMode === "availability_statement"
          ? "The closing must be declarative, low-pressure, and non-interrogative."
          : null,
        input.resolvedCatalogClosingMode === "availability_statement"
          ? "Do not use question marks in the closing."
          : null,
        "If in doubt, return null for intro and/or closing rather than inventing content.",
        "The closing must not use phrases equivalent to asking for more details or more information about the same item.",
      ]
    : input.isInfoGeneralOverviewTurn
    ? [
        "This is a grounded business overview turn.",
        "Intro must be null.",
        "Do not ask a broad discovery question before the canonical body.",
        "Do not restate, summarize, or paraphrase the canonical body.",
        "If PROMPT_BASE contains an explicit tenant CTA, use that CTA as the closing.",
        "Do not replace an explicit tenant CTA with a generic closing.",
        "Return one short closing that keeps the conversation moving naturally only when there is no explicit tenant CTA.",
      ]
    : [
        "Return optional framing only when it improves the DM reply.",
        "Do not rewrite or summarize the canonical body.",
      ];

  const framePrompt = [
    "SYSTEM_ROLE:",
    "You only generate a conversational frame around a canonical grounded body.",
    "",
    "TASK:",
    "- Return STRICT JSON only.",
    '- Use exactly this shape: {"intro":string|null,"closing":string|null,"closingType":"availability_statement"|"question"|"none"}.',
    "- You may generate only intro and closing.",
    "- Do not generate, rewrite, summarize, compress, paraphrase, reorder, or replace the canonical body.",
    "- The canonical body will be inserted by the system exactly as-is after your output.",
    "- intro must be very short.",
    "- closing must be very short.",
    "- intro may be null only when the turn is not a catalog choice turn.",
    "- for catalog choice turns, intro is mandatory and must not be null.",
    "- closing may be null only when the turn does not need a next-step prompt.",
    "- intro and closing must be framing only, never content expansion.",
    "- Do not mention facts, prices, includes, schedules, locations, links, conditions, service names, benefits, or details unless they are already explicit in the canonical body and strictly necessary for a minimal bridge sentence.",
    "- Do not add positioning language, suitability claims, audience assumptions, lifestyle assumptions, or persuasive claims not explicitly present in the canonical body.",
    "- Do not duplicate or summarize facts already stated in the canonical body.",
    "- If there is any risk of inventing information, return null for that field.",
    "- Do not produce lists, bullets, or long paragraphs.",
    "- Never return markdown fences.",
    "",
    "FRAME_RULES:",
    ...frameTaskRules,
    "",
    "GROUNDING_RULES:",
    "- If the turn is grounded business info or grounded catalog, preserve the body exactly.",
    "- You may only add framing around it.",
    "- If human handoff is appropriate, closing may suggest continuing with a person.",
    "",
    "TURN_METADATA_JSON:",
    JSON.stringify({
      fpIntent: input.fpIntent || null,
      isInfoGeneralOverviewTurn: input.isInfoGeneralOverviewTurn,
      isResolvedCatalogAnswer: input.isResolvedCatalogAnswer,
      isCatalogChoiceReply: input.isCatalogChoiceReply,
      isActionLinkResolvedCatalogReply: input.isActionLinkResolvedCatalogReply,
      resolvedCatalogClosingMode: input.resolvedCatalogClosingMode,
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

  const frameResponse = await answerWithPromptBase({
    tenantId: input.tenantId,
    promptBase: framePrompt,
    userInput: input.userInput,
    history: input.history,
    idiomaDestino: input.idiomaDestino,
    canal: input.canal,
    maxLines: 6,
    fallbackText: "",
    runtimeCapabilities: {
      bookingActive: false,
    },
    responsePolicy: {
      mode: "frame_only",
      resolvedEntityType: null,
      resolvedEntityId: null,
      resolvedEntityLabel: null,
      canMentionSpecificPrice: false,
      canSelectSpecificCatalogItem: false,
      canOfferBookingTimes: false,
      canUseOfficialLinks: false,
      unresolvedEntity: input.isCatalogChoiceReply,
      clarificationTarget: input.isCatalogChoiceReply ? "variant" : null,
      singleResolvedEntityOnly: input.isResolvedCatalogAnswer,
      allowAlternativeEntities: false,
      allowCrossSellEntities: false,
      allowAddOnSuggestions: false,
      preserveExactBody: true,
      preserveExactOrder: true,
      preserveExactBullets: true,
      preserveExactNumbers: true,
      preserveExactLinks: true,
      allowIntro: true,
      allowOutro: true,
      allowBodyRewrite: false,
      mustEndWithSalesQuestion: false,
      reasoningNotes:
        "Return strict JSON only with intro and closing. Do not write the body.",
    },
  });

  return parseFrameJson(String(frameResponse.text || ""));
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

    answerType:
      | "overview"
      | "direct_answer"
      | "disambiguation"
      | "comparison"
      | "guided_next_step"
      | "action_link";

    salesPosture:
      | "inform"
      | "guide"
      | "recommend"
      | "close_soft"
      | "close_direct";

    closingMode:
      | "none"
      | "soft_question"
      | "direct_question"
      | "availability_statement"
      | "tenant_cta";

    shouldAskQuestion: boolean;
    shouldOpenChoice: boolean;
    shouldForceNullIntro: boolean;
    shouldForceNullClosing: boolean;

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

  const isInfoGeneralOverviewTurn = replyPolicy.answerType === "overview";

  const catalogPayload = fp?.catalogPayload;

  const resolvedCatalogPresentationMode =
    catalogPayload?.kind === "resolved_catalog_answer"
      ? String(catalogPayload.presentationMode || "full_detail").trim().toLowerCase()
      : "full_detail";

  const resolvedCatalogClosingMode =
    catalogPayload?.kind === "resolved_catalog_answer"
      ? String(catalogPayload.closingMode || "default").trim().toLowerCase()
      : "default";

  const isActionLinkResolvedCatalogReply =
    catalogPayload?.kind === "resolved_catalog_answer" &&
    resolvedCatalogPresentationMode === "action_link";

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
      return renderCatalogChoiceBody({
        catalogPayload,
      });
    }

    if (catalogPayload?.kind === "variant_choice") {
      return renderCatalogChoiceBody({
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
      isCatalogListReply &&
      Boolean(canonicalReply);
    
    const bypassWriterModel =
      replyPolicy.shouldUseGroundedFrameOnly ||
      replyPolicy.canonicalBodyOwnsClosing ||
      isResolvedCatalogAnswer ||
      isCatalogListReply;

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
          ctxPatch.awaiting_yesno = true;
          ctxPatch.yesno_resolution = null;

          if (payload.kind === "pending_cta") {
            ctxPatch.pending_cta = {
              ...payload,
              createdAt: new Date().toISOString(),
            };
          }
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
    !isCatalogListReply &&
    !replyPolicy.shouldForceNullIntro &&
    (
      !bypassWriterModel || isResolvedCatalogAnswer
    );

  const shouldAllowOutro =
    resolvedCatalogClosingMode !== "none" &&
    !replyPolicy.shouldForceNullClosing &&
    !replyPolicy.canonicalBodyOwnsClosing;

  const shouldEndWithSalesQuestion =
    resolvedCatalogClosingMode === "default" &&
    !replyPolicy.shouldForceNullClosing &&
    !isCatalogChoiceReply &&
    replyPolicy.shouldAskQuestion;

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
    unresolvedEntity: replyPolicy.shouldOpenChoice,
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
    preserveExactBody: true,
    preserveExactOrder: true,
    preserveExactBullets: true,
    preserveExactNumbers: true,
    preserveExactLinks: true,
    allowIntro: isCatalogChoiceReply ? true : shouldAllowIntro,
    allowOutro: isCatalogChoiceReply ? true : shouldAllowOutro,
    allowBodyRewrite: false,
    mustEndWithSalesQuestion: isCatalogChoiceReply
      ? false
      : shouldEndWithSalesQuestion,
    reasoningNotes: isServiceChoiceReply
      ? "Catalog service choice turn. The canonical options body is owned by the system. Write one short intro that says these are the available options. After the canonical options body, add one short direct CTA telling the user to select the option they want. Use a clean and simple DM structure. Do not rewrite, summarize, rename, reorder, or replace the numbered options."
      : isVariantChoiceReply
      ? "Catalog variant choice turn. The canonical options body is owned by the system. Write one short intro that says the selected plan has these options. After the canonical options body, add one short direct CTA telling the user to select the option they want. Use a clean and simple DM structure. Do not say 'here is information about the plan'. Do not ask if the user wants more information. Do not mention includes, benefits, or prices. Do not rewrite, summarize, rename, reorder, or replace the numbered options."
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
          "Return one short commercial intro before the canonical body.",
          "The intro must be consultative, natural, and sales-oriented.",
          "The intro must not repeat the exact title or heading of the plan or variant if the canonical body already starts with it.",
          "Do not restate, preview, summarize, or paraphrase facts already contained in the canonical body.",
          "Do not mention prices, numbers, includes, service details, schedules, locations, policies, or links outside the canonical body.",
          resolvedCatalogClosingMode === "none"
            ? "Do not add any closing after the canonical body. Closing must be null."
            : resolvedCatalogClosingMode === "availability_statement"
            ? "After the canonical body, add one short declarative availability-style closing only if you can do so without asking a question. The closing must not be a CTA."
            : "After the canonical body, add exactly one short closing move only if it helps the user take a real next step.",
          resolvedCatalogClosingMode === "availability_statement"
            ? "The closing must be declarative, low-pressure, and availability-oriented."
            : "The closing must be consultative, natural, and sales-oriented.",

          resolvedCatalogClosingMode === "availability_statement"
            ? "Do not ask any question after the canonical body. Do not reopen booking, reservation, or process guidance."
            : "Do not ask whether the user wants more information, more details, or more explanation about the same plan or variant that was just explained.",
          "Do not use generic closings that reopen the same informational question already answered.",
          "If PROMPT_BASE contains an explicit tenant CTA or closing instruction, use it as the preferred closing whenever a closing is allowed and it does not conflict with the rules above.",
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
        ctxPatch.awaiting_yesno = true;
        ctxPatch.yesno_resolution = null;

        if (payload.kind === "pending_cta") {
          ctxPatch.pending_cta = {
            ...payload,
            createdAt: new Date().toISOString(),
          };
        }
      }
    }

    let frame = await buildGroundedFrameOnly({
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
      isActionLinkResolvedCatalogReply,
      resolvedCatalogClosingMode:
        resolvedCatalogClosingMode === "availability_statement"
          ? "availability_statement"
          : resolvedCatalogClosingMode === "none"
          ? "none"
          : "default",
    });

    if (isCatalogChoiceReply && !String(frame.intro || "").trim()) {
      frame = await buildGroundedFrameOnly({
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
        isActionLinkResolvedCatalogReply,
        resolvedCatalogClosingMode:
          resolvedCatalogClosingMode === "availability_statement"
            ? "availability_statement"
            : resolvedCatalogClosingMode === "none"
            ? "none"
            : "default",
      });
    }

    const normalizedIntro = String(frame.intro || "").trim();
    const normalizedClosing = String(frame.closing || "").trim();

    const safeIntro =
      isInfoGeneralOverviewTurn ? "" : normalizedIntro;

    if (resolvedCatalogClosingMode === "none") {
      frame = {
        intro: safeIntro || null,
        closing: null,
        closingType: "none",
      };
    } else if (resolvedCatalogClosingMode === "availability_statement") {
        frame = {
          intro: safeIntro || null,
          closing:
            frame.closingType === "availability_statement" && normalizedClosing
              ? normalizedClosing
              : null,
          closingType:
            frame.closingType === "availability_statement" && normalizedClosing
              ? "availability_statement"
              : "none",
        };
    } else {
      frame = {
        intro: safeIntro || null,
        closing: normalizedClosing || null,
        closingType: frame.closingType || "none",
      };
    }

    const renderedCanonicalBody =
      isResolvedCatalogAnswer
        ? stripFirstResolvedHeadingFromCanonicalBody({
            canonicalBody: canonicalReply,
            resolvedEntityLabel,
            resolvedServiceName: structuredService?.serviceName ?? null,
          })
        : canonicalReply;

    const dedupedCanonicalBody =
      isInfoGeneralOverviewTurn || isResolvedCatalogAnswer
        ? stripFirstCanonicalLineIfDuplicated({
            frameText: frame.intro,
            canonicalBody: renderedCanonicalBody,
          })
        : renderedCanonicalBody;

    const safeClosing =
      isInfoGeneralOverviewTurn || isResolvedCatalogAnswer
        ? nullifyFrameTextIfDuplicated({
            frameText: frame.closing,
            canonicalBody: dedupedCanonicalBody || renderedCanonicalBody,
          })
        : String(frame.closing || "").trim() || null;

    const finalGroundedReply = [
      String(frame.intro || "").trim(),
      dedupedCanonicalBody,
      String(safeClosing || "").trim(),
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

  if (fp?.awaitingEffect?.type === "set_awaiting_yes_no") {
    const payload = fp.awaitingEffect.payload || null;

    if (payload?.kind) {
      ctxPatch.awaiting_yes_no_action = payload;
      ctxPatch.awaiting_yesno = true;
      ctxPatch.yesno_resolution = null;

      if (payload.kind === "pending_cta") {
        ctxPatch.pending_cta = {
          ...payload,
          createdAt: new Date().toISOString(),
        };
      }
    }
  }

  return {
    reply: stripMarkdownLinksForDm(composed.text),
    ctxPatch,
  };
}