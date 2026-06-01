//src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimeStructuredValue.ts
import {
  clean,
  type BookingFlowStepLike,
} from "../../realtimeBookingFlowUtils";

export type RealtimeStructuredValueResult =
  | {
      ok: true;
      value: string;
      source: "model";
    }
  | {
      ok: false;
      error: "EMPTY_SUBMITTED_VALUE" | "INCOMPATIBLE_TEXT_VALUE";
      value: "";
      source: "none";
    };

function getValidationConfig(step: BookingFlowStepLike): Record<string, unknown> {
  return step.validation_config && typeof step.validation_config === "object"
    ? (step.validation_config as Record<string, unknown>)
    : {};
}

function getRequiredFields(step: BookingFlowStepLike): string[] {
  const config = getValidationConfig(step);
  const raw = config.required_fields;

  if (!Array.isArray(raw)) return [];

  return raw.map(clean).filter(Boolean);
}

function getOutputTemplate(step: BookingFlowStepLike): string {
  const config = getValidationConfig(step);
  return clean(config.output_template);
}

function parseObjectJson(value: string): Record<string, unknown> | null {
  const text = clean(value);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasAllRequiredFields(params: {
  payload: Record<string, unknown>;
  requiredFields: string[];
}): boolean {
  return params.requiredFields.every((field) => clean(params.payload[field]));
}

function renderOutputTemplate(params: {
  payload: Record<string, unknown>;
  outputTemplate: string;
}): string {
  let output = params.outputTemplate;

  for (const field of Object.keys(params.payload)) {
    output = output.split(`{${field}}`).join(clean(params.payload[field]));
  }

  return clean(output);
}

export function resolveRealtimeStructuredValue(params: {
  step: BookingFlowStepLike;
  value: string;
  modelValue: string;
  rawTranscriptValue: string;
}): RealtimeStructuredValueResult {
  const requiredFields = getRequiredFields(params.step);
  const outputTemplate = getOutputTemplate(params.step);

  if (!requiredFields.length || !outputTemplate) {
    return {
      ok: false,
      error: "INCOMPATIBLE_TEXT_VALUE",
      value: "",
      source: "none",
    };
  }

  const payload =
    parseObjectJson(params.modelValue) ||
    parseObjectJson(params.value);

  if (!payload) {
    return {
      ok: false,
      error:
        clean(params.value) || clean(params.modelValue) || clean(params.rawTranscriptValue)
          ? "INCOMPATIBLE_TEXT_VALUE"
          : "EMPTY_SUBMITTED_VALUE",
      value: "",
      source: "none",
    };
  }

  if (!hasAllRequiredFields({ payload, requiredFields })) {
    return {
      ok: false,
      error: "INCOMPATIBLE_TEXT_VALUE",
      value: "",
      source: "none",
    };
  }

  const renderedValue = renderOutputTemplate({
    payload,
    outputTemplate,
  });

  if (!renderedValue) {
    return {
      ok: false,
      error: "INCOMPATIBLE_TEXT_VALUE",
      value: "",
      source: "none",
    };
  }

  return {
    ok: true,
    value: renderedValue,
    source: "model",
  };
}