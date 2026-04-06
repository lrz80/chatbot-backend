// src/lib/answers/answerWithPromptBase.ts
import OpenAI from "openai";
import pool from "../db";
import { detectarIdioma } from "../detectarIdioma";
import { traducirMensaje } from "../traducirMensaje";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  getOfficialLinksForTenant,
  renderOfficialLinksSection,
} from "../prompts/officialLinks";
import type { LangCode } from "../i18n/lang";
import { normalizeLangCode } from "../i18n/lang";

type ResolvedEntityType =
  | "service"
  | "variant"
  | "booking"
  | "plan"
  | "package"
  | "other"
  | null;

type ResponseMode =
  | "normal"
  | "clarify_only"
  | "grounded_only"
  | "grounded_frame_only";

type ResponsePolicy = {
  mode?: ResponseMode;
  resolvedEntityType?: ResolvedEntityType;
  resolvedEntityId?: string | null;
  resolvedEntityLabel?: string | null;
  canMentionSpecificPrice?: boolean;
  canSelectSpecificCatalogItem?: boolean;
  canOfferBookingTimes?: boolean;
  canUseOfficialLinks?: boolean;
  unresolvedEntity?: boolean;
  clarificationTarget?: string | null;
  reasoningNotes?: string | null;

  singleResolvedEntityOnly?: boolean;
  allowAlternativeEntities?: boolean;
  allowCrossSellEntities?: boolean;
  allowAddOnSuggestions?: boolean;

  preserveExactBody?: boolean;
  preserveExactOrder?: boolean;
  preserveExactBullets?: boolean;
  preserveExactNumbers?: boolean;
  preserveExactLinks?: boolean;
  allowIntro?: boolean;
  allowOutro?: boolean;
  allowBodyRewrite?: boolean;

  mustEndWithSalesQuestion?: boolean;
};

type RuntimeCapabilities = {
  bookingActive?: boolean;
};

type AnswerWithPromptBaseParams = {
  tenantId: string;
  promptBase: string;
  userInput: string;
  history?: ChatCompletionMessageParam[];
  idiomaDestino: LangCode;
  canal: string;
  maxLines?: number;
  fallbackText?: string;
  extraContext?: string;
  responsePolicy?: ResponsePolicy | null;
  runtimeCapabilities?: RuntimeCapabilities | null;
};

/* =========================
   Helpers defensivos
========================= */

function sanitizeChatOutput(text: string) {
  if (!text) return "";

  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
}

function capLines(text: string, maxLines: number) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n").trim();
}


function stripUrlsIfPromptHasNone(out: string, promptBase: string) {
  const promptHasUrl = /https?:\/\/\S+/i.test(promptBase);
  if (promptHasUrl) return out;

  return out
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

type PendingCtaType = "estimate_offer" | "booking_offer";

type PendingCta =
  | {
      type: PendingCtaType;
      awaitsConfirmation: true;
    }
  | null;

type ModelAnswerEnvelope = {
  text: string;
  pendingCta: PendingCta;
};

function parseModelAnswerEnvelope(raw: string): ModelAnswerEnvelope | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);

    const replyText =
      typeof parsed?.text === "string" ? parsed.text.trim() : "";

    const rawPending = parsed?.pendingCta;
    const pendingCta: PendingCta =
      rawPending &&
      (rawPending.type === "estimate_offer" ||
        rawPending.type === "booking_offer") &&
      rawPending.awaitsConfirmation === true
        ? {
            type: rawPending.type,
            awaitsConfirmation: true,
          }
        : null;

    if (!replyText) return null;

    return {
      text: replyText,
      pendingCta,
    };
  } catch {
    return null;
  }
}

type CanonicalFrameEnvelope = {
  intro: string | null;
  closing: string | null;
  pendingCta: PendingCta;
};

