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
  idiomaDestino: "es" | "en";
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

function parseGroundedFrameEnvelope(raw: string): GroundedFrameEnvelope | null {
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

function normalizeResponsePolicy(
  policy?: ResponsePolicy | null
): Required<ResponsePolicy> {
  return {
    mode: policy?.mode ?? "normal",
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

    preserveExactBody: policy?.preserveExactBody ?? false,
    preserveExactOrder: policy?.preserveExactOrder ?? false,
    preserveExactBullets: policy?.preserveExactBullets ?? false,
    preserveExactNumbers: policy?.preserveExactNumbers ?? false,
    preserveExactLinks: policy?.preserveExactLinks ?? false,
    allowIntro: policy?.allowIntro ?? true,
    allowOutro: policy?.allowOutro ?? true,
    allowBodyRewrite: policy?.allowBodyRewrite ?? true,

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
  idiomaDestino: "es" | "en",
  maxLines: number,
  policy: Required<ResponsePolicy>
): string {
  const responseLanguage = idiomaDestino === "en" ? "English" : "Español";

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
  idiomaDestino: "es" | "en",
  policy: Required<ResponsePolicy>
): string {
  const lines: string[] = ["ENTITY_LOCK_RULES:"];

  if (policy.singleResolvedEntityOnly) {
    if (idiomaDestino === "en") {
      lines.push("- the_system_has_resolved_exactly_one_entity = true");
      lines.push("- talk_only_about_the_resolved_entity = true");
      lines.push("- do_not_introduce_second_entity = true");
      lines.push("- do_not_compare_with_other_services_or_plans = true");
      lines.push("- do_not_suggest_add_ons_or_extras = true");
      lines.push("- do_not_use_or_followed_by_another_service = true");
    } else {
      lines.push("- el_sistema_ya_resolvio_exactamente_una_entidad = true");
      lines.push("- habla_solo_de_la_entidad_resuelta = true");
      lines.push("- no_introduzcas_una_segunda_entidad = true");
      lines.push("- no_compares_con_otros_servicios_o_planes = true");
      lines.push("- no_sugieras_add_ons_complementos_o_extras = true");
      lines.push("- no_uses_o_seguido_de_otro_servicio = true");
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
                "- If no intro or closing is needed, return them as null.",
                '- Use this exact shape: {"intro":null,"closing":null,"pendingCta":null}',
              ]),
          '- If the reply includes a confirmation-oriented CTA for booking, use: {"intro":null,"closing":null,"pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
          '- If the reply includes a confirmation-oriented CTA for estimate, use: {"intro":null,"closing":null,"pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
        ]
      : [
          '- Use this exact shape: {"text":"...", "pendingCta":null}',
          '- If the reply includes a confirmation-oriented CTA for booking, use: {"text":"...", "pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
          '- If the reply includes a confirmation-oriented CTA for estimate, use: {"text":"...", "pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
        ]),
    "- Do not wrap the JSON in markdown fences.",
  ].join("\n");
}

function composeCanonicalReply(input: {
  canonicalBody: string;
  intro?: string | null;
  closing?: string | null;
  allowIntro?: boolean;
  allowOutro?: boolean;
}): string {
  const parts: string[] = [];

  if (input.allowIntro && String(input.intro || "").trim()) {
    parts.push(String(input.intro || "").trim());
  }

  if (String(input.canonicalBody || "").trim()) {
    parts.push(String(input.canonicalBody || "").trim());
  }

  if (input.allowOutro && String(input.closing || "").trim()) {
    parts.push(String(input.closing || "").trim());
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

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
  });

  const normalizedPolicy = normalizeResponsePolicy(responsePolicy);

  let promptBaseWithLinks = promptBase;

  try {
    if (normalizedPolicy.canUseOfficialLinks) {
      const links = await getOfficialLinksForTenant(tenantId);
      const section = renderOfficialLinksSection(links, idiomaDestino);

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

  if (
    effectivePolicy.mode === "grounded_frame_only" &&
    shouldUseCanonicalBodyComposition(effectivePolicy) &&
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
    buildInstructionBlock(idiomaDestino, maxLines, effectivePolicy),
    "",
    buildEntityLockBlock(idiomaDestino, effectivePolicy),
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

    const shouldComposeCanonicalBody =
    Boolean(String(fallbackText || "").trim()) &&
    shouldUseCanonicalBodyComposition(effectivePolicy);

  const parsedEnvelope = shouldComposeCanonicalBody
    ? null
    : parseModelAnswerEnvelope(rawModelOutput);

  const parsedCanonicalFrame = shouldComposeCanonicalBody
    ? parseCanonicalFrameEnvelope(rawModelOutput)
    : null;

  out = shouldComposeCanonicalBody
    ? (
        effectivePolicy.allowIntro ||
        effectivePolicy.allowOutro ||
        effectivePolicy.mustEndWithSalesQuestion
          ? composeCanonicalReply({
              canonicalBody: String(fallbackText || "").trim(),
              intro: parsedCanonicalFrame?.intro ?? null,
              closing: parsedCanonicalFrame?.closing ?? null,
              allowIntro: effectivePolicy.allowIntro,
              allowOutro: effectivePolicy.allowOutro,
            })
          : String(fallbackText || "").trim()
      )
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

  out = stripUrlsIfPromptHasNone(out, promptBaseWithLinks);
  out = capLines(out, maxLines);

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

  try {
    if (out) {
      const detected = await detectarIdioma(out);
      const langOut = detected?.lang ?? null;

      if ((langOut === "es" || langOut === "en") && langOut !== idiomaDestino) {
        out = await traducirMensaje(out, idiomaDestino);
        out = sanitizeChatOutput(out);
        out = capLines(out, maxLines);
      }
    }
  } catch (e) {
    console.warn("⚠️ No se pudo ajustar el idioma en answerWithPromptBase:", e);
  }

  let pendingCta: PendingCta = null;

  try {
    const shouldComposeCanonicalBody =
      Boolean(String(fallbackText || "").trim()) &&
      shouldUseCanonicalBodyComposition(effectivePolicy);

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