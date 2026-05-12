import { createAppointmentFromVoice } from "../../appointments/createAppointmentFromVoice";
import { getAppointmentSettings } from "../../appointments/getAppointmentSettings";
import { getBookingFlow } from "../../appointments/getBookingFlow";
import { resolveVoiceScheduleValidation } from "../../appointments/resolveVoiceScheduleValidation";

type ExecuteRealtimeToolParams = {
  tenantId: string;
  callerPhone: string | null;
  toolName: string;
  args: Record<string, any>;
};

type BookingFlowStepLike = {
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

type RealtimeMappedStep = {
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

type BookingState = {
  current_step_key: string | null;
  current_step_slot: string | null;
  awaiting_confirmation: boolean;
  final_confirmation_granted: boolean;
  ready_to_create: boolean;
  collected_slots: Record<string, string>;
};

type StepOptionCandidate = {
  canonical: string;
  candidates: string[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeComparable(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function toCleanStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => clean(item)).filter(Boolean);
  }

  const single = clean(value);
  return single ? [single] : [];
}

function getValidationConfig(
  step: BookingFlowStepLike
): Record<string, unknown> | null {
  return step.validation_config && typeof step.validation_config === "object"
    ? (step.validation_config as Record<string, unknown>)
    : null;
}

function getStepSlot(step: BookingFlowStepLike): string {
  const validationConfig = getValidationConfig(step);
  const configuredSlot = clean(validationConfig?.slot);

  if (configuredSlot) {
    return configuredSlot;
  }

  return clean(step.step_key);
}

function getStepAliases(step: BookingFlowStepLike): string[] {
  const aliases = new Set<string>();

  const stepKey = clean(step.step_key);
  const canonicalSlot = getStepSlot(step);

  if (stepKey) aliases.add(stepKey);
  if (canonicalSlot) aliases.add(canonicalSlot);

  return Array.from(aliases);
}

function getAnswerValueForStep(
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

function isTerminalFlowStep(step: BookingFlowStepLike): boolean {
  const validationConfig = getValidationConfig(step);
  const terminal = clean(validationConfig?.terminal_behavior).toLowerCase();

  return terminal === "success" || terminal === "end";
}

function isConfirmationStep(step: BookingFlowStepLike): boolean {
  return clean(step.expected_type).toLowerCase() === "confirmation";
}

function isSuccessStep(step: BookingFlowStepLike): boolean {
  return isTerminalFlowStep(step);
}

function sortFlowSteps(steps: BookingFlowStepLike[]): BookingFlowStepLike[] {
  return [...steps]
    .filter((step) => step.enabled !== false)
    .sort((a, b) => Number(a.step_order || 0) - Number(b.step_order || 0));
}

function mapStepForRealtime(step: BookingFlowStepLike): RealtimeMappedStep {
  return {
    step_key: clean(step.step_key),
    step_order: Number(step.step_order || 0),
    slot: getStepSlot(step),
    prompt: step.prompt || "",
    expected_type: step.expected_type || "text",
    required: step.required === true,
    retry_prompt: step.retry_prompt || "",
    validation_config: step.validation_config || null,
    prompt_translations: step.prompt_translations || null,
    retry_prompt_translations: step.retry_prompt_translations || null,
  };
}

function mapFlowStepsForRealtime(
  steps: BookingFlowStepLike[]
): RealtimeMappedStep[] {
  return sortFlowSteps(steps).map(mapStepForRealtime);
}

function extractStepOptionCandidates(
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

function canonicalizeStepValue(
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

function resolveConfiguredConfirmationValue(
  step: BookingFlowStepLike,
  rawValue: unknown
): boolean | null {
  const validationConfig = getValidationConfig(step);

  const acceptValues = Array.isArray(validationConfig?.accept_values)
    ? validationConfig.accept_values.map((item) => normalizeComparable(item))
    : [];

  const rejectValues = Array.isArray(validationConfig?.reject_values)
    ? validationConfig.reject_values.map((item) => normalizeComparable(item))
    : [];

  const normalized = normalizeComparable(rawValue);

  if (!normalized) return null;
  if (acceptValues.includes(normalized)) return true;
  if (rejectValues.includes(normalized)) return false;

  return null;
}

function buildAnswersBySlot(params: {
  args: Record<string, any>;
  callerPhone: string | null;
}): Record<string, string> {
  const { args, callerPhone } = params;

  const answersBySlot: Record<string, string> = {};

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

function normalizeAnswersToCanonicalSlots(params: {
  steps: BookingFlowStepLike[];
  answersBySlot: Record<string, string>;
}): Record<string, string> {
  const { steps } = params;
  const normalized: Record<string, string> = { ...params.answersBySlot };

  for (const step of sortFlowSteps(steps)) {
    const canonicalSlot = getStepSlot(step);
    if (!canonicalSlot) continue;

    const value = getAnswerValueForStep(step, normalized);
    if (!value) continue;

    normalized[canonicalSlot] = value;

    const stepKey = clean(step.step_key);
    if (stepKey) {
      normalized[stepKey] = value;
    }
  }

  return normalized;
}

function getMissingRequiredFlowSteps(params: {
  steps: BookingFlowStepLike[];
  answersBySlot: Record<string, string>;
}): BookingFlowStepLike[] {
  const { steps, answersBySlot } = params;

  return sortFlowSteps(steps).filter((step) => {
    if (step.required !== true) return false;
    if (isConfirmationStep(step)) return false;
    if (isSuccessStep(step)) return false;

    const slot = getStepSlot(step);
    if (!slot) return false;

    const value = getAnswerValueForStep(step, answersBySlot);
    return !value;
  });
}

function buildMissingStepDetails(steps: BookingFlowStepLike[]) {
  return steps.map(mapStepForRealtime);
}

function getConfirmationStep(
  steps: BookingFlowStepLike[]
): BookingFlowStepLike | null {
  for (const step of sortFlowSteps(steps)) {
    if (isConfirmationStep(step)) {
      return step;
    }
  }

  return null;
}

function getNextMissingRequiredStep(params: {
  steps: BookingFlowStepLike[];
  answersBySlot: Record<string, string>;
}): RealtimeMappedStep | null {
  const missingSteps = getMissingRequiredFlowSteps(params);

  if (missingSteps.length === 0) {
    return null;
  }

  return mapStepForRealtime(missingSteps[0]);
}

function resolveNextRequiredStepFromState(params: {
  steps: BookingFlowStepLike[];
  bookingState: BookingState;
}): RealtimeMappedStep | null {
  const { steps, bookingState } = params;

  if (bookingState.awaiting_confirmation) {
    const confirmationStep = getConfirmationStep(steps);
    return confirmationStep ? mapStepForRealtime(confirmationStep) : null;
  }

  if (bookingState.ready_to_create) {
    return null;
  }

  return getNextMissingRequiredStep({
    steps,
    answersBySlot: bookingState.collected_slots,
  });
}

function buildBookingState(params: {
  steps: BookingFlowStepLike[];
  answersBySlot: Record<string, string>;
  finalConfirmationGranted: boolean;
}): BookingState {
  const { steps, answersBySlot, finalConfirmationGranted } = params;

  const missingSteps = getMissingRequiredFlowSteps({
    steps,
    answersBySlot,
  });

  if (missingSteps.length > 0) {
    const currentStep = missingSteps[0];
    return {
      current_step_key: clean(currentStep.step_key) || null,
      current_step_slot: getStepSlot(currentStep) || null,
      awaiting_confirmation: false,
      final_confirmation_granted: false,
      ready_to_create: false,
      collected_slots: answersBySlot,
    };
  }

  const confirmationStep = getConfirmationStep(steps);

  if (confirmationStep && !finalConfirmationGranted) {
    return {
      current_step_key: clean(confirmationStep.step_key) || null,
      current_step_slot: getStepSlot(confirmationStep) || null,
      awaiting_confirmation: true,
      final_confirmation_granted: false,
      ready_to_create: false,
      collected_slots: answersBySlot,
    };
  }

  return {
    current_step_key: null,
    current_step_slot: null,
    awaiting_confirmation: false,
    final_confirmation_granted: finalConfirmationGranted,
    ready_to_create: true,
    collected_slots: answersBySlot,
  };
}

export async function executeRealtimeTool({
  tenantId,
  callerPhone,
  toolName,
  args,
}: ExecuteRealtimeToolParams): Promise<any> {
  switch (toolName) {
    case "get_booking_flow": {
      const steps = sortFlowSteps(
        (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
      );

      const answersBySlot = normalizeAnswersToCanonicalSlots({
        steps,
        answersBySlot: buildAnswersBySlot({
          args,
          callerPhone,
        }),
      });

      const bookingState = buildBookingState({
        steps,
        answersBySlot,
        finalConfirmationGranted: false,
      });

      return {
        ok: true,
        steps: mapFlowStepsForRealtime(steps),
        booking_state: bookingState,
        next_required_step: resolveNextRequiredStepFromState({
          steps,
          bookingState,
        }),
      };
    }

    case "submit_booking_step": {
      const steps = sortFlowSteps(
        (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
      );

      const rawAnswers = buildAnswersBySlot({
        args,
        callerPhone,
      });

      const stepKey = clean(args.step_key);
      const value = clean(args.value);

      if (!stepKey) {
        return {
          ok: false,
          error: "MISSING_STEP_KEY",
          message: "step_key is required.",
        };
      }

      const targetStep =
        steps.find((step) => clean(step.step_key) === stepKey) || null;

      if (!targetStep) {
        return {
          ok: false,
          error: "UNKNOWN_BOOKING_STEP",
          message: `Unknown booking step: ${stepKey}`,
        };
      }

      const targetSlot = getStepSlot(targetStep);

      if (!targetSlot) {
        return {
          ok: false,
          error: "BOOKING_STEP_WITHOUT_SLOT",
          message: `Booking step ${stepKey} has no canonical slot.`,
        };
      }

      const normalizedStepValue = canonicalizeStepValue(targetStep, value);

      const optionCandidates = extractStepOptionCandidates(targetStep);
      const hasConfiguredOptions = optionCandidates.length > 0;

      if (hasConfiguredOptions) {
        const resolvedToConfiguredOption = optionCandidates.some(
          (option) =>
            normalizeComparable(option.canonical) ===
            normalizeComparable(normalizedStepValue)
        );

        if (!resolvedToConfiguredOption) {
          const bookingState = buildBookingState({
            steps,
            answersBySlot: rawAnswers,
            finalConfirmationGranted: false,
          });

          return {
            ok: false,
            error: "UNRESOLVED_STEP_OPTION",
            message:
              "The requested value could not be resolved to a configured canonical option.",
            booking_state: bookingState,
            next_required_step: mapStepForRealtime(targetStep),
          };
        }
      }

      const mergedAnswers: Record<string, string> = {
        ...rawAnswers,
      };

      if (normalizedStepValue) {
        mergedAnswers[targetSlot] = normalizedStepValue;
        mergedAnswers[stepKey] = normalizedStepValue;
      }

      const answersBySlot = normalizeAnswersToCanonicalSlots({
        steps,
        answersBySlot: mergedAnswers,
      });

      if ((targetStep.expected_type || "").toLowerCase() === "datetime") {
        const serviceName = clean(answersBySlot.service);
        const rawDatetime = clean(answersBySlot.datetime);
        const validationConfig = getValidationConfig(targetStep);

        if (serviceName && rawDatetime) {
          const scheduleValidation = await resolveVoiceScheduleValidation({
            tenantId,
            serviceName,
            rawDatetime,
            channel: "voice",
          });

          if (!scheduleValidation.ok) {
            const invalidAnswersBySlot = {
              ...answersBySlot,
              [targetSlot]: "",
              [stepKey]: "",
              datetime: "",
            };

            const bookingState = buildBookingState({
              steps,
              answersBySlot: invalidAnswersBySlot,
              finalConfirmationGranted: false,
            });

            return {
              ok: false,
              error: "SLOT_UNAVAILABLE",
              message: "The requested date and time is not available.",
              booking_state: bookingState,
              next_required_step: mapStepForRealtime(targetStep),
              unavailable_reason: scheduleValidation.reason,
              unavailable_prompt:
                typeof validationConfig?.unavailable_prompt === "string"
                  ? validationConfig.unavailable_prompt
                  : "",
              available_times: Array.isArray(scheduleValidation.availableTimes)
                ? scheduleValidation.availableTimes
                : [],
              suggested_times: Array.isArray(scheduleValidation.suggestedStarts)
                ? scheduleValidation.suggestedStarts
                : [],
            };
          }
        }
      }

      const confirmationValue = isConfirmationStep(targetStep)
        ? resolveConfiguredConfirmationValue(targetStep, normalizedStepValue)
        : null;

      const finalConfirmationGranted = confirmationValue === true;

      const bookingState = buildBookingState({
        steps,
        answersBySlot,
        finalConfirmationGranted,
      });

      return {
        ok: true,
        booking_state: bookingState,
        next_required_step: resolveNextRequiredStepFromState({
          steps,
          bookingState,
        }),
        action_required: bookingState.ready_to_create
          ? "create_appointment"
          : null,
      };
    }

    case "create_appointment": {
      const [settings, stepsRaw] = await Promise.all([
        getAppointmentSettings(tenantId),
        getBookingFlow(tenantId, "voice"),
      ]);

      const steps = sortFlowSteps(stepsRaw as BookingFlowStepLike[]);

      const answersBySlot = normalizeAnswersToCanonicalSlots({
        steps,
        answersBySlot: buildAnswersBySlot({
          args,
          callerPhone,
        }),
      });

      const missingSteps = getMissingRequiredFlowSteps({
        steps,
        answersBySlot,
      });

      if (missingSteps.length > 0) {
        const bookingState = buildBookingState({
          steps,
          answersBySlot,
          finalConfirmationGranted: false,
        });

        return {
          ok: false,
          error: "MISSING_REQUIRED_BOOKING_FIELDS",
          message:
            "The appointment cannot be created until all required booking fields from the tenant flow are completed.",
          booking_state: bookingState,
          missing_required_slots: missingSteps.map((step) => getStepSlot(step)),
          next_required_step: resolveNextRequiredStepFromState({
            steps,
            bookingState,
          }),
          missing_required_steps: buildMissingStepDetails(missingSteps),
        };
      }

      const finalConfirmationGranted =
        args.final_confirmation_granted === true;

      if (!finalConfirmationGranted) {
        const bookingState = buildBookingState({
          steps,
          answersBySlot,
          finalConfirmationGranted: false,
        });

        return {
          ok: false,
          error: "MISSING_FINAL_CONFIRMATION",
          message:
            "The appointment cannot be created until the caller explicitly confirms the final appointment details.",
          booking_state: bookingState,
          next_required_step: resolveNextRequiredStepFromState({
            steps,
            bookingState,
          }),
        };
      }

      const service = clean(answersBySlot.service);
      const datetime = clean(answersBySlot.datetime);
      const datetimeIso = clean(answersBySlot.datetime_iso);
      const customerName = clean(answersBySlot.customer_name);
      const customerPhone = clean(answersBySlot.customer_phone) || null;
      const customerEmail = clean(answersBySlot.customer_email) || null;

      if (!service) {
        return {
          ok: false,
          error: "MISSING_SERVICE",
          message: "Service is required before creating an appointment.",
        };
      }

      if (!datetime && !datetimeIso) {
        return {
          ok: false,
          error: "MISSING_DATETIME",
          message: "Date and time are required before creating an appointment.",
        };
      }

      if (!customerName) {
        return {
          ok: false,
          error: "MISSING_CUSTOMER_NAME",
          message: "Customer name is required before creating an appointment.",
        };
      }

      const result = await createAppointmentFromVoice({
        tenantId,
        answersBySlot: {
          ...answersBySlot,
          service,
          datetime,
          datetime_iso: datetimeIso,
          customer_name: customerName,
          customer_phone: customerPhone || "",
          customer_email: customerEmail || "",
        },
        settings,
      });

      const bookingState = buildBookingState({
        steps,
        answersBySlot,
        finalConfirmationGranted: true,
      });

      return {
        ok: true,
        booking_state: bookingState,
        next_required_step: null,
        appointment: {
          id: result.id,
          service: result.service || service,
          customer_name: result.customer_name,
          customer_phone: result.customer_phone,
          start_time: result.start_time,
          end_time: result.end_time,
          status: result.status,
          google_event_link: result.google_event_link || null,
        },
      };
    }

    case "end_call": {
      return {
        ok: true,
        hangup: true,
      };
    }

    default:
      return {
        ok: false,
        error: "UNKNOWN_TOOL",
        message: `Unknown realtime tool: ${toolName}`,
      };
  }
}