function parseCanonicalFrameEnvelope(raw: string): CanonicalFrameEnvelope | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);

    const intro =
      typeof parsed?.intro === "string" && parsed.intro.trim()
        ? parsed.intro.trim()
        : null;

    const closing =
      typeof parsed?.closing === "string" && parsed.closing.trim()
        ? parsed.closing.trim()
        : null;

    const rawPending = parsed?.pendingCta;
    const pendingCta: PendingCta =
      rawPending &&
      (rawPending.type === "estimate_offer" ||
        rawPending.type === "booking_offer") &&
      rawPending.awaitsConfirmation === true
        ? {
            type: rawPending.type,
            awaitsConfirmation: true,
          }
        : null;

    return {
      intro,
      closing,
      pendingCta,
    };
  } catch {
    return null;
  }
}

type GroundedFrameEnvelope = {
  intro: string | null;
  closing: string | null;
  pendingCta: PendingCta;
};

function normalizeResponsePolicy(
  policy?: ResponsePolicy | null
): Required<ResponsePolicy> {
  const mode = policy?.mode ?? "normal";
  const mustPreserveCanonicalBody = mode === "grounded_frame_only";

  return {
    mode,
    resolvedEntityType: policy?.resolvedEntityType ?? null,
    resolvedEntityId: policy?.resolvedEntityId ?? null,
    resolvedEntityLabel: policy?.resolvedEntityLabel ?? null,
    canMentionSpecificPrice: policy?.canMentionSpecificPrice ?? true,
    canSelectSpecificCatalogItem: policy?.canSelectSpecificCatalogItem ?? true,
    canOfferBookingTimes: policy?.canOfferBookingTimes ?? true,
    canUseOfficialLinks: policy?.canUseOfficialLinks ?? true,
    unresolvedEntity: policy?.unresolvedEntity ?? false,
    clarificationTarget: policy?.clarificationTarget ?? null,
    reasoningNotes: policy?.reasoningNotes ?? null,

    singleResolvedEntityOnly: policy?.singleResolvedEntityOnly ?? false,
    allowAlternativeEntities: policy?.allowAlternativeEntities ?? true,
    allowCrossSellEntities: policy?.allowCrossSellEntities ?? true,
    allowAddOnSuggestions: policy?.allowAddOnSuggestions ?? true,

    preserveExactBody:
      policy?.preserveExactBody ?? mustPreserveCanonicalBody,
    preserveExactOrder:
      policy?.preserveExactOrder ?? mustPreserveCanonicalBody,
    preserveExactBullets:
      policy?.preserveExactBullets ?? mustPreserveCanonicalBody,
    preserveExactNumbers:
      policy?.preserveExactNumbers ?? mustPreserveCanonicalBody,
    preserveExactLinks:
      policy?.preserveExactLinks ?? mustPreserveCanonicalBody,
    allowIntro: policy?.allowIntro ?? true,
    allowOutro: policy?.allowOutro ?? true,
    allowBodyRewrite: policy?.allowBodyRewrite ?? !mustPreserveCanonicalBody,

    mustEndWithSalesQuestion: policy?.mustEndWithSalesQuestion ?? false,
  };
}

function buildResponsePolicyBlock(policy: Required<ResponsePolicy>): string {
  return [
    "RESPONSE_POLICY_JSON:",
    JSON.stringify(policy, null, 2),
  ].join("\n");
}

