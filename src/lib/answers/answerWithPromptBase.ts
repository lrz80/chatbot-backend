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

  mustEndWithSalesQuestion?: boolean;
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
  if (!candidate) return canonicalBody;

  if (policy.mode !== "grounded_frame_only" || !policy.preserveExactBody) {
    return candidate;
  }

  const canonicalLines = extractMeaningfulLines(canonicalBody);
  const candidateLines = extractMeaningfulLines(candidate);

  const canonicalBullets = canonicalLines.filter(startsWithBullet);
  const candidateBullets = candidateLines.filter(startsWithBullet);

  const canonicalHasBullets = canonicalBullets.length > 0;
  const canonicalIsSingleLine = canonicalLines.length === 1;

  // =========================================================
  // CASO 1: cuerpo canónico SIMPLE (una sola línea, sin bullets)
  // Permitimos framing si el cuerpo canónico aparece intacto.
  // =========================================================
  if (!canonicalHasBullets && canonicalIsSingleLine) {
    const normalizedCanonicalBody = normalizeLineForCompare(canonicalBody);
    const normalizedCandidate = normalizeLineForCompare(candidate);

    if (!normalizedCandidate.includes(normalizedCanonicalBody)) {
      return canonicalBody;
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

    return candidate;
  }

  // =========================================================
  // CASO 2: cuerpo canónico ESTRUCTURADO
  // Aquí sí exigimos preservación estricta.
  // =========================================================
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

      if (idx === -1) {
        return canonicalBody;
      }

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

  return candidate;
}

function composeGroundedFrameOnlyReply(args: {
  intro?: string | null;
  canonicalBody: string;
  closing?: string | null;
}): string {
  const parts = [
    String(args.intro || "").trim(),
    String(args.canonicalBody || "").trim(),
    String(args.closing || "").trim(),
  ].filter(Boolean);

  return parts.join("\n").trim();
}

