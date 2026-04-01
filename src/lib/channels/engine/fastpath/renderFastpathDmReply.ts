import type { Canal } from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";
import { getRecentHistoryForModel } from "../messages/getRecentHistoryForModel";
import { answerWithPromptBase } from "../../../answers/answerWithPromptBase";
import { stripMarkdownLinksForDm } from "../../format/stripMarkdownLinks";
import { buildDmWriterPrompt } from "./buildDmWriterPrompt";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function shouldBypassWriterModel(input: {
  isCatalogDisambiguationReply: boolean;
  isGroundedCatalogReply: boolean;
  isPriceSummaryReply: boolean;
  canonicalBodyOwnsClosing: boolean;
  shouldUseGroundedFrameOnly: boolean;
}): boolean {
  if (input.isCatalogDisambiguationReply) {
    return false;
  }

  return (
    input.isGroundedCatalogReply ||
    input.isPriceSummaryReply ||
    input.canonicalBodyOwnsClosing ||
    input.shouldUseGroundedFrameOnly
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
    isPriceDisambiguationReply,
    isGroundedCatalogReply,
    shouldForceSalesClosingQuestion,
  } = replyPolicy;

  const isCatalogDisambiguationReply =
    fp?.source === "catalog_disambiguation_db" ||
    fp?.intent === "catalog_disambiguation" ||
    ctxPatch?.lastResolvedIntent === "catalog_disambiguation" ||
    isPriceDisambiguationReply === true;

  const unresolvedCatalogDisambiguation =
    isCatalogDisambiguationReply ||
    (
      fp?.intent === "catalog_disambiguation" &&
      !replyPolicy.hasResolvedEntity
    );

  const canonicalReply = normalizeText(fastpathText);

  const bypassWriterModel = shouldBypassWriterModel({
    isCatalogDisambiguationReply,
    isGroundedCatalogReply,
    isPriceSummaryReply,
    canonicalBodyOwnsClosing: replyPolicy.canonicalBodyOwnsClosing,
    shouldUseGroundedFrameOnly: replyPolicy.shouldUseGroundedFrameOnly,
  });

  const runtimeCapabilities = {
    bookingActive: false,
  };

  const responsePolicy = {
    mode: isCatalogDisambiguationReply
      ? "clarify_only"
      : replyPolicy.responsePolicyMode,
    resolvedEntityType: replyPolicy.hasResolvedEntity ? "service" : null,
    resolvedEntityId: replyPolicy.hasResolvedEntity
      ? structuredService?.serviceId ?? null
      : null,
    resolvedEntityLabel: replyPolicy.hasResolvedEntity
      ? structuredService?.serviceLabel ?? null
      : null,
    canMentionSpecificPrice:
      isGroundedCatalogReply || replyPolicy.hasResolvedEntity,
    canSelectSpecificCatalogItem:
      isGroundedCatalogReply || replyPolicy.hasResolvedEntity,
    canOfferBookingTimes: false,
    canUseOfficialLinks: true,
    unresolvedEntity:
      unresolvedCatalogDisambiguation ||
      (!isGroundedCatalogReply && !replyPolicy.hasResolvedEntity),
    clarificationTarget:
      unresolvedCatalogDisambiguation ||
      (!isGroundedCatalogReply && !replyPolicy.hasResolvedEntity)
        ? "service"
        : null,
    singleResolvedEntityOnly:
      replyPolicy.hasResolvedEntity && !isCatalogDbReply,
    allowAlternativeEntities: false,
    allowCrossSellEntities: false,
    allowAddOnSuggestions: false,
    preserveExactBody: bypassWriterModel || isCatalogDisambiguationReply,
    preserveExactOrder: bypassWriterModel || isCatalogDisambiguationReply,
    preserveExactBullets: bypassWriterModel || isCatalogDisambiguationReply,
    preserveExactNumbers: bypassWriterModel || isCatalogDisambiguationReply,
    preserveExactLinks: bypassWriterModel || isCatalogDisambiguationReply,
    allowIntro: !bypassWriterModel,
    allowOutro:
      !bypassWriterModel &&
      !replyPolicy.canonicalBodyOwnsClosing,
    allowBodyRewrite: false,
    mustEndWithSalesQuestion:
      !bypassWriterModel &&
      !isCatalogDisambiguationReply &&
      shouldForceSalesClosingQuestion &&
      !replyPolicy.canonicalBodyOwnsClosing,
    reasoningNotes: isCatalogDisambiguationReply
      ? "Catalog disambiguation turn. Keep the canonical body exact, do not resolve or expand it, and add a short conversational intro that helps the user choose from the shown options."
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
    fastpathText,
  });

  const composed = await answerWithPromptBase({
    tenantId,
    promptBase: promptConFastpath,
    userInput,
    history,
    idiomaDestino,
    canal,
    maxLines,
    fallbackText: fastpathText,
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