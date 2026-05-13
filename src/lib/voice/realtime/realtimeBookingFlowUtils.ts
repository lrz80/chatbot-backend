//src/lib/voice/realtime/realtimeBookingFlowUtils.ts
import type { CallState } from "../types";

export type BookingFlowStepLike = {
  enabled?: boolean;
  required?: boolean;
  step_key?: string;
  step_order?: number;
  prompt?: string | null;
  retry_prompt?: string | null;
  expected_type?: string | null;
  validation_config?: Record<string, unknown> | null;
  prompt_translations?: Record<string, unknown> | null;
  retry_prompt_translations?: Record<string, unknown> | null;
};

export type BookingState = {
  current_step_key: string | null;
  current_step_slot: string | null;
  awaiting_confirmation: boolean;
  final_confirmation_granted: boolean;
  ready_to_create: boolean;
  collected_slots: Record<string, string>;
};

export type StepOptionCandidate = {
  canonical: string;
  candidates: string[];
};

export function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeComparable(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function toCleanStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => clean(item)).filter(Boolean);
  }

  const single = clean(value);
  return single ? [single] : [];
}

export function extractStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, string> = {};

  for (const [key, raw] of Object.entries(record)) {
    const normalizedKey = clean(key);
    if (!normalizedKey) continue;
    if (typeof raw === "boolean") continue;
    if (raw === null || raw === undefined) continue;

    const normalizedValue = clean(raw);
    if (!normalizedValue) continue;

    result[normalizedKey] = normalizedValue;
  }

  return result;
}

export function getValidationConfig(
  step: BookingFlowStepLike
): Record<string, unknown> | null {
  return step.validation_config && typeof step.validation_config === "object"
    ? (step.validation_config as Record<string, unknown>)
    : null;
}

export function getStepSlot(step: BookingFlowStepLike): string {
  const validationConfig = getValidationConfig(step);
  const configuredSlot = clean(validationConfig?.slot);

  if (configuredSlot) {
    return configuredSlot;
  }

  return clean(step.step_key);
}

export function getStepAliases(step: BookingFlowStepLike): string[] {
  const aliases = new Set<string>();

  const stepKey = clean(step.step_key);
  const canonicalSlot = getStepSlot(step);

  if (stepKey) aliases.add(stepKey);
  if (canonicalSlot) aliases.add(canonicalSlot);

  return Array.from(aliases);
}

export function getAnswerValueForStep(
  step: BookingFlowStepLike,
  answersBySlot: Record<string, string>
): string {
  for (const alias of getStepAliases(step)) {
    const value = clean(answersBySlot[alias]);
    if (value) {
      return value;
    }
  }

  return "";
}

export function isTerminalFlowStep(step: BookingFlowStepLike): boolean {
  const validationConfig = getValidationConfig(step);
  const terminal = clean(validationConfig?.terminal_behavior).toLowerCase();

  return terminal === "success" || terminal === "end";
}

export function isConfirmationLikeStep(step: BookingFlowStepLike): boolean {
  return (
    clean(step.expected_type).toLowerCase() === "confirmation" ||
    clean(step.step_key) === "offer_booking_sms"
  );
}

export function isSuccessStep(step: BookingFlowStepLike): boolean {
  return isTerminalFlowStep(step);
}

export function sortFlowSteps(
  steps: BookingFlowStepLike[]
): BookingFlowStepLike[] {
  return [...steps]
    .filter((step) => step.enabled !== false)
    .sort((a, b) => Number(a.step_order || 0) - Number(b.step_order || 0));
}

export function extractStepOptionCandidates(
  step: BookingFlowStepLike
): StepOptionCandidate[] {
  const validationConfig = getValidationConfig(step);
  const options = Array.isArray(validationConfig?.options)
    ? validationConfig.options
    : [];

  const results: StepOptionCandidate[] = [];

  for (const option of options) {
    if (typeof option === "string") {
      const canonical = clean(option);
      if (!canonical) continue;

      results.push({
        canonical,
        candidates: [canonical],
      });
      continue;
    }

    if (!option || typeof option !== "object") {
      continue;
    }

    const record = option as Record<string, unknown>;
    const canonical =
      clean(record.value) ||
      clean(record.label) ||
      clean(record.name) ||
      clean(record.title);

    if (!canonical) {
      continue;
    }

    const candidateSet = new Set<string>();

    [
      canonical,
      clean(record.label),
      clean(record.name),
      clean(record.title),
      ...toCleanStringArray(record.aliases),
      ...toCleanStringArray(record.synonyms),
      ...toCleanStringArray(record.keywords),
      ...toCleanStringArray(record.examples),
      ...toCleanStringArray(record.speech_hints),
    ]
      .filter(Boolean)
      .forEach((item) => candidateSet.add(item));

    results.push({
      canonical,
      candidates: Array.from(candidateSet),
    });
  }

  return results;
}

export function canonicalizeGenericStepValue(
  step: BookingFlowStepLike,
  rawValue: string
): string {
  const input = clean(rawValue);
  if (!input) return "";

  const options = extractStepOptionCandidates(step);
  if (!options.length) {
    return input;
  }

  const normalizedInput = normalizeComparable(input);

  for (const option of options) {
    for (const candidate of option.candidates) {
      const normalizedCandidate = normalizeComparable(candidate);
      if (normalizedCandidate && normalizedInput === normalizedCandidate) {
        return option.canonical;
      }
    }
  }

  const matchedOptions = options.filter((option) =>
    option.candidates.some((candidate) => {
      const normalizedCandidate = normalizeComparable(candidate);
      if (!normalizedCandidate || normalizedCandidate.length < 4) {
        return false;
      }

      return (
        normalizedInput.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalizedInput)
      );
    })
  );

  if (matchedOptions.length === 1) {
    return matchedOptions[0].canonical;
  }

  return input;
}