function buildGroundedFrameOnlyMessages(params: {
  idiomaDestino: "es" | "en";
  fallbackText: string;
  userInput: string;
  maxIntroLines: number;
  maxClosingLines: number;
  mustEndWithSalesQuestion: boolean;
}): { system: string; user: string } {
  const {
    idiomaDestino,
    fallbackText,
    userInput,
    maxIntroLines,
    maxClosingLines,
    mustEndWithSalesQuestion,
  } = params;

  const system =
    idiomaDestino === "es"
      ? [
          "Responde solo en español.",
          "Tu objetivo es vender con una respuesta breve, natural, clara y útil.",
          `Puedes agregar un intro corto de máximo ${maxIntroLines} línea(s), pero solo si aporta valor real.`,
          mustEndWithSalesQuestion
            ? `Debes cerrar obligatoriamente con una sola pregunta corta, consultiva y vendedora de máximo ${maxClosingLines} línea(s).`
            : `Puedes cerrar con un siguiente paso corto y consultivo de máximo ${maxClosingLines} línea(s) cuando ayude a avanzar la conversación.`,
          "No devuelvas el cuerpo canónico dentro de intro ni closing.",
          "intro debe ser opcional y breve.",
          "closing debe ser opcional y breve.",
          "Si mustEndWithSalesQuestion es true, closing debe ser una sola pregunta breve.",
          "No reescribas ni repitas el cuerpo canónico.",
          "No cierres en seco si existe una forma natural de avanzar la conversación.",
          "Debes conservar EXACTAMENTE el cuerpo canónico provisto.",
          "No cambies nombres, montos, horarios, ubicación, disponibilidad ni el orden.",
          "No elimines ni agregues bullets del cuerpo canónico.",
          "No resumas ni reescribas los bullets.",
          "No conviertas bullets a párrafos.",
          "Puedes envolver el cuerpo con un intro y/o un cierre breve, pero el bloque canónico debe quedar intacto.",
          "No dupliques el framing.",
          "No uses dos introducciones.",
          mustEndWithSalesQuestion
            ? "La última línea debe ser exactamente una pregunta breve que ayude a continuar la conversación comercial."
            : "Si la consulta es de horarios, ubicación o disponibilidad general, prioriza claridad y brevedad sin sonar frío.",
          "Formato requerido:",
          "1. intro opcional breve",
          "2. bloque canónico EXACTO",
          mustEndWithSalesQuestion
            ? "3. una sola pregunta breve al final"
            : "3. cierre opcional breve",
        ].join("\n\n")
      : [
          "Reply only in English.",
          "Your goal is to sell with a brief, natural, clear, useful reply.",
          `You may add a short intro of at most ${maxIntroLines} line(s), but only if it adds real value.`,
          mustEndWithSalesQuestion
            ? `You must end with exactly one short consultative sales question of at most ${maxClosingLines} line(s).`
            : `You may close with one short consultative next step of at most ${maxClosingLines} line(s) when it helps move the conversation forward.`,
          "Do not return the canonical body inside intro or closing.",
          "intro must be optional and brief.",
          "closing must be optional and brief.",
          "If mustEndWithSalesQuestion is true, closing must be exactly one brief question.",
          "Do not rewrite or repeat the canonical body.",
          "Do not end abruptly if there is a natural way to move the conversation forward.",
          "You must preserve the provided canonical body EXACTLY.",
          "Do not change names, amounts, schedules, location, availability, or order.",
          "Do not remove or add bullets from the canonical body.",
          "Do not summarize or rewrite the bullets.",
          "Do not turn bullets into paragraphs.",
          "You may wrap the body with a brief intro and/or closing, but the canonical block must remain intact.",
          "Do not duplicate framing.",
          "Do not use two introductions.",
          mustEndWithSalesQuestion
            ? "The final line must be exactly one short question that helps continue the sales conversation."
            : "For schedule, location, or availability questions, prioritize clarity and brevity without sounding cold.",
          "Required format:",
          "1. optional brief intro",
          "2. EXACT canonical block",
          mustEndWithSalesQuestion
            ? "3. exactly one brief question at the end"
            : "3. optional brief closing",
        ].join("\n\n");

  const user =
    idiomaDestino === "es"
      ? [
          `Mensaje del cliente: ${userInput || "(vacío)"}`,
          "",
          "Cuerpo canónico resuelto:",
          fallbackText,
          "",
          "Devuélveme la respuesta final lista para enviar, mejorando solo el framing comercial sin alterar el cuerpo canónico.",
          "Responde en JSON estricto.",
          'Usa exactamente este formato: {"intro":"...", "closing":"...", "pendingCta":null}',
          'Si incluyes un CTA de confirmación para reserva, usa: {"intro":"...", "closing":"...", "pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
          'Si incluyes un CTA de confirmación para estimado, usa: {"intro":"...", "closing":"...", "pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
          "No uses markdown ni bloques de código.",
        ].join("\n")
      : [
          `Customer message: ${userInput || "(empty)"}`,
          "",
          "Resolved canonical body:",
          fallbackText,
          "",
          "Return the final ready-to-send reply, improving only the sales framing without altering the canonical body.",
          "Return strict JSON.",
          'Use exactly this format: {"intro":"...", "closing":"...", "pendingCta":null}',
          'If you include a confirmation CTA for booking, use: {"intro":"...", "closing":"...", "pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
          'If you include a confirmation CTA for estimate, use: {"intro":"...", "closing":"...", "pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
          "Do not use markdown or code fences.",
        ].join("\n");

  return { system, user };
}

function isStructuredCatalogComparisonCanonical(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return false;

  return (
    value.includes("COMPARISON_MODE: catalog_compare") &&
    value.includes("ITEM_COUNT:") &&
    value.includes("ITEM:")
  );
}

function isScheduleCanonical(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return false;

  const lines = value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return false;

  const firstLine = String(lines[0] || "").toLowerCase();
  const hasScheduleHeader =
    firstLine === "horarios:" || firstLine === "schedules:";

  const hasBulletLikeScheduleLines = lines
    .slice(1)
    .some((line) => /^[-•*]/.test(line));

  return hasScheduleHeader && hasBulletLikeScheduleLines;
}