function buildInstructionBlock(
  idiomaDestino: LangCode,
  maxLines: number,
  policy: Required<ResponsePolicy>
): string {
  const responseLanguage = idiomaDestino === "es" ? "Español" : "English";

  const base = [
    "OUTPUT_RULES:",
    `- response_language = ${responseLanguage}`,
    `- max_lines = ${maxLines}`,
    "- style = concise_chat",
    "- use_only_grounded_business_data = true",
    "- if_data_missing = say_so_without_inventing",

    "- if_response_policy_mode = clarify_only_then_output_only_a_brief_clarification_question",

    "- if_response_policy_disallows_specific_catalog_item_then_do_not_choose_or_recommend_one",
    "- if_response_policy_disallows_specific_price_then_do_not_output_numeric_price",
    "- if_response_policy_disallows_booking_times_then_do_not_propose_dates_or times",
    "- if_response_policy_disallows_official_links_then_do_not include_links",

    "- if_structured_turn_data_exists_then_it_has_highest_priority",
    "- answer_as_business = true",

    // 🔥 NUEVO: reglas comerciales duras
    "- if_mustEndWithSalesQuestion = true_then_the_closing_must_be_a_guided_sales_question",
    "- if_allowOutro = true_and_sales_context_detected_then_include_a_clear_next_step",
    "- do_not_end_without_direction_if_sales_intent_present = true",
  ];

  if (policy.mode === "clarify_only" && policy.preserveExactBody) {
    base.push(
      "- clarification_with_canonical_body = true",
      "- the_system_will_render_the_canonical_options_body = true",
      "- write_a_short_conversational_intro_before_the_canonical_body = true",
      "- do_not_return_intro_null_in_this_mode = true",
      "- do_not_resolve_the_ambiguity = true",
      "- do_not_explain_includes_or_prices = true",
      "- do_not_replace_the_canonical_options_with_a_summary = true"
    );
  }

  if (policy.mode === "grounded_frame_only") {
    base.push(
      "- grounded_frame_only = true",
      "- fallback_text_is_canonical_body = true",
      "- do_not_rewrite_or_summarize_the_canonical_body = true",
      "- do_not_change_order_of_items_in_canonical_body = true",
      "- do_not_change_bullets_in_canonical_body = true",
      "- do_not_change_numbers_prices_or_links_in_canonical_body = true",
      "- you_may_only_add_a_short_intro_before_the_canonical_body_if_allowed = true",
      "- you_may_only_add_a_short_outro_after_the_canonical_body_if_allowed = true",
      "- never_replace_the_canonical_body_with_new_text = true"
    );
  }

  return base.join("\n");
}

function buildEntityLockBlock(
  idiomaDestino: LangCode,
  policy: Required<ResponsePolicy>
): string {
  const lines: string[] = ["ENTITY_LOCK_RULES:"];

  if (policy.singleResolvedEntityOnly) {
    if (idiomaDestino === "es") {
      lines.push("- el_sistema_ya_resolvio_exactamente_una_entidad = true");
      lines.push("- habla_solo_de_la_entidad_resuelta = true");
      lines.push("- no_introduzcas_una_segunda_entidad = true");
      lines.push("- no_compares_con_otros_servicios_o_planes = true");
      lines.push("- no_sugieras_add_ons_complementos_o_extras = true");
      lines.push("- no_uses_o_seguido_de_otro_servicio = true");
    } else {
      lines.push("- the_system_has_resolved_exactly_one_entity = true");
      lines.push("- talk_only_about_the_resolved_entity = true");
      lines.push("- do_not_introduce_second_entity = true");
      lines.push("- do_not_compare_with_other_services_or_plans = true");
      lines.push("- do_not_suggest_add_ons_or_extras = true");
      lines.push("- do_not_use_or_followed_by_another_service = true");
    }
  }

  if (!policy.allowAlternativeEntities) {
    lines.push("- alternative_entities_allowed = false");
  }

  if (!policy.allowCrossSellEntities) {
    lines.push("- cross_sell_entities_allowed = false");
  }

  if (!policy.allowAddOnSuggestions) {
    lines.push("- addon_suggestions_allowed = false");
  }

  return lines.join("\n");
}

