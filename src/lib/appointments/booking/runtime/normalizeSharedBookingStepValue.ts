// src/lib/appointments/booking/runtime/normalizeSharedBookingStepValue.ts

import OpenAI from "openai";

import type {
  VoiceLocale,
} from "../../../voice/types";

import type {
  BookingFlowStepLike,
} from "./bookingFlowRuntimeUtils";

import {
  clean,
  getStepSlot,
  isConfirmationLikeStep,
} from "./bookingFlowRuntimeUtils";

import {
  resolveGlobalConfirmationIntent,
} from "../../../voice/realtime/bookingStep/resolveGlobalConfirmationIntent";

export type SharedBookingStepValueSource =
  | "model"
  | "transcript";

export type NormalizeSharedBookingStepValueResult = {
  value: string;
  modelValue: string;
  source: SharedBookingStepValueSource;
};

function getExpectedType(
  step: BookingFlowStepLike
): string {
  return clean(
    step.expected_type
  ).toLowerCase();
}

function getValidationConfig(
  step: BookingFlowStepLike
): Record<string, unknown> {
  return step.validation_config &&
    typeof step.validation_config === "object"
    ? step.validation_config as Record<
        string,
        unknown
      >
    : {};
}

function getValidationMode(
  step: BookingFlowStepLike
): string {
  const validationConfig =
    getValidationConfig(step);

  const candidates = [
    validationConfig.mode,
    validationConfig.type,
    validationConfig.kind,
  ];

  for (const candidate of candidates) {
    const value = clean(candidate);

    if (value) {
      return value;
    }
  }

  return "";
}

function isConfirmationStep(
  step: BookingFlowStepLike
): boolean {
  const expectedType =
    getExpectedType(step);

  const slot =
    getStepSlot(step).toLowerCase();

  return (
    expectedType === "confirmation" ||
    slot === "confirmation" ||
    isConfirmationLikeStep(step)
  );
}

function isDatetimeStep(
  step: BookingFlowStepLike
): boolean {
  const expectedType =
    getExpectedType(step);

  const stepKey =
    clean(
      step.step_key
    ).toLowerCase();

  const slot =
    getStepSlot(step).toLowerCase();

  return (
    expectedType === "datetime" ||
    stepKey === "datetime" ||
    slot === "datetime"
  );
}

function buildDatetimeInstructions(
  params: {
    step: BookingFlowStepLike;
    userInput: string;
    locale: VoiceLocale;
  }
): string {
  const stepKey =
    clean(
      params.step.step_key
    );

  const slot =
    getStepSlot(params.step);

  const expectedType =
    getExpectedType(params.step);

  const validationMode =
    getValidationMode(params.step);

  return [
    "You normalize one booking-step answer.",
    "",
    "This is an internal normalization task.",
    "Do not answer the customer.",
    "Do not explain anything.",
    "Return exactly one JSON object and nothing else.",
    "",
    "The customer may answer in any language.",
    "Understand the meaning regardless of language.",
    "Never infer a value from the language code alone.",
    "",
    `Current locale: ${params.locale}`,
    `Current booking step key: ${stepKey}`,
    `Current booking slot: ${slot}`,
    `Current expected type: ${expectedType}`,
    `Current validation mode: ${validationMode}`,
    `Customer latest answer: ${params.userInput}`,
    "",
    "Resolve only the customer's latest answer.",
    "Do not use previous turns.",
    "Do not guess.",
    "Do not invent a missing date.",
    "Do not invent a missing time.",
    "",
    "For an exact datetime selection, use one of these shapes:",
    '{"status":"resolved","raw":"customer exact answer","date_kind":"today","hour_24":15,"minute":0}',
    '{"status":"resolved","raw":"customer exact answer","date_kind":"tomorrow","hour_24":15,"minute":0}',
    '{"status":"resolved","raw":"customer exact answer","date_kind":"weekday","weekday":1,"hour_24":15,"minute":0}',
    '{"status":"resolved","raw":"customer exact answer","date_kind":"calendar_date","date_iso":"2026-07-10","hour_24":15,"minute":0}',
    "",
    "When the customer clearly asks to see availability for a date/day without selecting an exact time, use:",
    '{"status":"resolved","raw":"customer exact answer","request_mode":"availability_window","date_kind":"today"}',
    '{"status":"resolved","raw":"customer exact answer","request_mode":"availability_window","date_kind":"tomorrow"}',
    '{"status":"resolved","raw":"customer exact answer","request_mode":"availability_window","date_kind":"weekday","weekday":1}',
    '{"status":"resolved","raw":"customer exact answer","request_mode":"availability_window","date_kind":"calendar_date","date_iso":"2026-07-10"}',
    "",
    "If the answer cannot be resolved safely, use:",
    '{"status":"unknown","raw":"customer exact answer"}',
    "",
    "Rules:",
    '- date_kind must be one of: "today", "tomorrow", "weekday", "calendar_date".',
    "- For weekday, weekday is 0=Sunday through 6=Saturday.",
    "- For calendar_date, date_iso must be YYYY-MM-DD.",
    "- hour_24 must be an integer from 0 through 23.",
    "- minute must be an integer from 0 through 59.",
    "- Convert clearly expressed time into 24-hour time.",
    "- A normal booking selection requires both date/day and time.",
    '- request_mode may only be "availability_window".',
    "- Do not add hour_24 or minute for availability_window.",
    "- Preserve the customer's exact latest answer in raw.",
    "",
    "Return JSON only.",
  ].join("\n");
}