function buildGroundedScheduleMessages(params: {
  idiomaDestino: "es" | "en";
  fallbackText: string;
  userInput: string;
}): { system: string; user: string } {
  const { idiomaDestino, fallbackText, userInput } = params;

  const system =
    idiomaDestino === "es"
      ? [
          "Responde solo en español.",
          "Tu objetivo es escribir la respuesta final para un canal DM de ventas.",
          "La disponibilidad y horarios ya fueron resueltos por el backend y vienen en un bloque canónico grounded.",
          "Debes usar SOLO esa información.",
          "No inventes horarios, días, ubicaciones, disponibilidad ni nombres.",
          "No copies el bloque literal como única respuesta si puedes responder de forma más útil y comercial.",
          "Puedes resumir solo la parte relevante para la pregunta del cliente, siempre usando únicamente los datos del bloque canónico.",
          "Si el cliente pregunta por una hora o disponibilidad concreta, responde primero esa pregunta de forma directa.",
          "Después puedes agregar una línea breve que ayude a avanzar la conversación de forma natural.",
          "No suenes robótico ni frío.",
          "No recomiendes un plan específico a menos que el cliente lo haya pedido explícitamente.",
          "Responde en JSON estricto.",
          'Usa exactamente este formato: {"text":"...", "pendingCta":null}',
          'Si incluyes un CTA de confirmación para reserva, usa: {"text":"...", "pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
          'Si incluyes un CTA de confirmación para estimado, usa: {"text":"...", "pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
          "No uses markdown ni bloques de código.",
        ].join("\n\n")
      : [
          "Reply only in English.",
          "Your goal is to write the final reply for a sales DM channel.",
          "Availability and schedules have already been resolved by the backend and come in a grounded canonical block.",
          "You must use ONLY that information.",
          "Do not invent schedules, days, locations, availability, or names.",
          "Do not copy the block literally as the only answer if you can answer more helpfully.",
          "You may summarize only the schedule lines relevant to the user's question, using only the canonical block.",
          "If the customer asks about a specific time or availability, answer that directly first.",
          "Then you may add one short next-step line to move the conversation forward naturally.",
          "Do not sound robotic or cold.",
          "Do not recommend a specific plan unless the customer explicitly asked for one.",
          "Return strict JSON.",
          'Use exactly this format: {"text":"...", "pendingCta":null}',
          'If you include a confirmation CTA for booking, use: {"text":"...", "pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
          'If you include a confirmation CTA for estimate, use: {"text":"...", "pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
          "Do not use markdown or code fences.",
        ].join("\n\n");

  const user =
    idiomaDestino === "es"
      ? [
          `Mensaje del cliente: ${userInput || "(vacío)"}`,
          "",
          "Bloque canónico de horarios/disponibilidad:",
          fallbackText,
          "",
          "Devuélveme la respuesta final lista para enviar.",
          "Contesta directamente lo que el cliente preguntó.",
          "Usa solo los horarios realmente presentes en el bloque.",
          "Puedes resumir las líneas relevantes y cerrar con una pregunta breve para avanzar la conversación.",
        ].join("\n")
      : [
          `Customer message: ${userInput || "(empty)"}`,
          "",
          "Canonical availability/schedule block:",
          fallbackText,
          "",
          "Return the final ready-to-send reply.",
          "Answer the customer's question directly.",
          "Use only the schedules actually present in the block.",
          "You may summarize the relevant lines and close with one brief next-step question.",
        ].join("\n");

  return { system, user };
}

