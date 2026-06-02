// src/lib/voice/realtime/bookingStep/requestNormalizedStepModelResolution.ts
import { USE_CALLER_PHONE_TOKEN } from "./resolvers/resolveRealtimePhoneValue";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

function clean(value: unknown): string {
  return String(value ?? "").trim();
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

  console.warn("[VOICE_REALTIME][NORMALIZED_STEP_MODEL_RESOLUTION_REQUESTED]", {
    callSid: params.callSid,
    source: params.source,
    pendingBookingStepKey,
    pendingSlot,
    expectedType,
    validationMode,
    lastUserTranscript,
    lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    pendingBookingStepPromptAnchorSeq: params.pendingBookingStepPromptAnchorSeq,
  });

  params.requestRealtimeResponse(
    {
      instructions: [
        "The caller answered the current booking step.",
        `Current booking step key: ${pendingBookingStepKey}`,
        `Current booking slot: ${pendingSlot}`,
        `Current expected type: ${expectedType}`,
        `Current validation mode: ${validationMode}`,
        `Caller latest answer: ${lastUserTranscript}`,
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
        `- step_key: ${pendingBookingStepKey}`,
        "- value: the normalized answer",
      ].join("\n"),
    },
    "booking_step_normalized_model_resolution"
  );
}