function extractJsonObject(
  value: string
): Record<string, unknown> | null {
  const raw = clean(value);

  if (!raw) {
    return null;
  }

  const candidates = [
    raw,
    raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim(),
  ];

  for (const candidate of candidates) {
    try {
      const parsed =
        JSON.parse(candidate);

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<
          string,
          unknown
        >;
      }
    } catch {
      // sigue con el próximo candidato
    }
  }

  return null;
}

function buildUnknownDatetimeValue(
  userInput: string
): string {
  return JSON.stringify({
    status: "unknown",
    raw: userInput,
  });
}

function sanitizeDatetimeProtocol(
  params: {
    parsed: Record<string, unknown>;
    userInput: string;
  }
): string {
  const status =
    clean(
      params.parsed.status
    ).toLowerCase();

  if (status !== "resolved") {
    return buildUnknownDatetimeValue(
      params.userInput
    );
  }

  const dateKind =
    clean(
      params.parsed.date_kind
    ).toLowerCase();

  const raw =
    clean(
      params.parsed.raw
    ) || params.userInput;

  const requestMode =
    clean(
      params.parsed.request_mode
    ).toLowerCase();

  const base:
    Record<string, unknown> = {
      status: "resolved",
      raw,
      date_kind: dateKind,
    };

  if (
    ![
      "today",
      "tomorrow",
      "weekday",
      "calendar_date",
    ].includes(dateKind)
  ) {
    return buildUnknownDatetimeValue(
      params.userInput
    );
  }

  if (dateKind === "weekday") {
    const weekday =
      params.parsed.weekday;

    if (
      typeof weekday !== "number" ||
      !Number.isInteger(weekday) ||
      weekday < 0 ||
      weekday > 6
    ) {
      return buildUnknownDatetimeValue(
        params.userInput
      );
    }

    base.weekday = weekday;
  }

  if (
    dateKind === "calendar_date"
  ) {
    const dateIso =
      clean(
        params.parsed.date_iso
      );

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(
        dateIso
      )
    ) {
      return buildUnknownDatetimeValue(
        params.userInput
      );
    }

    base.date_iso = dateIso;
  }

  if (
    requestMode ===
    "availability_window"
  ) {
    base.request_mode =
      "availability_window";

    return JSON.stringify(base);
  }

  const hour24 =
    params.parsed.hour_24;

  const minute =
    params.parsed.minute;

  if (
    typeof hour24 !== "number" ||
    !Number.isInteger(hour24) ||
    hour24 < 0 ||
    hour24 > 23 ||
    typeof minute !== "number" ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return buildUnknownDatetimeValue(
      params.userInput
    );
  }

  base.hour_24 = hour24;
  base.minute = minute;

  return JSON.stringify(base);
}

async function normalizeDatetimeStep(
  params: {
    step: BookingFlowStepLike;
    userInput: string;
    locale: VoiceLocale;
  }
): Promise<
  NormalizeSharedBookingStepValueResult
