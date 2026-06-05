// src/lib/voice/realtime/bookingStep/requestNormalizedStepModelResolution.ts
import { USE_CALLER_PHONE_TOKEN } from "./resolvers/resolveRealtimePhoneValue";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return clean(value).toLowerCase();
}

function isConfirmationStep(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
}): boolean {
  const pendingBookingStepKey = normalizeKey(params.pendingBookingStepKey);
  const pendingSlot = normalizeKey(params.pendingSlot);
  const expectedType = normalizeKey(params.expectedType);
  const validationMode = normalizeKey(params.validationMode);

  return (
    pendingBookingStepKey === "confirm" ||
    pendingBookingStepKey === "confirmation" ||
    pendingSlot === "confirmation" ||
    expectedType === "confirmation" ||
    validationMode === "confirmation"
  );
}

function buildConfirmationNormalizationInstructions(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  lastUserTranscript: string;
}): string {
  return [
    "The caller answered the current booking confirmation step.",
    `Current booking step key: ${params.pendingBookingStepKey}`,
    `Current booking slot: ${params.pendingSlot}`,
    `Current expected type: ${params.expectedType}`,
    `Current validation mode: ${params.validationMode}`,
    `Caller latest answer: ${params.lastUserTranscript}`,
    "",
    "Resolve the caller's latest answer into a booking confirmation intent.",
    "Use only the caller's latest answer.",
    "Do not guess.",
    "Do not invent missing data.",
    "Do not use earlier turns as the answer.",
    "Do not submit the caller's literal words.",
    "",
    "Allowed confirmation values:",
    "- confirm: the caller clearly approves creating the appointment.",
    "- cancel: the caller clearly rejects or cancels the appointment.",
    "- unknown: the caller's answer is unclear, unrelated, incomplete, noise, greeting, or not enough to confirm/cancel.",
    "",
    "If the answer is clear, call submit_booking_step with:",
    `- step_key: ${params.pendingBookingStepKey}`,
    "- value: confirm OR cancel",
    "",
    "If the answer is not clear, do not call submit_booking_step.",
    "Ask the current confirmation question again naturally in the active call language.",
  ].join("\n");
}

function buildDefaultNormalizationInstructions(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  lastUserTranscript: string;
}): string {
  return [
    "The caller answered the current booking step.",
    `Current booking step key: ${params.pendingBookingStepKey}`,
    `Current booking slot: ${params.pendingSlot}`,
    `Current expected type: ${params.expectedType}`,
    `Current validation mode: ${params.validationMode}`,
    `Caller latest answer: ${params.lastUserTranscript}`,
    "",
    "Normalize the caller's latest answer only if needed, then call submit_booking_step.",
    "Use only the caller's latest answer.",
    "Do not guess.",
    "Do not invent missing data.",
    "Do not use earlier turns as the answer.",
    "",
    "Rules:",
    "- If this is an address step, convert spoken numbers into address digits when clear.",
    "- If this is a phone-number step and the caller clearly confirms using the current calling number, submit the configured caller-phone token.",
    `- Caller-phone token: ${USE_CALLER_PHONE_TOKEN}`,
    "- If this is a phone-number step and the caller says a different phone number, submit only the normalized phone number.",
    "- If this is an email step, normalize the email only if the caller clearly said one.",
    "- If the latest answer does not clearly answer this step, ask the current question again naturally.",
    "",
    "If clear, call submit_booking_step with:",
    `- step_key: ${params.pendingBookingStepKey}`,
    "- value: the normalized answer",
  ].join("\n");
}

export function requestNormalizedStepModelResolution(params: {
  callSid: string | null;
  source: string;
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
  pendingBookingStepPromptAnchorSeq: number;
  requestRealtimeResponse: RequestRealtimeResponse;
}): void {
  const pendingBookingStepKey = clean(params.pendingBookingStepKey);
  const pendingSlot = clean(params.pendingSlot);
  const expectedType = clean(params.expectedType);
  const validationMode = clean(params.validationMode);
  const lastUserTranscript = clean(params.lastUserTranscript);

  if (!pendingBookingStepKey || !lastUserTranscript) {
    return;
  }

  const confirmationStep = isConfirmationStep({
    pendingBookingStepKey,
    pendingSlot,
    expectedType,
    validationMode,
  });

  console.warn("[VOICE_REALTIME][NORMALIZED_STEP_MODEL_RESOLUTION_REQUESTED]", {
    callSid: params.callSid,
    source: params.source,
    pendingBookingStepKey,
    pendingSlot,
    expectedType,
    validationMode,
    isConfirmationStep: confirmationStep,
    lastUserTranscript,
    lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    pendingBookingStepPromptAnchorSeq: params.pendingBookingStepPromptAnchorSeq,
  });

  const instructions = confirmationStep
    ? buildConfirmationNormalizationInstructions({
        pendingBookingStepKey,
        pendingSlot,
        expectedType,
        validationMode,
        lastUserTranscript,
      })
    : buildDefaultNormalizationInstructions({
        pendingBookingStepKey,
        pendingSlot,
        expectedType,
        validationMode,
        lastUserTranscript,
      });

  params.requestRealtimeResponse(
    {
      instructions,
    },
    confirmationStep
      ? "booking_step_confirmation_model_resolution"
      : "booking_step_normalized_model_resolution"
  );
}