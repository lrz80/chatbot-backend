//src/lib/voice/realtime/realtimeToolExecutor.ts
import { createAppointmentFromVoice } from "../../appointments/createAppointmentFromVoice";
import { getAppointmentSettings } from "../../appointments/getAppointmentSettings";
import { getBookingFlow } from "../../appointments/getBookingFlow";

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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getStepSlot(step: BookingFlowStepLike): string {
  const validationConfig =
    step.validation_config &&
    typeof step.validation_config === "object"
      ? (step.validation_config as Record<string, unknown>)
      : null;

  const configuredSlot = clean(validationConfig?.slot);

  if (configuredSlot) {
    return configuredSlot;
  }

  return clean(step.step_key);
}

function isConfirmationStep(step: BookingFlowStepLike): boolean {
  const slot = getStepSlot(step).toLowerCase();
  const stepKey = clean(step.step_key).toLowerCase();

  return (
    slot === "customer_confirmed" ||
    slot === "confirmation" ||
    stepKey === "customer_confirmed" ||
    stepKey === "confirmation" ||
    stepKey === "confirm"
  );
}

function isSuccessStep(step: BookingFlowStepLike): boolean {
  const slot = getStepSlot(step).toLowerCase();
  const stepKey = clean(step.step_key).toLowerCase();

  return (
    slot === "success" ||
    slot === "success_message" ||
    stepKey === "success" ||
    stepKey === "success_message"
  );
}

function sortFlowSteps(steps: BookingFlowStepLike[]): BookingFlowStepLike[] {
  return [...steps]
    .filter((step) => step.enabled !== false)
    .sort((a, b) => Number(a.step_order || 0) - Number(b.step_order || 0));
}

function mapFlowStepsForRealtime(steps: BookingFlowStepLike[]) {
  return sortFlowSteps(steps).map((step) => ({
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
  }));
}

function buildAnswersBySlot(params: {
  args: Record<string, any>;
  callerPhone: string | null;
}): Record<string, string> {
  const { args, callerPhone } = params;

  const answersBySlot: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(args || {})) {
    const key = clean(rawKey);
    if (!key || key === "customer_confirmed") continue;

    if (typeof rawValue === "boolean") {
      continue;
    }

    const value = clean(rawValue);
    if (!value) continue;

    answersBySlot[key] = value;
  }

  if (!answersBySlot.customer_phone && callerPhone) {
    answersBySlot.customer_phone = clean(callerPhone);
  }

  return answersBySlot;
}

function getMissingRequiredFlowSlots(params: {
  steps: BookingFlowStepLike[];
  answersBySlot: Record<string, string>;
}): string[] {
  const { steps, answersBySlot } = params;

  const missing: string[] = [];

  for (const step of sortFlowSteps(steps)) {
    if (step.required !== true) continue;
    if (isConfirmationStep(step)) continue;
    if (isSuccessStep(step)) continue;

    const slot = getStepSlot(step);
    if (!slot) continue;

    const value = clean(answersBySlot[slot]);
    if (!value) {
      missing.push(slot);
    }
  }

  return missing;
}

function buildMissingStepDetails(params: {
  steps: BookingFlowStepLike[];
  missingSlots: string[];
}) {
  const { steps, missingSlots } = params;

  const missingSet = new Set(missingSlots);

  return sortFlowSteps(steps)
    .filter((step) => {
      const slot = getStepSlot(step);
      return missingSet.has(slot);
    })
    .map((step) => ({
      step_key: clean(step.step_key),
      step_order: Number(step.step_order || 0),
      slot: getStepSlot(step),
      prompt: step.prompt || "",
      retry_prompt: step.retry_prompt || "",
      required: step.required === true,
      expected_type: step.expected_type || "text",
      validation_config: step.validation_config || null,
      prompt_translations: step.prompt_translations || null,
      retry_prompt_translations: step.retry_prompt_translations || null,
    }));
}

function getNextMissingRequiredStep(params: {
  steps: BookingFlowStepLike[];
  answersBySlot: Record<string, string>;
}) {
  const { steps, answersBySlot } = params;

  for (const step of sortFlowSteps(steps)) {
    if (step.required !== true) continue;
    if (isConfirmationStep(step)) continue;
    if (isSuccessStep(step)) continue;

    const slot = getStepSlot(step);
    if (!slot) continue;

    const value = clean(answersBySlot[slot]);
    if (!value) {
      return {
        step_key: clean(step.step_key),
        step_order: Number(step.step_order || 0),
        slot,
        prompt: step.prompt || "",
        retry_prompt: step.retry_prompt || "",
        required: true,
        expected_type: step.expected_type || "text",
        validation_config: step.validation_config || null,
        prompt_translations: step.prompt_translations || null,
        retry_prompt_translations: step.retry_prompt_translations || null,
      };
    }
  }

  return null;
}

export async function executeRealtimeTool({
  tenantId,
  callerPhone,
  toolName,
  args,
}: ExecuteRealtimeToolParams): Promise<any> {
  switch (toolName) {
    case "get_booking_flow": {
      const steps = await getBookingFlow(tenantId, "voice");

      return {
        ok: true,
        steps: mapFlowStepsForRealtime(steps as BookingFlowStepLike[]),
      };
    }

    case "create_appointment": {
      const [settings, steps] = await Promise.all([
        getAppointmentSettings(tenantId),
        getBookingFlow(tenantId, "voice"),
      ]);

      const flowSteps = sortFlowSteps(steps as BookingFlowStepLike[]);
      const answersBySlot = buildAnswersBySlot({
        args,
        callerPhone,
      });

      const missingRequiredSlots = getMissingRequiredFlowSlots({
        steps: flowSteps,
        answersBySlot,
      });

      if (missingRequiredSlots.length > 0) {
        return {
          ok: false,
          error: "MISSING_REQUIRED_BOOKING_FIELDS",
          message:
            "The appointment cannot be created until all required booking fields from the tenant flow are completed.",
          missing_required_slots: missingRequiredSlots,
          next_required_step: getNextMissingRequiredStep({
            steps: flowSteps,
            answersBySlot,
          }),
          missing_required_steps: buildMissingStepDetails({
            steps: flowSteps,
            missingSlots: missingRequiredSlots,
          }),
        };
      }

      if (args.customer_confirmed !== true) {
        return {
          ok: false,
          error: "MISSING_FINAL_CONFIRMATION",
          message:
            "The appointment cannot be created until the caller explicitly confirms the final appointment details.",
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

      return {
        ok: true,
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

    default:
      return {
        ok: false,
        error: "UNKNOWN_TOOL",
        message: `Unknown realtime tool: ${toolName}`,
      };
  }
}