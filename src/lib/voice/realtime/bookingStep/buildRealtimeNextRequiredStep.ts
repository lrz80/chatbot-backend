// src/lib/voice/realtime/bookingStep/buildRealtimeNextRequiredStep.ts
import type { VoiceLocale } from "../../types";
import {
  clean,
  getStepSlot,
  isConfirmationLikeStep,
  buildBookingPromptTemplateValues,
  renderBookingStepTemplateSafe,
  type BookingFlowStepLike,
  type BookingState,
  type BookingTemplateRenderResult,
} from "../realtimeBookingFlowUtils";
import {
  resolveBookingPromptText,
  resolveBookingRetryText,
} from "../../voiceBookingHelpers";

export type RealtimeMappedStep = {
  step_key: string;
  step_order: number;
  slot: string;
  prompt: string;
  expected_type: string;
  required: boolean;
  retry_prompt: string;
  validation_config: Record<string, unknown> | null;
  prompt_translations: Record<string, unknown> | null;
  retry_prompt_translations: Record<string, unknown> | null;
};

export type BuildRealtimeNextRequiredStepResult =
  | {
      ok: true;
      next_required_step: RealtimeMappedStep | null;
    }
  | {
      ok: false;
      error: "BOOKING_STEP_TEMPLATE_INVALID";
      step_key: string;
      slot: string;
      prompt_error: BookingTemplateRenderResult extends infer T
        ? T extends { ok: false; error: infer E }
          ? E
          : never
        : never;
      retry_prompt_error: BookingTemplateRenderResult extends infer T
        ? T extends { ok: false; error: infer E }
          ? E
          : never
        : never;
      next_required_step: null;
    };

function mapStepForRealtime(
  step: BookingFlowStepLike,
  locale?: VoiceLocale
): RealtimeMappedStep {
  const resolvedPrompt = locale
    ? resolveBookingPromptText({
        locale,
        prompt: step.prompt || "",
        promptTranslations:
          (step.prompt_translations as Record<string, string> | null) || null,
      })
    : step.prompt || "";

  const resolvedRetryPrompt = locale
    ? resolveBookingRetryText({
        locale,
        retryPrompt: step.retry_prompt || "",
        retryPromptTranslations:
          (step.retry_prompt_translations as Record<string, string> | null) ||
          null,
        fallbackPrompt: step.prompt || "",
        fallbackPromptTranslations:
          (step.prompt_translations as Record<string, string> | null) || null,
      })
    : step.retry_prompt || "";

  return {
    step_key: clean(step.step_key),
    step_order: Number(step.step_order || 0),
    slot: getStepSlot(step),
    prompt: resolvedPrompt,
    expected_type: step.expected_type || "text",
    required: step.required === true,
    retry_prompt: resolvedRetryPrompt,
    validation_config: step.validation_config || null,
    prompt_translations: step.prompt_translations || null,
    retry_prompt_translations: step.retry_prompt_translations || null,
  };
}

function buildDisplayTemplateAliases(
  values: Record<string, unknown>
): Record<string, string> {
  const output: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(values || {})) {
    const value = clean(rawValue);

    if (!key || !value) continue;

    output[key] = value;
    output[`${key}_display`] = value;
  }

  return output;
}

function buildRealtimeTemplateValues(
  bookingState: BookingState
): Record<string, string> {
  const baseValues = buildBookingPromptTemplateValues(bookingState);
  const displayValues = buildDisplayTemplateAliases(baseValues);

  const datetimeValue =
    clean(displayValues.datetime) ||
    clean(displayValues.appointment_datetime) ||
    clean(displayValues.start_time) ||
    clean(displayValues.startTime);

  if (datetimeValue) {
    displayValues.datetime = displayValues.datetime || datetimeValue;
    displayValues.datetime_display =
      displayValues.datetime_display || datetimeValue;
  }

  return displayValues;
}

export function buildRealtimeNextRequiredStep(params: {
  steps: BookingFlowStepLike[];
  bookingState: BookingState;
  locale?: VoiceLocale;
  overridePrompt?: string;
}): BuildRealtimeNextRequiredStepResult {
  const { steps, bookingState, locale, overridePrompt } = params;

  if (!bookingState.current_step_key) {
    return {
      ok: true,
      next_required_step: null,
    };
  }

  const step = steps.find(
    (candidate) =>
      clean(candidate.step_key) === clean(bookingState.current_step_key)
  );

  if (!step) {
    return {
      ok: true,
      next_required_step: null,
    };
  }

  const mapped = mapStepForRealtime(step, locale);
  const templateValues = buildRealtimeTemplateValues(bookingState);

  const requiresStrictTemplate =
    mapped.slot === "confirmation" ||
    isConfirmationLikeStep(step) ||
    mapped.step_key === "success";

  const promptRender = overridePrompt
    ? {
        ok: true as const,
        text: clean(overridePrompt),
      }
    : renderBookingStepTemplateSafe({
        template: mapped.prompt,
        values: templateValues,
        requireNonEmptyValues: requiresStrictTemplate,
      });

  const retryPromptRender = renderBookingStepTemplateSafe({
    template: mapped.retry_prompt || mapped.prompt,
    values: templateValues,
    requireNonEmptyValues: requiresStrictTemplate,
  });

  if (!promptRender.ok && !retryPromptRender.ok) {
    console.error("[VOICE_REALTIME][BOOKING_STEP_TEMPLATE_INVALID]", {
      step_key: mapped.step_key,
      slot: mapped.slot,
      prompt_error: promptRender.error,
      prompt_key: promptRender.key,
      retry_prompt_error: retryPromptRender.error,
      retry_prompt_key: retryPromptRender.key,
    });

    return {
      ok: false,
      error: "BOOKING_STEP_TEMPLATE_INVALID",
      step_key: mapped.step_key,
      slot: mapped.slot,
      prompt_error: promptRender.error,
      retry_prompt_error: retryPromptRender.error,
      next_required_step: null,
    };
  }

  const renderedPrompt = promptRender.ok
    ? promptRender.text
    : retryPromptRender.text;

  const renderedRetryPrompt = retryPromptRender.ok
    ? retryPromptRender.text
    : renderedPrompt;

  return {
    ok: true,
    next_required_step: {
      step_key: mapped.step_key,
      step_order: mapped.step_order,
      slot: mapped.slot,
      prompt: renderedPrompt,
      expected_type: mapped.expected_type,
      required: mapped.required,
      retry_prompt: renderedRetryPrompt,
      validation_config: mapped.validation_config,
      prompt_translations: mapped.prompt_translations,
      retry_prompt_translations: mapped.retry_prompt_translations,
    },
  };
}