> {
  const apiKey =
    clean(
      process.env.OPENAI_API_KEY
    );

  if (!apiKey) {
    return {
      value: params.userInput,
      modelValue: params.userInput,
      source: "transcript",
    };
  }

  try {
    const openai =
      new OpenAI({
        apiKey,
      });

    const completion =
      await openai.chat.completions.create({
        model:
          process.env
            .BOOKING_NORMALIZATION_MODEL ||
          "gpt-4o-mini",

        temperature: 0,

        response_format: {
          type: "json_object",
        },

        messages: [
          {
            role: "system",
            content:
              buildDatetimeInstructions(
                params
              ),
          },
          {
            role: "user",
            content:
              params.userInput,
          },
        ],
      });

    const modelText =
      clean(
        completion
          .choices?.[0]
          ?.message
          ?.content
      );

    const parsed =
      extractJsonObject(
        modelText
      );

    if (!parsed) {
      return {
        value:
          buildUnknownDatetimeValue(
            params.userInput
          ),
        modelValue:
          buildUnknownDatetimeValue(
            params.userInput
          ),
        source: "model",
      };
    }

    const normalized =
      sanitizeDatetimeProtocol({
        parsed,
        userInput:
          params.userInput,
      });

    return {
      value: normalized,
      modelValue: normalized,
      source: "model",
    };
  } catch (error) {
    console.warn(
      "[SHARED_BOOKING][STEP_NORMALIZATION_FAILED]",
      {
        stepKey:
          clean(
            params.step.step_key
          ),
        slot:
          getStepSlot(
            params.step
          ),
        expectedType:
          getExpectedType(
            params.step
          ),
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );

    return {
      value: params.userInput,
      modelValue: params.userInput,
      source: "transcript",
    };
  }
}
function isPhoneStep(
  step: BookingFlowStepLike
): boolean {
  const expectedType =
    getExpectedType(step);

  const slot =
    getStepSlot(step).toLowerCase();

  return (
    expectedType === "phone" ||
    slot === "customer_phone" ||
    slot === "phone"
  );
}

function getPhoneValidationMode(
  step: BookingFlowStepLike
): string {
  return getValidationMode(step)
    .trim()
    .toLowerCase();
}

async function normalizePhoneStep(
  params: {
    step: BookingFlowStepLike;
    userInput: string;
    locale: VoiceLocale;
    contactPhone: string | null;
  }
): Promise<
  NormalizeSharedBookingStepValueResult
> {
  const validationMode =
    getPhoneValidationMode(
      params.step
    );

  if (
    validationMode ===
    "confirm_or_replace" &&
    params.contactPhone
  ) {
    const confirmationIntent =
      await resolveGlobalConfirmationIntent({
        locale: params.locale,
        values: [
          params.userInput,
        ],
      });

    const normalizedIntent =
      clean(
        confirmationIntent
      ).toLowerCase();

    if (
      normalizedIntent === "confirm"
    ) {
      return {
        value:
          "__USE_CALLER_PHONE__",
        modelValue:
          "__USE_CALLER_PHONE__",
        source: "model",
      };
    }
  }

  return {
    value: params.userInput,
    modelValue:
      params.userInput,
    source: "transcript",
  };
}

export async function normalizeSharedBookingStepValue(
  params: {
    tenantId: string;
    locale: VoiceLocale;
    step: BookingFlowStepLike;
    userInput: string;
    contactPhone: string | null;
  }
): Promise<
  NormalizeSharedBookingStepValueResult
> {
  const userInput =
    clean(
      params.userInput
    );

  if (!userInput) {
    return {
      value: "",
      modelValue: "",
      source: "transcript",
    };
  }

  if (
    isConfirmationStep(
      params.step
    )
  ) {
    const confirmationIntent =
      await resolveGlobalConfirmationIntent({
        locale: params.locale,
        values: [userInput],
      });

    const resolved =
      clean(
        confirmationIntent
      ) || "unknown";

    return {
      value: resolved,
      modelValue: resolved,
      source: "model",
    };
  }

  if (
    isPhoneStep(
      params.step
    )
  ) {
    return normalizePhoneStep({
      step: params.step,
      userInput,
      locale: params.locale,
      contactPhone:
        params.contactPhone,
    });
  }

  if (
    isDatetimeStep(
      params.step
    )
  ) {
    return normalizeDatetimeStep({
      step: params.step,
      userInput,
      locale: params.locale,
    });
  }

  /**
   * Por ahora los demás steps conservan exactamente
   * el comportamiento actual de Messaging/Voice.
   *
   * No añadimos normalización especulativa aquí.
   */
  return {
    value: userInput,
    modelValue: userInput,
    source: "transcript",
  };
}