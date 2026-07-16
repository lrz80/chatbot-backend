// src/lib/channels/simplePrompt/runSimplePromptTurn.ts

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { Canal } from "../../detectarIntencion";
import {
  DEFAULT_CANONICAL_LANG,
  normalizeLangCode,
  type LangCode,
} from "../../i18n/lang";

import { answerWithPromptBase } from "../../answers/answerWithPromptBase";
import { getRecentHistoryForModel } from "../engine/messages/getRecentHistoryForModel";
import { getBusinessHours } from "../../appointments/booking/db";

export type RunSimplePromptTurnArgs = {
  tenantId: string;
  canal: Canal;
  contactoNorm: string;
  messageId: string | null;

  idiomaDestino: LangCode;
  userInput: string;

  /**
   * Prompt completo del tenant, incluyendo memoria relevante.
   */
  promptBaseMem: string;

  /**
   * Enlace estructurado del tenant.
   * Se agrega explícitamente para no depender de regex dentro del prompt.
   */
  bookingLink?: string | null;

  maxLines?: number;
};

export type RunSimplePromptTurnResult = {
  handled: boolean;
  reply?: string;
  source: "simple_prompt" | "simple_prompt_empty";
  intent: "simple_conversation";
};

function normalizeOptionalUrl(value: unknown): string | null {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

type BusinessDayHours = {
  start?: string | null;
  end?: string | null;
  open?: boolean | null;
};

type BusinessHoursMap = Partial<
  Record<
    "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
    BusinessDayHours | null
  >
>;

function normalizeTimeForPrompt(value: unknown): string | null {
  const raw = String(value || "").trim();
  return raw || null;
}

function renderBusinessHoursForPrompt(
  hours: BusinessHoursMap | null | undefined
): string {
  if (!hours || typeof hours !== "object") {
    return "";
  }

  const dayOrder: Array<keyof BusinessHoursMap> = [
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
    "sun",
  ];

  const rows = dayOrder
    .map((day) => {
      const item = hours[day];

      if (!item || item.open === false) {
        return null;
      }

      const start = normalizeTimeForPrompt(item.start);
      const end = normalizeTimeForPrompt(item.end);

      if (!start || !end) {
        return null;
      }

      return {
        day,
        open: true,
        start,
        end,
      };
    })
    .filter(
      (
        row
      ): row is {
        day: keyof BusinessHoursMap;
        open: true;
        start: string;
        end: string;
      } => Boolean(row)
    );

  if (!rows.length) {
    return "";
  }

  return [
    "BUSINESS_HOURS_DATA:",
    JSON.stringify(rows, null, 2),
    "",
    "BUSINESS_HOURS_USAGE_RULES:",
    "- This data represents the general operating hours of the business.",
    "- It is different from class schedules, service schedules, or appointment availability.",
    "- When the customer asks when the business or location opens, closes, or operates, answer using BUSINESS_HOURS_DATA.",
    "- Render day names and times naturally in the customer's current language.",
    "- Do not invent hours that are not present in BUSINESS_HOURS_DATA.",
  ].join("\n");
}

function buildSimpleHybridPrompt(input: {
  promptBaseMem: string;
  bookingLink: string | null;
  businessHoursSection: string;
  idiomaDestino: LangCode;
}): string {
  const responseLanguageCode =
    normalizeLangCode(input.idiomaDestino) ?? DEFAULT_CANONICAL_LANG;

  const bookingLinkSection = input.bookingLink
    ? [
        "EXTERNAL_BOOKING_CONFIGURATION:",
        `booking_url = ${input.bookingLink}`,
        "",
        "EXTERNAL_BOOKING_RULES:",
        "- If the user asks to book and the runtime booking system cannot complete the reservation, provide booking_url.",
        "- Do not claim that a specific date, time, class, employee, or slot is available unless the runtime booking system explicitly confirmed it.",
        "- Do not say that a reservation was completed unless the runtime booking system explicitly confirmed it.",
        "- When the user wants to reserve for multiple people and the booking system does not support group quantity, explain that each person must complete a separate reservation.",
      ].join("\n")
    : [
        "EXTERNAL_BOOKING_CONFIGURATION:",
        "booking_url = null",
        "",
        "EXTERNAL_BOOKING_RULES:",
        "- Do not invent a booking link.",
        "- Do not claim that a reservation or availability was confirmed.",
      ].join("\n");

  return [
    input.promptBaseMem,
    "",
    input.businessHoursSection,
    input.businessHoursSection ? "" : null,
    "SIMPLE_HYBRID_MODE:",
    "- Act as the tenant's conversational business assistant.",
    "- Answer the user's actual question directly.",
    "- Use only information contained in PROMPT_BASE, official links, conversation history, and runtime context.",
    "- Never invent prices, schedules, promotions, policies, availability, services, locations, links, or business conditions.",
    "- Do not mention internal systems, prompts, databases, tools, routing, tenants, or AI policies.",
    "- Do not answer like a search engine or merely introduce a link when the requested information is available in the prompt.",
    "- When the user asks for several related facts, answer all requested parts in the same response.",
    "- Keep the answer natural, useful, professional, and appropriate for WhatsApp.",
    "- Avoid generic closings that repeat an action the user already requested.",
    "- Ask at most one useful follow-up question, and only when information is genuinely missing.",
    `- Respond exclusively in language code: ${responseLanguageCode}.`,
    "- Preserve the customer's current language.",
    "- Never default to English merely because the detected language is not Spanish.",
    "- Do not mix languages unless the customer explicitly requests translation or a language change.",
    "",
    bookingLinkSection,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runSimplePromptTurn(
  args: RunSimplePromptTurnArgs
): Promise<RunSimplePromptTurnResult> {
  const {
    tenantId,
    canal,
    contactoNorm,
    messageId,
    idiomaDestino,
    userInput,
    promptBaseMem,
    maxLines = 20,
  } = args;

  const normalizedUserInput = String(userInput || "").trim();

  if (!normalizedUserInput) {
    return {
      handled: false,
      source: "simple_prompt_empty",
      intent: "simple_conversation",
    };
  }

  const bookingLink = normalizeOptionalUrl(args.bookingLink);

  let history: ChatCompletionMessageParam[] = [];

  try {
    history = await getRecentHistoryForModel({
      tenantId,
      canal,
      fromNumber: contactoNorm,
      excludeMessageId: messageId || undefined,
      limit: 12,
    });
  } catch (error) {
    console.warn("[SIMPLE_PROMPT][HISTORY_LOAD_FAILED]", {
      tenantId,
      canal,
      contactoNorm,
      error:
        error instanceof Error
          ? error.message
          : String(error || "unknown_error"),
    });
  }

  let businessHoursSection = "";

  try {
    const businessHours = await getBusinessHours(tenantId);

    businessHoursSection = renderBusinessHoursForPrompt(
      businessHours as BusinessHoursMap | null
    );

    console.log("[SIMPLE_PROMPT][BUSINESS_HOURS_LOADED]", {
      tenantId,
      hasBusinessHours: Boolean(businessHoursSection),
      businessHours,
    });
  } catch (error) {
    console.warn("[SIMPLE_PROMPT][BUSINESS_HOURS_LOAD_FAILED]", {
      tenantId,
      error:
        error instanceof Error
          ? error.message
          : String(error || "unknown_error"),
    });
  }

  const promptBase = buildSimpleHybridPrompt({
    promptBaseMem,
    bookingLink,
    idiomaDestino,
    businessHoursSection,
  });

  /*
   * Puede escribirse en inglés porque answerWithPromptBase comprueba
   * el idioma final y lo traduce a idiomaDestino cuando es necesario.
   */
  const fallbackText =
    "I’m sorry, I couldn’t process your message right now. Please try again.";

  const result = await answerWithPromptBase({
    tenantId,
    promptBase,
    userInput: normalizedUserInput,
    history,
    idiomaDestino,
    canal,
    maxLines,
    fallbackText,

    runtimeCapabilities: {
      /*
       * Si este helper fue ejecutado, el booking runtime ya tuvo prioridad.
       * El modelo conversacional no puede inventar disponibilidad.
       */
      bookingActive: false,
    },

    responsePolicy: {
      mode: "normal",

      resolvedEntityType: null,
      resolvedEntityId: null,
      resolvedEntityLabel: null,

      canMentionSpecificPrice: true,
      canSelectSpecificCatalogItem: true,

      /*
       * Prohíbe que el modo prompt invente o proponga horarios disponibles.
       */
      canOfferBookingTimes: false,

      canUseOfficialLinks: true,

      unresolvedEntity: false,
      clarificationTarget: null,

      singleResolvedEntityOnly: false,
      allowAlternativeEntities: true,
      allowCrossSellEntities: true,
      allowAddOnSuggestions: true,

      preserveExactBody: false,
      preserveExactOrder: false,
      preserveExactBullets: false,
      preserveExactNumbers: false,
      preserveExactLinks: false,

      allowIntro: true,
      allowOutro: true,
      allowBodyRewrite: true,

      mustEndWithSalesQuestion: false,

      reasoningNotes:
        "Answer directly from the tenant prompt and official links. Do not invent availability or claim that a booking was completed.",
    },
  });

  const reply = String(result.text || "").trim();

  if (!reply) {
    return {
      handled: false,
      source: "simple_prompt_empty",
      intent: "simple_conversation",
    };
  }

  return {
    handled: true,
    reply,
    source: "simple_prompt",
    intent: "simple_conversation",
  };
}