function buildGroundedComparisonMessages(params: {
  idiomaDestino: "es" | "en";
  fallbackText: string;
  userInput: string;
}): { system: string; user: string } {
  const { idiomaDestino, fallbackText, userInput } = params;

  const system =
    idiomaDestino === "es"
      ? [
          "Responde solo en español.",
          "Tu objetivo es escribir la respuesta final para un canal DM de ventas.",
          "La comparación ya fue resuelta por el backend y viene en un bloque canónico estructurado.",
          "Debes usar SOLO esa data estructurada.",
          "No inventes atributos, diferencias, precios, beneficios, descuentos, includes ni disponibilidad.",
          "No copies el bloque canónico literal ni lo muestres como etiquetas técnicas.",
          "Convierte esa data en una comparación natural, breve, clara y útil.",
          "Debes contrastar las opciones entre sí, no listarlas como fichas separadas.",
          "Si existen COMMON, puedes resumir brevemente lo común solo si ayuda.",
          "Si existen DIFF, prioriza esas diferencias.",
          "Termina con una sola pregunta breve que ayude a avanzar la conversación.",
          "Responde en JSON estricto.",
          'Usa exactamente este formato: {"text":"...", "pendingCta":null}',
          'Si incluyes un CTA de confirmación para reserva, usa: {"text":"...", "pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
          'Si incluyes un CTA de confirmación para estimado, usa: {"text":"...", "pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
          "No uses markdown ni bloques de código.",
        ].join("\n\n")
      : [
          "Reply only in English.",
          "Your goal is to write the final customer-facing reply for a sales DM channel.",
          "The comparison has already been resolved by the backend and comes as a structured canonical block.",
          "You must use ONLY that structured data.",
          "Do not invent attributes, differences, prices, benefits, discounts, included items, or availability.",
          "Do not copy the canonical block literally or expose technical labels.",
          "Turn that data into a natural, brief, clear, useful comparison.",
          "You must contrast the options against each other, not list them as separate cards.",
          "If COMMON exists, you may briefly summarize common ground only if useful.",
          "If DIFF exists, prioritize those differences.",
          "End with one brief question that helps move the conversation forward.",
          "Return strict JSON.",
          'Use exactly this format: {"text":"...", "pendingCta":null}',
          'If you include a confirmation CTA for booking, use: {"text":"...", "pendingCta":{"type":"booking_offer","awaitsConfirmation":true}}',
          'If you include a confirmation CTA for estimate, use: {"text":"...", "pendingCta":{"type":"estimate_offer","awaitsConfirmation":true}}',
          "Do not use markdown or code fences.",
        ].join("\n\n");

  const user =
    idiomaDestino === "es"
      ? [
          `Mensaje del cliente: ${userInput || "(vacío)"}`,
          "",
          "Bloque canónico estructurado de comparación:",
          fallbackText,
          "",
          "Devuélveme la respuesta final lista para enviar.",
          "No devuelvas las etiquetas técnicas tal cual.",
          "No copies el bloque literal.",
          "Redacta una comparación natural basada únicamente en esos datos.",
        ].join("\n")
      : [
          `Customer message: ${userInput || "(empty)"}`,
          "",
          "Structured canonical comparison block:",
          fallbackText,
          "",
          "Return the final ready-to-send reply.",
          "Do not return the technical labels literally.",
          "Do not copy the block verbatim.",
          "Write a natural comparison based only on that data.",
        ].join("\n");

  return { system, user };
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

  const hasFallbackText = String(fallbackText || "").trim().length > 0;

  const isStructuredComparisonCanonical =
    hasFallbackText && isStructuredCatalogComparisonCanonical(fallbackText);

  const isScheduleCanonicalBody =
    hasFallbackText && isScheduleCanonical(fallbackText);

  const shouldUseGroundedScheduleFormatter =
    effectivePolicy.mode === "grounded_frame_only" &&
    hasFallbackText &&
    isScheduleCanonicalBody;

  const shouldUseGroundedFrameOnlyFormatter =
    effectivePolicy.mode === "grounded_frame_only" &&
    effectivePolicy.preserveExactBody &&
    hasFallbackText &&
    !isStructuredComparisonCanonical &&
    !isScheduleCanonicalBody;

  const shouldUseGroundedComparisonFormatter =
    effectivePolicy.mode === "grounded_frame_only" &&
    hasFallbackText &&
    isStructuredComparisonCanonical;

  let systemPrompt = "";
  let userPrompt = "";

  if (shouldUseGroundedComparisonFormatter) {
    const comparisonMsgs = buildGroundedComparisonMessages({
      idiomaDestino,
      fallbackText,
      userInput,
    });

    systemPrompt = comparisonMsgs.system;
    userPrompt = comparisonMsgs.user;
  } else if (shouldUseGroundedScheduleFormatter) {
    const scheduleMsgs = buildGroundedScheduleMessages({
      idiomaDestino,
      fallbackText,
      userInput,
    });

    systemPrompt = scheduleMsgs.system;
    userPrompt = scheduleMsgs.user;
  } else if (shouldUseGroundedFrameOnlyFormatter) {
    const groundedMsgs = buildGroundedFrameOnlyMessages({
      idiomaDestino,
      fallbackText,
      userInput,
      maxIntroLines: 1,
      maxClosingLines: 1,
      mustEndWithSalesQuestion: effectivePolicy.mustEndWithSalesQuestion,
    });

    systemPrompt = groundedMsgs.system;
    userPrompt = groundedMsgs.user;
  } else {
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

    systemPrompt = systemPromptParts.join("\n");
    userPrompt = buildUserPrompt(userInput);
  }

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

  const isGroundedFrameOnlyFlow =
    shouldUseGroundedFrameOnlyFormatter && String(fallbackText || "").trim().length > 0;

  if (isGroundedFrameOnlyFlow) {
    const parsedGroundedFrame = parseGroundedFrameEnvelope(rawModelOutput);

    const canonicalBody = String(fallbackText || "").trim();

    out = composeGroundedFrameOnlyReply({
      intro: parsedGroundedFrame?.intro ?? null,
      canonicalBody,
      closing: parsedGroundedFrame?.closing ?? null,
    });

    console.log("[ANSWER_WITH_PROMPT_BASE][RAW_MODEL_OUTPUT][GROUNDED_FRAME_ONLY]", {
      tenantId,
      canal,
      userInput,
      rawModelOutput,
      parsedGroundedFrame,
      selectedOut: out,
    });
  } else {
    const parsedEnvelope = parseModelAnswerEnvelope(rawModelOutput);

    out = parsedEnvelope?.text || rawModelOutput || fallbackText || "";

    console.log("[ANSWER_WITH_PROMPT_BASE][RAW_MODEL_OUTPUT]", {
      tenantId,
      canal,
      userInput,
      rawModelOutput,
      parsedEnvelope,
      selectedOut: out,
    });
  }

  } catch (e) {
    console.warn("❌ answerWithPromptBase LLM error; using fallback:", e);
    rawModelOutputForPendingCta = "";
    out = fallbackText || "";
  }

  out = sanitizeChatOutput(out);

  const shouldPreserveCanonicalLinks =
    effectivePolicy.mode === "grounded_frame_only" &&
    effectivePolicy.preserveExactBody &&
    effectivePolicy.preserveExactLinks;

  if (!shouldPreserveCanonicalLinks) {
    out = stripUrlsIfPromptHasNone(out, promptBaseWithLinks);
  }

  out = capLines(out, maxLines);

  if (!isStructuredComparisonCanonical && !isScheduleCanonicalBody) {
    out = preserveCanonicalBodyOrFallback({
      modelText: out,
      fallbackText,
      policy: effectivePolicy,
      idiomaDestino,
    });
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

  const shouldSkipPostTranslation =
    effectivePolicy.mode === "grounded_frame_only" &&
    effectivePolicy.preserveExactBody;

  if (!shouldSkipPostTranslation) {
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
  }

  let pendingCta: PendingCta = null;

  try {
    if (shouldUseGroundedFrameOnlyFormatter) {
      const reparsedGroundedFrame =
        parseGroundedFrameEnvelope(rawModelOutputForPendingCta);
      pendingCta = reparsedGroundedFrame?.pendingCta ?? null;
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