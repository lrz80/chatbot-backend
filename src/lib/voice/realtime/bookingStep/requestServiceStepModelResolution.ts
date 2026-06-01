// src/lib/voice/realtime/bookingStep/requestServiceStepModelResolution.ts

type RequestRealtimeResponse = (
  payload: {
    instructions: string;
  },
  source: string
) => void;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function requestServiceStepModelResolution(params: {
  callSid: string | null;
  source: string;
  pendingBookingStepKey: string;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
  pendingBookingStepPromptAnchorSeq: number;
  requestRealtimeResponse: RequestRealtimeResponse;
}): void {
  const pendingBookingStepKey = clean(params.pendingBookingStepKey);
  const lastUserTranscript = clean(params.lastUserTranscript);

  if (!pendingBookingStepKey || !lastUserTranscript) {
    console.warn("[VOICE_REALTIME][SERVICE_STEP_MODEL_RESOLUTION_SKIPPED]", {
      callSid: params.callSid,
      reason: "MISSING_STEP_OR_TRANSCRIPT",
      source: params.source,
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq: params.pendingBookingStepPromptAnchorSeq,
    });

    return;
  }

  console.warn("[VOICE_REALTIME][SERVICE_STEP_MODEL_RESOLUTION_REQUESTED]", {
    callSid: params.callSid,
    source: params.source,
    pendingBookingStepKey,
    lastUserTranscript,
    lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    pendingBookingStepPromptAnchorSeq: params.pendingBookingStepPromptAnchorSeq,
  });

  params.requestRealtimeResponse(
    {
      instructions: [
        "Use only the active booking flow and the latest caller transcript as source of truth.",
        "The current pending booking step is service.",
        `Latest caller transcript: ${lastUserTranscript}`,
        "Do not submit the raw transcript as the service value unless it clearly matches one configured service option.",
        "Use the current next_required_step.validation_config.options and speech_hints to resolve the caller's intended service.",
        "If exactly one configured service is clearly intended, call submit_booking_step with step_key service and value set to the configured/canonical service name.",
        "If the service is not clear enough, do not call submit_booking_step. Ask the service question again naturally in the active call language.",
        "Do not advance to another booking step until service is resolved.",
        "Do not call end_call.",
      ].join(" "),
    },
    "booking_step_service_model_resolution"
  );
}