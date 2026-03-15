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
  | "grounded_only";

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

type PendingCtaType =
  | "estimate_offer"
  | "booking_offer";

type PendingCta =
  | {
      type: PendingCtaType;
      awaitsConfirmation: true;
    }
  | null;

/* =========================
   Helpers defensivos
========================= */

function sanitizeChatOutput(text: string) {
  if (!text) return "";

  let t = String(text)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*\d+\)\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\r\n/g, "\n");

  t = t
    .replace(/^\s*text\s*:\s*/i, "")
    .replace(/^\s*message\s*:\s*/i, "")
    .replace(/^\s*reply\s*:\s*/i, "");

  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t;
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

function inferPendingCtaFromAssistantReply(
  text: string,
  idiomaDestino: "es" | "en"
): PendingCta {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;

  const estimatePatternsEs = [
    /te gustar[ií]a agendar un estimado/i,
    /te gustar[ií]a agendar.*estimado/i,
    /quieres agendar un estimado/i,
    /deseas agendar un estimado/i,
  ];

  const estimatePatternsEn = [
    /would you like to schedule an estimate/i,
    /would you like to book an estimate/i,
    /do you want to schedule an estimate/i,
  ];

  const bookingPatternsEs = [
    /si quieres,\s*te ayudo a reservar/i,
    /te gustar[ií]a reservar/i,
    /quieres reservar/i,
    /deseas reservar/i,
    /quieres agendar/i,
    /te ayudo a agendar/i,
  ];

  const bookingPatternsEn = [
    /if you want,\s*i can help you book/i,
    /would you like to book/i,
    /do you want to book/i,
    /would you like to schedule/i,
    /do you want to schedule/i,
  ];

  const estimatePatterns =
    idiomaDestino === "en" ? estimatePatternsEn : estimatePatternsEs;

  const bookingPatterns =
    idiomaDestino === "en" ? bookingPatternsEn : bookingPatternsEs;

  if (estimatePatterns.some((rx) => rx.test(t))) {
    return {
      type: "estimate_offer",
      awaitsConfirmation: true,
    };
  }

  if (bookingPatterns.some((rx) => rx.test(t))) {
    return {
      type: "booking_offer",
      awaitsConfirmation: true,
    };
  }

  return null;
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

function hasExplicitPriceSignals(text: string): boolean {
  const t = String(text || "");

  return (
    /\$\s?\d/.test(t) ||
    /\b\d+(?:[.,]\d{1,2})?\s?(usd|d[oó]lares?)\b/i.test(t) ||
    /\bdesde\s+\$\s?\d/i.test(t) ||
    /\bfrom\s+\$\s?\d/i.test(t) ||
    /\bstarting at\s+\$\s?\d/i.test(t)
  );
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
  maxLines: number
): string {
  const responseLanguage = idiomaDestino === "en" ? "English" : "Español";

  return [
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
  ].join("\n");
}

function buildUserPrompt(userInput: string) {
  return [
    "MENSAJE_USUARIO:",
    userInput,
    "",
    "TASK:",
    "- Produce the final customer-facing reply.",
    "- Obey RESPONSE_POLICY_JSON and OUTPUT_RULES.",
  ].join("\n");
}

function enforceClarifyOnlyOutput(
  text: string,
  idiomaDestino: "es" | "en"
): string {
  const out = String(text || "").trim();

  const isQuestion = /\?\s*$/.test(out);
  const shortEnough = out.split(/\s+/).filter(Boolean).length <= 30;

  if (isQuestion && shortEnough) {
    return out;
  }

  return idiomaDestino === "en"
    ? "Which specific service do you mean?"
    : "¿A cuál servicio te refieres exactamente?";
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

  const promptHasExplicitPrices =
    hasExplicitPriceSignals(promptBaseWithLinks) ||
    hasExplicitPriceSignals(catalogDbContext);

  const effectivePolicy: Required<ResponsePolicy> = {
    ...normalizedPolicy,
    canMentionSpecificPrice:
      normalizedPolicy.canMentionSpecificPrice && promptHasExplicitPrices,
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
    buildInstructionBlock(idiomaDestino, maxLines),
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

    out = completion.choices[0]?.message?.content?.trim() || fallbackText || "";
  } catch (e) {
    console.warn("❌ answerWithPromptBase LLM error; using fallback:", e);
    out = fallbackText || "";
  }

  out = sanitizeChatOutput(out);
  out = stripUrlsIfPromptHasNone(out, promptBaseWithLinks);
  out = capLines(out, maxLines);

  if (effectivePolicy.mode === "clarify_only") {
    const forced =
      idiomaDestino === "en"
        ? "Which specific service do you mean?"
        : "¿A cuál servicio te refieres exactamente?";

    return {
      text: capLines(sanitizeChatOutput(forced), maxLines),
      pendingCta: null,
    };
  }

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

  const pendingCta = inferPendingCtaFromAssistantReply(out, idiomaDestino);

  return {
    text: out,
    pendingCta,
  };
}