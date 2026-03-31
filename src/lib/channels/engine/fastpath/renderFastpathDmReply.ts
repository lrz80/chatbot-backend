import type { Canal } from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";
import { getRecentHistoryForModel } from "../messages/getRecentHistoryForModel";
import { answerWithPromptBase } from "../../../answers/answerWithPromptBase";
import { stripMarkdownLinksForDm } from "../../format/stripMarkdownLinks";

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
  };
  ctxPatch: any;
  maxLines?: number;
};

export type RenderFastpathDmReplyResult = {
  reply: string;
  ctxPatch: any;
};

function toNormalizedString(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isDmChannel(canal: Canal): boolean {
  const normalized = toNormalizedString(canal);
  return (
    normalized === "whatsapp" ||
    normalized === "facebook" ||
    normalized === "instagram"
  );
}

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
    detectedIntent,
    intentFallback,
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

  const fpSource = toNormalizedString(fp?.source);
  const fpIntent = toNormalizedString(fp?.intent);
  const detectedIntentNorm = toNormalizedString(detectedIntent);
  const intentFallbackNorm = toNormalizedString(intentFallback);

  const isCatalogDbReply = fpSource === "catalog_db";
  const isPriceSummaryReply = fpSource === "price_summary_db";
  const isPriceDisambiguationReply = fpSource === "price_disambiguation_db";
  const isGroundedCatalogReply =
    isCatalogDbReply || isPriceSummaryReply || isPriceDisambiguationReply;

  const isGroundedCatalogOverviewDm =
    isDmChannel(canal) &&
    isGroundedCatalogReply &&
    !replyPolicy.hasResolvedEntity;

  const shouldForceSalesClosingQuestion =
    isGroundedCatalogOverviewDm &&
    !ctxPatch?.pending_cta &&
    !fp?.awaitingEffect;

  const NO_NUMERIC_MENUS =
    idiomaDestino === "en"
      ? "RULE: Do NOT present numbered menus or ask the user to reply with a number. If you need clarification, ask ONE short question. Numbered picks are handled by the system, not you."
      : "REGLA: NO muestres menús numerados ni pidas que respondan con un número. Si necesitas aclarar, haz UNA sola pregunta corta. Las selecciones por número las maneja el sistema, no tú.";

  const PRICE_QUALIFIER_RULE =
    idiomaDestino === "en"
      ? "RULE: If a price is described as 'FROM/STARTING AT' (or 'desde'), you MUST keep that qualifier. Never rewrite it as an exact price. Use: 'starts at $X' / 'from $X'."
      : "REGLA: Si un precio está descrito como 'DESDE' (o 'from/starting at'), DEBES mantener ese calificativo. Nunca lo conviertas en precio exacto. Usa: 'desde $X'.";

  const NO_PRICE_INVENTION_RULE =
    idiomaDestino === "en"
      ? "RULE: Do not invent exact prices. Only mention prices if explicitly present in the provided business info or in SYSTEM_STRUCTURED_DATA, and preserve ranges/qualifiers."
      : "REGLA: No inventes precios exactos. Solo menciona precios si están explícitos en la info del negocio o en DATOS_ESTRUCTURADOS_DEL_SISTEMA, y preserva rangos/calificativos.";

  const PRICE_LIST_FORMAT_RULE =
    idiomaDestino === "en"
      ? [
          "RULE: If your reply mentions any prices or plans from SYSTEM_STRUCTURED_DATA, you MUST format them as a bullet list.",
          "- You may start with 0–1 very short intro line.",
          "- Then put ONE option per line.",
          "- NEVER put several different prices or plans in one long paragraph.",
        ].join(" ")
      : [
          "REGLA: Si tu respuesta menciona precios o planes tomados de DATOS_ESTRUCTURADOS_DEL_SISTEMA, DEBES formatearlos como lista con viñetas.",
          "- Puedes empezar con 0–1 línea muy corta.",
          "- Luego usa UNA línea por opción.",
          "- NUNCA metas varios precios o planes distintos en un solo párrafo largo.",
        ].join(" ");

  const CHANNEL_TONE_RULE =
    idiomaDestino === "en"
      ? "RULE: You may rephrase for a natural, warm, sales-oriented chat/DM tone, but DO NOT change amounts, ranges, or plan/service names."
      : "REGLA: Puedes re-redactar para que suene natural, cálido y vendedor en chat/DM, pero NO cambies montos, rangos ni nombres de planes/servicios.";

  const SALES_OPENING_RULE =
    idiomaDestino === "en"
      ? [
          "SALES OPENING RULE:",
          "- Start with one short, natural, useful line.",
          "- Sound like an advisor, not a cold catalog.",
        ].join("\n")
      : [
          "REGLA DE APERTURA COMERCIAL:",
          "- Empieza con una sola línea corta, natural y útil.",
          "- Suena como asesor, no como catálogo frío.",
        ].join("\n");

  const SALES_CTA_RULE =
    idiomaDestino === "en"
      ? [
          "SALES CTA RULE:",
          "- Close with one short next-step CTA.",
          "- Sound consultative, not pushy.",
        ].join("\n")
      : [
          "REGLA DE CTA COMERCIAL:",
          "- Cierra con un solo CTA corto.",
          "- Suena consultivo, no agresivo.",
        ].join("\n");

  const CATALOG_OVERVIEW_DM_CLOSING_RULE =
    shouldForceSalesClosingQuestion
      ? idiomaDestino === "en"
        ? [
            "CATALOG OVERVIEW DM RULE:",
            "- Because this is a catalog overview reply in DM, you MUST end with exactly one short consultative sales question.",
            "- The question must help the user continue the conversation.",
            "- Examples of intent only: ask which option interests them most, or whether they want the most affordable or the most complete option.",
            "- Do NOT add more than one question.",
            "- Do NOT mention booking times.",
            "- Do NOT change the catalog body.",
          ].join("\n")
        : [
            "REGLA PARA OVERVIEW DE CATÁLOGO EN DM:",
            "- Como esta es una respuesta de overview de catálogo en DM, DEBES cerrar con exactamente una pregunta corta, consultiva y vendedora.",
            "- La pregunta debe ayudar a que el usuario continúe la conversación.",
            "- Ejemplos de intención solamente: preguntar cuál opción le interesa más, o si busca algo más económico o más completo.",
            "- NO agregues más de una pregunta.",
            "- NO menciones horarios de reserva.",
            "- NO cambies el cuerpo del catálogo.",
          ].join("\n")
      : "";

  const GROUNDED_FRAME_RULE =
    idiomaDestino === "en"
      ? [
          "GROUNDED FRAME RULE:",
          "- Keep the structured body as the source of truth.",
          "- Do NOT rewrite, reorder, summarize, or omit the structured body.",
          "- You MUST wrap it in a natural DM-style response.",
          "- Add a short, useful opening line that feels human and consultative.",
          "- You MAY add one short closing line if it helps move the conversation forward.",
          "- The body from DATOS_ESTRUCTURADOS_DEL_SISTEMA must remain intact.",
        ].join("\n")
      : [
          "REGLA DE ENMARCADO GROUNDED:",
          "- Mantén el cuerpo estructurado como fuente de verdad.",
          "- NO reescribas, reordenes, resumas ni omitas el cuerpo estructurado.",
          "- DEBES envolverlo en una respuesta natural estilo chat/DM.",
          "- Agrega una apertura corta, útil, humana y consultiva.",
          "- PUEDES agregar un cierre corto si ayuda a mover la conversación.",
          "- El cuerpo de DATOS_ESTRUCTURADOS_DEL_SISTEMA debe permanecer intacto.",
        ].join("\n");

  const promptConFastpath = [
    promptBaseMem,
    "",
    "DATOS_ESTRUCTURADOS_DEL_SISTEMA (úsalos como fuente de verdad, sin cambiar montos ni nombres):",
    fastpathText,
    "",
    "INSTRUCCIONES_DE_ESTILO_PARA_ESTE_TURNO:",
    NO_NUMERIC_MENUS,
    PRICE_QUALIFIER_RULE,
    NO_PRICE_INVENTION_RULE,
    PRICE_LIST_FORMAT_RULE,
    CHANNEL_TONE_RULE,
    "",
    SALES_OPENING_RULE,
    "",
    SALES_CTA_RULE,
    "",
    replyPolicy.shouldUseGroundedFrameOnly ? GROUNDED_FRAME_RULE : "",
    "",
    CATALOG_OVERVIEW_DM_CLOSING_RULE,
  ]
    .filter(Boolean)
    .join("\n");

  const composed = await answerWithPromptBase({
    tenantId,
    promptBase: promptConFastpath,
    userInput,
    history,
    idiomaDestino,
    canal,
    maxLines,
    fallbackText: fastpathText,
    responsePolicy: {
      mode: replyPolicy.responsePolicyMode,
      resolvedEntityType:
        replyPolicy.hasResolvedEntity ? "service" : null,
      resolvedEntityId:
        replyPolicy.hasResolvedEntity
          ? structuredService?.serviceId ?? null
          : null,
      resolvedEntityLabel:
        replyPolicy.hasResolvedEntity
          ? structuredService?.serviceLabel ?? null
          : null,
      canMentionSpecificPrice: isGroundedCatalogReply || replyPolicy.hasResolvedEntity,
      canSelectSpecificCatalogItem: isGroundedCatalogReply || replyPolicy.hasResolvedEntity,
      canOfferBookingTimes: false,
      canUseCatalogLists: isGroundedCatalogReply || replyPolicy.hasResolvedEntity,
      canUseOfficialLinks: true,
      unresolvedEntity: !isGroundedCatalogReply && !replyPolicy.hasResolvedEntity,
      clarificationTarget:
        !isGroundedCatalogReply && !replyPolicy.hasResolvedEntity ? "service" : null,
      singleResolvedEntityOnly:
        replyPolicy.hasResolvedEntity && !isCatalogDbReply,
      allowAlternativeEntities: false,
      allowCrossSellEntities: false,
      allowAddOnSuggestions: false,
      preserveExactBody: replyPolicy.shouldUseGroundedFrameOnly,
      preserveExactOrder: replyPolicy.shouldUseGroundedFrameOnly,
      preserveExactBullets: replyPolicy.shouldUseGroundedFrameOnly,
      preserveExactNumbers: replyPolicy.shouldUseGroundedFrameOnly,
      preserveExactLinks: replyPolicy.shouldUseGroundedFrameOnly,
      allowIntro: true,
      allowOutro: true,
      allowBodyRewrite: !replyPolicy.shouldUseGroundedFrameOnly,
      mustEndWithSalesQuestion: shouldForceSalesClosingQuestion,
      reasoningNotes: isCatalogDbReply
        ? shouldForceSalesClosingQuestion
          ? "Catalog grounded overview reply in DM. Keep the structured body exactly intact, wrap it naturally, and end with exactly one short consultative sales question."
          : "Catalog grounded reply. Keep the structured body exactly intact, but wrap it in a natural, consultative DM response with a short opening and optional short closing."
        : isPriceDisambiguationReply
        ? "Variant/price disambiguation grounded reply. Keep the structured body exactly intact, but wrap it in a natural, consultative DM response with a short opening and optional short closing."
        : isPriceSummaryReply
        ? shouldForceSalesClosingQuestion
          ? "Grounded price summary overview in DM. Keep the structured body exactly intact, wrap it naturally, and end with exactly one short consultative sales question."
          : "Grounded price summary reply. Keep the structured body exactly intact, but wrap it in a natural, consultative DM response with a short opening and optional short closing."
        : null,
    },
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