export function buildAnswersBySlot(params: {
  args: Record<string, any>;
  callerPhone: string | null;
  state?: CallState;
}): Record<string, string> {
  const { args, callerPhone, state } = params;

  const answersBySlot: Record<string, string> = {
    ...extractStringRecord(state?.bookingData),
  };

  for (const [rawKey, rawValue] of Object.entries(args || {})) {
    const key = clean(rawKey);
    if (!key) continue;
    if (typeof rawValue === "boolean") continue;

    const value = clean(rawValue);
    if (!value) continue;

    answersBySlot[key] = value;
  }

  if (!answersBySlot.customer_phone && callerPhone) {
    answersBySlot.customer_phone = clean(callerPhone);
  }

  return answersBySlot;
}

export function normalizeAnswersToCanonicalSlots(params: {
  steps: BookingFlowStepLike[];
  answersBySlot: Record<string, string>;
}): Record<string, string> {
  const { steps } = params;
  const normalized: Record<string, string> = { ...params.answersBySlot };

  for (const step of sortFlowSteps(steps)) {
    const canonicalSlot = getStepSlot(step);
    if (!canonicalSlot) continue;

    const rawValue = getAnswerValueForStep(step, normalized);
    if (!rawValue) continue;

    const canonicalValue = canonicalizeGenericStepValue(step, rawValue);

    normalized[canonicalSlot] = canonicalValue;

    const stepKey = clean(step.step_key);
    if (stepKey) {
    normalized[stepKey] = canonicalValue;
    }
  }

  return normalized;
}

export function getMissingRequiredFlowSteps(params: {
  steps: BookingFlowStepLike[];
  answersBySlot: Record<string, string>;
}): BookingFlowStepLike[] {
  const { steps, answersBySlot } = params;

  return sortFlowSteps(steps).filter((step) => {
    if (step.required !== true) return false;
    if (isConfirmationLikeStep(step)) return false;
    if (isSuccessStep(step)) return false;

    const slot = getStepSlot(step);
    if (!slot) return false;

    const value = getAnswerValueForStep(step, answersBySlot);
    return !value;
  });
}

export function getStepIndexByKey(
  steps: BookingFlowStepLike[],
  stepKey: string
): number {
  return steps.findIndex((step) => clean(step.step_key) === clean(stepKey));
}

export function getConfirmationLikeStep(
  steps: BookingFlowStepLike[]
): BookingFlowStepLike | null {
  for (const step of sortFlowSteps(steps)) {
    if (isConfirmationLikeStep(step)) {
      return step;
    }
  }

  return null;
}

export function resolveCurrentStepIndex(params: {
  steps: BookingFlowStepLike[];
  state: CallState;
  answersBySlot: Record<string, string>;
  explicitStepKey?: string;
}): number | null {
  const { steps, state, answersBySlot, explicitStepKey } = params;

  if (explicitStepKey) {
    const explicitIndex = getStepIndexByKey(steps, explicitStepKey);
    if (explicitIndex >= 0) return explicitIndex;
  }

  if (
    typeof state.bookingStepIndex === "number" &&
    state.bookingStepIndex >= 0 &&
    state.bookingStepIndex < steps.length
  ) {
    return state.bookingStepIndex;
  }

  const missingRequired = getMissingRequiredFlowSteps({
    steps,
    answersBySlot,
  });

  if (missingRequired.length > 0) {
    const idx = getStepIndexByKey(steps, clean(missingRequired[0].step_key));
    return idx >= 0 ? idx : 0;
  }

  const confirmationStep = getConfirmationLikeStep(steps);
  if (confirmationStep) {
    const idx = getStepIndexByKey(steps, clean(confirmationStep.step_key));
    return idx >= 0 ? idx : null;
  }

  return steps.length ? 0 : null;
}

export function getNextStepIndex(
  steps: BookingFlowStepLike[],
  currentIndex: number
): number | null {
  const nextIndex = currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= steps.length) {
    return null;
  }
  return nextIndex;
}

export function buildCanonicalCallState(params: {
  state: CallState;
  answersBySlot: Record<string, string>;
  bookingStepIndex?: number | null;
}): CallState {
  const { state, answersBySlot, bookingStepIndex } = params;

  return {
    ...state,
    bookingStepIndex:
      typeof bookingStepIndex === "number" ? bookingStepIndex : undefined,
    bookingData: {
      ...(state.bookingData || {}),
      ...answersBySlot,
    },
  };
}

export function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => clean(item)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export function renderBookingStepTemplate(
  template: string,
  values: Record<string, string>
): string {
  return String(template || "").replace(/\{([^}]+)\}/g, (_, rawKey: string) => {
    const key = clean(rawKey);
    return clean(values[key] || "");
  });
}

export function buildBookingPromptTemplateValues(
  bookingState: BookingState
): Record<string, string> {
  const slots = bookingState.collected_slots || {};

  const readFirst = (...keys: string[]): string => {
    for (const key of keys) {
      const value = clean(slots[key]);
      if (value) return value;
    }
    return "";
  };

  return {
    service: readFirst(
      "service_display",
      "service",
      "service_name",
      "requested_service",
      "selected_service",
      "appointment_service"
    ),
    datetime: readFirst(
      "datetime_display",
      "datetime",
      "datetime_iso",
      "requested_datetime",
      "appointment_datetime",
      "start_time"
    ),
    customer_name: readFirst("customer_name", "name"),
    customer_phone: readFirst("customer_phone", "phone"),
    pet_name: readFirst("pet_name"),
    pet_weight: readFirst("pet_weight", "subject_detail"),
    location_detail: readFirst("location_detail"),
  };
}