function buildUserPrompt(
  userInput: string,
  policy: Required<ResponsePolicy>,
  hasCanonicalFallback: boolean
) {
  const mustPreserveCanonicalBody =
    hasCanonicalFallback && shouldUseCanonicalBodyComposition(policy);

  return [
    "MENSAJE_USUARIO:",
    userInput,
    "",
    "TASK:",
    "- Produce the final customer-facing reply.",
    "- Obey RESPONSE_POLICY_JSON and OUTPUT_RULES.",
    "- Return STRICT JSON only.",
    ...(mustPreserveCanonicalBody
      ? [
          '- Use this exact shape: {"intro":null,"closing":null,"pendingCta":null}',
          "- The canonical fallback body is owned by the system.",
          "- Do not rewrite, replace, summarize, merge, expand, or resolve the canonical body.",
          "- The canonical fallback body is owned by the system.",
          "- Do not rewrite, replace, summarize, merge, expand, or resolve the canonical body.",
          "- You may only provide an intro and/or a closing if allowed by the response policy.",
          ...(policy.mode === "clarify_only"
            ? [
                "- Because this is a clarification turn, intro is required.",
                "- The intro must be one short conversational line that preserves continuity with the user's last message.",
                "- The intro must not resolve the ambiguity or invent catalog facts.",
                "- The intro should guide the user to choose from the canonical options shown by the system.",
                "- closing should normally be null unless the response policy explicitly allows and needs one.",
                '- Use this exact shape: {"intro":"...", "closing":null, "pendingCta":null}',
              ]
            : [
                ...(policy.allowIntro
                  ? [
                      "- intro is required and must be a short conversational framing line.",
                    ]
                  : [
                      "- intro must be null.",
                    ]),
                ...((policy.allowOutro || policy.mustEndWithSalesQuestion)
                  ? [
                      "- closing is required and must be a short guided closing line.",
                    ]
                  : [
                      "- closing must be null.",
                    ]),
                '- Use this exact shape: {"intro":"...", "closing":"...", "pendingCta":null} when intro/closing are required.',
                '- Use null only for fields that are explicitly not allowed by the response policy.',
              ]),
          "- Only include pendingCta if the response policy clearly supports an immediate confirmation-oriented next step.",
          "- Never include pendingCta for greetings, general information, exploratory questions, overview turns, or low-intent turns.",
          "- booking_offer is only valid when the user is clearly ready to book now.",
          "- estimate_offer is only valid when the user is clearly asking for a quote/estimate and is ready to proceed now.",
        ]
      : [
          '- Use this exact shape: {"text":"...", "pendingCta":null}',
          "- Only include pendingCta if the response policy clearly supports an immediate confirmation-oriented next step.",
          "- Never include pendingCta for greetings, general information, exploratory questions, overview turns, or low-intent turns.",
          "- booking_offer is only valid when the user is clearly ready to book now.",
          "- estimate_offer is only valid when the user is clearly asking for a quote/estimate and is ready to proceed now.",
        ]),
    "- Do not wrap the JSON in markdown fences.",
  ].join("\n");
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

function shouldStripFirstCanonicalLineFromBody(args: {
  intro?: string | null;
  canonicalBody: string;
}): boolean {
  const intro = String(args.intro || "").trim();
  const canonicalBody = String(args.canonicalBody || "").trim();

  if (!intro || !canonicalBody) return false;

  const firstCanonicalLine = getFirstNonEmptyLine(canonicalBody);
  if (!firstCanonicalLine) return false;

  const normalizedIntro = normalizeComparableText(intro);
  const normalizedFirstLine = normalizeComparableText(firstCanonicalLine);

  if (!normalizedIntro || !normalizedFirstLine) return false;

  if (
    normalizedIntro === normalizedFirstLine ||
    normalizedIntro.includes(normalizedFirstLine)
  ) {
    return true;
  }

  const overlapRatio = getTokenOverlapRatio(intro, firstCanonicalLine);
  return overlapRatio >= 0.9;
}

function stripFirstCanonicalLineIfDuplicated(args: {
  intro?: string | null;
  canonicalBody: string;
}): string {
  const canonicalBody = String(args.canonicalBody || "").trim();
  if (!canonicalBody) return "";

  if (!shouldStripFirstCanonicalLineFromBody(args)) {
    return canonicalBody;
  }

  const lines = canonicalBody
    .split("\n")
    .map((line) => line.trim());

  let removed = false;
  const nextLines: string[] = [];

  for (const line of lines) {
    if (!removed && line) {
      removed = true;
      continue;
    }

    if (line) {
      nextLines.push(line);
    }
  }

  return nextLines.join("\n").trim();
}

function composeCanonicalReply(input: {
  canonicalBody: string;
  intro?: string | null;
  closing?: string | null;
  allowIntro?: boolean;
  allowOutro?: boolean;
  dedupeIntroAgainstCanonicalBody?: boolean;
}): string {
  const parts: string[] = [];

  let canonicalBody = String(input.canonicalBody || "").trim();
  const intro = String(input.intro || "").trim();
  const closing = String(input.closing || "").trim();

  if (input.dedupeIntroAgainstCanonicalBody === true) {
    canonicalBody = stripFirstCanonicalLineIfDuplicated({
      intro,
      canonicalBody,
    });
  }

  if (input.allowIntro && intro) {
    parts.push(intro);
  }

  if (canonicalBody) {
    parts.push(canonicalBody);
  }

  if (input.allowOutro && closing) {
    parts.push(closing);
  }

  return parts.join("\n").trim();
}

function shouldUseCanonicalBodyComposition(
  policy: Required<ResponsePolicy>
): boolean {
  return (
    policy.preserveExactBody === true ||
    policy.preserveExactOrder === true ||
    policy.preserveExactBullets === true ||
    policy.preserveExactNumbers === true ||
    policy.preserveExactLinks === true
  );
}

function hasUsableCanonicalFrame(
  frame: CanonicalFrameEnvelope | null,
  policy: Required<ResponsePolicy>
): boolean {
  const needsIntro = policy.allowIntro === true;
  const needsClosing =
    policy.allowOutro === true || policy.mustEndWithSalesQuestion === true;

  const hasIntro = Boolean(String(frame?.intro || "").trim());
  const hasClosing = Boolean(String(frame?.closing || "").trim());

  if (needsIntro && !hasIntro) return false;
  if (needsClosing && !hasClosing) return false;

  return true;
}

async function forceMissingClosingFrame(args: {
  openai: OpenAI;
  model: string;
  systemPrompt: string;
  history: ChatCompletionMessageParam[];
  userPrompt: string;
}): Promise<CanonicalFrameEnvelope | null> {
  const completion = await args.openai.chat.completions.create({
    model: args.model,
    temperature: 0,
    max_tokens: 120,
    messages: [
      { role: "system", content: args.systemPrompt },
      ...(Array.isArray(args.history) ? args.history : []),
      {
        role: "user",
        content: [
          args.userPrompt,
          "",
          "VALIDATION_ERROR:",
          "- closing is mandatory for this response.",
          "- Return STRICT JSON only.",
          '- Use this exact shape: {"intro":null,"closing":"...","pendingCta":null}',
          "- intro must be null.",
          "- closing must not be null or empty.",
          "- Follow the tenant-specific closing policy from PROMPT_BASE if present.",
          "- Do not rewrite, summarize, or replace the canonical body.",
          "- Generate only the missing closing field.",
        ].join("\n"),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "";
  return parseCanonicalFrameEnvelope(raw);
}

/* =========================
   Main function
========================= */

export async function answerWithPromptBase(
  params: AnswerWithPromptBaseParams
): Promise<{ text: string; pendingCta: PendingCta }> {
  console.log("[ANSWER_WITH_PROMPT_BASE][VERSION]", {
    tenantId: params.tenantId,
    canal: params.canal,
    userInput: params.userInput,
    hasResponsePolicy: Boolean(params.responsePolicy),
    responsePolicyMode: params.responsePolicy?.mode ?? null,
    reasoningNotes: params.responsePolicy?.reasoningNotes ?? null,
  });

  const {
    tenantId,
    promptBase,
    userInput,
    history = [],
    idiomaDestino,
    canal,
    maxLines = 9999,
    fallbackText = "",
    extraContext = "",
    responsePolicy,
    runtimeCapabilities,
  } = params;

  const normalizedIdiomaDestino = normalizeLangCode(idiomaDestino) ?? "en";

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
  });

  const normalizedPolicy = normalizeResponsePolicy(responsePolicy);

  let promptBaseWithLinks = promptBase;

  try {
    if (normalizedPolicy.canUseOfficialLinks) {
      const links = await getOfficialLinksForTenant(tenantId);
      const section = renderOfficialLinksSection(links, normalizedIdiomaDestino);

      if (section.trim()) {
        promptBaseWithLinks = [promptBase, "", section].join("\n");
      }
    }
  } catch (e) {
    console.warn("⚠️ No se pudieron cargar ENLACES_OFICIALES para el prompt:", e);
  }

  const bookingActive =
    runtimeCapabilities?.bookingActive === true;

  const effectivePolicy: Required<ResponsePolicy> = {
    ...normalizedPolicy,
    canMentionSpecificPrice: normalizedPolicy.canMentionSpecificPrice,
    canOfferBookingTimes:
      normalizedPolicy.canOfferBookingTimes && bookingActive,
  };

  const shouldComposeCanonicalBody =
    Boolean(String(fallbackText || "").trim()) &&
    shouldUseCanonicalBodyComposition(effectivePolicy);

  if (
    effectivePolicy.mode === "grounded_frame_only" &&
    shouldComposeCanonicalBody &&
    effectivePolicy.allowIntro !== true &&
    effectivePolicy.allowOutro !== true &&
    effectivePolicy.mustEndWithSalesQuestion !== true
  ) {
    return {
      text: String(fallbackText || "").trim(),
      pendingCta: null,
    };
  }

  const runtimeCapabilitiesBlock = [
    "RUNTIME_CAPABILITIES:",
    JSON.stringify(
      {
        bookingActive,
      },
      null,
      2
    ),
  ].join("\n");

  const systemPromptParts = [
    promptBaseWithLinks,
    "",
    runtimeCapabilitiesBlock,
    "",
    buildResponsePolicyBlock(effectivePolicy),
    "",
    buildInstructionBlock(normalizedIdiomaDestino, maxLines, effectivePolicy),
    "",
    buildEntityLockBlock(normalizedIdiomaDestino, effectivePolicy),
    "",
    extraContext ? `DATOS_ESTRUCTURADOS_DEL_TURNO:\n${extraContext}` : "",
    "",
    `CHANNEL_CONTEXT: ${canal}`,
  ].filter(Boolean);

  const systemPrompt = systemPromptParts.join("\n");
    const userPrompt = buildUserPrompt(
    userInput,
    effectivePolicy,
    Boolean(String(fallbackText || "").trim())
  );

  let out = "";
  let rawModelOutputForPendingCta = "";

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        ...(Array.isArray(history) ? history : []),
        { role: "user", content: userPrompt },
      ],
    });

    const used = completion.usage?.total_tokens ?? 0;
    if (used > 0) {
      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
         VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
         ON CONFLICT (tenant_id, canal, mes)
         DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenantId, used]
      );
    }

  const rawModelOutput =
    completion.choices[0]?.message?.content?.trim() || "";

  rawModelOutputForPendingCta = rawModelOutput;

  let parsedEnvelope = shouldComposeCanonicalBody
    ? null
    : parseModelAnswerEnvelope(rawModelOutput);

  let parsedCanonicalFrame = shouldComposeCanonicalBody
    ? parseCanonicalFrameEnvelope(rawModelOutput)
    : null;

  if (
    shouldComposeCanonicalBody &&
    effectivePolicy.mode === "grounded_frame_only" &&
    !hasUsableCanonicalFrame(parsedCanonicalFrame, effectivePolicy)
  ) {
    const retryCompletion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      max_tokens: 250,
      messages: [
        { role: "system", content: systemPrompt },
        ...(Array.isArray(history) ? history : []),
        {
          role: "user",
          content: [
            userPrompt,
            "",
            "VALIDATION_ERROR:",
            "- The previous JSON did not satisfy the response policy.",
            "- Return strict JSON again.",
            "- Provide intro if allowIntro=true.",
            "- If allowOutro=true or mustEndWithSalesQuestion=true, closing is mandatory and must not be null or empty.",
            "- Follow the tenant-specific closing policy from PROMPT_BASE if present.",
            "- Do not rewrite the canonical body.",
            "- Only regenerate the JSON frame fields."
          ].join("\n"),
        },
      ],
    });

    const retryRaw =
      retryCompletion.choices[0]?.message?.content?.trim() || "";

    rawModelOutputForPendingCta = retryRaw;
    parsedCanonicalFrame = parseCanonicalFrameEnvelope(retryRaw);
  }

    const requiresClosing =
    shouldComposeCanonicalBody &&
    (effectivePolicy.allowOutro === true ||
      effectivePolicy.mustEndWithSalesQuestion === true);

  const hasClosing =
    typeof parsedCanonicalFrame?.closing === "string" &&
    parsedCanonicalFrame.closing.trim().length > 0;

  if (
    shouldComposeCanonicalBody &&
    requiresClosing &&
    !hasClosing
  ) {
    const forcedFrame = await forceMissingClosingFrame({
      openai,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      systemPrompt,
      history: Array.isArray(history) ? history : [],
      userPrompt,
    });

    if (forcedFrame?.closing?.trim()) {
      parsedCanonicalFrame = {
        intro:
          effectivePolicy.allowIntro === true
            ? parsedCanonicalFrame?.intro ?? null
            : null,
        closing: forcedFrame.closing.trim(),
        pendingCta: forcedFrame.pendingCta ?? null,
      };
      rawModelOutputForPendingCta = JSON.stringify(parsedCanonicalFrame);
    }
  }

  out = shouldComposeCanonicalBody
    ? composeCanonicalReply({
        canonicalBody: String(fallbackText || "").trim(),
        intro: parsedCanonicalFrame?.intro ?? null,
        closing: parsedCanonicalFrame?.closing ?? null,
        allowIntro: effectivePolicy.allowIntro,
        allowOutro:
          effectivePolicy.allowOutro || effectivePolicy.mustEndWithSalesQuestion,
        dedupeIntroAgainstCanonicalBody:
          effectivePolicy.mode === "grounded_frame_only",
      })
    : parsedEnvelope?.text || rawModelOutput || fallbackText || "";

  console.log("[ANSWER_WITH_PROMPT_BASE][RAW_MODEL_OUTPUT]", {
    tenantId,
    canal,
    userInput,
    rawModelOutput,
    parsedEnvelope,
    parsedCanonicalFrame,
    selectedOut: out,
    usedCanonicalBodyComposition: shouldComposeCanonicalBody,
    preserveExactBody: effectivePolicy.preserveExactBody,
  });

  } catch (e) {
    console.warn("❌ answerWithPromptBase LLM error; using fallback:", e);
    rawModelOutputForPendingCta = "";
    out = fallbackText || "";
  }

  out = sanitizeChatOutput(out);

  if (!shouldComposeCanonicalBody) {
    out = stripUrlsIfPromptHasNone(out, promptBaseWithLinks);
    out = capLines(out, maxLines);
  }

  console.log("[ANSWER_WITH_PROMPT_BASE][POST_PRESERVE]", {
    tenantId,
    canal,
    userInput,
    fallbackText,
    finalOut: out,
    preserveExactBody: effectivePolicy.preserveExactBody,
    preserveExactOrder: effectivePolicy.preserveExactOrder,
    preserveExactBullets: effectivePolicy.preserveExactBullets,
    preserveExactNumbers: effectivePolicy.preserveExactNumbers,
    preserveExactLinks: effectivePolicy.preserveExactLinks,
  });

  if (!shouldComposeCanonicalBody) {
    try {
      if (out) {
        const detected = await detectarIdioma(out);
        const langOut = detected?.lang ?? null;

        if (langOut && langOut !== normalizedIdiomaDestino) {
          out = await traducirMensaje(out, normalizedIdiomaDestino);
          out = sanitizeChatOutput(out);
          out = capLines(out, maxLines);
        }
      }
    } catch (e) {
      console.warn("⚠️ No se pudo ajustar el idioma en answerWithPromptBase:", e);
    }
  }

  let pendingCta: PendingCta = null;

  try {
    if (shouldComposeCanonicalBody) {
      const reparsedCanonicalFrame =
        parseCanonicalFrameEnvelope(rawModelOutputForPendingCta);
      pendingCta = reparsedCanonicalFrame?.pendingCta ?? null;
    } else {
      const reparsedEnvelope =
        parseModelAnswerEnvelope(rawModelOutputForPendingCta);
      pendingCta = reparsedEnvelope?.pendingCta ?? null;
    }
  } catch {
    pendingCta = null;
  }

  return {
    text: out,
    pendingCta,
  };
}