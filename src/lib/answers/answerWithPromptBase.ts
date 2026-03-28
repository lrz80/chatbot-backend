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
  canUseCatalogLists?: boolean;
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

function cleanOneLine(s: string) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(arr: string[]) {
  return Array.from(new Set(arr.map((x) => cleanOneLine(x)).filter(Boolean)));
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

async function buildCatalogDbContext(tenantId: string): Promise<string> {
  try {
    const servicesRes = await pool.query<{
      id: string;
      name: string;
      description: string | null;
    }>(
      `
      SELECT id, name, description
      FROM services
      WHERE tenant_id = $1
        AND active = true
      ORDER BY name ASC
      LIMIT 80
      `,
      [tenantId]
    );

    const variantsRes = await pool.query<{
      service_id: string;
      service_name: string;
      variant_name: string | null;
      description: string | null;
    }>(
      `
      SELECT
        v.service_id,
        s.name AS service_name,
        v.variant_name,
        v.description
      FROM service_variants v
      JOIN services s
        ON s.id = v.service_id
      WHERE s.tenant_id = $1
        AND s.active = true
        AND v.active = true
      ORDER BY s.name ASC, v.created_at ASC, v.id ASC
      LIMIT 120
      `,
      [tenantId]
    );

    const serviceLines = uniqueStrings(
      (servicesRes.rows || []).map((r) => `- ${cleanOneLine(r.name)}`)
    );

    const variantLines = uniqueStrings(
      (variantsRes.rows || [])
        .filter((r) => cleanOneLine(r.variant_name || "").length > 0)
        .map(
          (r) =>
            `- ${cleanOneLine(r.service_name)} — ${cleanOneLine(
              r.variant_name || ""
            )}`
        )
    );

    const parts: string[] = [];

    if (serviceLines.length > 0) {
      parts.push("SERVICIOS_VALIDOS_DB:", ...serviceLines);
    }

    if (variantLines.length > 0) {
      parts.push("", "VARIANTES_VALIDAS_DB:", ...variantLines);
    }

    return parts.join("\n").trim();
  } catch (e) {
    console.warn("⚠️ No se pudo construir SERVICIOS_VALIDOS_DB:", e);
    return "";
  }
}

async function getBookingActiveForTenant(tenantId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ enabled: boolean | null }>(
      `
      SELECT enabled
      FROM appointment_settings
      WHERE tenant_id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    return rows[0]?.enabled === true;
  } catch (e) {
    console.warn("⚠️ No se pudo leer appointment_settings.enabled:", e);
    return false;
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
    canUseCatalogLists: policy?.canUseCatalogLists ?? true,
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
    "- if_response_policy_disallows_catalog_lists_then_do_not dump_catalog_lists",
    "- if_response_policy_disallows_official_links_then_do_not include_links",
    "- if_structured_turn_data_exists_then_it_has_highest_priority",
    "- answer_as_business = true",
  ];

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

function buildUserPrompt(userInput: string) {
  return [
    "MENSAJE_USUARIO:",
    userInput,
    "",
    "TASK:",
    "- Produce the final customer-facing reply.",
    "- Obey RESPONSE_POLICY_JSON and OUTPUT_RULES.",
    "- Return STRICT JSON only.",
    '- Use this exact shape: {"text":"...", "pendingCta":null}',
    '- If the reply includes a confirmation-oriented CTA for booking, use: {"text":"...", "pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
    '- If the reply includes a confirmation-oriented CTA for estimate, use: {"text":"...", "pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
    "- Do not wrap the JSON in markdown fences.",
  ].join("\n");
}

function extractUrls(text: string): string[] {
  return Array.from(new Set(String(text || "").match(/https?:\/\/\S+/gi) || []));
}

function extractNumbers(text: string): string[] {
  return Array.from(
    new Set(String(text || "").match(/\$?\d+(?:[.,]\d{1,2})?/g) || [])
  );
}

function normalizeLineForCompare(line: string): string {
  return String(line || "").replace(/\s+/g, " ").trim();
}

function extractMeaningfulLines(text: string): string[] {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function startsWithBullet(line: string): boolean {
  return /^[-•*]/.test(String(line || "").trim());
}

function preserveCanonicalBodyOrFallback(args: {
  modelText: string;
  fallbackText: string;
  policy: Required<ResponsePolicy>;
  idiomaDestino: "es" | "en";
}): string {
  const { modelText, fallbackText, policy } = args;

  const canonicalBody = String(fallbackText || "").trim();
  const candidate = String(modelText || "").trim();

  if (!canonicalBody) return candidate;

  if (policy.mode !== "grounded_frame_only" || !policy.preserveExactBody) {
    return candidate || canonicalBody;
  }

  const canonicalLines = extractMeaningfulLines(canonicalBody);
  const candidateLines = extractMeaningfulLines(candidate);

  const canonicalBullets = canonicalLines.filter(startsWithBullet);
  const candidateBullets = candidateLines.filter(startsWithBullet);

  if (policy.preserveExactBullets) {
    if (canonicalBullets.length !== candidateBullets.length) {
      return canonicalBody;
    }

    for (let i = 0; i < canonicalBullets.length; i++) {
      if (
        normalizeLineForCompare(canonicalBullets[i]) !==
        normalizeLineForCompare(candidateBullets[i])
      ) {
        return canonicalBody;
      }
    }
  }

  if (policy.preserveExactOrder) {
    let lastIndex = -1;
    for (const line of canonicalLines) {
      const idx = candidateLines.findIndex(
        (c, i) =>
          i > lastIndex &&
          normalizeLineForCompare(c) === normalizeLineForCompare(line)
      );
      if (idx === -1) return canonicalBody;
      lastIndex = idx;
    }
  }

  if (policy.preserveExactNumbers) {
    const canonicalNumbers = extractNumbers(canonicalBody);
    const candidateNumbers = extractNumbers(candidate);

    for (const value of canonicalNumbers) {
      if (!candidateNumbers.includes(value)) {
        return canonicalBody;
      }
    }
  }

  if (policy.preserveExactLinks) {
    const canonicalUrls = extractUrls(canonicalBody);
    const candidateUrls = extractUrls(candidate);

    for (const url of canonicalUrls) {
      if (!candidateUrls.includes(url)) {
        return canonicalBody;
      }
    }
  }

  const canonicalAppearsInsideCandidate = canonicalLines.every((line) =>
    candidateLines.some(
      (c) => normalizeLineForCompare(c) === normalizeLineForCompare(line)
    )
  );

  if (!canonicalAppearsInsideCandidate) {
    return canonicalBody;
  }

  return candidate || canonicalBody;
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

  const catalogDbContext = normalizedPolicy.canUseCatalogLists
    ? await buildCatalogDbContext(tenantId)
    : "";

  const bookingActive = await getBookingActiveForTenant(tenantId);
  const bookingStateBlock = `BOOKING_ACTIVE: ${bookingActive ? "true" : "false"}`;

  const effectivePolicy: Required<ResponsePolicy> = {
    ...normalizedPolicy,
    canMentionSpecificPrice: normalizedPolicy.canMentionSpecificPrice,
    canOfferBookingTimes:
      normalizedPolicy.canOfferBookingTimes && bookingActive,
  };

  const systemPromptParts = [
    promptBaseWithLinks,
    "",
    bookingStateBlock,
    "",
    buildResponsePolicyBlock(effectivePolicy),
    "",
    buildInstructionBlock(idiomaDestino, maxLines, effectivePolicy),
    "",
    buildEntityLockBlock(idiomaDestino, effectivePolicy),
    "",
    catalogDbContext,
    "",
    extraContext ? `DATOS_ESTRUCTURADOS_DEL_TURNO:\n${extraContext}` : "",
    "",
    `CHANNEL_CONTEXT: ${canal}`,
  ].filter(Boolean);

  const systemPrompt = systemPromptParts.join("\n");

  const userPrompt = buildUserPrompt(userInput);

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

    const parsedEnvelope = parseModelAnswerEnvelope(rawModelOutput);

    out = parsedEnvelope?.text || fallbackText || "";
  } catch (e) {
    console.warn("❌ answerWithPromptBase LLM error; using fallback:", e);
    out = fallbackText || "";
  }

  out = sanitizeChatOutput(out);
  out = stripUrlsIfPromptHasNone(out, promptBaseWithLinks);
  out = capLines(out, maxLines);

  out = preserveCanonicalBodyOrFallback({
    modelText: out,
    fallbackText,
    policy: effectivePolicy,
    idiomaDestino,
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
    const reparsedEnvelope = parseModelAnswerEnvelope(rawModelOutputForPendingCta);
    pendingCta = reparsedEnvelope?.pendingCta ?? null;
  } catch {
    pendingCta = null;
  }

  return {
    text: out,
    pendingCta,
  };
}